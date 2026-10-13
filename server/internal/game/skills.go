package game

// Hero skills on the server: the Trooper's grenade (Q), barrier (E) and bombardment (ultimate).
// See spec/brainstorm/09-heroes.md. Until there is a hero picker everyone is the Trooper.
//
// The cooldowns of Q and E live in the weapon state (weapon.go), so the client predicts them.
// Everything else is here and server-only: the grenade's flight, the barrier's health, the
// ultimate's charge and the shells. Each object is also an entity (kind grenade, barrier or
// strike), so clients learn about it through the normal snapshot and draw it.
//
// Runs on the world goroutine inside Step, so it must never allocate: fixed arrays only.

import (
	"math"

	"arena/server/internal/protocol"
)

// maxHero is the highest hero a client may ask for (protocol HeroKinds).
const maxHero = protocol.HeroKindAssassin

const (
	maxGrenades = 32
	maxBarriers = 16
	maxStrikes  = 8
	maxPickups  = 8
	maxSpears   = 16
	// maxSkillEntities is how many skill objects a snapshot may have to carry.
	maxSkillEntities = maxGrenades + maxBarriers + maxStrikes + maxPickups + maxSpears + 2*MaxPlayers // + two grapple hooks each
	// secondHook is added to a player's hook id for their second hook.
	secondHook = 500

	grenadeSize = 0.12 // half the size of the box a grenade collides as
	// slopeStep is how far up a slope a grenade moving sideways is lifted in one step; a taller face is a wall.
	slopeStep = 0.3
	// skyHeight is how far up a bombardment looks for a roof.
	skyHeight = 60.0
)

type grenade struct {
	Entity
	active     bool
	owner      uint32
	bombard    bool
	vx, vy, vz float64
	fuse       float64
}

// spear is a thunder spear: it flies fast and nearly straight, sticks in the first thing it
// hits, and explodes a moment later.
type spear struct {
	Entity
	active     bool
	owner      uint32
	vx, vy, vz float64
	flown      float64 // metres so far
	stuck      bool
	fuse       float64 // seconds until it goes off, once stuck
	// stuckIn is the player or practice target it is stuck in (0: a wall or the ground), and
	// (ox, oy, oz) is where on them, from their feet: it goes where they go until it goes off.
	stuckIn    uint32
	ox, oy, oz float64
}

type barrier struct {
	Entity
	active bool
	box    Aabb
	health float64
	until  uint64 // the tick it expires
}

type strike struct {
	Entity
	active bool
	owner  uint32
	start  uint64  // the tick it was called
	next   float64 // seconds until the next shell lands, once the warning is over
}

// pickup is a recharge pickup in the practice range: walk over it and every cooldown is
// ready again. It is gone for a moment after being taken, then comes back.
type pickup struct {
	Entity
	placed bool   // the level has a pickup in this slot
	backAt uint64 // the tick it can be taken again (0 or in the past: it is there now)
}

// skills is the state of every skill object in the world.
type skills struct {
	grenades [maxGrenades]grenade
	barriers [maxBarriers]barrier
	strikes  [maxStrikes]strike
	spears   [maxSpears]spear
	serial   uint32 // numbers the objects, so a client can tell two grenades apart
}

// nextID returns an id for a new object in the range that starts at base.
func (s *skills) nextID(base uint32) uint32 {
	s.serial++
	return base + s.serial%1000
}

// clearSkills removes every skill object (a new match).
func (w *World) clearSkills() { w.skills = skills{serial: w.skills.serial} }

// --- Grenade ---------------------------------------------------------------

// throwGrenade throws a grenade from the thrower's eye along where they look, with a little lift.
func (w *World) throwGrenade(p *Player, in *Input) {
	p.Health.ProtectedFor = 0 // a skill ends spawn protection, like firing
	for i := range w.skills.grenades {
		g := &w.skills.grenades[i]
		if g.active {
			continue
		}
		s := &p.State
		dx, dy, dz := ViewDirection(in.Yaw, in.Pitch)
		*g = grenade{
			active: true,
			owner:  p.ID,
			vx:     dx * SkillGrenadeSpeed,
			vy:     dy*SkillGrenadeSpeed + SkillGrenadeLift,
			vz:     dz * SkillGrenadeSpeed,
			fuse:   SkillGrenadeFuse,
		}
		g.Entity = Entity{
			ID: w.skills.nextID(SkillGrenadeIdBase), TeamID: p.Entity.TeamID, Kind: protocol.EntityKindGrenade,
			X: s.X, Y: s.Y + eyeHeight(s) - 0.2, Z: s.Z,
		}
		return
	}
}

// grenadeBlocked reports whether a grenade at (x, y, z) is inside something solid. For a ramp it
// also returns the height of the ramp's surface there.
func (w *World) grenadeBlocked(x, y, z float64) (hit bool, rampTop float64, onRamp bool) {
	b := Aabb{MinX: x - grenadeSize, MaxX: x + grenadeSize, MinY: y - grenadeSize, MaxY: y + grenadeSize, MinZ: z - grenadeSize, MaxZ: z + grenadeSize}
	c := &w.level.Collision
	for i := range c.Boxes {
		if overlaps(&b, &c.Boxes[i]) {
			return true, 0, false
		}
	}
	for i := range c.Ramps {
		// (A ramp is a wedge filling its box: under the box there is nothing to hit.)
		if surf, ok := rampSurface(&c.Ramps[i], &b); ok && b.MinY < surf && b.MaxY > c.Ramps[i].Box.MinY {
			return true, surf, true
		}
	}
	return false, 0, false
}

// stepGrenade flies one grenade for a tick and sets it off when its fuse runs out.
func (w *World) stepGrenade(g *grenade) {
	if w.flyGrenade(g) {
		if g.bombard {
			w.startStrikeAt(g.owner, g.X, g.Y, g.Z)
		} else {
			w.explode(g)
		}
		g.active = false
	}
}

// flyGrenade moves a grenade for one tick: gravity, then one axis at a time, bouncing off
// whatever it runs into and losing speed each time. It reports whether the fuse has run out.
func (w *World) flyGrenade(g *grenade) bool {
	g.fuse -= TickDT
	if g.fuse <= 0 {
		return true
	}
	g.vy -= SkillGrenadeGravity * TickDT
	const sub = 2
	h := TickDT / sub
	for k := 0; k < sub; k++ {
		if nx := g.X + g.vx*h; nx != g.X {
			hit, top, onRamp := w.grenadeBlocked(nx, g.Y, g.Z)
			switch {
			case !hit:
				g.X = nx
			case onRamp && top-(g.Y-grenadeSize) <= slopeStep:
				g.X, g.Y = nx, top+grenadeSize // up the slope
			default:
				if g.bombard {
					g.vx = 0
				} else {
					g.vx = -g.vx * SkillGrenadeBounce
				}
			}
		}
		if nz := g.Z + g.vz*h; nz != g.Z {
			hit, top, onRamp := w.grenadeBlocked(g.X, g.Y, nz)
			switch {
			case !hit:
				g.Z = nz
			case onRamp && top-(g.Y-grenadeSize) <= slopeStep:
				g.Z, g.Y = nz, top+grenadeSize
			default:
				if g.bombard {
					g.vz = 0
				} else {
					g.vz = -g.vz * SkillGrenadeBounce
				}
			}
		}
		ny := g.Y + g.vy*h
		if hit, top, onRamp := w.grenadeBlocked(g.X, ny, g.Z); hit {
			if onRamp && g.vy <= 0 {
				g.Y = top + grenadeSize // rest on the slope
			}
			if g.bombard {
				g.vy = 0
			} else {
				g.vy = -g.vy * SkillGrenadeBounce
				g.vx *= SkillGrenadeFriction
				g.vz *= SkillGrenadeFriction
				if math.Abs(g.vy) < 1 {
					g.vy = 0 // too slow to bounce again: it rolls to a stop
				}
			}
		} else {
			g.Y = ny
		}
	}
	return false
}

// explode sets off a grenade: its blast radius and damage.
func (w *World) explode(g *grenade) {
	w.explodeAt(g.owner, g.X, g.Y, g.Z, 0, SkillGrenadeRadius, SkillGrenadeDamage)
}

// explodeAt hurts everyone within radius of (x, y, z) who has a clear line to it, the owner
// included: full damage at the centre, falling to nothing at the edge.
func (w *World) explodeAt(ownerID uint32, x, y, z, core, radius, damage float64) {
	owner := w.byID(ownerID)
	if owner == nil {
		return // the owner left: a dud
	}
	for _, q := range w.players {
		if !q.Health.Alive || (w.practice && q != owner) {
			continue // in the range players cannot hurt each other
		}
		s := &q.State
		if dmg := w.blastDamage(x, y, z, s.X, s.Y, s.Z, bodyHeight(s), core, radius, damage); dmg > 0 {
			w.dealDamage(owner, q.ID, dmg, false, protocol.GameEventFlagBlast)
		}
	}
	for i := range w.targets {
		t := &w.targets[i]
		if !t.Health.Alive {
			continue
		}
		e := t.live(w.tick)
		if dmg := w.blastDamage(x, y, z, e.x, e.y, e.z, e.height, core, radius, damage); dmg > 0 {
			w.dealDamage(owner, t.ID, dmg, false, protocol.GameEventFlagBlast)
		}
	}
}

// blastDamage is the damage a blast at (gx, gy, gz) does to a body standing at (x, y, z): full
// within `core` metres of the body's surface (0 for a blast that is only full right at it),
// falling to nothing at the radius, and nothing through a wall.
func (w *World) blastDamage(gx, gy, gz, x, y, z, height, core, radius, damage float64) float64 {
	// Distance to the nearest point of the body, so being beside a grenade counts as close.
	cx := clamp(gx, x-HalfWidth, x+HalfWidth)
	cy := clamp(gy, y, y+height)
	cz := clamp(gz, z-HalfWidth, z+HalfWidth)
	d := math.Sqrt((cx-gx)*(cx-gx) + (cy-gy)*(cy-gy) + (cz-gz)*(cz-gz))
	if d >= radius {
		return 0
	}
	// A wall between the grenade and the middle of the body stops the blast.
	mx, my, mz := x-gx, y+height/2-gy, z-gz
	if l := math.Sqrt(mx*mx + my*my + mz*mz); l > 1e-6 {
		if hit := CastRay(&w.level.Collision, nil, gx, gy, gz, mx/l, my/l, mz/l, l); hit.Kind == RayWorld {
			return 0
		}
	}
	if d <= core {
		return damage
	}
	return damage * (1 - (d-core)/(radius-core))
}

// --- Thunder spear (the Assassin's second gun) -------------------------------

// fireSpear launches a thunder spear from the shooter's eye along where they look.
func (w *World) fireSpear(p *Player, in *Input, shot *ShotResult) {
	p.Health.ProtectedFor = 0
	for i := range w.skills.spears {
		sp := &w.skills.spears[i]
		if sp.active {
			continue
		}
		s := &p.State
		yaw, pitch := in.Yaw+shot.SpreadYaw, in.Pitch+shot.SpreadPitch
		dx, dy, dz := ViewDirection(yaw, pitch)
		*sp = spear{active: true, owner: p.ID, vx: dx * SkillSpearSpeed, vy: dy * SkillSpearSpeed, vz: dz * SkillSpearSpeed}
		sp.Entity = Entity{
			ID: w.skills.nextID(SkillSpearIdBase), TeamID: p.Entity.TeamID, Kind: protocol.EntityKindSpear,
			X: s.X, Y: s.Y + eyeHeight(s) - 0.15, Z: s.Z, Yaw: yaw, Pitch: pitch,
		}
		return
	}
}

// feetOf is where the living player or practice target with this id stands.
func (w *World) feetOf(id uint32) (x, y, z float64, ok bool) {
	if id >= CombatTargetIdBase {
		if t := w.targetByID(id); t != nil && t.Health.Alive {
			e := t.live(w.tick)
			return e.x, e.y, e.z, true
		}
		return 0, 0, 0, false
	}
	if q := w.byID(id); q != nil && q.Health.Alive {
		return q.State.X, q.State.Y, q.State.Z, true
	}
	return 0, 0, 0, false
}

// stepSpear flies a spear for a tick, or counts down its fuse once it has stuck. Flying, the
// whole stretch it covers is cast against the level and against everyone but its owner, so it
// cannot skip through a thin wall or a player. Whatever it hits, it sticks there. A body takes
// the launcher's small impact damage and carries the spear with it: the blast, which is what
// does the damage, goes off wherever they have got to.
func (w *World) stepSpear(sp *spear) {
	if sp.stuck {
		if sp.stuckIn != 0 {
			if x, y, z, ok := w.feetOf(sp.stuckIn); ok {
				sp.X, sp.Y, sp.Z = x+sp.ox, y+sp.oy, z+sp.oz
			} else {
				sp.stuckIn = 0 // they died or left: it stays where it was
			}
		}
		sp.fuse -= TickDT
		if sp.fuse <= 0 {
			w.explodeAt(sp.owner, sp.X, sp.Y, sp.Z, SkillSpearCore, SkillSpearRadius, SkillSpearDamage)
			sp.active = false
		}
		return
	}
	sp.vy -= SkillSpearGravity * TickDT
	mx, my, mz := sp.vx*TickDT, sp.vy*TickDT, sp.vz*TickDT
	l := math.Sqrt(mx*mx + my*my + mz*mz)
	owner := w.byID(sp.owner)
	n := w.fillBoxes(owner, float64(w.tick))
	hit := CastRay(&w.level.Collision, w.boxes[:n], sp.X, sp.Y, sp.Z, mx/l, my/l, mz/l, l)
	sp.X, sp.Y, sp.Z = hit.X, hit.Y, hit.Z
	sp.flown += hit.T
	sp.Pitch = math.Asin(clamp(my/l, -1, 1))
	switch {
	case hit.Kind == RayTarget:
		id := uint32(hit.TargetID)
		if owner != nil {
			w.dealDamage(owner, id, SpearDamage, false, 0)
		}
		// Stuck a hair inside the body, so they take the whole blast, and carried along with it.
		// (A barrier is a wall: nothing to follow.)
		if x, y, z, ok := w.feetOf(id); ok && id < SkillBarrierIdBase {
			sp.X += mx / l * 0.05
			sp.Y += my / l * 0.05
			sp.Z += mz / l * 0.05
			sp.stuckIn, sp.ox, sp.oy, sp.oz = id, sp.X-x, sp.Y-y, sp.Z-z
		}
		sp.stuck, sp.fuse, sp.Flags = true, SkillSpearFuse, 1
	case hit.Kind == RayWorld, sp.flown >= SpearRange:
		// Stuck a hair short of the surface, so the blast is on this side of the wall it is in.
		sp.X -= mx / l * 0.05
		sp.Y -= my / l * 0.05
		sp.Z -= mz / l * 0.05
		sp.stuck, sp.fuse, sp.Flags = true, SkillSpearFuse, 1
	}
}

// --- Barrier ---------------------------------------------------------------

// placeBarrier stands a barrier in front of the player, across the way they face. It stops
// bullets from both sides; players walk through it.
func (w *World) placeBarrier(p *Player, in *Input) {
	for i := range w.skills.barriers {
		b := &w.skills.barriers[i]
		if b.active {
			continue
		}
		s := &p.State
		fx, fz := -math.Sin(in.Yaw), -math.Cos(in.Yaw)
		x, z := s.X+fx*SkillBarrierDistance, s.Z+fz*SkillBarrierDistance
		// Axis-aligned, like everything else: it spans whichever axis is more across the view.
		halfX, halfZ, yaw := SkillBarrierWidth/2, SkillBarrierThickness/2, 0.0
		if math.Abs(fx) > math.Abs(fz) {
			halfX, halfZ, yaw = SkillBarrierThickness/2, SkillBarrierWidth/2, math.Pi/2
		}
		*b = barrier{
			active: true,
			box:    Aabb{MinX: x - halfX, MaxX: x + halfX, MinY: s.Y, MaxY: s.Y + SkillBarrierHeight, MinZ: z - halfZ, MaxZ: z + halfZ},
			health: SkillBarrierHealth,
			until:  w.tick + uint64(SkillBarrierSeconds*TickRate),
		}
		b.Entity = Entity{
			ID: w.skills.nextID(SkillBarrierIdBase), TeamID: p.Entity.TeamID, Kind: protocol.EntityKindBarrier,
			X: x, Y: s.Y, Z: z, Yaw: yaw,
		}
		return
	}
}

func (w *World) barrierByID(id uint32) *barrier {
	for i := range w.skills.barriers {
		if b := &w.skills.barriers[i]; b.active && b.ID == id {
			return b
		}
	}
	return nil
}

// barrierBoxes adds every standing barrier to the hitboxes a bullet can strike (no head zone).
func (w *World) barrierBoxes(n int) int {
	for i := range w.skills.barriers {
		b := &w.skills.barriers[i]
		if !b.active || n == len(w.boxes) {
			continue
		}
		w.boxes[n] = Hitbox{ID: b.ID, HeadMinY: b.box.MaxY + 1, Aabb: b.box}
		n++
	}
	return n
}

// damageBarrier is a bullet (or a punch) landing on a barrier. The shooter gets a hit event
// with what the barrier has left, like hitting a player.
func (w *World) damageBarrier(shooter *Player, b *barrier, amount float64, extra uint8) {
	b.health -= amount
	flags := extra
	if b.health <= 0 {
		b.health = 0
		b.active = false
		flags |= protocol.GameEventFlagKilled
	}
	shooter.pushEvent(w.tick, protocol.EventKindHit, shooter.ID, b.ID, amount, flags, b.health, 0)
}

// --- Ultimate: bombardment ---------------------------------------------------

// chargeUlt adds to a player's ultimate, up to full.
func chargeUlt(p *Player, amount float64) { p.Health.Ult = math.Min(1, p.Health.Ult+amount) }

// openSky reports whether nothing solid is above the point (x, y, z).
func (w *World) openSky(x, y, z float64) bool {
	return CastRay(&w.level.Collision, nil, x, y, z, 0, 1, 0, skyHeight).Kind != RayWorld
}

// callStrike throws a bombardment marker. It needs a full charge and a free grenade slot;
// the marker uses grenade flight physics and starts the bombardment after its fuse.
func (w *World) callStrike(p *Player, in *Input) {
	if p.Health.Ult < 1 {
		return
	}
	dx, dy, dz := ViewDirection(in.Yaw, in.Pitch)
	for i := range w.skills.grenades {
		g := &w.skills.grenades[i]
		if g.active {
			continue
		}
		s := &p.State
		*g = grenade{
			active:  true,
			owner:   p.ID,
			bombard: true,
			vx:      dx * SkillGrenadeSpeed,
			vy:      dy*SkillGrenadeSpeed + SkillGrenadeLift,
			vz:      dz * SkillGrenadeSpeed,
			fuse:    SkillBombardFuse,
		}
		g.Entity = Entity{
			ID: w.skills.nextID(SkillGrenadeIdBase), TeamID: p.Entity.TeamID, Kind: protocol.EntityKindGrenade,
			X: s.X, Y: s.Y + eyeHeight(s) - 0.2, Z: s.Z,
		}
		p.Health.Ult = 0
		p.Health.ProtectedFor = 0
		return
	}
}

// startStrikeAt drops a marker's final position to the ground and starts the bombardment if the
// spot has open sky. A marker under a roof is a dud.
func (w *World) startStrikeAt(ownerID uint32, x, y, z float64) {
	y = supportHeight(&w.level.Collision, x, z, y+0.5)
	if !w.openSky(x, y+0.2, z) {
		return
	}
	owner := w.byID(ownerID)
	if owner == nil {
		return
	}
	for i := range w.skills.strikes {
		st := &w.skills.strikes[i]
		if st.active {
			continue
		}
		*st = strike{active: true, owner: ownerID, start: w.tick}
		st.Entity = Entity{
			ID: w.skills.nextID(SkillStrikeIdBase), TeamID: owner.Entity.TeamID, Kind: protocol.EntityKindStrike,
			X: x, Y: y, Z: z,
		}
		return
	}
}

// stepStrike runs one bombardment for a tick: a warning, then a shell every interval that
// hurts everyone in the circle who is not under a roof.
func (w *World) stepStrike(st *strike) {
	age := float64(w.tick-st.start) * TickDT
	if age < SkillBombardWarning {
		return
	}
	if age >= SkillBombardWarning+SkillBombardSeconds {
		st.active = false
		return
	}
	st.Flags = 1 // the shells are falling
	st.next -= TickDT
	if st.next > 0 {
		return
	}
	st.next += SkillBombardInterval
	owner := w.byID(st.owner)
	if owner == nil {
		return
	}
	for _, q := range w.players {
		if !q.Health.Alive || (w.practice && q != owner) {
			continue
		}
		s := &q.State
		w.shell(owner, st, q.ID, s.X, s.Y, s.Z, bodyHeight(s))
	}
	for i := range w.targets {
		t := &w.targets[i]
		if !t.Health.Alive {
			continue
		}
		e := t.live(w.tick)
		w.shell(owner, st, t.ID, e.x, e.y, e.z, e.height)
	}
}

// shell applies one shell of a bombardment to a body at (x, y, z): inside the circle, near the
// marked height, and with nothing overhead.
func (w *World) shell(owner *Player, st *strike, id uint32, x, y, z, height float64) {
	if math.Hypot(x-st.X, z-st.Z) > SkillBombardRadius || math.Abs(y-st.Y) > SkillBombardRadius {
		return
	}
	if !w.openSky(x, y+height, z) {
		return
	}
	w.dealDamage(owner, id, SkillBombardDamage, false, protocol.GameEventFlagBlast)
}

// --- Per tick ----------------------------------------------------------------

// useSkills acts on what the player's weapon step and input asked for this tick.
func (w *World) useSkills(p *Player, in *Input, shot *ShotResult) {
	if shot.Grenade {
		w.throwGrenade(p, in)
	}
	if shot.Barrier {
		w.placeBarrier(p, in)
	}
	if shot.SlashStarted {
		p.Health.ProtectedFor = 0
		p.slashFor = slashShownTicks // others see the blades drawn and the X before the dash
	}
	if shot.Slash {
		SlashLunge(&p.State, in.Yaw)
		p.slashCut = slashCutTicks
		p.slashHits = 0
	}
	if shot.RollStarted {
		p.Health.ProtectedFor = 0
	}
	if shot.Roll {
		StartRoll(&p.State, in.Yaw, in.Pitch)
		p.rollHits = 0
		p.rollFromY = p.State.Y
	}
	if in.Ult {
		switch p.Health.Hero {
		case protocol.HeroKindTrooper:
			w.callStrike(p, in)
		case protocol.HeroKindAssassin:
			startOverdrive(p)
		}
	}
	if p.slashFor > 0 {
		p.slashFor--
	}
}

// --- Assassin: dash cut and overdrive ---------------------------------------
// (The grapple is movement: see updateGrapple in movement.go.)

// slashShownTicks is how long others are told a player is mid-slash, for the animation: the
// wind-up and the dash.
var slashShownTicks = int(math.Ceil((SkillSlashWindup + DashDuration) * TickRate))

// slashCutTicks is how many of the player's ticks the dash cut goes on cutting: the dash itself.
var slashCutTicks = int(math.Ceil(DashDuration * TickRate))

// stepSlash is the Assassin's dash cut doing its damage. The press draws the blades and cuts an X
// (the wind-up, in the weapon sim); then comes a dash straight ahead. While the dash lasts, everyone it reaches in front of the attacker, as the attacker's
// screen showed them (rewound like a bullet), with nothing solid in between, takes the slash
// damage, once each. A kill makes the slash ready again at once.
func (w *World) stepSlash(p *Player, in *Input) {
	if p.slashCut <= 0 {
		return
	}
	p.slashCut--
	s := &p.State
	ex, ey, ez := s.X, s.Y+eyeHeight(s), s.Z
	n := w.fillBoxes(p, w.rewindView(in.ViewTick))
	killed := false
bodies:
	for i := 0; i < n; i++ {
		b := &w.boxes[i]
		for k := 0; k < p.slashHits; k++ {
			if p.slashHit[k] == b.ID {
				continue bodies
			}
		}
		// The nearest point of the body to the attacker's eye must be within reach...
		cx, cy, cz := clamp(ex, b.MinX, b.MaxX), clamp(ey, b.MinY, b.MaxY), clamp(ez, b.MinZ, b.MaxZ)
		if math.Sqrt((cx-ex)*(cx-ex)+(cy-ey)*(cy-ey)+(cz-ez)*(cz-ez)) > SkillSlashRange {
			continue
		}
		// ...ahead of the dash, not behind it (a body the attacker is inside counts as ahead)...
		if (cx-ex)*s.DashDirX+(cz-ez)*s.DashDirZ < 0 {
			continue
		}
		// ...with no wall in the way.
		mx, my, mz := (b.MinX+b.MaxX)/2-ex, (b.MinY+b.MaxY)/2-ey, (b.MinZ+b.MaxZ)/2-ez
		if l := math.Sqrt(mx*mx + my*my + mz*mz); l > 1e-6 {
			if hit := CastRay(&w.level.Collision, nil, ex, ey, ez, mx/l, my/l, mz/l, l); hit.Kind == RayWorld {
				continue
			}
		}
		id := b.ID
		if p.slashHits < len(p.slashHit) {
			p.slashHit[p.slashHits] = id
			p.slashHits++
		}
		if w.dealDamage(p, id, SkillSlashDamage, false, protocol.GameEventFlagMelee|protocol.GameEventFlagSlash) && !w.aliveByID(id) {
			killed = true
		}
	}
	if killed {
		p.Weapon.SkillQT = 0 // the slash's cooldown (the dash button's skill)
	}
}

// diveDropMult is how much harder the rolling dive's blades cut for having dropped `drop` metres
// since the dive began: nothing extra up to SkillRollDropMin, rising evenly to SkillRollDropMult
// times at SkillRollDropFull and above. From high enough the cut kills outright.
func diveDropMult(drop float64) float64 {
	t := clamp((drop-SkillRollDropMin)/(SkillRollDropFull-SkillRollDropMin), 0, 1)
	return 1 + (SkillRollDropMult-1)*t
}

// stepRoll is the Assassin's rolling dive doing its damage. While it lasts, anyone the blades
// pass within reach of is cut, once each, harder the further the dive has dropped (diveDropMult). If it ends by hitting the ground, that is the slam:
// everyone near the landing with a clear line is hurt as well (not the diver).
func (w *World) stepRoll(p *Player, in *Input, wasRolling bool) {
	s := &p.State
	if s.RollT > 0 {
		cx, cy, cz := s.X, s.Y+bodyHeight(s)/2, s.Z
		n := w.fillBoxes(p, w.rewindView(in.ViewTick))
	bodies:
		for i := 0; i < n; i++ {
			b := &w.boxes[i]
			for k := 0; k < p.rollHits; k++ {
				if p.rollHit[k] == b.ID {
					continue bodies
				}
			}
			nx, ny, nz := clamp(cx, b.MinX, b.MaxX), clamp(cy, b.MinY, b.MaxY), clamp(cz, b.MinZ, b.MaxZ)
			if math.Sqrt((nx-cx)*(nx-cx)+(ny-cy)*(ny-cy)+(nz-cz)*(nz-cz)) > SkillRollRange {
				continue
			}
			if p.rollHits < len(p.rollHit) {
				p.rollHit[p.rollHits] = b.ID
				p.rollHits++
			}
			w.dealDamage(p, b.ID, SkillRollDamage*diveDropMult(p.rollFromY-s.Y), false, protocol.GameEventFlagMelee|protocol.GameEventFlagSlash)
		}
		return
	}
	if !wasRolling || !s.OnGround {
		return
	}
	// The slam.
	n := w.fillBoxes(p, float64(w.tick))
	for i := 0; i < n; i++ {
		b := &w.boxes[i]
		x, z := (b.MinX+b.MaxX)/2, (b.MinZ+b.MaxZ)/2
		if dmg := w.blastDamage(s.X, s.Y+0.3, s.Z, x, b.MinY, z, b.MaxY-b.MinY, 0, SkillSlamRadius, SkillSlamDamage); dmg > 0 {
			w.dealDamage(p, b.ID, dmg, false, protocol.GameEventFlagBlast)
		}
	}
}

// aliveByID reports whether the player, practice target or barrier with this id is still standing.
func (w *World) aliveByID(id uint32) bool {
	switch {
	case id >= SkillBarrierIdBase:
		return w.barrierByID(id) != nil
	case id >= CombatTargetIdBase:
		t := w.targetByID(id)
		return t != nil && t.Health.Alive
	}
	q := w.byID(id)
	return q != nil && q.Health.Alive
}

// startOverdrive begins the Assassin's ultimate if it is charged: for a few seconds the grapple
// recharges at once and the slash has no cooldown, and the gun is put away (weapon.go, movement.go).
func startOverdrive(p *Player) {
	if p.Health.Ult < 1 || p.Health.Overdrive > 0 {
		return
	}
	p.Health.Ult = 0
	p.Health.Overdrive = SkillOverdriveSeconds
	p.Health.ProtectedFor = 0
}

// stepSkills advances every skill object by one tick.
func (w *World) stepSkills() {
	for i := range w.skills.grenades {
		if g := &w.skills.grenades[i]; g.active {
			w.stepGrenade(g)
		}
	}
	for i := range w.skills.barriers {
		if b := &w.skills.barriers[i]; b.active && w.tick >= b.until {
			b.active = false
		}
	}
	for i := range w.skills.strikes {
		if st := &w.skills.strikes[i]; st.active {
			w.stepStrike(st)
		}
	}
	for i := range w.skills.spears {
		if sp := &w.skills.spears[i]; sp.active {
			w.stepSpear(sp)
		}
	}
	w.stepPickups()
}

// stepPickups gives every cooldown back to a player who walks over a recharge pickup: both
// skills, a full ultimate, the dashes, the grapples and the melee.
func (w *World) stepPickups() {
	for i := range w.pickups {
		k := &w.pickups[i]
		if !k.placed || w.tick < k.backAt {
			continue
		}
		for _, p := range w.players {
			s := &p.State
			if !p.Health.Alive || math.Hypot(s.X-k.X, s.Z-k.Z) > SkillPickupReach || math.Abs(s.Y-k.Y) > StandHeight {
				continue
			}
			p.Weapon.SkillQT, p.Weapon.SkillET, p.Weapon.MeleeCooldown = 0, 0, 0
			p.Health.Ult = 1
			s.DashCharges = DashCharges
			s.GrappleCharges = SkillGrappleCharges
			k.backAt = w.tick + uint64(SkillPickupRespawn*TickRate)
			break
		}
	}
}

// skillEntities appends every skill object to a snapshot's entities.
func (w *World) skillEntities(dst []Entity) []Entity {
	return w.skillEntitiesRelevant(nil, dst)
}

func (w *World) skillEntitiesRelevant(viewer *Player, dst []Entity) []Entity {
	// The point each grappling player is hooked to, so others can draw the line.
	for _, p := range w.players {
		if s := &p.State; s.Grappling && p.Health.Alive {
			if !w.relevant(viewer, s.GrappleX, s.GrappleY, s.GrappleZ) {
				continue
			}
			dst = append(dst, Entity{
				ID: SkillHookIdBase + p.ID, TeamID: uint16(p.ID), Kind: protocol.EntityKindHook,
				X: s.GrappleX, Y: s.GrappleY, Z: s.GrappleZ,
			})
			if s.Grapple2 {
				dst = append(dst, Entity{
					ID: SkillHookIdBase + secondHook + p.ID, TeamID: uint16(p.ID), Kind: protocol.EntityKindHook,
					X: s.Grapple2X, Y: s.Grapple2Y, Z: s.Grapple2Z,
				})
			}
		}
	}
	for i := range w.pickups {
		if k := &w.pickups[i]; k.placed && w.tick >= k.backAt {
			if w.relevant(viewer, k.X, k.Y, k.Z) {
				dst = append(dst, k.Entity)
			}
		}
	}
	for i := range w.skills.grenades {
		if g := &w.skills.grenades[i]; g.active && w.relevant(viewer, g.X, g.Y, g.Z) {
			dst = append(dst, g.Entity)
		}
	}
	for i := range w.skills.barriers {
		if b := &w.skills.barriers[i]; b.active && w.relevant(viewer, b.X, b.Y, b.Z) {
			dst = append(dst, b.Entity)
		}
	}
	for i := range w.skills.strikes {
		if st := &w.skills.strikes[i]; st.active && w.relevant(viewer, st.X, st.Y, st.Z) {
			dst = append(dst, st.Entity)
		}
	}
	for i := range w.skills.spears {
		if sp := &w.skills.spears[i]; sp.active && w.relevant(viewer, sp.X, sp.Y, sp.Z) {
			dst = append(dst, sp.Entity)
		}
	}
	return dst
}
