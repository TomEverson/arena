package game

import (
	"context"
	"math"
	"testing"

	"arena/server/internal/protocol"
)

// placeGrenade puts a live grenade owned by p at a point, about to go off.
func placeGrenade(w *World, p *Player, x, y, z float64) {
	g := &w.skills.grenades[0]
	*g = grenade{active: true, owner: p.ID, fuse: TickDT / 2}
	g.Entity = Entity{ID: SkillGrenadeIdBase + 1, Kind: protocol.EntityKindGrenade, X: x, Y: y, Z: z}
}

func skillEntitiesOf(w *World, kind uint8) []Entity {
	var out []Entity
	for _, e := range w.skillEntities(nil) {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

func TestGrenadeFliesBouncesAndGoesOffOnItsFuse(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 50}) // the victim is far out of the way
	d.step(&Input{SkillQ: true, Pitch: -0.3}, nil)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindGrenade)); n != 1 {
		t.Fatalf("grenades in flight = %d, want 1", n)
	}
	if d.a.Weapon.SkillQT <= SkillGrenadeCooldown-1 {
		t.Fatalf("the grenade should be on cooldown, got %v s", d.a.Weapon.SkillQT)
	}
	bounced := false
	lastVY := 0.0
	ticks := 0
	for len(skillEntitiesOf(d.w, protocol.EntityKindGrenade)) == 1 {
		g := &d.w.skills.grenades[0]
		if g.Y < grenadeSize-1e-9 {
			t.Fatalf("the grenade sank into the floor: y = %v", g.Y)
		}
		if lastVY < 0 && g.vy > 0 {
			bounced = true
		}
		lastVY = g.vy
		d.step(nil, nil)
		if ticks++; ticks > 5*TickRate {
			t.Fatal("the grenade never went off")
		}
	}
	if !bounced {
		t.Fatal("the grenade never bounced")
	}
	if want := int(SkillGrenadeFuse * TickRate); ticks < want-2 || ticks > want+2 {
		t.Fatalf("went off after %d ticks, want about %d", ticks, want)
	}
	if z := d.w.skills.grenades[0].Z; z > -5 {
		t.Fatalf("thrown down -Z it should have travelled, ended at z = %v", z)
	}
}

func TestGrenadeHasACooldown(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 50})
	d.step(&Input{SkillQ: true}, nil)
	d.step(&Input{SkillQ: true}, nil)
	d.step(&Input{SkillQ: true}, nil)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindGrenade)); n != 1 {
		t.Fatalf("grenades thrown = %d, want 1 (the others were on cooldown)", n)
	}
}

func TestBlastDamageFallsOffWithDistance(t *testing.T) {
	hurtAt := func(dist float64) float64 {
		d := newDuel(t, nil, Vec3{X: 60}, Vec3{})
		placeGrenade(d.w, d.a, HalfWidth+dist, 1, 0) // `dist` from the side of the victim's body
		d.step(nil, nil)
		return WeaponMaxHealth + WeaponMaxShield - d.b.Health.Health - d.b.Health.Shield
	}
	if got := hurtAt(0); math.Abs(got-SkillGrenadeDamage) > 1e-6 {
		t.Fatalf("touching the body: %v damage, want the full %v", got, float64(SkillGrenadeDamage))
	}
	if got, want := hurtAt(SkillGrenadeRadius/2.0), SkillGrenadeDamage/2.0; math.Abs(got-want) > 1e-6 {
		t.Fatalf("half way out: %v damage, want %v", got, want)
	}
	if got := hurtAt(SkillGrenadeRadius + 0.1); got != 0 {
		t.Fatalf("outside the radius: %v damage, want 0", got)
	}
}

func TestBlastIsStoppedByWallsAndMarkedAsABlast(t *testing.T) {
	lv := FlatLevel()
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: 1, MaxX: 1.5, MinY: 0, MaxY: 4, MinZ: -5, MaxZ: 5})
	d := newDuel(t, lv, Vec3{X: 60}, Vec3{})
	placeGrenade(d.w, d.a, 2.5, 1, 0) // the wall is between the grenade and the victim
	d.step(nil, nil)
	if len(eventsOf(d.a, protocol.EventKindHit)) != 0 {
		t.Fatal("a blast went through a wall")
	}
	placeGrenade(d.w, d.a, -1.5, 1, 0) // the open side
	d.step(nil, nil)
	hit := eventsOf(d.a, protocol.EventKindHit)
	if len(hit) != 1 || hit[0].Flags&protocol.GameEventFlagBlast == 0 || hit[0].Other != 2 {
		t.Fatalf("hit events = %+v, want one blast on player 2", hit)
	}
}

func TestYourOwnGrenadeHurtsYouButIsNotAKill(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 60})
	d.a.Health.Shield, d.a.Health.Health = 0, 10
	placeGrenade(d.w, d.a, 0, 0.5, 0)
	d.step(nil, nil)
	if d.a.Health.Alive || d.a.Deaths != 1 || d.a.Kills != 0 {
		t.Fatalf("alive %v, deaths %d, kills %d: want dead, 1 death, 0 kills", d.a.Health.Alive, d.a.Deaths, d.a.Kills)
	}
	if d.a.Health.Ult > 0.01 {
		t.Fatalf("hurting yourself must not charge the ultimate, got %v", d.a.Health.Ult)
	}
}

func TestBarrierStopsBulletsFromBothSidesUntilItBreaksOrExpires(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.step(&Input{SkillE: true}, nil) // faces -Z: the barrier stands 2 m ahead, across X
	bars := skillEntitiesOf(d.w, protocol.EntityKindBarrier)
	if len(bars) != 1 || math.Abs(bars[0].Z+SkillBarrierDistance) > 1e-9 || bars[0].Yaw != 0 {
		t.Fatalf("barriers = %+v, want one at z = -2 spanning X", bars)
	}
	id := bars[0].ID
	d.step(aimedShot(bodyPitch), nil)
	d.settle(6)
	toward := &Input{Fire: true, ADS: true, Yaw: math.Pi, Pitch: bodyPitch} // the victim shoots back, facing +Z
	d.step(nil, toward)
	d.settle(6)
	if d.a.Health.Shield != WeaponMaxShield || d.b.Health.Shield != WeaponMaxShield {
		t.Fatalf("someone was shot through the barrier: shields %v and %v", d.a.Health.Shield, d.b.Health.Shield)
	}
	hit := eventsOf(d.a, protocol.EventKindHit)
	if len(hit) != 1 || hit[0].Other != id || hit[0].Health != SkillBarrierHealth-WeaponDamage {
		t.Fatalf("shooter's hit events = %+v, want one on the barrier with %v left", hit, SkillBarrierHealth-WeaponDamage)
	}
	if got := d.w.barrierByID(id).health; got != SkillBarrierHealth-2*WeaponDamage {
		t.Fatalf("barrier health = %v, want two bullets' worth gone", got)
	}

	// Enough damage breaks it.
	d.w.dealDamage(d.a, id, SkillBarrierHealth, false, 0)
	if d.w.barrierByID(id) != nil {
		t.Fatal("the barrier should have broken")
	}
	d.idle(8) // the shooter's weapon only advances on its own inputs: let the rifle come off cooldown
	d.step(aimedShot(bodyPitch), nil)
	d.settle(6)
	if d.b.Health.Shield == WeaponMaxShield {
		t.Fatal("with the barrier gone the bullet should land")
	}

	// And one left alone expires.
	d.a.Weapon.SkillET = 0
	d.step(&Input{SkillE: true}, nil)
	d.settle(int(SkillBarrierSeconds*TickRate) + 2)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindBarrier)); n != 0 {
		t.Fatalf("barriers after %v s = %d, want 0", float64(SkillBarrierSeconds), n)
	}
}

func TestBarrierTurnsToStandAcrossTheView(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 60})
	d.step(&Input{SkillE: true, Yaw: math.Pi / 2}, nil) // facing -X
	bars := skillEntitiesOf(d.w, protocol.EntityKindBarrier)
	if len(bars) != 1 || bars[0].Yaw != math.Pi/2 || math.Abs(bars[0].X+SkillBarrierDistance) > 1e-9 {
		t.Fatalf("barriers = %+v, want one at x = -2 spanning Z", bars)
	}
}

// aimAtGround is the pitch that looks at the floor `dist` metres ahead from a standing eye.
func aimAtGround(dist float64) float64 { return -math.Atan2(StandEye, dist) }

func TestUltimateChargesOverTimeAndFromDamage(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.settle(TickRate)
	if got, want := d.a.Health.Ult, 1.0/SkillUltChargeSeconds; math.Abs(got-want) > 0.002 {
		t.Fatalf("after a second the ultimate is %v, want about %v", got, want)
	}
	before := d.a.Health.Ult
	d.step(aimedShot(bodyPitch), nil)
	d.settle(4)
	gained := d.a.Health.Ult - before - 5*TickDT/SkillUltChargeSeconds
	if want := WeaponDamage / float64(SkillUltChargeDamage); math.Abs(gained-want) > 1e-6 {
		t.Fatalf("a hit charged %v, want %v", gained, want)
	}
}

func TestBombardmentNeedsAFullChargeThenShellsAtOnce(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	call := &Input{Ult: true, Pitch: aimAtGround(10)}
	d.step(call, nil)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindStrike)); n != 0 {
		t.Fatal("a bombardment was called without a full charge")
	}
	d.a.Health.Ult = 1
	d.step(call, nil)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindGrenade)); n != 1 || len(skillEntitiesOf(d.w, protocol.EntityKindStrike)) != 0 {
		t.Fatalf("ultimate marker entities = %d grenades, %d strikes; want one marker and no strike", n, len(skillEntitiesOf(d.w, protocol.EntityKindStrike)))
	}
	d.settle(int(SkillBombardFuse*TickRate) + 1)
	strikes := skillEntitiesOf(d.w, protocol.EntityKindStrike)
	if len(strikes) != 1 {
		t.Fatalf("strikes = %+v, want one after the marker fuse", strikes)
	}
	// The marker fuse has elapsed, so the charge is spent and the strike is active.
	if d.a.Health.Ult > 0.05 {
		t.Fatalf("calling it should spend the charge, got %v", d.a.Health.Ult)
	}
	full := float64(WeaponMaxHealth + WeaponMaxShield)
	// Whatever warning there is (none by default), nobody is hurt during it.
	if warn := int(SkillBombardWarning * TickRate); warn > 5 {
		d.settle(warn - 3)
		if left := d.b.Health.Health + d.b.Health.Shield; left != full {
			t.Fatalf("hurt during the warning: %v left", left)
		}
		d.settle(3)
	} else if s := skillEntitiesOf(d.w, protocol.EntityKindStrike); s[0].Flags != 1 {
		t.Fatalf("with no warning the shells fall from the first tick: %+v", s)
	}
	d.settle(TickRate) // a second of shells: about four of them
	if s := skillEntitiesOf(d.w, protocol.EntityKindStrike); len(s) != 1 || s[0].Flags != 1 {
		t.Fatalf("strikes while shelling = %+v, want the falling flag set", s)
	}
	lost := full - d.b.Health.Health - d.b.Health.Shield
	if lost < 3*SkillBombardDamage || lost > 6*SkillBombardDamage {
		t.Fatalf("a second of shells did %v damage, want about %v", lost, 4.0*SkillBombardDamage)
	}
	d.settle(int(SkillBombardSeconds*TickRate) + 5)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindStrike)); n != 0 {
		t.Fatal("the bombardment never ended")
	}
}

func TestBombardmentSparesAnyoneUnderARoofAndCannotBeCalledUnderOne(t *testing.T) {
	lv := FlatLevel()
	// A roof over the victim, 3 m up.
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -30, MaxX: 30, MinY: 3, MaxY: 3.5, MinZ: -30, MaxZ: 10})
	d := newDuel(t, lv, Vec3{}, Vec3{Z: -10})
	d.a.Health.Ult = 1
	d.step(&Input{Ult: true, Pitch: aimAtGround(10)}, nil) // the spot is under the roof
	d.settle(int(SkillBombardFuse*TickRate) + 1)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindStrike)); n != 0 || d.a.Health.Ult > 0.05 {
		t.Fatalf("marker under a roof: %d strikes, charge %v (want no strike)", n, d.a.Health.Ult)
	}
	d = newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.a.Health.Ult = 1
	d.step(&Input{Ult: true, Pitch: aimAtGround(7)}, nil) // open ground 3 m short of the victim
	d.settle(int(SkillBombardFuse*TickRate) + 1)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindStrike)); n != 1 {
		t.Fatalf("strikes = %d, want 1", n)
	}
	d.settle(int((SkillBombardWarning + SkillBombardSeconds) * TickRate))
	if left, full := d.b.Health.Health+d.b.Health.Shield, float64(WeaponMaxHealth+WeaponMaxShield); left >= full {
		t.Fatalf("the open marker did not hurt the victim: %v left", left)
	}
}

func TestSkillObjectsAreSentAsEntities(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.a.Health.Ult = 1
	d.step(&Input{SkillQ: true, SkillE: true, Ult: true, Pitch: aimAtGround(10)}, nil)
	kinds := map[uint8]int{}
	for _, e := range d.w.entitiesFor(d.b, nil) {
		kinds[e.Kind]++
	}
	want := map[uint8]int{protocol.EntityKindPlayer: 1, protocol.EntityKindGrenade: 2, protocol.EntityKindBarrier: 1}
	for k, n := range want {
		if kinds[k] != n {
			t.Fatalf("entities by kind = %v, want %v", kinds, want)
		}
	}
	d.settle(int(SkillBombardFuse*TickRate) + 1)
	if n := len(skillEntitiesOf(d.w, protocol.EntityKindStrike)); n != 1 {
		t.Fatalf("strikes after marker fuse = %d, want 1", n)
	}
}

func TestSkillsStepDoesNotAllocate(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 6}, {X: -6}, {Z: 6}, {Z: -6}}
	w := NewWorld(lv)
	players := make([]*Player, 4)
	for i := range players {
		players[i] = NewPlayer(uint32(i + 1))
		w.Join(context.Background(), players[i])
	}
	w.Step()
	tick := uint32(0)
	run := func() {
		tick++
		for _, p := range players {
			// Skills as often as they come off cooldown, with the cooldowns and the charge cut short.
			if tick%40 == 0 {
				p.Weapon.SkillQT, p.Weapon.SkillET, p.Health.Ult = 0, 0, 1
			}
			yaw := math.Atan2(p.State.X, p.State.Z)
			w.SubmitInput(p.ID, Input{Seq: tick, Yaw: yaw, Pitch: aimAtGround(6), SkillQ: true, SkillE: true, Ult: true, Fire: true})
		}
		w.Step()
		for _, p := range players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
	}
	for i := 0; i < 120; i++ {
		run()
	}
	if allocs := testing.AllocsPerRun(900, run); allocs != 0 {
		t.Fatalf("Step with skills in play allocated %v times per tick, want 0", allocs)
	}
	deaths := uint16(0)
	for _, p := range players {
		deaths += p.Deaths
	}
	if deaths == 0 {
		t.Fatal("the test never saw a skill kill anyone, so it did not cover the damage paths")
	}
}

func TestRechargePickupGivesEveryCooldownBackInThePracticeRange(t *testing.T) {
	lv := FlatLevel()
	lv.Pickups = []Vec3{{X: 3}}
	w := NewWorld(lv)
	w.SetPractice(true)
	p := NewPlayer(1)
	p.SetInitialState(SpawnState(10, 0, 0))
	w.Join(context.Background(), p)
	w.Step()
	spend := func() {
		p.Weapon.SkillQT, p.Weapon.SkillET, p.Weapon.MeleeCooldown = 9, 9, 0.5
		p.Health.Ult, p.State.DashCharges = 0.2, 0
	}
	shown := func() int {
		n := 0
		for _, e := range w.entitiesFor(p, nil) {
			if e.Kind == protocol.EntityKindPickup {
				n++
			}
		}
		return n
	}
	spend()
	w.Step()
	if p.Weapon.SkillQT == 0 || shown() != 1 {
		t.Fatalf("7 m away nothing should happen: Q %v, pickups shown %d", p.Weapon.SkillQT, shown())
	}
	p.State.X = 3.5 // walk onto it
	w.Step()
	if p.Weapon.SkillQT != 0 || p.Weapon.SkillET != 0 || p.Weapon.MeleeCooldown != 0 || p.Health.Ult != 1 || p.State.DashCharges != DashCharges {
		t.Fatalf("not recharged: weapon %+v, ult %v, dashes %v", p.Weapon, p.Health.Ult, p.State.DashCharges)
	}
	if shown() != 0 {
		t.Fatal("a taken pickup should be gone for a moment")
	}
	spend()
	w.Step()
	if p.Weapon.SkillQT == 0 {
		t.Fatal("standing on a taken pickup must not recharge again straight away")
	}
	for i := 0; i < int(SkillPickupRespawn*TickRate); i++ {
		w.Step()
	}
	if p.Weapon.SkillQT != 0 {
		t.Fatal("once it is back, standing on it recharges again")
	}

	// Outside the practice range the level's pickups do not exist.
	ffa := NewWorld(lv)
	if n := len(ffa.entitiesFor(p, nil)); n != 0 {
		t.Fatalf("an FFA room has %d pickups, want 0", n)
	}
}

func TestHeroChangeWaitsForTheNextLifeInALiveMatch(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.w.SetHero(context.Background(), 1, protocol.HeroKindAssassin)
	d.step(nil, nil)
	if d.a.Health.Hero != protocol.HeroKindTrooper || d.a.Health.NextHero != protocol.HeroKindAssassin {
		t.Fatalf("mid-life: hero %d next %d, want still the trooper with the assassin queued", d.a.Health.Hero, d.a.Health.NextHero)
	}
	d.w.resetLife(d.a)
	if d.a.Health.Hero != protocol.HeroKindAssassin || d.a.Entity.Hero != protocol.HeroKindAssassin {
		t.Fatalf("after respawn: hero %d, entity %d, want the assassin in both", d.a.Health.Hero, d.a.Entity.Hero)
	}
	// Others are told who to draw.
	for _, e := range d.w.entitiesFor(d.b, nil) {
		if e.ID == 1 && e.Hero != protocol.HeroKindAssassin {
			t.Fatalf("player 1's entity says hero %d", e.Hero)
		}
	}
	// A hero that does not exist is ignored.
	d.w.SetHero(context.Background(), 1, 9)
	d.step(nil, nil)
	if d.a.Health.NextHero != protocol.HeroKindAssassin {
		t.Fatalf("an unknown hero was accepted: next %d", d.a.Health.NextHero)
	}
}

func TestHeroChangeIsImmediateInThePracticeRange(t *testing.T) {
	w := NewWorld(FlatLevel())
	w.SetPractice(true)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	w.SetHero(context.Background(), 1, protocol.HeroKindAssassin)
	w.Step()
	if p.Health.Hero != protocol.HeroKindAssassin {
		t.Fatalf("hero %d, want the assassin at once", p.Health.Hero)
	}
}

func TestTheAssassinHasNoneOfTheTroopersSkills(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	d.a.Health.Hero = protocol.HeroKindAssassin
	// Looking at the floor: Q hooks the floor and E is the slash, not a grenade and a barrier.
	d.step(&Input{SkillQ: true, SkillE: true, Pitch: aimAtGround(10)}, nil)
	for _, e := range d.w.skillEntities(nil) {
		if e.Kind != protocol.EntityKindHook {
			t.Fatalf("an assassin made a skill object of kind %d", e.Kind)
		}
	}
	if d.a.Weapon.SkillQT != 0 || d.a.Weapon.SkillET != 0 {
		t.Fatalf("neither of the Trooper's cooldowns should start (and E, the dive, is air only): %+v", d.a.Weapon)
	}
}

// airborneAssassin is a duel whose player 1 is an Assassin hanging in the air at (0, 5, 0).
func airborneAssassin(t *testing.T, victimAt Vec3) *duel {
	d := newDuel(t, nil, Vec3{Y: 5}, victimAt)
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.a.State = SpawnState(0, 5, 0)
	return d
}

func TestGrappleIsOnlyForTheAssassinAndShowsAHookToOthers(t *testing.T) {
	lv := FlatLevel()
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -20, MaxX: 20, MinY: 0, MaxY: 20, MinZ: -30, MaxZ: -20})
	d := newDuel(t, lv, Vec3{}, Vec3{X: 30})
	press := &Input{SkillQ: true, Reel: true, Pitch: 0.4}
	d.step(press, nil)
	if d.a.State.Grappling {
		t.Fatal("a Trooper grappled")
	}
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.step(press, nil)
	if !d.a.State.Grappling || d.a.Entity.Flags&protocol.EntityFlagGrappling == 0 {
		t.Fatalf("an Assassin looking at a wall 20 m away should be grappling: %+v", d.a.State)
	}
	hooks := 0
	for _, e := range d.w.entitiesFor(d.b, nil) {
		if e.Kind == protocol.EntityKindHook && e.TeamID == 1 && math.Abs(e.Z+20) < 1e-6 {
			hooks++
		}
	}
	if hooks != 1 {
		t.Fatalf("the other player sees %d hooks on the wall, want 1", hooks)
	}
	for i := 0; i < 75; i++ {
		d.step(&Input{Pitch: 0.4, Reel: true}, nil) // the button stays held: it reels in
	}
	if d.a.State.Grappling || d.a.State.Z > -15 {
		t.Fatalf("held for over a second it should have reeled to the wall and let go: %+v", d.a.State)
	}
}

func TestAirSlashHitsEveryoneInFrontWithinReachAndLunges(t *testing.T) {
	d := airborneAssassin(t, Vec3{Y: 4, Z: -2}) // just ahead, about level
	d.step(&Input{Dash: true}, nil)
	full := float64(WeaponMaxHealth + WeaponMaxShield)
	if lost := full - d.b.Health.Health - d.b.Health.Shield; lost != SkillSlashDamage {
		t.Fatalf("the slash did %v damage, want %v", lost, float64(SkillSlashDamage))
	}
	hit := eventsOf(d.a, protocol.EventKindHit)
	if len(hit) != 1 || hit[0].Flags&protocol.GameEventFlagSlash == 0 {
		t.Fatalf("hit events = %+v, want one marked as a slash", hit)
	}
	if d.a.State.DashTime <= 0 || d.a.State.DashDirZ > -0.99 {
		t.Fatalf("the slash should start a dash straight ahead (-Z): %+v", d.a.State)
	}
	if d.a.Entity.Flags&protocol.EntityFlagSlashing == 0 {
		t.Fatal("others should be told the player is mid-slash")
	}
	if d.a.Weapon.SkillQT <= SkillSlashCooldown-1 {
		t.Fatalf("the slash should be on cooldown, got %v", d.a.Weapon.SkillQT)
	}
}

func TestSpinningSlashHitsBehindAndOnTheGroundButNotOutOfReach(t *testing.T) {
	behind := airborneAssassin(t, Vec3{Y: 4, Z: 2})
	behind.step(&Input{Dash: true}, nil)
	if behind.b.Health.Shield == WeaponMaxShield {
		t.Fatal("it is a spin: someone just behind should be hit")
	}
	far := airborneAssassin(t, Vec3{Y: 4, Z: -6})
	far.step(&Input{Dash: true}, nil)
	if far.b.Health.Shield != WeaponMaxShield {
		t.Fatal("the slash hit someone out of reach")
	}
	// It works standing on the ground too.
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -2})
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.idle(3) // standing on the ground
	d.step(&Input{Dash: true}, nil)
	if d.b.Health.Shield == WeaponMaxShield || d.a.Weapon.SkillQT == 0 {
		t.Fatalf("on the ground the slash should hit and go on cooldown: shield %v, cooldown %v", d.b.Health.Shield, d.a.Weapon.SkillQT)
	}
}

func TestAKillWithTheSlashMakesItReadyAgain(t *testing.T) {
	d := airborneAssassin(t, Vec3{Y: 4, Z: -2})
	d.b.Health.Shield, d.b.Health.Health = 0, 10
	d.step(&Input{Dash: true}, nil)
	if d.b.Health.Alive || d.a.Weapon.SkillQT != 0 {
		t.Fatalf("victim alive %v, slash cooldown %v: want a kill and the slash ready", d.b.Health.Alive, d.a.Weapon.SkillQT)
	}
}

func TestOverdriveNeedsAChargeThenChainsSlashesFreesTheGrappleAndStowsTheGun(t *testing.T) {
	d := airborneAssassin(t, Vec3{X: 40})
	d.step(&Input{Ult: true}, nil)
	if d.a.Health.Overdrive != 0 {
		t.Fatal("overdrive started without a charge")
	}
	d.a.Health.Ult = 1
	d.a.State.GrappleCharges = 0
	d.step(&Input{Ult: true}, nil)
	if d.a.Health.Overdrive < SkillOverdriveSeconds-0.1 || d.a.Health.Ult > 0.01 {
		t.Fatalf("overdrive %v, charge %v: want it running and the charge spent", d.a.Health.Overdrive, d.a.Health.Ult)
	}
	// While it runs: slashes back to back (one per spin, not one per tick), grapples always
	// full, and the trigger does nothing.
	ammo := d.a.Weapon.Ammo
	slashes := 0
	ticks := int(SkillSlashSpin*TickRate)*3 + 3 // room for three spins and a little
	for i := 0; i < ticks; i++ {
		d.a.State.GrappleCharges = 0
		before := d.a.Weapon.SkillQT
		d.step(&Input{Dash: true, Fire: true}, nil)
		if d.a.Weapon.SkillQT > before {
			slashes++
		}
		if d.a.Weapon.SkillQT > SkillSlashSpin {
			t.Fatalf("tick %d: the wait between slashes is %v, more than one spin", i, d.a.Weapon.SkillQT)
		}
		if d.a.State.GrappleCharges != SkillGrappleCharges {
			t.Fatalf("tick %d: grapple charges %v, want full", i, d.a.State.GrappleCharges)
		}
	}
	if slashes != 3 && slashes != 4 {
		t.Fatalf("holding E for three spins' worth gave %d slashes, want one per spin", slashes)
	}
	if d.a.Weapon.Ammo != ammo {
		t.Fatal("the gun fired during overdrive")
	}
	d.settle(int(SkillOverdriveSeconds*TickRate) + 2)
	if d.a.Health.Overdrive != 0 {
		t.Fatalf("overdrive should have run out, %v s left", d.a.Health.Overdrive)
	}
}

func TestTheAssassinCarriesTheSniperSpearsAndBlades(t *testing.T) {
	w := NewWorld(FlatLevel())
	w.SetPractice(true)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	if p.Weapon.Gun != 0 || int(p.Weapon.Ammo) != WeaponMagSize {
		t.Fatalf("a Trooper starts with the rifle: %+v", p.Weapon)
	}
	w.SetHero(context.Background(), 1, protocol.HeroKindAssassin)
	w.Step()
	if p.Weapon.Gun != 1 || int(p.Weapon.Ammo) != SniperMagSize || int(p.Weapon.Stash) != SpearMagSize {
		t.Fatalf("an Assassin starts with the sniper and spears in reserve: %+v", p.Weapon)
	}
	seq := uint32(0)
	press := func(in Input) {
		seq++
		in.Seq = seq
		w.SubmitInput(1, in)
		w.Step()
	}
	press(Input{Slot: 2})
	if p.Weapon.Gun != 2 || int(p.Weapon.Ammo) != SpearMagSize || p.Entity.Flags&protocol.EntityFlagHoldingSpear == 0 {
		t.Fatalf("slot 2 is the spears: %+v flags %b", p.Weapon, p.Entity.Flags)
	}
	press(Input{Slot: 3})
	if p.Weapon.Slot != emptyHands || p.Entity.Flags&protocol.EntityFlagEmptyHanded == 0 {
		t.Fatalf("slot 3 is the blades (the hands slot): %+v", p.Weapon)
	}
	press(Input{Slot: 1})
	if p.Weapon.Gun != 1 || p.Entity.Flags&protocol.EntityFlagHoldingSniper == 0 {
		t.Fatalf("slot 1 is the sniper: %+v", p.Weapon)
	}
}

// assassinWithSpears is a duel whose player 1 is an Assassin holding the spear launcher, ready to fire.
func assassinWithSpears(t *testing.T, lv *Level, victimAt Vec3) *duel {
	d := newDuel(t, lv, Vec3{}, victimAt)
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.a.Weapon = SpawnWeapon(1, protocol.HeroKindAssassin)
	d.step(&Input{Slot: 2}, nil)
	d.idle(40) // the draw
	return d
}

func spears(w *World) []Entity { return skillEntitiesOf(w, protocol.EntityKindSpear) }

func TestThunderSpearSticksInAWallThenExplodes(t *testing.T) {
	lv := FlatLevel()
	lv.Collision.Boxes = append(lv.Collision.Boxes, Aabb{MinX: -10, MaxX: 10, MinY: 0, MaxY: 10, MinZ: -31, MaxZ: -30})
	d := assassinWithSpears(t, lv, Vec3{X: 2, Z: -28}) // the victim stands by the wall, off the line of fire
	d.step(&Input{Fire: true, ADS: true}, nil)
	if n := len(spears(d.w)); n != 1 {
		t.Fatalf("spears in flight = %d, want 1", n)
	}
	if int(d.a.Weapon.Ammo) != SpearMagSize-1 {
		t.Fatalf("a spear should be spent: ammo %d", d.a.Weapon.Ammo)
	}
	stuckAt := -1
	for i := 0; i < 2*TickRate && len(spears(d.w)) == 1; i++ {
		if sp := spears(d.w)[0]; sp.Flags == 1 && stuckAt < 0 {
			stuckAt = i
			if math.Abs(sp.Z+30) > 0.1 {
				t.Fatalf("it should stick on the wall face at z = -30, got %v", sp.Z)
			}
			if d.b.Health.Shield != WeaponMaxShield {
				t.Fatal("sticking in a wall must not hurt anyone yet")
			}
		}
		d.step(&Input{}, nil)
	}
	if stuckAt < 0 || len(spears(d.w)) != 0 {
		t.Fatalf("the spear should have stuck (at tick %d) and gone off", stuckAt)
	}
	lost := float64(WeaponMaxHealth+WeaponMaxShield) - d.b.Health.Health - d.b.Health.Shield
	if lost <= 0 || lost > SkillSpearDamage {
		t.Fatalf("the blast did %v damage to someone 2.8 m away, want some (at most %v)", lost, float64(SkillSpearDamage))
	}
}

func TestThunderSpearSticksInABodyForImpactDamageThenExplodes(t *testing.T) {
	d := assassinWithSpears(t, nil, Vec3{Z: -15})
	d.step(&Input{Fire: true, ADS: true, Pitch: bodyPitch}, nil)
	d.settle(20) // well short of the fuse
	full := float64(WeaponMaxHealth + WeaponMaxShield)
	if lost := full - d.b.Health.Health - d.b.Health.Shield; lost != SpearDamage {
		t.Fatalf("on impact it did %v, want the launcher's %v", lost, float64(SpearDamage))
	}
	d.settle(int(SkillSpearFuse*TickRate) + 5)
	if lost := full - d.b.Health.Health - d.b.Health.Shield; lost <= SpearDamage+SkillSpearDamage*0.8 {
		t.Fatalf("after it went off the total is %v: the blast at the body should be near its full %v", lost, float64(SkillSpearDamage))
	}
}

func TestBladesCutHarderThanAPunch(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -1.5})
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.a.Weapon = SpawnWeapon(1, protocol.HeroKindAssassin)
	d.step(&Input{Slot: 3}, nil)
	d.idle(20) // the draw
	d.step(meleeInput(), nil)
	d.idle(10) // the wind-up
	hit := eventsOf(d.a, protocol.EventKindHit)
	if len(hit) != 1 || hit[0].Amount != SkillBladeDamage {
		t.Fatalf("hit events = %+v, want one blade cut for %v", hit, float64(SkillBladeDamage))
	}
}

func TestOverdriveHoldsTheAssassinToTheBlades(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 40})
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.a.Weapon = SpawnWeapon(1, protocol.HeroKindAssassin)
	d.a.Health.Ult = 1
	d.step(&Input{Ult: true}, nil)
	d.step(&Input{}, nil)
	if d.a.Weapon.Slot != emptyHands {
		t.Fatalf("overdrive should put the blades in hand: %+v", d.a.Weapon)
	}
	d.step(&Input{Slot: 1}, nil)
	if d.a.Weapon.Slot != emptyHands {
		t.Fatal("no switching away from the blades during overdrive")
	}
}

func TestRollingDiveCutsWhoItPassesOnceAndSlamsOnLanding(t *testing.T) {
	// In the air at 6 m, a victim on the ground 6 m ahead: dive at their feet.
	d := newDuel(t, nil, Vec3{Y: 6}, Vec3{Z: -6})
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.a.State = SpawnState(0, 6, 0)
	pitch := -math.Atan2(6+StandEye-1, 6) // down at the victim's middle
	d.step(&Input{SkillE: true, Pitch: pitch}, nil)
	if d.a.State.RollT <= 0 || d.a.Entity.Flags&protocol.EntityFlagRolling == 0 {
		t.Fatalf("E in the air should start the dive: %+v", d.a.State)
	}
	if d.a.Weapon.SkillET < SkillRollCooldown-0.1 {
		t.Fatalf("the dive should be on cooldown, got %v", d.a.Weapon.SkillET)
	}
	for i := 0; i < 40 && (d.a.State.RollT > 0 || !d.a.State.OnGround); i++ {
		d.step(&Input{Pitch: pitch}, nil)
	}
	if !d.a.State.OnGround || d.a.State.Z > -3 {
		t.Fatalf("it should have flown down and forward and landed: %+v", d.a.State)
	}
	cuts, slams := 0, 0
	for _, e := range eventsOf(d.a, protocol.EventKindHit) {
		switch {
		case e.Flags&protocol.GameEventFlagSlash != 0 && e.Amount == SkillRollDamage:
			cuts++
		case e.Flags&protocol.GameEventFlagBlast != 0:
			slams++
		}
	}
	if cuts != 1 || slams != 1 {
		t.Fatalf("the victim should be cut once on the way through and hit once by the slam: %d cuts, %d slams", cuts, slams)
	}
	// On the ground E does nothing.
	d.a.Weapon.SkillET = 0
	d.step(&Input{SkillE: true}, nil)
	if d.a.State.RollT > 0 || d.a.Weapon.SkillET != 0 {
		t.Fatal("the dive is for the air only")
	}
}

func TestTheAssassinsDashIsItsSlashAndItHasNoAirJump(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 40})
	d.a.Health.Hero = protocol.HeroKindAssassin
	d.idle(3)
	// Strafing right while pressing dash: a Trooper would dash right. The Assassin slashes and
	// dashes straight ahead, where it is looking.
	d.step(&Input{Dash: true, MoveX: 1}, nil)
	if d.a.Weapon.SkillQT == 0 {
		t.Fatal("the dash button should be the spinning slash")
	}
	if d.a.State.DashTime <= 0 || d.a.State.DashDirZ > -0.99 || math.Abs(d.a.State.DashDirX) > 0.01 {
		t.Fatalf("the slash should dash straight ahead: %+v", d.a.State)
	}
	d.step(&Input{MoveX: 1}, nil)
	if d.a.State.VZ > -DashSpeed+0.01 {
		t.Fatalf("mid-dash it should be going ahead at dash speed, got vz %v", d.a.State.VZ)
	}
	// And a second press while the slash is on cooldown is no dash at all.
	d.idle(30)
	d.step(&Input{Dash: true}, nil)
	if d.a.State.DashTime > 0 {
		t.Fatal("no dash without the slash")
	}
	d.step(&Input{Jump: true}, nil) // off the ground
	d.idle(10)
	vy := d.a.State.VY
	d.step(&Input{Jump: true}, nil) // a second press in the air
	if d.a.State.VY > vy {
		t.Fatalf("the Assassin air jumped: vy %v -> %v", vy, d.a.State.VY)
	}
}
