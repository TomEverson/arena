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
	"sync/atomic"
	"time"
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
)

// Entity is the replicated state of one thing in the world.
// Every entity carries a TeamID from day one (teams of 1 for now).
type Entity struct {
	ID     uint32  `json:"id"`
	TeamID uint16  `json:"teamId"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
}

// Snapshot is a reusable buffer holding what one player sees at one tick.
type Snapshot struct {
	Tick     uint64
	AckSeq   uint32 // last input sequence the server has simulated for this player
	Entities []Entity
}

// Level is what the world needs from a map: collision geometry and spawn points.
type Level struct {
	Collision CollisionWorld
	Spawns    []Vec3
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

	ackSeq uint32

	// Pending inputs, oldest first (a fixed ring: no allocation).
	queue     [InputQueueSize]Input
	qHead     int
	qLen      int
	lastInput Input

	initial    PlayerState
	hasInitial bool
}

// NewPlayer allocates a player and its snapshot buffer pool.
// Teams of one for now: the team ID equals the player ID.
func NewPlayer(id uint32) *Player {
	p := &Player{
		ID:     id,
		Entity: Entity{ID: id, TeamID: uint16(id)},
		Out:    make(chan *Snapshot, snapshotBuffers),
		Free:   make(chan *Snapshot, snapshotBuffers),
	}
	for i := 0; i < snapshotBuffers; i++ {
		p.Free <- &Snapshot{Entities: make([]Entity, 0, MaxPlayers)}
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
)

type command struct {
	kind   commandKind
	player *Player // join
	id     uint32  // leave, input
	input  Input   // input
}

// World is the authoritative game state.
type World struct {
	tick      uint64
	level     *Level
	players   []*Player // cap MaxPlayers, never grows
	inbox     chan command
	nextSpawn int

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
	}
}

// Tick returns the last completed tick. Safe from any goroutine.
func (w *World) Tick() uint64 { return w.publishedTick.Load() }

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

	if w.tick%snapshotEvery == 0 {
		w.sendSnapshots()
	}
	w.publishedTick.Store(w.tick)
}

// stepPlayer simulates one tick of movement for p. It consumes exactly one
// queued input; if the queue is empty it repeats the last input with the
// one-shot buttons (jump, dash) cleared, so a held key keeps working but a
// press is never applied twice.
func (w *World) stepPlayer(p *Player) {
	if p.qLen > 0 {
		p.lastInput = p.popInput()
		p.ackSeq = p.lastInput.Seq
	} else {
		p.lastInput.Jump = false
		p.lastInput.Dash = false
	}
	StepPlayer(&p.State, &p.lastInput, &w.level.Collision, TickDT)
	p.Entity.X = p.State.X
	p.Entity.Y = p.State.Y
	p.Entity.Z = p.State.Z
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
			if p.hasInitial {
				p.State = p.initial
			} else {
				sp := w.level.Spawns[w.nextSpawn%len(w.level.Spawns)]
				w.nextSpawn++
				p.State = SpawnState(sp.X, sp.Y, sp.Z)
			}
			p.Entity.X, p.Entity.Y, p.Entity.Z = p.State.X, p.State.Y, p.State.Z
			w.players = append(w.players, p)
		}
	case cmdLeave:
		for i, p := range w.players {
			if p.ID == c.id {
				last := len(w.players) - 1
				w.players[i] = w.players[last]
				w.players[last] = nil
				w.players = w.players[:last]
				return
			}
		}
	case cmdInput:
		for _, p := range w.players {
			if p.ID == c.id {
				p.pushInput(c.input)
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
		s.Tick = w.tick
		s.AckSeq = p.ackSeq
		s.Entities = w.entitiesFor(p, s.Entities[:0])
		select {
		case p.Out <- s:
		default:
			p.Free <- s // cannot happen (same capacity) but never lose a buffer
		}
	}
}

// entitiesFor is the single choke point for what a player may see.
// Interest management / fog of war / team visibility will live here.
// Currently returns everything.
func (w *World) entitiesFor(_ *Player, dst []Entity) []Entity {
	for _, p := range w.players {
		dst = append(dst, p.Entity)
	}
	return dst
}
