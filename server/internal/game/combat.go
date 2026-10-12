package game

// Server-side combat: shot resolution with lag compensation, damage, death,
// respawn, spawn-point choice and the events players see. Runs on the world
// goroutine inside Step, so it must never allocate.

import (
	"math"

	"arena/server/internal/protocol"
)

// histEntry is one player's position at one server tick, kept for lag compensation.
type histEntry struct {
	tick   uint32
	valid  bool
	alive  bool
	x, y   float64
	z      float64
	height float64
}

const eventRingSize = 16

func eyeHeight(s *PlayerState) float64 {
	if s.Sliding {
		return SlideEye
	}
	if s.Crouching {
		return CrouchEye
	}
	return StandEye
}

// --- Life cycle ------------------------------------------------------------

// resetLife gives p a fresh life at the spawn point: full health, full magazine, spawn protection.
func (w *World) resetLife(p *Player) {
	w.spawn(p)
	p.Health = protocol.PlayerHealth{
		Health:       WeaponMaxHealth,
		Shield:       WeaponMaxShield,
		Alive:        true,
		ProtectedFor: CombatSpawnProtection,
	}
	p.Weapon = SpawnWeapon(p.Weapon.Rng)
	p.sinceDamage = 1e9
}

// updateLife runs the per-tick timers: respawn countdown, spawn protection, shield recharge.
func (w *World) updateLife(p *Player) {
	h := &p.Health
	if !h.Alive {
		h.RespawnIn -= TickDT
		if h.RespawnIn <= 0 {
			w.resetLife(p)
		}
		return
	}
	if h.ProtectedFor > 0 {
		h.ProtectedFor = math.Max(0, h.ProtectedFor-TickDT)
	}
	p.sinceDamage += TickDT
	if p.sinceDamage > CombatShieldRechargeDelay && h.Shield < WeaponMaxShield {
		h.Shield = math.Min(WeaponMaxShield, h.Shield+CombatShieldRechargeRate*TickDT)
	}
}

// --- Spawn points ----------------------------------------------------------

// chooseSpawn picks the spawn point farthest from living enemies, strongly
// preferring ones no enemy can see. With nobody else around it rotates through the spawns.
func (w *World) chooseSpawn(p *Player) Vec3 {
	spawns := w.level.Spawns
	best, bestScore := 0, math.Inf(-1)
	anyEnemy := false
	for i, sp := range spawns {
		minDist := math.Inf(1)
		seen := false
		for _, q := range w.players {
			if q == p || !q.Health.Alive {
				continue
			}
			anyEnemy = true
			dx, dy, dz := sp.X-q.State.X, sp.Y-q.State.Y, sp.Z-q.State.Z
			d := math.Sqrt(dx*dx + dy*dy + dz*dz)
			minDist = math.Min(minDist, d)
			if !seen && w.canSee(q, sp, d) {
				seen = true
			}
		}
		score := minDist
		if seen {
			score -= 1000
		}
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	if !anyEnemy {
		best = w.nextSpawn % len(spawns)
		w.nextSpawn++
	}
	return spawns[best]
}

// canSee reports whether q has a clear line from its eyes to a standing player at sp.
func (w *World) canSee(q *Player, sp Vec3, dist float64) bool {
	if dist < 1e-6 {
		return true
	}
	ox, oy, oz := q.State.X, q.State.Y+eyeHeight(&q.State), q.State.Z
	tx, ty, tz := sp.X, sp.Y+StandEye, sp.Z
	dx, dy, dz := tx-ox, ty-oy, tz-oz
	l := math.Sqrt(dx*dx + dy*dy + dz*dz)
	hit := CastRay(&w.level.Collision, nil, ox, oy, oz, dx/l, dy/l, dz/l, l)
	return hit.Kind != RayWorld // nothing solid in between
}

// --- Lag compensation ------------------------------------------------------

// recordHistory stores where p is at the end of this tick.
func (w *World) recordHistory(p *Player) {
	s := &p.State
	p.hist[w.tick%CombatHistoryTicks] = histEntry{
		tick: uint32(w.tick), valid: true, alive: p.Health.Alive,
		x: s.X, y: s.Y, z: s.Z, height: bodyHeight(s),
	}
}

// entryAt returns p's recorded position at a tick. The current tick is not
// recorded yet (it ends after all shots), so it comes from live state.
func (w *World) entryAt(p *Player, tick uint32) (histEntry, bool) {
	if uint64(tick) >= w.tick {
		s := &p.State
		return histEntry{tick: tick, valid: true, alive: p.Health.Alive, x: s.X, y: s.Y, z: s.Z, height: bodyHeight(s)}, true
	}
	e := p.hist[tick%CombatHistoryTicks]
	return e, e.valid && e.tick == tick
}

// hitboxAt is where p was when the shooter's screen showed them at viewTick.
// Clients only ever saw snapshots (every snapshotEvery ticks) and interpolated
// between them, so we do the same between the two bracketing snapshot ticks.
func (w *World) hitboxAt(p *Player, viewTick float64) (Aabb, bool) {
	cur := float64(w.tick)
	if viewTick >= cur {
		e, _ := w.entryAt(p, uint32(w.tick))
		return boxOf(e.x, e.y, e.z, e.height), e.alive
	}
	lo := math.Floor(viewTick/snapshotEvery) * snapshotEvery
	frac := (viewTick - lo) / snapshotEvery
	a, okA := w.entryAt(p, uint32(lo))
	b, okB := w.entryAt(p, uint32(lo)+snapshotEvery)
	if !okA || !okB {
		// Too old or the player had not joined yet: fall back to where they are now.
		e, _ := w.entryAt(p, uint32(w.tick))
		return boxOf(e.x, e.y, e.z, e.height), e.alive
	}
	return boxOf(a.x+(b.x-a.x)*frac, a.y+(b.y-a.y)*frac, a.z+(b.z-a.z)*frac, a.height), a.alive
}

func boxOf(x, y, z, height float64) Aabb {
	return Aabb{MinX: x - HalfWidth, MaxX: x + HalfWidth, MinY: y, MaxY: y + height, MinZ: z - HalfWidth, MaxZ: z + HalfWidth}
}

// rewindView clamps a client's claimed view tick to what we are willing to rewind.
func (w *World) rewindView(claimed float64) float64 {
	cur := float64(w.tick)
	if claimed <= 0 || claimed > cur {
		return cur
	}
	return math.Max(claimed, cur-CombatMaxRewindTicks)
}

// --- Shots -----------------------------------------------------------------

// resolveShot traces one bullet from shooter against everyone else, as the shooter saw them.
func (w *World) resolveShot(shooter *Player, in *Input, shot *ShotResult) {
	shooter.Health.ProtectedFor = 0 // firing ends spawn protection

	s := &shooter.State
	ox, oy, oz := s.X, s.Y+eyeHeight(s), s.Z
	dx, dy, dz := ViewDirection(in.Yaw+shot.SpreadYaw, in.Pitch+shot.SpreadPitch)

	view := w.rewindView(in.ViewTick)
	n := 0
	for _, q := range w.players {
		if q == shooter || !q.Health.Alive {
			continue
		}
		box, alive := w.hitboxAt(q, view)
		if !alive {
			continue
		}
		w.boxes[n] = Hitbox{ID: q.ID, HeadMinY: box.MaxY - CombatHeadSize, Aabb: box}
		n++
	}
	hit := CastRay(&w.level.Collision, w.boxes[:n], ox, oy, oz, dx, dy, dz, WeaponRange)
	if hit.Kind != RayTarget {
		return
	}
	victim := w.byID(uint32(hit.TargetID))
	if victim == nil || !victim.Health.Alive || victim.Health.ProtectedFor > 0 {
		return // protected players soak up the bullet without damage
	}
	w.damage(shooter, victim, Damage(hit.Headshot), hit.Headshot)
}

// damage applies a hit: shield first, then health; handles death and the kill reward.
func (w *World) damage(shooter, victim *Player, amount float64, headshot bool) {
	h := &victim.Health
	fromShield := math.Min(h.Shield, amount)
	h.Shield -= fromShield
	h.Health -= math.Min(h.Health, amount-fromShield)
	victim.sinceDamage = 0
	killed := h.Health <= 0

	var flags uint8
	if headshot {
		flags |= protocol.GameEventFlagHeadshot
	}
	if killed {
		flags |= protocol.GameEventFlagKilled
	}
	shooter.pushEvent(w.tick, protocol.EventKindHit, shooter.ID, victim.ID, amount, flags)
	victim.pushEvent(w.tick, protocol.EventKindHurt, shooter.ID, victim.ID, amount, flags)

	if !killed {
		return
	}
	h.Alive = false
	h.RespawnIn = CombatRespawnTime
	h.ProtectedFor = 0
	victim.Deaths++
	shooter.Kills++
	// A kill restores health and shield to full.
	shooter.Health.Health = WeaponMaxHealth
	shooter.Health.Shield = WeaponMaxShield
	for _, q := range w.players {
		q.pushEvent(w.tick, protocol.EventKindKill, shooter.ID, victim.ID, 0, flags&protocol.GameEventFlagHeadshot)
	}
}

func (w *World) byID(id uint32) *Player {
	for _, p := range w.players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// --- Events ----------------------------------------------------------------

// pushEvent queues an event for p. Each recipient numbers its own events so the
// client can skip ones it has already handled when they are resent.
func (p *Player) pushEvent(tick uint64, kind uint8, actor, other uint32, amount float64, flags uint8) {
	p.eventSeq++
	p.events[(p.eventHead+p.eventLen)%eventRingSize] = protocol.GameEvent{
		Seq: p.eventSeq, Tick: uint32(tick), Kind: kind, Actor: actor, Other: other, Amount: amount, Flags: flags,
	}
	if p.eventLen == eventRingSize {
		p.eventHead = (p.eventHead + 1) % eventRingSize
	} else {
		p.eventLen++
	}
}

// recentEvents appends the events of the last few ticks to dst (they are resent
// in several snapshots so one lost snapshot does not lose a kill).
func (p *Player) recentEvents(dst []protocol.GameEvent, tick uint64) []protocol.GameEvent {
	for i := 0; i < p.eventLen; i++ {
		e := p.events[(p.eventHead+i)%eventRingSize]
		if uint64(e.Tick)+CombatEventRedundancyTicks >= tick {
			dst = append(dst, e)
		}
	}
	return dst
}
