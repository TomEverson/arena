package game

import (
	"context"
	"math"
	"testing"

	"arena/server/internal/protocol"
)

// duel is a world with a shooter (id 1) and a victim (id 2) placed by hand.
type duel struct {
	t       *testing.T
	w       *World
	a, b    *Player
	seq     map[uint32]uint32
	victimX []float64 // victim x after each tick, indexed by tick
}

func newDuel(t *testing.T, lv *Level, aAt, bAt Vec3) *duel {
	t.Helper()
	if lv == nil {
		lv = FlatLevel()
	}
	d := &duel{t: t, w: NewWorld(lv), seq: map[uint32]uint32{}}
	d.a, d.b = NewPlayer(1), NewPlayer(2)
	d.a.SetInitialState(SpawnState(aAt.X, aAt.Y, aAt.Z))
	d.b.SetInitialState(SpawnState(bAt.X, bAt.Y, bAt.Z))
	d.w.Join(context.Background(), d.a)
	d.w.Join(context.Background(), d.b)
	d.step(nil, nil)
	return d
}

// step runs one tick with an input for a and/or b (nil = no input that tick).
func (d *duel) step(a, b *Input) {
	for _, x := range []struct {
		p  *Player
		in *Input
	}{{d.a, a}, {d.b, b}} {
		if x.in != nil {
			in := *x.in
			d.seq[x.p.ID]++
			in.Seq = d.seq[x.p.ID]
			d.w.SubmitInput(x.p.ID, in)
		}
	}
	d.w.Step()
	for len(d.a.Out) > 0 {
		d.a.Free <- <-d.a.Out
	}
	for len(d.b.Out) > 0 {
		d.b.Free <- <-d.b.Out
	}
	d.victimX = append(d.victimX, d.b.State.X)
}

// aimedShot is an aimed-down-sights shot straight down -Z, pitched down so it lands on the body.
func aimedShot(pitch float64) *Input { return &Input{Fire: true, ADS: true, Pitch: pitch} }

const bodyPitch = -0.05 // at 10 m this lands about 1.1 m up: the body, not the head

func eventsOf(p *Player, kind uint8) []protocol.GameEvent {
	var out []protocol.GameEvent
	for i := 0; i < p.eventLen; i++ {
		e := p.events[(p.eventHead+i)%eventRingSize]
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

func TestBodyShotHitsShieldFirst(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(aimedShot(bodyPitch), nil)

	if d.b.Health.Shield != WeaponMaxShield-WeaponDamage || d.b.Health.Health != WeaponMaxHealth {
		t.Fatalf("victim health %+v, want shield %v and full health", d.b.Health, WeaponMaxShield-WeaponDamage)
	}
	hit := eventsOf(d.a, protocol.EventKindHit)
	hurt := eventsOf(d.b, protocol.EventKindHurt)
	if len(hit) != 1 || hit[0].Other != 2 || hit[0].Amount != WeaponDamage || hit[0].Flags != 0 {
		t.Fatalf("shooter hit events = %+v", hit)
	}
	if len(hurt) != 1 || hurt[0].Actor != 1 {
		t.Fatalf("victim hurt events = %+v", hurt)
	}
	// Both events say how much the victim has left, so a health bar can be drawn.
	for _, e := range []protocol.GameEvent{hit[0], hurt[0]} {
		if e.Shield != WeaponMaxShield-WeaponDamage || e.Health != WeaponMaxHealth {
			t.Fatalf("event victim health/shield = %v/%v, want %v/%v", e.Health, e.Shield, float64(WeaponMaxHealth), WeaponMaxShield-WeaponDamage)
		}
	}
	if d.b.sinceDamage > 2*TickDT { // reset by the hit, then at most a tick or two of timer since
		t.Fatalf("damage should reset the shield recharge timer, got %v s", d.b.sinceDamage)
	}
}

func TestHeadshotDoesMoreDamage(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(aimedShot(0), nil) // level at eye height 1.6 m: the head
	ev := eventsOf(d.a, protocol.EventKindHit)
	if len(ev) != 1 || ev[0].Amount != WeaponDamage*WeaponHeadshotMult || ev[0].Flags&protocol.GameEventFlagHeadshot == 0 {
		t.Fatalf("headshot event = %+v", ev)
	}
}

func TestCrouchedPlayersCanBeHeadshotToo(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	// The victim crouches: 1.2 m tall, so a level shot at 1.6 m would sail over; aim lower.
	d.step(nil, &Input{Slide: true})
	d.step(nil, &Input{Slide: true})
	if !d.b.State.Crouching {
		t.Fatal("victim should be crouching")
	}
	d.step(aimedShot(-0.0155), nil) // lands about 1.45 m: over the head of a 1.2 m figure
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 0 {
		t.Fatalf("a shot over a crouched player's head should miss, got %d hits", n)
	}
	for i := 0; i < 8; i++ { // let the weapon's cooldown pass (time only advances with the shooter's inputs)
		d.step(&Input{}, nil)
	}
	d.step(aimedShot(-0.057), nil) // about 1.05 m at 9.7 m: the middle of the 0.9-1.2 m head zone
	ev := eventsOf(d.a, protocol.EventKindHit)
	if len(ev) == 0 || ev[len(ev)-1].Flags&protocol.GameEventFlagHeadshot == 0 {
		t.Fatalf("expected a headshot on the crouched player, got %+v", ev)
	}
}

func TestKillFlow(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.a.Health.Health, d.a.Health.Shield = 10, 0 // wounded shooter: the kill must heal them fully
	for i := 0; i < 300 && d.b.Health.Alive; i++ {
		d.step(aimedShot(bodyPitch), nil)
	}
	if d.b.Health.Alive {
		t.Fatal("victim never died")
	}
	if d.a.Kills != 1 || d.b.Deaths != 1 {
		t.Fatalf("kills %d deaths %d", d.a.Kills, d.b.Deaths)
	}
	if d.a.Health.Health != WeaponMaxHealth || d.a.Health.Shield != WeaponMaxShield {
		t.Fatalf("a kill should restore full health and shield, got %+v", d.a.Health)
	}
	if d.b.Health.RespawnIn <= 0 || d.b.Health.RespawnIn > CombatRespawnTime {
		t.Fatalf("respawn timer = %v", d.b.Health.RespawnIn)
	}
	hits := eventsOf(d.a, protocol.EventKindHit)
	if last := hits[len(hits)-1]; last.Flags&protocol.GameEventFlagKilled == 0 || last.Health != 0 || last.Shield != 0 {
		t.Fatalf("the killing hit should leave the victim at 0/0, got %+v", last)
	}
	for i := 1; i < len(hits); i++ { // damage only ever lowers the victim's health and shield
		if hits[i].Health+hits[i].Shield >= hits[i-1].Health+hits[i-1].Shield {
			t.Fatalf("hit %d did not reduce the victim's total: %+v then %+v", i, hits[i-1], hits[i])
		}
	}
	for _, p := range []*Player{d.a, d.b} {
		kills := eventsOf(p, protocol.EventKindKill)
		if len(kills) != 1 || kills[0].Actor != 1 || kills[0].Other != 2 {
			t.Fatalf("player %d kill events = %+v", p.ID, kills)
		}
	}
	if d.b.Entity.Flags&protocol.EntityFlagDead == 0 {
		t.Fatalf("victim entity should be flagged dead")
	}
	// Roughly the designed time to kill: 150 total health / 9 per shot at 10 shots/s.
	if hits := len(eventsOf(d.a, protocol.EventKindHit)); hits < 15 || hits > 18 {
		t.Fatalf("killed in %d hits, want about 17", hits)
	}
}

func TestDeadPlayersConsumeInputsButDoNothing(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.b.Health.Alive, d.b.Health.RespawnIn = false, CombatRespawnTime
	before := d.b.State
	for i := 0; i < 10; i++ {
		d.step(nil, &Input{MoveZ: 1, Fire: true})
	}
	if d.b.State != before {
		t.Fatalf("a dead player moved: %+v -> %+v", before, d.b.State)
	}
	if d.b.ackSeq != 10 {
		t.Fatalf("dead player's inputs should still be acknowledged, ack = %d", d.b.ackSeq)
	}
	if len(eventsOf(d.a, protocol.EventKindHurt)) != 0 {
		t.Fatalf("a dead player must not shoot")
	}
}

func TestRespawnAfterDelayWithSpawnProtection(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 40, Z: 40}}
	d := newDuel(t, lv, Vec3{}, Vec3{Z: -10})
	d.b.Health.Alive, d.b.Health.RespawnIn, d.b.Health.Health = false, CombatRespawnTime, 0
	for i := 0; i < int(CombatRespawnTime*TickRate)-2; i++ {
		d.step(nil, nil)
	}
	if d.b.Health.Alive {
		t.Fatal("respawned too early")
	}
	for i := 0; i < 4; i++ {
		d.step(nil, nil)
	}
	h := d.b.Health
	if !h.Alive || h.Health != WeaponMaxHealth || h.Shield != WeaponMaxShield {
		t.Fatalf("after respawn: %+v", h)
	}
	if h.ProtectedFor <= CombatSpawnProtection-0.2 || h.ProtectedFor > CombatSpawnProtection {
		t.Fatalf("spawn protection = %v, want about %v", h.ProtectedFor, CombatSpawnProtection)
	}
	if d.b.State.X != 40 || d.b.State.Z != 40 {
		t.Fatalf("respawned at %v, %v", d.b.State.X, d.b.State.Z)
	}
	if d.b.Entity.Flags&protocol.EntityFlagProtected == 0 || d.b.Entity.Flags&protocol.EntityFlagDead != 0 {
		t.Fatalf("entity flags %b", d.b.Entity.Flags)
	}
}

func TestSpawnProtectionBlocksDamageAndEndsOnFire(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.b.Health.ProtectedFor = CombatSpawnProtection
	d.a.Health.ProtectedFor = CombatSpawnProtection
	d.step(aimedShot(bodyPitch), nil)
	if d.b.Health.Shield != WeaponMaxShield || len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatalf("a protected player took damage: %+v", d.b.Health)
	}
	if d.a.Health.ProtectedFor != 0 {
		t.Fatalf("firing should end the shooter's own protection")
	}
}

func TestShieldRechargesAfterDelay(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.b.Health.Shield = 10
	d.b.sinceDamage = 0
	for i := 0; i < int(CombatShieldRechargeDelay*TickRate)-3; i++ {
		d.step(nil, nil)
	}
	if d.b.Health.Shield != 10 {
		t.Fatalf("shield recharged during the delay: %v", d.b.Health.Shield)
	}
	for i := 0; i < TickRate; i++ { // one second after the delay: +20
		d.step(nil, nil)
	}
	if got := d.b.Health.Shield; got < 25 || got > 32 {
		t.Fatalf("shield after one second of recharge = %v, want about 30", got)
	}
	for i := 0; i < 5*TickRate; i++ {
		d.step(nil, nil)
	}
	if d.b.Health.Shield != WeaponMaxShield {
		t.Fatalf("shield should cap at %v, got %v", WeaponMaxShield, d.b.Health.Shield)
	}
}

// --- Lag compensation ------------------------------------------------------

// runPast has the victim run sideways across the shooter's line of fire (x = 0) and
// returns the (fractional) tick at which the victim was exactly on that line,
// as a client interpolating between snapshots would have drawn them.
func runPast(t *testing.T, d *duel, ticks int) (crossing float64) {
	t.Helper()
	for i := 0; i < ticks; i++ {
		d.step(nil, &Input{MoveX: 1}) // strafe right: +x
	}
	xs := d.victimX
	for tick := 2; tick+2 < len(xs); tick += 2 { // snapshot ticks are even
		if xs[tick] <= 0 && xs[tick+2] > 0 {
			return float64(tick) + 2*(-xs[tick])/(xs[tick+2]-xs[tick])
		}
	}
	t.Fatal("victim never crossed the line of fire")
	return 0
}

func lagDuel(t *testing.T) *duel {
	// Shooter at the origin faces -Z; the victim starts 6 m to the left, 10 m ahead.
	return newDuel(t, nil, Vec3{}, Vec3{X: -6, Z: -10})
}

func TestLagCompensationHitsWhereTheShooterSawThem(t *testing.T) {
	probe := lagDuel(t)
	crossing := runPast(t, probe, 45)
	cur := probe.w.tick // victim has now run well past x = 0

	// With a rewound view the shot lands where the victim was on screen...
	d := lagDuel(t)
	runPast(t, d, int(cur)-1-1) // same moves, stop one tick before the shot (tick numbers start after the join step)
	if lag := float64(d.w.tick+1) - crossing; lag <= 2 || lag > CombatMaxRewindTicks {
		t.Skipf("test geometry gives a %.1f tick rewind, outside the compensated range", lag)
	}
	shot := aimedShot(bodyPitch)
	shot.ViewTick = crossing
	d.step(shot, &Input{MoveX: 1})
	if len(eventsOf(d.a, protocol.EventKindHit)) != 1 {
		t.Fatalf("a shot at where the victim was seen (tick %.1f of %d) should hit", crossing, d.w.tick)
	}

	// ...and without any rewind the same aim misses a victim who has moved on.
	m := lagDuel(t)
	runPast(t, m, int(cur)-1-1)
	m.step(aimedShot(bodyPitch), &Input{MoveX: 1})
	if len(eventsOf(m.a, protocol.EventKindHit)) != 0 {
		t.Fatalf("with no rewind the victim is no longer on the line of fire; got a hit")
	}
}

func TestRewindIsCapped(t *testing.T) {
	probe := lagDuel(t)
	crossing := runPast(t, probe, 45)

	// Keep the victim running so the view claim becomes too old to honour.
	d := lagDuel(t)
	runPast(t, d, 45)
	for float64(d.w.tick)-crossing <= CombatMaxRewindTicks+4 {
		d.step(nil, &Input{MoveX: 1})
	}
	shot := aimedShot(bodyPitch)
	shot.ViewTick = crossing // older than the allowed rewind: clamped, so it must miss
	d.step(shot, &Input{MoveX: 1})
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatalf("a view tick %.0f ticks old was honoured; the rewind cap is %d", float64(d.w.tick)-crossing, CombatMaxRewindTicks)
	}
}

func TestViewTickFromTheFutureIsIgnored(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	shot := aimedShot(bodyPitch)
	shot.ViewTick = float64(d.w.tick) + 500
	d.step(shot, nil)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 1 {
		t.Fatalf("a bogus view tick should fall back to the present and still hit a stationary target")
	}
}

// --- Spawns ----------------------------------------------------------------

func TestSpawnPrefersPlacesEnemiesCannotSee(t *testing.T) {
	lv := FlatLevel()
	// A wall hides spawn B from the enemy standing at the origin; spawn A is in the open and farther.
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -5.5, MaxX: 0.5, MinY: 0, MaxY: 4, MinZ: 9.5, MaxZ: 10.5})
	lv.Spawns = []Vec3{{X: 30, Z: 0}, {X: -5, Z: 20}}
	w := NewWorld(lv)
	enemy := NewPlayer(1)
	enemy.SetInitialState(SpawnState(0, 0, 0))
	w.Join(context.Background(), enemy)
	w.Step()

	newcomer := NewPlayer(2)
	w.Join(context.Background(), newcomer)
	w.Step()
	if newcomer.State.X != -5 || newcomer.State.Z != 20 {
		t.Fatalf("spawned at (%v, %v); wanted the hidden spawn (-5, 20) even though the open one is farther", newcomer.State.X, newcomer.State.Z)
	}
}

func TestSpawnPicksFarthestWhenNothingIsHidden(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 10, Z: 0}, {X: 60, Z: 0}, {X: 30, Z: 0}}
	w := NewWorld(lv)
	enemy := NewPlayer(1)
	enemy.SetInitialState(SpawnState(0, 0, 0))
	w.Join(context.Background(), enemy)
	w.Step()
	newcomer := NewPlayer(2)
	w.Join(context.Background(), newcomer)
	w.Step()
	if newcomer.State.X != 60 {
		t.Fatalf("spawned at x = %v, want the farthest (60)", newcomer.State.X)
	}
}

func TestDeadEnemiesDoNotInfluenceSpawns(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 5, Z: 0}, {X: 50, Z: 0}}
	w := NewWorld(lv)
	corpse := NewPlayer(1)
	corpse.SetInitialState(SpawnState(0, 0, 0))
	w.Join(context.Background(), corpse)
	w.Step()
	corpse.Health.Alive = false
	a := NewPlayer(2)
	w.Join(context.Background(), a)
	w.Step()
	if a.State.X != 5 { // with nobody alive to avoid, it rotates from the first spawn
		t.Fatalf("spawned at x = %v, want the first spawn (5)", a.State.X)
	}
}

// --- Snapshots -------------------------------------------------------------

func TestSnapshotsCarryHealthWeaponAndEventsOnce(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(aimedShot(bodyPitch), nil)
	for len(d.a.Out) > 0 {
		d.a.Free <- <-d.a.Out
	}
	// Collect the next snapshots (no draining) and look at what the shooter is told.
	var seen []protocol.Snapshot
	for i := 0; i < 8; i++ {
		d.w.Step()
		for len(d.a.Out) > 0 {
			s := <-d.a.Out
			cp := *s
			cp.Events = append([]protocol.GameEvent(nil), s.Events...)
			seen = append(seen, cp)
			d.a.Free <- s
		}
	}
	if len(seen) < 3 {
		t.Fatalf("only %d snapshots", len(seen))
	}
	withHit := 0
	for _, s := range seen {
		if s.Health.Health != WeaponMaxHealth || s.Weapon.Ammo >= WeaponMagSize {
			t.Fatalf("snapshot health/weapon not filled: %+v %+v", s.Health, s.Weapon)
		}
		for _, e := range s.Events {
			if e.Kind == protocol.EventKindHit {
				withHit++
				if e.Seq != 1 {
					t.Fatalf("event seq = %d, want 1 (same event resent)", e.Seq)
				}
			}
		}
	}
	if withHit < 2 || withHit > 4 {
		t.Fatalf("the hit event was resent in %d snapshots, want a few (redundancy %d ticks)", withHit, CombatEventRedundancyTicks)
	}
}

// --- Allocation ------------------------------------------------------------

// HARD RULE: Step must not allocate, including through shots, deaths and respawns.
func TestCombatStepDoesNotAllocate(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 8}, {X: -8}, {Z: 8}, {Z: -8}}
	w := NewWorld(lv)
	const n = 4
	players := make([]*Player, n)
	for i := range players {
		p := NewPlayer(uint32(i + 1))
		players[i] = p
		w.Join(context.Background(), p)
	}
	w.Step()
	yawToCenter := func(p *Player) float64 { return math.Atan2(p.State.X, p.State.Z) }
	tick := uint32(0)
	run := func() {
		tick++
		for _, p := range players {
			w.SubmitInput(p.ID, Input{Seq: tick, Yaw: yawToCenter(p), Fire: true, ADS: true, ViewTick: float64(w.tick) - 3})
		}
		w.Step()
		for _, p := range players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
	}
	for i := 0; i < 60; i++ {
		run()
	}
	deathsBefore := uint16(0)
	for _, p := range players {
		deathsBefore += p.Deaths
	}
	if allocs := testing.AllocsPerRun(900, run); allocs != 0 {
		t.Fatalf("combat Step allocated %v times per tick, want 0", allocs)
	}
	deaths := uint16(0)
	for _, p := range players {
		deaths += p.Deaths
	}
	if deaths <= deathsBefore {
		t.Fatalf("the test never saw a kill, so it did not cover the death and respawn paths")
	}
}
