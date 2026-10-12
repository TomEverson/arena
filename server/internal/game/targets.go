package game

// The practice range's targets: dummies that stand still or strafe, can be shot
// and killed, and come back after a moment. They live in the world like players
// (history for lag compensation, entries in snapshots) but never shoot back.
// Runs on the world goroutine inside Step, so it must never allocate.

import (
	"math"

	"arena/server/internal/protocol"
)

// maxTargets bounds the preallocated target list.
const maxTargets = 32

// PracticeAction is a helper command available in the practice range.
type PracticeAction uint8

const (
	// PracticeRefill restores health, shield and a full magazine.
	PracticeRefill PracticeAction = iota + 1
	// PracticeStart teleports back to the course start (the first spawn point).
	PracticeStart
	// PracticeReset brings every target back at full health.
	PracticeReset
)

// Target is one dummy.
type Target struct {
	ID      uint32
	spec    TargetSpec
	x, y, z float64
	dir     float64 // +1 or -1 along the strafe axis
	// runT is how long the current pass along the wall has lasted (wall-running targets).
	runT float64
	// The knock offset: how far a melee blow has pushed the target from where its script has it
	// (and hopped it up), and how fast. A spring pulls it back.
	kx, kz, ky    float64
	kvx, kvz, kvy float64
	Health        protocol.PlayerHealth
	hist          history
	Entity        protocol.Entity
}

func newTarget(i int, spec TargetSpec) Target {
	t := Target{ID: CombatTargetIdBase + uint32(i), spec: spec}
	t.Entity = protocol.Entity{ID: t.ID, Kind: protocol.EntityKindTarget}
	t.reset()
	return t
}

// reset brings the target back at its home position with full health.
func (t *Target) reset() {
	t.x, t.y, t.z, t.dir, t.runT = t.spec.Pos.X, t.spec.Pos.Y, t.spec.Pos.Z, 1, 0
	t.kx, t.kz, t.ky, t.kvx, t.kvz, t.kvy = 0, 0, 0, 0, 0, 0
	if t.spec.WallRun {
		t.placeOnWall() // starts at one end of its run
	}
	t.Health = protocol.PlayerHealth{Health: WeaponMaxHealth, Shield: WeaponMaxShield, Alive: true}
	t.syncEntity()
}

func (t *Target) syncEntity() {
	e := &t.Entity
	e.X, e.Y, e.Z = t.x+t.kx, t.y+t.ky, t.z+t.kz
	if t.Health.Alive && t.spec.WallRun {
		e.Flags = protocol.EntityFlagWallRunning
	} else if t.Health.Alive {
		e.Flags = protocol.EntityFlagOnGround
	} else {
		e.Flags = protocol.EntityFlagDead
	}
}

func (t *Target) live(tick uint64) histEntry {
	return histEntry{tick: uint32(tick), valid: true, alive: t.Health.Alive, x: t.x + t.kx, y: t.y + t.ky, z: t.z + t.kz, height: StandHeight}
}

// SetPractice makes this world a practice range: the level's targets appear, players
// cannot hurt each other, and there is no spawn protection. Call before Run.
func (w *World) SetPractice(on bool) {
	w.practice = on
	w.targets = nil
	if !on {
		return
	}
	specs := w.level.Targets
	if len(specs) > maxTargets {
		specs = specs[:maxTargets]
	}
	w.targets = make([]Target, len(specs))
	for i, spec := range specs {
		w.targets[i] = newTarget(i, spec)
	}
}

// spawnProtection is how long a fresh life is invulnerable: not in the range.
func (w *World) spawnProtection() float64 {
	if w.practice {
		return 0
	}
	return CombatSpawnProtection
}

// stepTargets moves strafing targets and brings dead ones back.
func (w *World) stepTargets() {
	for i := range w.targets {
		t := &w.targets[i]
		if !t.Health.Alive {
			t.Health.RespawnIn -= TickDT
			if t.Health.RespawnIn <= 0 {
				t.reset()
			}
			continue
		}
		knocked := t.stepKnock()
		if t.spec.WallRun {
			t.stepWallRun()
			continue
		}
		if !t.spec.Strafe {
			if knocked {
				t.syncEntity()
			}
			continue
		}
		pos, home := &t.z, t.spec.Pos.Z
		if t.spec.AxisX {
			pos, home = &t.x, t.spec.Pos.X
		}
		*pos += t.dir * CombatTargetSpeed * TickDT
		if *pos > home+t.spec.Range {
			*pos, t.dir = home+t.spec.Range, -1
		} else if *pos < home-t.spec.Range {
			*pos, t.dir = home-t.spec.Range, 1
		}
		t.syncEntity()
	}
}

// knockSpring and knockDamping pull a knocked target back to where its script has it (slightly
// underdamped, so it settles with a little give).
const (
	knockSpring  = 25.0
	knockDamping = 7.0
)

// knock gives the target a shove: horizontal speed away from the attacker, and a hop.
func (t *Target) knock(dirX, dirZ float64) {
	t.kvx += dirX * WeaponMeleeKnockback
	t.kvz += dirZ * WeaponMeleeKnockback
	t.kvy = math.Max(t.kvy, WeaponMeleeKnockUp)
}

// stepKnock moves the knock offset one tick (spring back, hop under gravity) and reports whether
// the target is, or was just, displaced.
func (t *Target) stepKnock() bool {
	if t.kx == 0 && t.kz == 0 && t.ky == 0 && t.kvx == 0 && t.kvz == 0 && t.kvy == 0 {
		return false
	}
	t.kvx += (-knockSpring*t.kx - knockDamping*t.kvx) * TickDT
	t.kvz += (-knockSpring*t.kz - knockDamping*t.kvz) * TickDT
	t.kx += t.kvx * TickDT
	t.kz += t.kvz * TickDT
	if t.ky > 0 || t.kvy > 0 {
		t.kvy -= Gravity * TickDT
		t.ky += t.kvy * TickDT
		if t.ky <= 0 {
			t.ky, t.kvy = 0, 0
		}
	}
	if math.Abs(t.kx) < 1e-4 && math.Abs(t.kz) < 1e-4 && math.Abs(t.kvx) < 1e-3 && math.Abs(t.kvz) < 1e-3 && t.ky == 0 {
		t.kx, t.kz, t.kvx, t.kvz = 0, 0, 0, 0
	}
	return true
}

// wallRunArc is how far above its wall-run line a wall runner is `tau` seconds into a pass: the
// same rise and slow fall as the player's wall run (WallRunMaxRise up, gravity scaled by
// WallRunGravityScale), tilted so the pass ends back at the height it began.
func wallRunArc(tau float64) float64 {
	f := func(t float64) float64 { return WallRunMaxRise*t - 0.5*Gravity*WallRunGravityScale*t*t }
	return f(tau) - f(WallRunMaxTime)*tau/WallRunMaxTime
}

// placeOnWall puts a wall-running target where its pass has got to: it runs from one end of
// its range to the other in WallRunMaxTime (the longest a player can wall run), then turns.
func (t *Target) placeOnWall() {
	u := t.runT / WallRunMaxTime
	off := t.dir * t.spec.Range * (2*u - 1)
	if t.spec.AxisX {
		t.x = t.spec.Pos.X + off
	} else {
		t.z = t.spec.Pos.Z + off
	}
	t.y = t.spec.Pos.Y + wallRunArc(t.runT)
}

// stepWallRun advances a wall-running target one tick along its arc.
func (t *Target) stepWallRun() {
	t.runT += TickDT
	if t.runT >= WallRunMaxTime {
		t.runT -= WallRunMaxTime
		t.dir = -t.dir
	}
	t.placeOnWall()
	t.syncEntity()
}

func (w *World) recordTargetHistory() {
	for i := range w.targets {
		w.targets[i].hist.record(w.targets[i].live(w.tick))
	}
}

func (w *World) targetByID(id uint32) *Target {
	for i := range w.targets {
		if w.targets[i].ID == id {
			return &w.targets[i]
		}
	}
	return nil
}

// damageTarget applies a hit to a target and tells the shooter (and, on a kill, everyone).
func (w *World) damageTarget(shooter *Player, t *Target, amount float64, headshot bool, extra uint8) {
	killed := takeDamage(&t.Health, amount)
	flags := extra
	if headshot {
		flags |= protocol.GameEventFlagHeadshot
	}
	if killed {
		flags |= protocol.GameEventFlagKilled
	}
	shooter.pushEvent(w.tick, protocol.EventKindHit, shooter.ID, t.ID, amount, flags, t.Health.Health, t.Health.Shield)
	if killed {
		t.Health.Alive = false
		t.Health.RespawnIn = CombatTargetRespawn
		for _, q := range w.players {
			q.pushEvent(w.tick, protocol.EventKindKill, shooter.ID, t.ID, 0, flags&protocol.GameEventFlagHeadshot, 0, 0)
		}
	}
	t.syncEntity()
}

// takeDamage takes shield first, then health, and reports whether health ran out.
func takeDamage(h *protocol.PlayerHealth, amount float64) bool {
	fromShield := math.Min(h.Shield, amount)
	h.Shield -= fromShield
	h.Health -= math.Min(h.Health, amount-fromShield)
	return h.Health <= 0
}

// applyPractice runs a practice helper for player p.
func (w *World) applyPractice(p *Player, action PracticeAction) {
	if !w.practice {
		return
	}
	switch action {
	case PracticeRefill:
		p.Health = protocol.PlayerHealth{Health: WeaponMaxHealth, Shield: WeaponMaxShield, Alive: true}
		// Full ammo for both guns, keeping the weapon in hand.
		slot, gun := p.Weapon.Slot, p.Weapon.Gun
		p.Weapon = SpawnWeapon(p.Weapon.Rng)
		if gun == 1 {
			p.Weapon.Gun = 1
			p.Weapon.Ammo, p.Weapon.Stash = p.Weapon.Stash, p.Weapon.Ammo
		}
		p.Weapon.Slot = slot
		p.sinceDamage = 1e9
		p.syncEntity()
	case PracticeStart:
		sp := w.level.Spawns[0]
		p.State = SpawnState(sp.X, sp.Y, sp.Z)
		p.syncEntity()
	case PracticeReset:
		for i := range w.targets {
			w.targets[i].reset()
		}
	}
}
