package game

// Bullets on the server: every gun's shot (the rifle's and the sniper's; the spears are in
// skills.go). A shot spawns a Bullet (bullet.go) at the shooter's eye. The
// bullet is then flown tick by tick against everyone else, and a hit is applied the tick it lands.
//
// Lag compensation: the shooter's screen was showing the world `lag` ticks in the past when they
// fired, and that is the world their bullet flew through. So at spawn the bullet is flown `lag`
// steps at once, each against the targets as they were at that moment of the shooter's view
// (positions come from the history kept in combat.go). After that it has caught up
// with real time and flies against the live positions. Walls never move, so only targets need
// the rewind. Runs on the world goroutine inside Step, so it must never allocate.

import (
	"math"

	"arena/server/internal/protocol"
)

const (
	// maxBullets bounds the bullets in flight: at 600 rpm a bullet lives under a second, so
	// eight players need well under a hundred.
	maxBullets = 128
	// shotRingSize bounds the shots kept to resend (eight players at 600 rpm, 6 ticks of resend).
	shotRingSize = 64
)

// liveBullet is a bullet in the world.
type liveBullet struct {
	Bullet
	def       *weaponDef // the gun it came from: its damage, range and drop
	owner     uint32
	spawnTick uint64
	active    bool
}

// shotLog is a ring of the shots fired recently, numbered across the room.
type shotLog struct {
	ring [shotRingSize]protocol.Shot
	head int
	len  int
	seq  uint32
}

func (l *shotLog) push(s protocol.Shot) {
	l.seq++
	s.Seq = l.seq
	l.ring[(l.head+l.len)%shotRingSize] = s
	if l.len == shotRingSize {
		l.head = (l.head + 1) % shotRingSize
	} else {
		l.len++
	}
}

// recent appends the shots of the last few ticks to dst (resent in several snapshots so one lost
// snapshot does not lose a tracer).
func (l *shotLog) recent(dst []protocol.Shot, tick uint64) []protocol.Shot {
	for i := 0; i < l.len; i++ {
		s := l.ring[(l.head+i)%shotRingSize]
		if uint64(s.Tick)+CombatEventRedundancyTicks >= tick {
			dst = append(dst, s)
		}
	}
	return dst
}

// fillBoxes puts the hitboxes of everyone the shooter can hit, where they were at `view` (a
// fractional server tick; the current tick or later means where they are now), into w.boxes.
func (w *World) fillBoxes(shooter *Player, view float64) int {
	n := 0
	for _, q := range w.players {
		if w.practice {
			break // in the range bullets pass through other players
		}
		if q == shooter || !q.Health.Alive || n == len(w.boxes) {
			continue
		}
		box, alive := w.hitboxAt(q, view)
		if !alive {
			continue
		}
		w.boxes[n] = Hitbox{ID: q.ID, HeadMinY: box.MaxY - CombatHeadSize, Aabb: box}
		n++
	}
	for i := range w.targets {
		t := &w.targets[i]
		if !t.Health.Alive || n == len(w.boxes) {
			continue
		}
		box, alive := t.hist.boxAt(view, w.tick, t.live(w.tick))
		if !alive {
			continue
		}
		w.boxes[n] = Hitbox{ID: t.ID, HeadMinY: box.MaxY - CombatHeadSize, Aabb: box}
		n++
	}
	return w.barrierBoxes(n) // barriers stop bullets too (they do not move, so no rewind)
}

// fireBullet spawns the bullet for a shot and catches it up with real time (see the top of this file).
func (w *World) fireBullet(shooter *Player, in *Input, shot *ShotResult, d *weaponDef) {
	shooter.Health.ProtectedFor = 0 // firing ends spawn protection

	s := &shooter.State
	ox, oy, oz := s.X, s.Y+eyeHeight(s), s.Z
	dx, dy, dz := ViewDirection(in.Yaw+shot.SpreadYaw, in.Pitch+shot.SpreadPitch)
	w.shots.push(protocol.Shot{Tick: uint32(w.tick), Actor: shooter.ID, Gun: shooter.Weapon.Gun, X: ox, Y: oy, Z: oz, Dx: dx, Dy: dy, Dz: dz})

	b := SpawnBullet(ox, oy, oz, dx, dy, dz, d.bulletSpeed)
	view := w.rewindView(in.ViewTick)
	catchUp := int(math.Floor(float64(w.tick) - view))
	for k := 1; k <= catchUp; k++ {
		n := w.fillBoxes(shooter, view+float64(k))
		hit := StepBullet(&b, TickDT, &w.level.Collision, w.boxes[:n], d.rng, d.bulletGravity)
		if hit.Kind == RayTarget {
			w.bulletHit(shooter, hit, d)
		}
		if b.Done {
			return
		}
	}
	for i := range w.bullets {
		if !w.bullets[i].active {
			w.bullets[i] = liveBullet{Bullet: b, def: d, owner: shooter.ID, spawnTick: w.tick, active: true}
			return
		}
	}
	// No free slot: the bullet is dropped (cannot happen within the limits above).
}

// stepBullets flies every bullet one tick against the live positions of everyone but its owner.
func (w *World) stepBullets() {
	for i := range w.bullets {
		lb := &w.bullets[i]
		if !lb.active || lb.spawnTick == w.tick {
			continue // a bullet fired this tick has already been flown up to now
		}
		owner := w.byID(lb.owner)
		n := w.fillBoxes(owner, float64(w.tick))
		hit := StepBullet(&lb.Bullet, TickDT, &w.level.Collision, w.boxes[:n], lb.def.rng, lb.def.bulletGravity)
		if hit.Kind == RayTarget && owner != nil {
			w.bulletHit(owner, hit, lb.def)
		}
		if lb.Done {
			lb.active = false
		}
	}
}

// bulletHit applies a bullet of gun d that struck something. A player it hurts is also slowed
// for a moment (SlowT, see movement.go), so being hit costs speed. (Server-side only: the
// victim's client picks it up from the next snapshot, like a knock.)
func (w *World) bulletHit(shooter *Player, hit RayHit, d *weaponDef) {
	id := uint32(hit.TargetID)
	if !w.dealDamage(shooter, id, d.damageOf(hit.Headshot), hit.Headshot, 0) || id >= CombatTargetIdBase {
		return
	}
	if victim := w.byID(id); victim != nil && victim.Health.Alive {
		victim.State.SlowT = HitSlowTime
	}
}

// dealDamage hurts the player or practice target with this id (extra adds event flags, e.g. melee).
func (w *World) dealDamage(shooter *Player, id uint32, amount float64, headshot bool, extra uint8) bool {
	if id >= SkillBarrierIdBase {
		if b := w.barrierByID(id); b != nil && w.canDamage() {
			w.damageBarrier(shooter, b, amount, extra)
			return true
		}
		return false
	}
	if id >= CombatTargetIdBase {
		if t := w.targetByID(id); t != nil && w.canDamage() {
			w.damageTarget(shooter, t, amount, headshot, extra)
			return true
		}
		return false
	}
	victim := w.byID(id)
	if victim == nil || !victim.Health.Alive || victim.Health.ProtectedFor > 0 || !w.canDamage() {
		return false // protected players soak up the bullet; before the match it is only a warm-up
	}
	w.damage(shooter, victim, amount, headshot, extra)
	return true
}

// resolveMelee is a melee blow landing: the nearest target in reach and in front, as the
// shooter's screen showed them (rewound like a bullet), takes WeaponMeleeDamage.
func (w *World) resolveMelee(shooter *Player, in *Input) {
	shooter.Health.ProtectedFor = 0 // swinging ends spawn protection
	s := &shooter.State
	ex, ey, ez := s.X, s.Y+eyeHeight(s), s.Z
	dx, dy, dz := ViewDirection(in.Yaw, in.Pitch)
	n := w.fillBoxes(shooter, w.rewindView(in.ViewTick))
	id, _ := FindMeleeTarget(&w.level.Collision, w.boxes[:n], ex, ey, ez, dx, dy, dz)
	// The Assassin with the blades out cuts; everyone else punches (or swings the gun).
	amount := float64(WeaponMeleeDamage)
	if shooter.Health.Hero == protocol.HeroKindAssassin && shooter.Weapon.Slot == emptyHands {
		amount = SkillBladeDamage
	}
	if id >= 0 && w.dealDamage(shooter, uint32(id), amount, false, protocol.GameEventFlagMelee) {
		if uint32(id) >= CombatTargetIdBase {
			if t := w.targetByID(uint32(id)); t != nil && !t.spec.WallRun && t.Health.Alive {
				ax, az := t.x+t.kx-s.X, t.z+t.kz-s.Z
				if l := math.Hypot(ax, az); l > 1e-6 {
					t.knock(ax/l, az/l)
				} else {
					t.knock(dx, dz)
				}
			}
		} else if victim := w.byID(uint32(id)); victim != nil {
			w.knockBack(shooter, victim, dx, dz)
		}
	}
}

// knockBack shoves a player a melee blow has hit: away from the attacker, and a little up so
// they leave the ground. (Server-side only: the victim's client picks it up from the next
// snapshot, like any other correction.) A player mid-mantle or dead is left alone.
func (w *World) knockBack(attacker, victim *Player, faceX, faceZ float64) {
	s := &victim.State
	if !victim.Health.Alive || s.Mantling {
		return
	}
	dx, dz := s.X-attacker.State.X, s.Z-attacker.State.Z
	l := math.Hypot(dx, dz)
	if l < 1e-6 { // standing on top of each other: push along where the attacker faces
		dx, dz = faceX, faceZ
		l = math.Hypot(dx, dz)
		if l < 1e-6 {
			return
		}
	}
	s.VX += dx / l * WeaponMeleeKnockback
	s.VZ += dz / l * WeaponMeleeKnockback
	s.VY = math.Max(s.VY, WeaponMeleeKnockUp)
	s.OnGround = false
	s.Sliding = false
}
