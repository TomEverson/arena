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

// settle runs ticks with no input, so bullets in flight reach their targets: a 10 m shot at
// 300 m/s lands about two ticks after it is fired.
func (d *duel) settle(ticks int) {
	for i := 0; i < ticks; i++ {
		d.step(nil, nil)
	}
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
	d.settle(4)

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
	if d.b.sinceDamage > 6*TickDT { // reset by the hit, then at most a tick or two of timer since
		t.Fatalf("damage should reset the shield recharge timer, got %v s", d.b.sinceDamage)
	}
}

func TestHeadshotDoesMoreDamage(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(aimedShot(0), nil) // level at eye height 1.6 m: the head
	d.settle(4)
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
	d.settle(4)
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 0 {
		t.Fatalf("a shot over a crouched player's head should miss, got %d hits", n)
	}
	for i := 0; i < 8; i++ { // let the weapon's cooldown pass (time only advances with the shooter's inputs)
		d.step(&Input{}, nil)
	}
	d.step(aimedShot(-0.057), nil) // about 1.05 m at 9.7 m: the middle of the 0.9-1.2 m head zone
	d.settle(4)
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
	d.settle(4)
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
	// Roughly the designed time to kill: 150 total health / 12 per shot at 10 shots/s.
	if hits := len(eventsOf(d.a, protocol.EventKindHit)); hits < 12 || hits > 14 {
		t.Fatalf("killed in %d hits, want about 13", hits)
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
	// Shooter at the origin faces -Z; the victim starts 3.5 m to the left, 10 m ahead.
	return newDuel(t, nil, Vec3{}, Vec3{X: -3.5, Z: -10})
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
	d.settle(4)
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

// --- Projectiles -----------------------------------------------------------

func TestBulletsTakeTimeToArrive(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -45}) // 45 m away: 0.15 s of flight, nine ticks
	d.step(aimedShot(-0.0), nil)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a 45 m shot cannot land on the tick it is fired")
	}
	landed := -1
	for i := 1; i <= 20 && landed < 0; i++ {
		d.step(nil, nil)
		if len(eventsOf(d.a, protocol.EventKindHit)) > 0 {
			landed = i
		}
	}
	if landed < 7 || landed > 11 {
		t.Fatalf("the bullet landed %d ticks after the shot, want about 9 (45 m at 300 m/s)", landed)
	}
}

func TestBulletsDropOverDistance(t *testing.T) {
	// Eye height 1.6 m, the head zone starts at 1.5 m. Aimed a hair high (6 cm at 40 m), the bullet
	// falls 7 cm on the way and still ends in the head zone. (Aimed level it would too, but the
	// aiming spread alone is about 10 cm, so this shot is not left to chance.)
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -40})
	d.step(aimedShot(0.0015), nil)
	d.settle(20)
	ev := eventsOf(d.a, protocol.EventKindHit)
	if len(ev) != 1 || ev[0].Flags&protocol.GameEventFlagHeadshot == 0 {
		t.Fatalf("40 m level shot = %+v, want a headshot", ev)
	}
}

func TestBulletsCanBeLedAndDodged(t *testing.T) {
	// A target sprinting across at run speed 30 m away. A shot at where it is misses, because it
	// has moved on by the time the bullet arrives.
	d := newDuel(t, nil, Vec3{}, Vec3{X: -3, Z: -30})
	d.step(aimedShot(bodyPitch*0.4), &Input{MoveX: 1})
	for i := 0; i < 20; i++ {
		d.step(nil, &Input{MoveX: 1})
	}
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 0 {
		t.Fatalf("a shot at a sprinter's current position should miss (it ran on), got %d hits", n)
	}
}

func TestShotsAreAnnouncedForTracers(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(aimedShot(bodyPitch), nil)
	got := d.w.shots.recent(nil, d.w.tick)
	if len(got) != 1 || got[0].Actor != 1 || got[0].Seq == 0 {
		t.Fatalf("shots = %+v, want one from player 1", got)
	}
	if got[0].Dz >= 0 || got[0].Y != 1.6 {
		t.Fatalf("shot origin/direction = %+v, want from the eye (1.6 m) toward -Z", got[0])
	}
	// They are resent for a few ticks, then dropped.
	d.settle(CombatEventRedundancyTicks + 2)
	if got := d.w.shots.recent(nil, d.w.tick); len(got) != 0 {
		t.Fatalf("an old shot is still being resent: %+v", got)
	}
}

func TestBulletsStopAtWalls(t *testing.T) {
	lv := FlatLevel()
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -5, MaxX: 5, MinY: 0, MaxY: 4, MinZ: -6, MaxZ: -5})
	d := newDuel(t, lv, Vec3{}, Vec3{Z: -10}) // the wall is between them
	d.step(aimedShot(bodyPitch), nil)
	d.settle(10)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a bullet went through a wall")
	}
}

func TestBulletsNeverOutliveTheirRange(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 20, Z: 20})
	d.step(aimedShot(0.3), nil) // up into the sky
	d.settle(int(WeaponRange/(WeaponBulletSpeed*TickDT)) + 10)
	for i := range d.w.bullets {
		if d.w.bullets[i].active {
			t.Fatal("a bullet is still flying long past its range")
		}
	}
}

// --- Melee -----------------------------------------------------------------

func meleeInput() *Input { return &Input{Melee: true} }

// idle runs ticks in which the shooter sends empty inputs (the weapon's clock only advances with
// the shooter's inputs, as a real client sends one every tick).
func (d *duel) idle(ticks int) {
	for i := 0; i < ticks; i++ {
		d.step(&Input{}, nil)
	}
}

func TestMeleeHitsAfterTheWindupForFixedDamage(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8}) // 1.5 m to the near face: in reach
	d.step(meleeInput(), nil)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a melee blow lands after its wind-up, not on the key press")
	}
	d.idle(int(math.Ceil(WeaponMeleeWindup*TickRate)) + 3)
	hit := eventsOf(d.a, protocol.EventKindHit)
	hurt := eventsOf(d.b, protocol.EventKindHurt)
	if len(hit) != 1 || hit[0].Amount != WeaponMeleeDamage || hit[0].Flags&protocol.GameEventFlagMelee == 0 {
		t.Fatalf("melee hit events = %+v, want one for %v damage flagged melee", hit, float64(WeaponMeleeDamage))
	}
	if hit[0].Flags&protocol.GameEventFlagHeadshot != 0 {
		t.Fatal("melee has no headshots")
	}
	if len(hurt) != 1 || hurt[0].Actor != 1 {
		t.Fatalf("victim hurt events = %+v", hurt)
	}
	if d.b.Health.Shield != WeaponMaxShield-WeaponMeleeDamage {
		t.Fatalf("victim shield %v, want %v", d.b.Health.Shield, WeaponMaxShield-WeaponMeleeDamage)
	}
}

func TestMeleeNeedsReachAndFacing(t *testing.T) {
	far := newDuel(t, nil, Vec3{}, Vec3{Z: -6})
	far.step(meleeInput(), nil)
	far.idle(12)
	if len(eventsOf(far.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a melee blow reached 6 m")
	}
	behind := newDuel(t, nil, Vec3{}, Vec3{Z: 1.5}) // right behind the shooter, who faces -Z
	behind.step(meleeInput(), nil)
	behind.idle(12)
	if len(eventsOf(behind.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a melee blow hit someone behind the swinger")
	}
}

func TestMeleeIsBlockedByWalls(t *testing.T) {
	lv := FlatLevel()
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -3, MaxX: 3, MinY: 0, MaxY: 4, MinZ: -1.2, MaxZ: -1.0})
	d := newDuel(t, lv, Vec3{}, Vec3{Z: -1.8})
	d.step(meleeInput(), nil)
	d.idle(12)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a melee blow went through a wall")
	}
}

func TestMeleeHasACooldownAndLocksFiring(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8})
	d.step(meleeInput(), nil)
	// Fire is held while swinging: no bullet may leave.
	for i := 0; i < int(math.Ceil(WeaponMeleeLock*TickRate))-3; i++ {
		d.step(aimedShot(bodyPitch), nil)
	}
	if got := d.w.shots.recent(nil, d.w.tick); len(got) != 0 {
		t.Fatalf("fired %d shots while swinging", len(got))
	}
	// A second press too soon does nothing; after the cooldown it lands again.
	d.step(meleeInput(), nil)
	d.idle(int(math.Ceil(WeaponMeleeCooldown*TickRate)) + 4)
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 1 {
		t.Fatalf("hits so far %d, want exactly the first swing", n)
	}
	d.step(meleeInput(), nil)
	d.idle(12)
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 2 {
		t.Fatalf("hits after the cooldown %d, want 2", n)
	}
}

func TestMeleeingIsShownToOthers(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8})
	d.step(meleeInput(), nil)
	if d.a.Entity.Flags&protocol.EntityFlagMeleeing == 0 {
		t.Fatal("the swinging player's entity should be flagged meleeing")
	}
	d.idle(int(math.Ceil(WeaponMeleeCooldown*TickRate)) + 2)
	if d.a.Entity.Flags&protocol.EntityFlagMeleeing != 0 {
		t.Fatal("the flag should clear when the swing is over")
	}
}

// idleBoth runs ticks in which both players send empty inputs (players are only simulated when
// they send input, as a real client does every tick).
func (d *duel) idleBoth(ticks int) {
	for i := 0; i < ticks; i++ {
		d.step(&Input{}, &Input{})
	}
}

func TestMeleeKnocksTheVictimBack(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8})
	start := d.b.State.Z
	d.step(meleeInput(), nil)
	d.idleBoth(int(math.Ceil(WeaponMeleeWindup*TickRate)) + 1)
	if d.b.State.VZ >= -1 && d.b.State.Z >= start-0.01 {
		t.Fatalf("the victim was not pushed away: z %v (from %v), vz %v", d.b.State.Z, start, d.b.State.VZ)
	}
	d.idleBoth(20)
	if d.b.State.Z > start-0.8 {
		t.Fatalf("the victim moved only %.2f m away, want a real shove", start-d.b.State.Z)
	}
	if math.Abs(d.b.State.X) > 0.3 {
		t.Fatalf("pushed sideways (x = %v): the shove should be straight away from the attacker", d.b.State.X)
	}
	if d.a.State.Z != 0 {
		t.Fatal("the attacker should not move")
	}
}

func TestNoKnockbackWithoutADamagingHit(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -6}) // out of reach
	d.step(meleeInput(), nil)
	d.idleBoth(15)
	if d.b.State.VZ != 0 || d.b.State.Z != -6 {
		t.Fatalf("a missed swing moved the target: z %v vz %v", d.b.State.Z, d.b.State.VZ)
	}
	// A protected player takes no damage and is not shoved.
	p := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8})
	p.b.Health.ProtectedFor = 2
	p.step(meleeInput(), nil)
	p.idleBoth(15)
	if p.b.State.VZ != 0 || p.b.State.Z != -1.8 {
		t.Fatalf("a protected player was shoved: z %v", p.b.State.Z)
	}
}

// --- Weapon slots and the sniper -------------------------------------------

func slotInput(slot uint8) *Input { return &Input{Slot: slot} }

// drawn runs ticks of empty input from the shooter until a switch's draw time is over.
func (d *duel) drawn() { d.idle(int(math.Ceil(WeaponSwitchTime*TickRate)) + 2) }

func sniperShot(pitch float64) *Input { return &Input{Fire: true, ADS: true, Pitch: pitch} }

func TestSniperHitsInstantlyForMoreDamage(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -60}) // 60 m: a rifle bullet would take 12 ticks
	d.step(slotInput(2), nil)
	d.drawn()
	d.step(sniperShot(0), nil) // level at eye height: the head, no drop
	hit := eventsOf(d.a, protocol.EventKindHit)
	if len(hit) != 1 {
		t.Fatalf("a hitscan shot should land on the tick it is fired, got %d hits", len(hit))
	}
	if hit[0].Amount != SniperDamage*SniperHeadshotMult || hit[0].Flags&protocol.GameEventFlagHeadshot == 0 {
		t.Fatalf("sniper headshot = %+v, want %v damage and the headshot flag", hit[0], float64(SniperDamage*SniperHeadshotMult))
	}
	if d.b.Health.Alive {
		t.Fatal("a sniper headshot (150) on a full health and shield (150) player should kill")
	}
}

func TestSniperBodyShotAndTheBoltCycle(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -30})
	d.step(slotInput(2), nil)
	d.drawn()
	d.step(sniperShot(bodyPitch*0.3), nil)
	d.step(sniperShot(bodyPitch*0.3), nil) // held fire: the bolt is cycling, no second shot
	hits := eventsOf(d.a, protocol.EventKindHit)
	if len(hits) != 1 || hits[0].Amount != SniperDamage || hits[0].Flags&protocol.GameEventFlagHeadshot != 0 {
		t.Fatalf("sniper body shot hits = %+v, want one for %v", hits, float64(SniperDamage))
	}
	d.idle(int(math.Ceil(60/SniperRpm*TickRate)) - 2)
	d.step(sniperShot(bodyPitch*0.3), nil)
	if n := len(eventsOf(d.a, protocol.EventKindHit)); n != 2 {
		t.Fatalf("hits after the bolt cycle = %d, want 2", n)
	}
}

func TestSwitchingNeedsADrawAndKeepsEachGunsRounds(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	for i := 0; i < 5; i++ {
		d.step(aimedShot(bodyPitch), nil)
	}
	rifleLeft := d.a.Weapon.Ammo
	if rifleLeft >= WeaponMagSize {
		t.Fatal("the rifle should have fired")
	}
	d.step(slotInput(2), nil)
	if d.a.Weapon.Slot != 1 || d.a.Weapon.Ammo != SniperMagSize || d.a.Weapon.Stash != rifleLeft {
		t.Fatalf("after switching: slot %d ammo %d stash %d, want sniper with %d and the rifle's %d kept", d.a.Weapon.Slot, d.a.Weapon.Ammo, d.a.Weapon.Stash, SniperMagSize, rifleLeft)
	}
	before := len(d.w.shots.recent(nil, d.w.tick))
	d.step(sniperShot(0), nil) // still drawing
	if len(d.w.shots.recent(nil, d.w.tick)) != before {
		t.Fatal("a gun fired during its draw")
	}
	d.drawn()
	d.step(slotInput(1), nil)
	if d.a.Weapon.Slot != 0 || d.a.Weapon.Ammo != rifleLeft {
		t.Fatalf("back to the rifle: slot %d ammo %d, want its %d rounds back", d.a.Weapon.Slot, d.a.Weapon.Ammo, rifleLeft)
	}
}

func TestEmptyHandsCannotShootButCanPunch(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.8})
	d.step(slotInput(3), nil)
	d.idle(int(math.Ceil(WeaponSwitchQuickTime*TickRate)) + 2) // the quick draw out of empty hands is 0.2 s
	if d.a.Weapon.Slot != emptyHands || d.a.Entity.Flags&protocol.EntityFlagEmptyHanded == 0 {
		t.Fatalf("slot %d flags %b, want empty hands flagged", d.a.Weapon.Slot, d.a.Entity.Flags)
	}
	for i := 0; i < 10; i++ {
		d.step(aimedShot(bodyPitch), nil)
	}
	if got := d.w.shots.recent(nil, d.w.tick); len(got) != 0 {
		t.Fatal("empty hands fired a gun")
	}
	d.step(meleeInput(), nil)
	d.idleBoth(12)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 1 {
		t.Fatal("empty hands should still be able to punch")
	}
}

func TestWeaponInHandIsShownToOthers(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	if d.a.Entity.Flags&(protocol.EntityFlagHoldingSniper|protocol.EntityFlagEmptyHanded) != 0 {
		t.Fatal("the rifle is the default: no weapon flag")
	}
	d.step(slotInput(2), nil)
	if d.a.Entity.Flags&protocol.EntityFlagHoldingSniper == 0 {
		t.Fatal("holding the sniper should be flagged")
	}
}

func TestSniperLagCompensation(t *testing.T) {
	// A target at 30 m sprints sideways. The sniper's hit is judged where the shooter's screen
	// showed it, like any hitscan: aiming at where it was seen hits it.
	d := newDuel(t, nil, Vec3{}, Vec3{X: -4, Z: -30})
	d.step(slotInput(2), &Input{MoveX: 1})
	for i := 0; i < int(math.Ceil(WeaponSwitchTime*TickRate))+2; i++ {
		d.step(&Input{}, &Input{MoveX: 1})
	}
	// Where the shooter saw the target 5 ticks ago:
	view := float64(d.w.tick) - 5
	box, _ := d.w.hitboxAt(d.b, view)
	cx := (box.MinX + box.MaxX) / 2
	yaw := math.Atan2(-cx, 30)
	shot := sniperShot(0)
	shot.Yaw = yaw
	shot.ViewTick = view
	d.step(shot, &Input{MoveX: 1})
	if len(eventsOf(d.a, protocol.EventKindHit)) != 1 {
		t.Fatal("a sniper shot aimed at where the screen showed the target should hit it")
	}
}

// --- Weapon-dependent movement -----------------------------------------------

// runSpeedAfter runs player a forward for a second and returns its speed.
func (d *duel) runSpeedAfter(in Input) float64 {
	for i := 0; i < 60; i++ {
		x := in
		x.MoveZ = 1
		d.step(&x, nil)
	}
	return hSpeed(&d.a.State)
}

func TestEmptyHandsRunFasterAndSniperAimingIsSlow(t *testing.T) {
	// The rifle: run speed, and 0.65 of it while aiming.
	rifle := newDuel(t, nil, Vec3{Z: 30}, Vec3{X: 30, Z: 30})
	if got := rifle.runSpeedAfter(Input{}); math.Abs(got-RunSpeed) > 1e-6 {
		t.Fatalf("rifle run speed = %v, want %v", got, float64(RunSpeed))
	}
	rifleADS := newDuel(t, nil, Vec3{Z: 30}, Vec3{X: 30, Z: 30})
	if got := rifleADS.runSpeedAfter(Input{ADS: true}); math.Abs(got-RunSpeed*WeaponAdsSpeedMult) > 1e-6 {
		t.Fatalf("rifle ads speed = %v, want %v", got, RunSpeed*WeaponAdsSpeedMult)
	}
	// The sniper: much slower while aiming.
	sniper := newDuel(t, nil, Vec3{Z: 30}, Vec3{X: 30, Z: 30})
	sniper.step(slotInput(2), nil)
	sniper.drawn()
	if got := sniper.runSpeedAfter(Input{ADS: true}); math.Abs(got-RunSpeed*SniperAdsSpeedMult) > 1e-6 {
		t.Fatalf("sniper ads speed = %v, want %v", got, RunSpeed*SniperAdsSpeedMult)
	}
	// Empty hands: faster than the run speed.
	empty := newDuel(t, nil, Vec3{Z: 30}, Vec3{X: 30, Z: 30})
	empty.step(slotInput(3), nil)
	empty.idle(int(math.Ceil(WeaponSwitchQuickTime*TickRate)) + 2)
	if got := empty.runSpeedAfter(Input{}); math.Abs(got-RunSpeed*WeaponEmptyRunMult) > 1e-6 {
		t.Fatalf("empty-handed run speed = %v, want %v", got, RunSpeed*WeaponEmptyRunMult)
	}
}

func TestClientsCannotChooseTheirOwnSpeed(t *testing.T) {
	d := newDuel(t, nil, Vec3{Z: 30}, Vec3{X: 30, Z: 30})
	// A tampered client claims a huge run multiplier: the server uses the weapon's own.
	if got := d.runSpeedAfter(Input{RunSpeedMult: 5, ADSSpeedMult: 5}); math.Abs(got-RunSpeed) > 1e-6 {
		t.Fatalf("run speed with a forged multiplier = %v, want the real %v", got, float64(RunSpeed))
	}
}
