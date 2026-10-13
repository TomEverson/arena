// Package game holds the authoritative world simulation.
//
// Concurrency model: exactly one goroutine (the one calling Run/Step) owns all
// mutable world state. Network goroutines communicate with it only through the
// inbox channel and per-player snapshot channels. There are no locks in here.
//
// HARD RULE: Step must not allocate. TestStepDoesNotAllocate enforces it.
package game

import (
	"context"
	"math"
	"sync/atomic"
	"time"

	"arena/server/internal/protocol"
)

const (
	TickRate     = 60
	SnapshotRate = 30
	// TickDT is the simulation step in seconds. 1.0/60 rounds exactly like JavaScript's 1/60.
	TickDT = 1.0 / TickRate
	// snapshotEvery is how many ticks pass between snapshots.
	snapshotEvery = TickRate / SnapshotRate
	// MaxPlayers bounds every preallocated buffer so Step never grows a slice.
	MaxPlayers = 64
	// snapshotBuffers is the number of in-flight snapshots per player.
	snapshotBuffers = 4
	inboxSize       = 1024
	// InputQueueSize is how many not-yet-simulated inputs we buffer per player.
	InputQueueSize = 16

	// A player is simulated only when an input arrives (input-driven), one input
	// per tick. If a backlog builds up (a lag spike delivering inputs in a burst)
	// the server catches up by simulating a second input in a tick, paid for with
	// credit so a client that floods inputs cannot run faster than real time for long.
	catchUpThreshold = 2    // queue length above which catch-up may happen
	catchUpCreditMax = 8    // largest burst of extra ticks that can be banked
	catchUpRegen     = 0.05 // credit regained per tick (one extra tick per 20)
)

// Entity, Snapshot and the messages around them are defined once, in
// protocol/messages.json. Every entity carries a TeamID from day one.
type (
	Entity   = protocol.Entity
	Snapshot = protocol.Snapshot
)

// Level is what the world needs from a map: collision geometry and spawn points.
type Level struct {
	// Name is the level's name ("ffa", "greybox"); clients load the map of the same name.
	Name      string
	Collision CollisionWorld
	Spawns    []Vec3
	// Targets are the practice range's dummies; only practice rooms use them.
	Targets []TargetSpec
	// Pickups are where the practice range's recharge pickups sit (floor level); only practice rooms use them.
	Pickups []Vec3
}

// TargetSpec places one practice target: it stands still, or strafes back and forth.
type TargetSpec struct {
	ID     string
	Pos    Vec3 // feet position (the centre of a strafe)
	Strafe bool
	// WallRun makes the target run along a wall: it strafes (Strafe is true too) up in the
	// air at Pos.Y, drawn in the wall-run pose. It is a moving target at height.
	WallRun bool
	AxisX   bool    // strafe along x (true) or z
	Range   float64 // half the strafe distance
}

// FlatLevel is a large empty floor with its top at y = 0 and one spawn point.
func FlatLevel() *Level {
	return &Level{
		Collision: CollisionWorld{Boxes: []Aabb{{MinX: -200, MaxX: 200, MinY: -1, MaxY: 0, MinZ: -200, MaxZ: 200}}},
		Spawns:    []Vec3{{}},
	}
}

// Player is the world's view of a connection. The network layer creates it
// (so allocation happens off the tick goroutine) and hands it over via Join.
type Player struct {
	ID     uint32
	Entity Entity
	// State is the player's movement state. Owned by the world goroutine once joined.
	State PlayerState

	// Out carries filled snapshots to the connection's writer goroutine.
	// Free returns drained buffers. Both are created by NewPlayer.
	Out  chan *Snapshot
	Free chan *Snapshot

	// Combat state (server-authoritative).
	Weapon        WeaponState
	Health        protocol.PlayerHealth
	Kills, Deaths uint16
	sinceDamage   float64 // seconds since last damage (shield recharge)
	hist          history
	events        [eventRingSize]protocol.GameEvent
	eventHead     int
	eventLen      int
	eventSeq      uint32

	ackSeq        uint32 // last input sequence simulated
	lastQueuedSeq uint32 // highest input sequence accepted into the queue (duplicates are skipped)
	catchUpCredit float64
	rematch       bool // voted for another match while the results are showing

	// Pending inputs, oldest first (a fixed ring: no allocation).
	queue [InputQueueSize]Input
	qHead int
	qLen  int

	initial    PlayerState
	hasInitial bool
	// rollHit is who this rolling dive has already cut (each body is cut once per dive).
	rollHit  [8]uint32
	rollHits int
	// slashFor is how many more ticks others are told the player is mid-slash (for the animation).
	slashFor int
}

// NewPlayer allocates a player and its snapshot buffer pool.
// Teams of one for now: the team ID equals the player ID.
func NewPlayer(id uint32) *Player {
	p := &Player{
		ID:     id,
		Entity: Entity{ID: id, TeamID: uint16(id)},
		Out:    make(chan *Snapshot, snapshotBuffers),
		Free:   make(chan *Snapshot, snapshotBuffers),

		catchUpCredit: catchUpCreditMax,
		Weapon:        SpawnWeapon(id*2654435761+1, protocol.HeroKindTrooper),
	}
	for i := 0; i < snapshotBuffers; i++ {
		p.Free <- &Snapshot{
			Type:     protocol.ServerTypeSnapshot,
			Entities: make([]Entity, 0, MaxPlayers+maxTargets+maxSkillEntities),
			Events:   make([]protocol.GameEvent, 0, eventRingSize),
			Shots:    make([]protocol.Shot, 0, shotRingSize),
			Scores:   make([]protocol.Score, 0, MaxPlayers),
		}
	}
	return p
}

// SetInitialState makes the player join with this state instead of a level spawn
// (used by tests and the movement vectors). Call before Join.
func (p *Player) SetInitialState(s PlayerState) {
	p.initial = s
	p.hasInitial = true
}

func (p *Player) pushInput(in Input) {
	if p.qLen == InputQueueSize {
		// Full: drop the oldest so the player stays close to real time.
		p.qHead = (p.qHead + 1) % InputQueueSize
		p.qLen--
	}
	p.queue[(p.qHead+p.qLen)%InputQueueSize] = in
	p.qLen++
}

func (p *Player) popInput() Input {
	in := p.queue[p.qHead]
	p.qHead = (p.qHead + 1) % InputQueueSize
	p.qLen--
	return in
}

type commandKind uint8

const (
	cmdJoin commandKind = iota
	cmdLeave
	cmdInput
	cmdRespawn
	cmdRematch
	cmdPractice
	cmdHero
)

type command struct {
	kind   commandKind
	player *Player // join
	id     uint32  // leave, input
	input  Input   // input
	action PracticeAction
	hero   uint8 // hero
}

// World is the authoritative game state.
type World struct {
	tick      uint64
	level     *Level
	players   []*Player // cap MaxPlayers, never grows
	inbox     chan command
	nextSpawn int
	boxes     [MaxPlayers + maxTargets + maxBarriers]Hitbox // scratch: target hitboxes for one bullet step

	bullets [maxBullets]liveBullet // projectiles in flight (see bullets.go)
	skills  skills                 // grenades, barriers and bombardments (see skills.go)
	pickups [maxPickups]pickup     // the practice range's recharge pickups (see skills.go)
	shots   shotLog                // recent shots, for clients to draw tracers

	cfg   MatchConfig
	match matchState

	practice bool // a practice range: targets, no player-vs-player damage
	targets  []Target

	playerCount atomic.Int32 // players in the world, readable from other goroutines

	publishedTick atomic.Uint64 // readable from other goroutines (healthz)
}

// NewWorld creates a world on the given level (nil means FlatLevel).
func NewWorld(level *Level) *World {
	if level == nil {
		level = FlatLevel()
	}
	if len(level.Spawns) == 0 {
		level.Spawns = []Vec3{{}}
	}
	return &World{
		level:   level,
		players: make([]*Player, 0, MaxPlayers),
		inbox:   make(chan command, inboxSize),
		match:   matchState{phase: protocol.MatchPhaseLive}, // always live until SetMatchConfig enables a cycle
	}
}

// Tick returns the last completed tick. Safe from any goroutine.
func (w *World) Tick() uint64 { return w.publishedTick.Load() }

// PlayerCount returns how many players are in the world. Safe from any goroutine.
func (w *World) PlayerCount() int { return int(w.playerCount.Load()) }

// Join registers a player. Blocks until the world accepts it or ctx ends.
func (w *World) Join(ctx context.Context, p *Player) {
	select {
	case w.inbox <- command{kind: cmdJoin, player: p}:
	case <-ctx.Done():
	}
}

// Leave removes a player. Blocks until the world accepts it or ctx ends.
func (w *World) Leave(ctx context.Context, id uint32) {
	select {
	case w.inbox <- command{kind: cmdLeave, id: id}:
	case <-ctx.Done():
	}
}

// Respawn puts the player back at a spawn point. Queued inputs are kept and
// play out from the new position, exactly as the client will replay them.
func (w *World) Respawn(ctx context.Context, id uint32) {
	select {
	case w.inbox <- command{kind: cmdRespawn, id: id}:
	case <-ctx.Done():
	}
}

// Rematch records a vote for another match while the results are showing.
func (w *World) Rematch(ctx context.Context, id uint32) {
	select {
	case w.inbox <- command{kind: cmdRematch, id: id}:
	case <-ctx.Done():
	}
}

// Practice asks for a practice-range helper (ignored in other modes).
func (w *World) Practice(ctx context.Context, id uint32, action PracticeAction) {
	select {
	case w.inbox <- command{kind: cmdPractice, id: id, action: action}:
	case <-ctx.Done():
	}
}

// SetHero records which hero a player wants to be. It takes effect on their next life, or at
// once where it cannot be used to dodge a fight: in the practice range, outside a live match,
// while they are dead, or while they still have spawn protection (so a player who has just
// joined or respawned can still pick).
func (w *World) SetHero(ctx context.Context, id uint32, hero uint8) {
	select {
	case w.inbox <- command{kind: cmdHero, id: id, hero: hero}:
	case <-ctx.Done():
	}
}

// SubmitInput queues a client input. It never blocks: if the inbox is full
// the input is dropped.
func (w *World) SubmitInput(id uint32, in Input) {
	select {
	case w.inbox <- command{kind: cmdInput, id: id, input: in}:
	default:
	}
}

// Run drives Step from ticks until ctx is cancelled. Taking the tick source as
// a channel lets tests drive the loop deterministically.
func (w *World) Run(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			w.Step()
		}
	}
}

// Step advances the world by one tick. MUST NOT ALLOCATE.
func (w *World) Step() {
	w.drainInbox()
	w.tick++

	for _, p := range w.players {
		w.stepPlayer(p)
	}
	// Positions at the end of this tick, for lag compensation of later shots.
	w.stepTargets()
	w.stepBullets()
	w.stepSkills()
	for _, p := range w.players {
		w.recordHistory(p)
	}
	w.recordTargetHistory()
	for _, p := range w.players {
		w.updateLife(p)
	}
	w.updateMatch()

	if w.tick%snapshotEvery == 0 {
		w.sendSnapshots()
	}
	w.publishedTick.Store(w.tick)
}

// stepPlayer simulates p for this tick. Input-driven: it consumes queued inputs
// and does nothing when there are none, so the player's state is always exactly
// "the state after input ackSeq". That is what lets the client predict with the
// same function and reconcile without phantom ticks.
func (w *World) stepPlayer(p *Player) {
	p.catchUpCredit = math.Min(catchUpCreditMax, p.catchUpCredit+catchUpRegen)
	n := 0
	if p.qLen > 0 {
		n = 1
		if p.qLen > catchUpThreshold && p.catchUpCredit >= 1 {
			n = 2
			p.catchUpCredit--
		}
	}
	for i := 0; i < n; i++ {
		in := p.popInput()
		p.ackSeq = in.Seq // dead players still consume inputs so acks keep flowing
		if !p.Health.Alive || !w.canAct() {
			continue // dead, or in a countdown/results screen: frozen, but the input is acknowledged
		}
		// Who the player is decides what the skill buttons do: the client's own claim is ignored.
		in.Hero, in.Overdrive = p.Health.Hero, p.Health.Overdrive > 0
		// The weapon in hand sets run speed and the aim slowdown; the client's own values are ignored.
		in.RunSpeedMult, in.ADSSpeedMult = movementMods(&p.Weapon)
		wasRolling := p.State.RollT > 0
		StepPlayer(&p.State, &in, &w.level.Collision, TickDT)
		ctx := WeaponContext{HSpeed: hSpeed(&p.State), OnGround: p.State.OnGround, Crouching: p.State.Crouching, Sliding: p.State.Sliding, Grappling: p.State.Grappling}
		shot := StepWeapon(&p.Weapon, &in, &ctx, TickDT)
		if shot.Fired {
			switch d := activeDef(&p.Weapon); {
			case d.hitscan:
				w.resolveShot(p, &in, &shot, d)
			case d.spear:
				w.fireSpear(p, &in, &shot)
			default:
				w.fireBullet(p, &in, &shot)
			}
		}
		if shot.MeleeStrike {
			w.resolveMelee(p, &in)
		}
		w.useSkills(p, &in, &shot)
		w.stepRoll(p, &in, wasRolling)
		p.Entity.Yaw = in.Yaw
		p.Entity.Pitch = in.Pitch
	}
	p.syncEntity()
}

// syncEntity copies the replicated parts of the movement state into the entity.
func (p *Player) syncEntity() {
	s := &p.State
	p.Entity.X, p.Entity.Y, p.Entity.Z = s.X, s.Y, s.Z
	p.Entity.Hero = p.Health.Hero
	var f uint16
	if s.Crouching {
		f |= protocol.EntityFlagCrouching
	}
	if s.Sliding {
		f |= protocol.EntityFlagSliding
	}
	if s.DashTime > 0 {
		f |= protocol.EntityFlagDashing
	}
	if s.OnGround {
		f |= protocol.EntityFlagOnGround
	}
	if s.Mantling {
		f |= protocol.EntityFlagMantling
	}
	if s.WallRunning {
		f |= protocol.EntityFlagWallRunning
	}
	if s.Grappling {
		f |= protocol.EntityFlagGrappling
	}
	if p.slashFor > 0 {
		f |= protocol.EntityFlagSlashing
	}
	if s.RollT > 0 {
		f |= protocol.EntityFlagRolling
	}
	if p.Weapon.MeleeCooldown > WeaponMeleeCooldown-WeaponMeleeLock {
		f |= protocol.EntityFlagMeleeing
	}
	switch {
	case p.Weapon.Slot == emptyHands:
		f |= protocol.EntityFlagEmptyHanded
	case p.Weapon.Gun == 1:
		f |= protocol.EntityFlagHoldingSniper
	case p.Weapon.Gun == 2:
		f |= protocol.EntityFlagHoldingSpear
	}
	if !p.Health.Alive {
		f |= protocol.EntityFlagDead
	}
	if p.Health.ProtectedFor > 0 {
		f |= protocol.EntityFlagProtected
	}
	p.Entity.Flags = f
}

func (w *World) drainInbox() {
	for {
		select {
		case c := <-w.inbox:
			w.apply(c)
		default:
			return
		}
	}
}

func (w *World) apply(c command) {
	switch c.kind {
	case cmdJoin:
		if len(w.players) < cap(w.players) {
			p := c.player
			w.players = append(w.players, p) // before choosing a spawn so others count as enemies
			w.playerCount.Add(1)
			if p.hasInitial {
				p.State = p.initial
				p.Health = protocol.PlayerHealth{Health: WeaponMaxHealth, Shield: WeaponMaxShield, Alive: true, Hero: p.Health.NextHero, NextHero: p.Health.NextHero}
				p.sinceDamage = 1e9
				p.syncEntity()
			} else {
				w.resetLife(p)
			}
		}
	case cmdLeave:
		for i, p := range w.players {
			if p.ID == c.id {
				last := len(w.players) - 1
				w.players[i] = w.players[last]
				w.players[last] = nil
				w.players = w.players[:last]
				w.playerCount.Add(-1)
				return
			}
		}
	case cmdInput:
		for _, p := range w.players {
			if p.ID == c.id {
				// Inputs are resent redundantly: skip anything already accepted.
				if c.input.Seq > p.lastQueuedSeq {
					p.lastQueuedSeq = c.input.Seq
					p.pushInput(c.input)
				}
				return
			}
		}
	case cmdHero:
		if c.hero > maxHero {
			return
		}
		for _, p := range w.players {
			if p.ID == c.id {
				p.Health.NextHero = c.hero
				if p.Health.Hero != c.hero && (w.practice || !w.canDamage() || !p.Health.Alive || p.Health.ProtectedFor > 0) {
					p.Health.Hero = c.hero
					p.Health.Overdrive = 0
					p.Weapon = SpawnWeapon(p.Weapon.Rng, c.hero) // the new hero's own weapons
					p.State.Grappling, p.State.Grapple2 = false, false
					p.syncEntity()
				}
				return
			}
		}
	case cmdPractice:
		for _, p := range w.players {
			if p.ID == c.id {
				w.applyPractice(p, c.action)
				return
			}
		}
	case cmdRematch:
		if w.match.phase == protocol.MatchPhaseEnded {
			for _, p := range w.players {
				if p.ID == c.id {
					p.rematch = true
					return
				}
			}
		}
	case cmdRespawn:
		for _, p := range w.players {
			if p.ID == c.id {
				w.resetLife(p) // a dev shortcut: instant new life at a spawn point
				return
			}
		}
	}
}

func (w *World) sendSnapshots() {
	for _, p := range w.players {
		var s *Snapshot
		select {
		case s = <-p.Free:
		default:
			continue // all buffers in flight: this client is slow, skip it
		}
		s.Tick = uint32(w.tick)
		s.AckSeq = p.ackSeq
		s.Queued = uint8(p.qLen)
		s.You = p.State
		s.Health = p.Health
		s.Weapon = p.Weapon
		s.Match = w.matchInfo()
		s.Scores = w.scoresInto(s.Scores[:0])
		s.Entities = w.entitiesFor(p, s.Entities[:0])
		s.Events = p.recentEvents(s.Events[:0], w.tick)
		s.Shots = w.shots.recent(s.Shots[:0], w.tick)
		select {
		case p.Out <- s:
		default:
			p.Free <- s // cannot happen (same capacity) but never lose a buffer
		}
	}
}

// entitiesFor is the single choke point for what a player may see.
// Interest management / fog of war / team visibility will live here.
// Currently returns everyone else (the player's own state is sent as `you`).
func (w *World) entitiesFor(viewer *Player, dst []Entity) []Entity {
	for _, p := range w.players {
		if p != viewer {
			dst = append(dst, p.Entity)
		}
	}
	for i := range w.targets {
		dst = append(dst, w.targets[i].Entity)
	}
	return w.skillEntities(dst)
}
