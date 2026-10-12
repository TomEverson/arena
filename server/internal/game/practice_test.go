package game

import (
	"context"
	"testing"

	"arena/server/internal/protocol"
)

// A practice range: one static and one strafing target in front of the spawn.
func rangeLevel() *Level {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 0, Z: 0}, {X: 30, Z: 30}}
	lv.Targets = []TargetSpec{
		{ID: "still", Pos: Vec3{X: 0, Z: -10}},
		{ID: "mover", Pos: Vec3{X: 0, Z: -20}, Strafe: true, AxisX: true, Range: 5},
	}
	return lv
}

type rangeRoom struct {
	t       *testing.T
	w       *World
	players map[uint32]*Player
	seq     map[uint32]uint32
	moverX  []float64 // the strafing target's x after every tick, indexed by tick (entry 0 is a placeholder)
}

func newRange(t *testing.T) *rangeRoom {
	t.Helper()
	w := NewWorld(rangeLevel())
	w.SetPractice(true)
	r := &rangeRoom{t: t, w: w, players: map[uint32]*Player{}, seq: map[uint32]uint32{}, moverX: []float64{0}}
	r.join(1)
	r.step(nil)
	return r
}

func (r *rangeRoom) join(id uint32) *Player {
	p := NewPlayer(id)
	r.players[id] = p
	r.w.Join(context.Background(), p)
	return p
}

// step runs one tick; inputs maps player id to that player's input this tick.
func (r *rangeRoom) step(inputs map[uint32]*Input) {
	for id, in := range inputs {
		x := *in
		r.seq[id]++
		x.Seq = r.seq[id]
		r.w.SubmitInput(id, x)
	}
	r.w.Step()
	for _, p := range r.players {
		for len(p.Out) > 0 {
			p.Free <- <-p.Out
		}
	}
	r.moverX = append(r.moverX, r.w.targets[1].x)
}

func shoot(pitch float64) *Input { return &Input{Fire: true, ADS: true, Pitch: pitch} }

// idle keeps the shooter's weapon clock moving (time only advances with a player's inputs).
func (r *rangeRoom) idle(n int) {
	for i := 0; i < n; i++ {
		r.step(map[uint32]*Input{1: {}})
	}
}

func hitEvents(p *Player) []protocol.GameEvent { return eventsOf(p, protocol.EventKindHit) }

func TestTargetsComeFromTheLevelAndAppearInSnapshots(t *testing.T) {
	r := newRange(t)
	if len(r.w.targets) != 2 || r.w.targets[0].ID != CombatTargetIdBase || r.w.targets[1].ID != CombatTargetIdBase+1 {
		t.Fatalf("targets = %+v", r.w.targets)
	}
	p := r.players[1]
	var snap *protocol.Snapshot
	for i := 0; i < 4 && snap == nil; i++ {
		r.w.Step()
		select {
		case snap = <-p.Out:
		default:
		}
	}
	if snap == nil {
		t.Fatal("no snapshot")
	}
	if len(snap.Entities) != 2 {
		t.Fatalf("snapshot has %d entities, want the 2 targets (the player is `you`)", len(snap.Entities))
	}
	for _, e := range snap.Entities {
		if e.Kind != protocol.EntityKindTarget || e.ID < CombatTargetIdBase || e.TeamID != 0 || e.Flags&protocol.EntityFlagDead != 0 {
			t.Fatalf("target entity = %+v", e)
		}
	}
}

func TestOnlyPracticeRoomsHaveTargets(t *testing.T) {
	w := NewWorld(rangeLevel()) // an FFA world on the same level
	w.SetPractice(false)        // what room creation does for every FFA room
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	if len(w.targets) != 0 || len(w.entitiesFor(p, nil)) != 0 {
		t.Fatalf("an FFA room must not grow targets")
	}
}

func TestStrafingTargetStaysInRangeAndStaticOneStaysPut(t *testing.T) {
	r := newRange(t)
	r.idle(600)
	lo, hi := r.moverX[0], r.moverX[0]
	for _, x := range r.moverX {
		lo, hi = min(lo, x), max(hi, x)
	}
	if lo < -5-1e-9 || hi > 5+1e-9 || hi-lo < 9 {
		t.Fatalf("strafing target covered x in [%v, %v], want about [-5, 5]", lo, hi)
	}
	if r.w.targets[0].x != 0 || r.w.targets[0].z != -10 {
		t.Fatalf("static target moved to (%v, %v)", r.w.targets[0].x, r.w.targets[0].z)
	}
}

func TestShootingATargetReportsItsHealth(t *testing.T) {
	r := newRange(t)
	r.step(map[uint32]*Input{1: shoot(-0.05)}) // body of the static target, 10 m ahead
	ev := hitEvents(r.players[1])
	if len(ev) != 1 || ev[0].Other != CombatTargetIdBase || ev[0].Amount != WeaponDamage {
		t.Fatalf("hit events = %+v", ev)
	}
	if ev[0].Shield != WeaponMaxShield-WeaponDamage || ev[0].Health != WeaponMaxHealth {
		t.Fatalf("event health/shield = %v/%v", ev[0].Health, ev[0].Shield)
	}
	if r.w.targets[0].Health.Shield != WeaponMaxShield-WeaponDamage {
		t.Fatalf("target shield = %v", r.w.targets[0].Health.Shield)
	}
}

func TestKillingATargetAndItsRespawn(t *testing.T) {
	r := newRange(t)
	for i := 0; i < 400 && r.w.targets[0].Health.Alive; i++ {
		r.step(map[uint32]*Input{1: shoot(-0.05)})
	}
	tg := &r.w.targets[0]
	if tg.Health.Alive {
		t.Fatal("the target never died")
	}
	hits := hitEvents(r.players[1])
	last := hits[len(hits)-1]
	if last.Flags&protocol.GameEventFlagKilled == 0 || last.Health != 0 || last.Shield != 0 {
		t.Fatalf("the killing hit = %+v", last)
	}
	kills := eventsOf(r.players[1], protocol.EventKindKill)
	if len(kills) != 1 || kills[0].Other != tg.ID || kills[0].Actor != 1 {
		t.Fatalf("kill events = %+v", kills)
	}
	if tg.Entity.Flags&protocol.EntityFlagDead == 0 {
		t.Fatalf("a dead target should be flagged dead")
	}
	// Shots at the empty spot do nothing; then it comes back at full health.
	before := len(hitEvents(r.players[1]))
	r.idle(int(CombatTargetRespawn*TickRate) - 4)
	if tg.Health.Alive {
		t.Fatal("respawned too early")
	}
	r.idle(8)
	if !tg.Health.Alive || tg.Health.Health != WeaponMaxHealth || tg.Health.Shield != WeaponMaxShield {
		t.Fatalf("after respawn: %+v", tg.Health)
	}
	if len(hitEvents(r.players[1])) != before {
		t.Fatalf("hit events appeared while the target was away")
	}
}

func TestHeadshotsOnTargetsDoMoreDamage(t *testing.T) {
	r := newRange(t)
	r.step(map[uint32]*Input{1: shoot(0)}) // level at eye height: the head
	ev := hitEvents(r.players[1])
	if len(ev) != 1 || ev[0].Amount != WeaponDamage*WeaponHeadshotMult || ev[0].Flags&protocol.GameEventFlagHeadshot == 0 {
		t.Fatalf("headshot event = %+v", ev)
	}
}

// The strafing target is hit where the shooter saw it, not where it is now.
func TestLagCompensationOnAStrafingTarget(t *testing.T) {
	// Find the moment the mover crosses x = 0 (the shooter's line of fire is straight ahead at x = 0).
	probe := newRange(t)
	probe.idle(300)
	var crossing float64
	xs := probe.moverX
	for tick := 4; tick+2 < len(xs); tick += 2 { // snapshot ticks are even; skip the start, where it is at x = 0
		if xs[tick]*xs[tick+2] < 0 {
			crossing = float64(tick) + 2*(-xs[tick])/(xs[tick+2]-xs[tick])
			break
		}
	}
	if crossing == 0 {
		t.Fatal("the target never crossed the line of fire")
	}

	fireAt := int(crossing) + 12 // ticks later, the target has moved on
	aimed := func(viewTick float64) int {
		r := newRange(t)
		r.w.targets[0].x = 8         // the static target would otherwise stand in the line of fire
		for len(r.moverX) < fireAt { // after this loop the world is at tick fireAt-1
			r.step(map[uint32]*Input{1: {}})
		}
		shot := shoot(-0.0095) // level-ish at the 20 m mover, body height
		shot.ViewTick = viewTick
		r.step(map[uint32]*Input{1: shot})
		n := 0
		for _, e := range hitEvents(r.players[1]) {
			if e.Other == CombatTargetIdBase+1 {
				n++
			}
		}
		return n
	}
	if aimed(crossing) != 1 {
		t.Fatalf("a shot at where the strafing target was seen (tick %.1f) should hit it", crossing)
	}
	if aimed(0) != 0 {
		t.Fatalf("with no rewind the target has moved off the line of fire; got a hit")
	}
}

func TestPlayersCannotHurtEachOtherInTheRange(t *testing.T) {
	r := newRange(t)
	b := r.join(2)
	r.step(nil)
	a := r.players[1]
	a.State, b.State = SpawnState(0, 0, 0), SpawnState(0, 0, -5)
	a.Health.ProtectedFor, b.Health.ProtectedFor = 0, 0
	// Shoot straight at the other player: the static target is further along the same line.
	for i := 0; i < 8; i++ {
		r.step(map[uint32]*Input{1: shoot(-0.0155), 2: {}})
	}
	if b.Health.Shield != WeaponMaxShield || b.Health.Health != WeaponMaxHealth {
		t.Fatalf("a player was hurt in the range: %+v", b.Health)
	}
	if len(eventsOf(b, protocol.EventKindHurt)) != 0 {
		t.Fatalf("the other player should have no hurt events")
	}
	// ...and bullets pass through them to the target behind.
	if len(hitEvents(a)) == 0 {
		t.Fatalf("bullets should reach the target behind the other player")
	}
}

func TestNoSpawnProtectionAndEveryoneStartsAtTheCourseStart(t *testing.T) {
	r := newRange(t)
	b := r.join(2)
	r.step(nil)
	for _, p := range []*Player{r.players[1], b} {
		if p.Health.ProtectedFor != 0 {
			t.Fatalf("player %d has spawn protection in the range", p.ID)
		}
		if p.State.X != 0 || p.State.Z != 0 {
			t.Fatalf("player %d spawned at (%v, %v), want the course start (0, 0)", p.ID, p.State.X, p.State.Z)
		}
	}
}

func TestPracticeHelpers(t *testing.T) {
	r := newRange(t)
	p := r.players[1]

	// refill: after taking damage and firing.
	p.Health.Health, p.Health.Shield = 10, 0
	for i := 0; i < 5; i++ {
		r.step(map[uint32]*Input{1: shoot(-0.05)})
	}
	if p.Weapon.Ammo >= WeaponMagSize {
		t.Fatal("setup: the weapon should have fired")
	}
	r.w.Practice(context.Background(), 1, PracticeRefill)
	r.step(nil)
	if p.Health.Health != WeaponMaxHealth || p.Health.Shield != WeaponMaxShield || p.Weapon.Ammo != WeaponMagSize {
		t.Fatalf("refill left health %+v ammo %d", p.Health, p.Weapon.Ammo)
	}

	// start: back to the course start.
	p.State = SpawnState(7, 3, -9)
	r.w.Practice(context.Background(), 1, PracticeStart)
	r.step(nil)
	if p.State.X != 0 || p.State.Y != 0 || p.State.Z != 0 {
		t.Fatalf("start moved the player to (%v, %v, %v)", p.State.X, p.State.Y, p.State.Z)
	}

	// reset: hurt and dead targets come back.
	r.w.targets[0].Health.Health, r.w.targets[0].Health.Alive = 0, false
	r.w.targets[1].Health.Shield = 3
	r.w.Practice(context.Background(), 1, PracticeReset)
	r.step(nil)
	for i := range r.w.targets {
		h := r.w.targets[i].Health
		if !h.Alive || h.Health != WeaponMaxHealth || h.Shield != WeaponMaxShield {
			t.Fatalf("target %d after reset: %+v", i, h)
		}
	}
}

func TestPracticeHelpersDoNothingOutsideTheRange(t *testing.T) {
	w := NewWorld(rangeLevel())
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	p.State = SpawnState(7, 3, -9)
	w.Practice(context.Background(), 1, PracticeStart)
	w.Step()
	if p.State.X != 7 {
		t.Fatalf("the start helper teleported a player in an FFA room")
	}
}

// HARD RULE: Step must not allocate, including targets moving, dying and coming back.
func TestPracticeStepDoesNotAllocate(t *testing.T) {
	r := newRange(t)
	r.join(2)
	r.step(nil)
	tick := uint32(0)
	run := func() {
		tick++
		for _, id := range []uint32{1, 2} {
			r.w.SubmitInput(id, Input{Seq: tick, Fire: true, ADS: true, Pitch: -0.05, MoveX: float64(id) - 1.5, ViewTick: float64(r.w.tick) - 6})
		}
		r.w.Step()
		for _, p := range r.players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
		if tick%300 == 0 {
			r.w.applyPractice(r.players[1], PracticeReset)
		}
	}
	for i := 0; i < 60; i++ {
		run()
	}
	if allocs := testing.AllocsPerRun(1500, run); allocs != 0 {
		t.Fatalf("practice Step allocated %v times per tick, want 0", allocs)
	}
	killed := 0
	for _, e := range eventsOf(r.players[1], protocol.EventKindKill) {
		if e.Other >= CombatTargetIdBase {
			killed++
		}
	}
	if killed == 0 && r.w.targets[0].Health.Alive && r.w.targets[1].Health.Alive {
		t.Logf("note: no target died during the allocation run, so the death path may not have been covered")
	}
}

// A wall-running target runs along a wall in the air on the same arc as the player's wall run:
// it rises and falls (not a straight line), ends each pass where it began, turns at the ends,
// stays inside its range, and is flagged as wall running (so clients draw the wall-run pose).
func TestWallRunTargetFollowsTheWallRunArc(t *testing.T) {
	lv := FlatLevel()
	lv.Targets = []TargetSpec{{ID: "wr", Pos: Vec3{X: 5, Y: 2.5, Z: -10}, Strafe: true, WallRun: true, Range: 8}}
	w := NewWorld(lv)
	w.SetPractice(true)
	e := &w.targets[0].Entity
	if e.Flags&protocol.EntityFlagWallRunning == 0 || e.Flags&protocol.EntityFlagOnGround != 0 {
		t.Fatalf("flags = %b, want wall running and not on the ground", e.Flags)
	}
	if e.X != 5 || e.Y != 2.5 || e.Z != -18 {
		t.Fatalf("starts at (%v, %v, %v), want one end of the run (5, 2.5, -18)", e.X, e.Y, e.Z)
	}
	maxY, minY := e.Y, e.Y
	var sawBack bool
	prevZ := e.Z
	for i := 0; i < int(2*WallRunMaxTime*TickRate)+5; i++ {
		w.stepTargets()
		if e.X != 5 {
			t.Fatalf("it left its wall line: x=%v", e.X)
		}
		if e.Z < -10-8-1e-9 || e.Z > -10+8+1e-9 {
			t.Fatalf("z = %v is outside its range", e.Z)
		}
		if e.Z < prevZ-1e-9 {
			sawBack = true // it turned round and came back
		}
		prevZ = e.Z
		maxY, minY = max(maxY, e.Y), min(minY, e.Y)
		if e.Y < 2.5-1e-9 {
			t.Fatalf("y = %v dipped below its start", e.Y)
		}
	}
	if !sawBack {
		t.Fatal("it should turn at the end of a pass and run back")
	}
	// The same arc as the player's wall run: a rise of about a metre, not a straight line.
	peak := wallRunArc(WallRunMaxTime / 2)
	if peak < 0.5 || maxY < 2.5+peak-0.05 {
		t.Fatalf("peak %v (arc says %v): it should rise like a wall run", maxY-2.5, peak)
	}
	if got := wallRunArc(WallRunMaxTime); got > 1e-9 || got < -1e-9 {
		t.Fatalf("a pass should end at its starting height, ends %v above", got)
	}
}
