package game

// Designated movement file (server side).
//
// The player movement function lives ONLY here (with collision.go, types.go and
// the generated params_gen.go) and in client/src/sim/. It is a line-for-line port
// of client/src/sim/movement.ts: both must agree on every vector in
// /testvectors/movement. Any change here must update the TypeScript twin and the
// vectors in the same commit (`pnpm vectors`).
//
// StepPlayer is deterministic, takes no hidden state, and never allocates.

import (
	"math"

	"arena/server/internal/protocol"
)

// SpawnState returns the initial movement state standing at (x, y, z).
func SpawnState(x, y, z float64) PlayerState {
	return PlayerState{X: x, Y: y, Z: z, DashCharges: DashCharges, AirJumps: MaxAirJumps, GrappleCharges: SkillGrappleCharges}
}

func hSpeed(s *PlayerState) float64 { return math.Hypot(s.VX, s.VZ) }

func bodyHeight(s *PlayerState) float64 {
	if s.Sliding {
		return SlideHeight
	}
	if s.Crouching {
		return CrouchHeight
	}
	return StandHeight
}

// wallHit describes a wall the player ran into. ok is false for "no wall".
type wallHit struct {
	ok    bool
	box   *Aabb
	axisX bool
	// sign is the direction the player was moving along the axis when blocked.
	sign float64
}

type wish struct {
	// Unit direction in world XZ ((0, 0) if no input) and input magnitude 0..1.
	x, z, mag float64
	// Ground speed multiplier (less than 1 while aiming down sights, more with empty hands).
	speed float64
	// run is the weapon's run speed multiplier alone (it also applies in the air).
	run float64
}

func wishOf(in *Input) wish {
	mx, mz := in.MoveX, in.MoveZ
	l := math.Hypot(mx, mz)
	if l < 1e-9 {
		return wish{speed: 1, run: 1}
	}
	mag := math.Min(1, l)
	mx /= l
	mz /= l
	sin := math.Sin(in.Yaw)
	cos := math.Cos(in.Yaw)
	// 0 (a field an old input lacks) means the default.
	run := in.RunSpeedMult
	if run == 0 {
		run = 1
	}
	speed := run
	if in.ADS {
		ads := in.ADSSpeedMult
		if ads == 0 {
			ads = AdsSpeedMult
		}
		speed *= ads
	}
	// forward = (-sin, -cos), right = (cos, -sin)
	return wish{x: cos*mx - sin*mz, z: -sin*mx - cos*mz, mag: mag, speed: speed, run: run}
}

// StepPlayer advances the player by dt seconds, in place.
func StepPlayer(s *PlayerState, in *Input, w *CollisionWorld, dt float64) {
	// Timers
	s.SlideCooldown = math.Max(0, s.SlideCooldown-dt)
	s.WallCooldown = math.Max(0, s.WallCooldown-dt)
	if s.OnGround {
		s.Coyote = CoyoteTime
	} else {
		s.Coyote = math.Max(0, s.Coyote-dt)
	}
	if in.Jump {
		s.JumpBuffer = JumpBufferTime
	} else {
		s.JumpBuffer = math.Max(0, s.JumpBuffer-dt)
	}
	// Slowed by a bullet hit (the server sets SlowT): running is slower until it runs out.
	slow := 1.0
	if s.SlowT > 0 {
		slow = HitSlowMult
	}
	s.SlowT = math.Max(0, s.SlowT-dt)

	if s.Mantling {
		stepMantle(s, dt)
		return
	}

	wi := wishOf(in)
	wasGround := s.OnGround
	wasDashing := s.DashTime > 0

	if !wasDashing {
		s.DashCharges = math.Min(DashCharges, s.DashCharges+dt/DashRegenTime)
	}
	// (The Assassin has no dash: that button is the spinning slash, see weapon.go.)
	if in.Dash && s.DashCharges >= 1 && !wasDashing && in.Hero != protocol.HeroKindAssassin {
		s.DashCharges -= 1
		s.DashTime = DashDuration
		if wi.mag > 0 {
			s.DashDirX = wi.x
			s.DashDirZ = wi.z
		} else {
			s.DashDirX = -math.Sin(in.Yaw)
			s.DashDirZ = -math.Cos(in.Yaw)
		}
	}

	updateGrapple(s, in, w, dt)
	wasRolling := s.RollT > 0

	switch {
	case s.DashTime > 0:
		// Dash overrides everything: constant velocity, no gravity.
		endWallRun(s)
		if in.Hero != protocol.HeroKindAssassin {
			// (The Assassin's dash is its slash, which stays on the line.)
			s.Grappling = false
			s.Grapple2 = false
		}
		s.VX = s.DashDirX * DashSpeed
		s.VZ = s.DashDirZ * DashSpeed
		s.VY = 0
		s.DashTime = math.Max(0, s.DashTime-dt)
	case s.RollT > 0:
		// The rolling dive: straight along where it was aimed (forward and down) at a fixed
		// speed, until it hits something or its time runs out. No gravity, no steering.
		endWallRun(s)
		s.Sliding = false
		s.Crouching = false
		s.VX = s.RollDirX * SkillRollSpeed
		s.VY = s.RollDirY * SkillRollSpeed
		s.VZ = s.RollDirZ * SkillRollSpeed
		s.RollT = math.Max(0, s.RollT-dt)
		s.JumpBuffer = 0
	case s.Grappling && (!s.OnGround || in.Reel):
		// Grapple: on a line. Gravity acts and you can steer, and the line holds you (holdLine),
		// so you swing. While the button is held the line also reels you in: a pull toward the
		// hook, or up the middle of two. (Standing on the ground without reeling, you keep the
		// line but move as usual: see below.)
		endWallRun(s)
		s.Sliding = false
		s.Crouching = false
		if wi.mag > 0 {
			accelerate(s, &wi, RunSpeed*wi.mag, SkillGrappleSteer, dt)
		}
		if in.Reel {
			s.VY -= Gravity * SkillGrappleGravityScale * dt
			dx, dy, dz, _ := pullDirection(s)
			s.VX += dx * SkillGrapplePull * dt
			s.VY += dy * SkillGrapplePull * dt
			s.VZ += dz * SkillGrapplePull * dt
		} else {
			s.VY -= Gravity * dt
		}
		holdLine(s, s.GrappleX, s.GrappleY, s.GrappleZ, s.GrappleLen, dt)
		if s.Grapple2 {
			holdLine(s, s.Grapple2X, s.Grapple2Y, s.Grapple2Z, s.Grapple2Len, dt)
		}
		if speed := math.Sqrt(s.VX*s.VX + s.VY*s.VY + s.VZ*s.VZ); speed > SkillGrappleSpeed {
			k := SkillGrappleSpeed / speed
			s.VX *= k
			s.VY *= k
			s.VZ *= k
		}
		s.GrappleT += dt
		s.JumpBuffer = 0
	default:
		updateWallRun(s, in, &wi, w)
		if s.WallRunning {
			if in.Jump {
				wallJump(s)
			} else {
				runAlongWall(s, dt)
			}
		} else {
			updateSlide(s, in, w, dt)
			updateCrouch(s, in, w)
			updateHorizontalVelocity(s, &wi, slow, dt)
			if !tryWallJump(s, in, w) {
				tryJump(s, in, w)
			}
			if !s.OnGround {
				s.VY = math.Max(-TerminalVelocity, s.VY-Gravity*dt)
			} else if s.VY < 0 {
				s.VY = 0
			}
		}
		if s.Grappling {
			// On the ground with a line out and the button up: the line is kept (it only lets go
			// on a jump or a crouch), and still will not let you get further from the hook than
			// it is long.
			holdLine(s, s.GrappleX, s.GrappleY, s.GrappleZ, s.GrappleLen, dt)
			if s.Grapple2 {
				holdLine(s, s.Grapple2X, s.Grapple2Y, s.Grapple2Z, s.Grapple2Len, dt)
			}
		}
	}

	hit := integrate(s, w, dt)
	if s.Grappling {
		_, _, _, d1 := toHook(s, s.GrappleX, s.GrappleY, s.GrappleZ)
		d2 := 0.0
		if s.Grapple2 {
			_, _, _, d2 = toHook(s, s.Grapple2X, s.Grapple2Y, s.Grapple2Z)
		}
		reeledOut := false
		if in.Reel {
			// Reeling takes the line in as you come closer. Getting no closer for a while means
			// you are circling the hook (or something is in the way): it lets go.
			if d1 < s.GrappleLen-0.02 || (s.Grapple2 && d2 < s.Grapple2Len-0.02) {
				s.GrappleStall = 0
			} else {
				s.GrappleStall += dt
			}
			s.GrappleLen = math.Min(s.GrappleLen, d1)
			if s.Grapple2 {
				s.Grapple2Len = math.Min(s.Grapple2Len, d2)
			}
			_, _, _, together := pullDirection(s)
			reeledOut = together < SkillGrappleSplit || s.GrappleStall >= SkillGrappleStallTime
		} else {
			s.GrappleStall = 0
		}
		// Let go: on reaching a hook; reeling, once between two hooks (the lines pull against
		// each other) or stalled; on crouch; or when it has gone on too long. The speed is kept:
		// the fling.
		// (Letting go of the button does not let go of the line, in the air or on the ground: a
		// jump does, see updateGrapple.)
		if nearestHook(s) <= SkillGrappleArrive || reeledOut || in.Slide || s.GrappleT >= SkillGrappleMaxTime {
			endGrapple(s, false)
		}
	}

	if wasDashing && s.DashTime <= 0 {
		// Dash just ended: keep some momentum.
		s.VX = s.DashDirX * DashExitSpeed
		s.VZ = s.DashDirZ * DashExitSpeed
	}

	probeGround(s, w, wasGround)

	if wasRolling {
		// The dive ends when its time is up, or early on hitting the ground (the slam) or a
		// wall; part of the speed is kept.
		if hit.ok || s.OnGround {
			s.RollT = 0
		}
		if s.RollT <= 0 {
			s.VX *= SkillRollExitScale
			s.VY *= SkillRollExitScale
			s.VZ *= SkillRollExitScale
		}
	} else if hit.ok && !s.OnGround {
		tryStartMantle(s, w, &wi, &hit)
	}
}

// --- Slide and crouch ------------------------------------------------------

func fitsStanding(s *PlayerState, w *CollisionWorld) bool {
	pb := playerBox(s.X, s.Y, s.Z, StandHeight)
	return !blocked(w, &pb)
}

func endSlide(s *PlayerState) {
	s.Sliding = false
	s.SlideCooldown = SlideCooldown
}

func updateSlide(s *PlayerState, in *Input, w *CollisionWorld, dt float64) {
	speed := hSpeed(s)
	if !s.Sliding {
		if in.Slide && s.OnGround && !s.Crouching && speed >= SlideMinSpeed {
			s.Sliding = true
			s.SlideTime = 0
			if s.SlideCooldown <= 0 && speed < SlideSpeed {
				k := SlideSpeed / speed
				s.VX *= k
				s.VZ *= k
			}
		}
		return
	}
	s.SlideTime += dt
	wantEnd := !in.Slide || !s.OnGround || speed < SlideEndSpeed || s.SlideTime > SlideMaxTime
	// Cannot stand up under a low ceiling: stay in the slide.
	if wantEnd && fitsStanding(s, w) {
		endSlide(s)
	}
}

// updateCrouch: hold the slide key on the ground without enough speed to slide.
// A finished slide with the key still held settles into a crouch.
func updateCrouch(s *PlayerState, in *Input, w *CollisionWorld) {
	if s.Sliding {
		s.Crouching = false
		return
	}
	if !s.Crouching {
		if in.Slide && s.OnGround {
			s.Crouching = true
		}
		return
	}
	// Stay low while the key is held or while there is no room to stand.
	if !in.Slide && fitsStanding(s, w) {
		s.Crouching = false
	}
}

// --- Horizontal velocity ---------------------------------------------------

func accelerate(s *PlayerState, wi *wish, wishSpeed, accel, dt float64) {
	add := wishSpeed - (s.VX*wi.x + s.VZ*wi.z)
	if add <= 0 {
		return
	}
	a := math.Min(accel*wishSpeed*dt, add)
	s.VX += a * wi.x
	s.VZ += a * wi.z
}

// reduceSpeed lowers horizontal speed by drop, never below floor.
func reduceSpeed(s *PlayerState, drop, floor float64) {
	speed := hSpeed(s)
	if speed < 1e-9 {
		return
	}
	next := math.Max(floor, speed-drop)
	if next >= speed {
		return
	}
	k := next / speed
	s.VX *= k
	s.VZ *= k
}

func updateHorizontalVelocity(s *PlayerState, wi *wish, slow, dt float64) {
	if s.Sliding && s.OnGround && hSpeed(s) >= SlideEndSpeed {
		// Momentum slide: fixed direction, linear decay.
		reduceSpeed(s, SlideDecel*dt, 0)
		return
	}
	if s.OnGround {
		// Crouch-walk (also when stuck low under a ceiling after a slide).
		base := float64(RunSpeed)
		if s.Sliding || s.Crouching {
			base = CrouchSpeed
		}
		wishSpeed := base * wi.mag * wi.speed * slow
		if wi.mag == 0 {
			reduceSpeed(s, math.Max(hSpeed(s), StopSpeed)*GroundFriction*dt, 0)
		} else {
			// Only bleed off overspeed (after a slide or dash); never slow below the wish speed.
			speed := hSpeed(s)
			if speed > wishSpeed {
				reduceSpeed(s, speed*GroundFriction*dt, wishSpeed)
			}
			accelerate(s, wi, wishSpeed, GroundAccel, dt)
		}
		return
	}
	// Air: steer freely but never gain speed beyond what we had (or run speed).
	before := hSpeed(s)
	if wi.mag > 0 {
		accelerate(s, wi, RunSpeed*wi.run*wi.mag*slow, AirAccel, dt)
	}
	limit := math.Max(before, RunSpeed*wi.run)
	after := hSpeed(s)
	if after > limit {
		s.VX *= limit / after
		s.VZ *= limit / after
	}
}

// --- Jump ------------------------------------------------------------------

func tryJump(s *PlayerState, in *Input, w *CollisionWorld) {
	canGroundJump := s.OnGround || s.Coyote > 0
	if s.JumpBuffer > 0 && canGroundJump {
		if s.Sliding {
			if !fitsStanding(s, w) {
				return
			}
			endSlide(s)
			// A jump out of a slide costs part of its speed (never below run speed), so chained
			// slide-jumps wind down.
			reduceSpeed(s, hSpeed(s)*(1-SlideJumpKeep), RunSpeed)
		}
		if s.Crouching {
			if !fitsStanding(s, w) {
				return
			}
			s.Crouching = false
		}
		s.VY = JumpSpeed
		s.OnGround = false
		s.Coyote = 0
		s.JumpBuffer = 0
		return
	}
	// Air jump: only on a fresh press (a buffered press must not burn it just before landing).
	// (The Assassin has no air jump: the grapple and the dive are its air movement.)
	if in.Jump && !canGroundJump && s.AirJumps > 0 && in.Hero != protocol.HeroKindAssassin {
		s.AirJumps--
		s.VY = AirJumpSpeed
		s.JumpBuffer = 0
	}
}

// --- Integration and collision --------------------------------------------

func integrate(s *PlayerState, w *CollisionWorld, dt float64) wallHit {
	maxDisp := math.Max(math.Abs(s.VX), math.Max(math.Abs(s.VY), math.Abs(s.VZ))) * dt
	n := int(math.Max(1, math.Ceil(maxDisp/MaxSubstep)))
	h := dt / float64(n)
	var hit wallHit
	for i := 0; i < n; i++ {
		if got := moveHorizontal(s, w, true, s.VX*h); got.ok {
			hit = got
		}
		if got := moveHorizontal(s, w, false, s.VZ*h); got.ok {
			hit = got
		}
		moveVertical(s, w, s.VY*h)
	}
	return hit
}

// moveHorizontal moves along one horizontal axis, stepping up small ledges and
// pushing out of walls.
func moveHorizontal(s *PlayerState, w *CollisionWorld, axisX bool, d float64) wallHit {
	var hit wallHit
	if d == 0 {
		return hit
	}
	pos, vel := &s.Z, &s.VZ
	if axisX {
		pos, vel = &s.X, &s.VX
	}
	before := *pos
	*pos += d

	for i := range w.Boxes {
		b := &w.Boxes[i]
		pb := playerBox(s.X, s.Y, s.Z, bodyHeight(s))
		// A player standing on a box may move across its top; floating-point drift should not turn
		// the support surface into a horizontal wall.
		if s.Y >= b.MaxY-GroundEps {
			continue
		}
		if !overlaps(&pb, b) {
			continue
		}
		// Small ledge: step up onto it instead of stopping.
		if b.MaxY > s.Y && b.MaxY-s.Y <= StepHeight {
			oldY := s.Y
			s.Y = b.MaxY
			up := playerBox(s.X, s.Y, s.Z, bodyHeight(s))
			if !blocked(w, &up) {
				continue
			}
			s.Y = oldY
		}
		switch {
		case d > 0 && axisX:
			*pos = b.MinX - HalfWidth
		case d > 0:
			*pos = b.MinZ - HalfWidth
		case axisX:
			*pos = b.MaxX + HalfWidth
		default:
			*pos = b.MaxZ + HalfWidth
		}
		*vel = 0
		sign := -1.0
		if d > 0 {
			sign = 1
		}
		hit = wallHit{ok: true, box: b, axisX: axisX, sign: sign}
	}

	for i := range w.Ramps {
		pb := playerBox(s.X, s.Y, s.Z, bodyHeight(s))
		// A ramp is a wedge filling its box and nothing more: wholly under the box, it is overhead.
		if pb.MaxY <= w.Ramps[i].Box.MinY+1e-9 {
			continue
		}
		surf, ok := rampSurface(&w.Ramps[i], &pb)
		if !ok || s.Y >= surf {
			continue
		}
		if surf-s.Y <= RampStep {
			s.Y = surf
		} else {
			// The tall side of a ramp is a wall.
			*pos = before
			*vel = 0
		}
	}
	return hit
}

func moveVertical(s *PlayerState, w *CollisionWorld, dy float64) {
	if dy == 0 {
		return
	}
	prevY := s.Y
	s.Y += dy
	height := bodyHeight(s)

	for i := range w.Boxes {
		b := &w.Boxes[i]
		pb := playerBox(s.X, s.Y, s.Z, height)
		if !overlaps(&pb, b) {
			continue
		}
		if dy < 0 && prevY >= b.MaxY-1e-6 {
			s.Y = b.MaxY
			s.VY = 0
		} else if dy > 0 && prevY+height <= b.MinY+1e-6 {
			s.Y = b.MinY - height
			s.VY = 0
		}
	}

	for i := range w.Ramps {
		pb := playerBox(s.X, s.Y, s.Z, height)
		surf, ok := rampSurface(&w.Ramps[i], &pb)
		if !ok {
			continue
		}
		if minY := w.Ramps[i].Box.MinY; prevY+height <= minY+1e-6 {
			// Came from underneath: the flat bottom of the ramp's box is a ceiling, like a box's.
			if s.Y+height > minY {
				s.Y = minY - height
				s.VY = 0
			}
			continue
		}
		if s.Y < surf {
			s.Y = surf
			if s.VY < 0 {
				s.VY = 0
			}
		}
	}
}

// probeGround decides whether we are standing on something, snapping down small drops.
func probeGround(s *PlayerState, w *CollisionWorld, wasGround bool) {
	support := supportHeight(w, s.X, s.Z, s.Y)
	gap := s.Y - support
	if (s.VY <= 0 && gap <= GroundEps) || (wasGround && s.VY <= 0 && gap <= SnapDown) {
		s.OnGround = true
		s.AirJumps = MaxAirJumps
		s.WallJumps = 0
		endWallRun(s)
		s.Y = support
		s.VY = 0
	} else {
		s.OnGround = false
	}
}

// --- Grapple (the Assassin's first skill) -----------------------------------

// toHook is the unit direction from the player's chest to a hook at (hx, hy, hz), and the
// distance (never zero).
func toHook(s *PlayerState, hx, hy, hz float64) (dx, dy, dz, dist float64) {
	dx = hx - s.X
	dy = hy - (s.Y + bodyHeight(s)/2)
	dz = hz - s.Z
	dist = math.Max(1e-6, math.Sqrt(dx*dx+dy*dy+dz*dz))
	return dx / dist, dy / dist, dz / dist, dist
}

// holdLine: the line to a hook at (hx, hy, hz) holds. Once the player is as far from the hook as
// the line is long, any speed away from the hook is taken out (what is left is the swing around
// it), and a little pull is added if the line has been stretched.
func holdLine(s *PlayerState, hx, hy, hz, length, dt float64) {
	ux, uy, uz, dist := toHook(s, hx, hy, hz)
	if dist < length {
		return
	}
	if toward := s.VX*ux + s.VY*uy + s.VZ*uz; toward < 0 {
		s.VX -= ux * toward
		s.VY -= uy * toward
		s.VZ -= uz * toward
	}
	back := (dist - length) * SkillGrappleStretch * dt
	s.VX += ux * back
	s.VY += uy * back
	s.VZ += uz * back
}

// nearestHook is how far the nearer hook is.
func nearestHook(s *PlayerState) float64 {
	_, _, _, a := toHook(s, s.GrappleX, s.GrappleY, s.GrappleZ)
	if !s.Grapple2 {
		return a
	}
	_, _, _, b := toHook(s, s.Grapple2X, s.Grapple2Y, s.Grapple2Z)
	return math.Min(a, b)
}

// pullDirection is which way the grapple pulls: straight at one hook, or with two, along the
// middle of the V they make (the two unit directions added together). together is how hard the
// two lines pull together, 0 to 1: it falls to nothing as the player comes between the hooks.
func pullDirection(s *PlayerState) (x, y, z, together float64) {
	ax, ay, az, _ := toHook(s, s.GrappleX, s.GrappleY, s.GrappleZ)
	if !s.Grapple2 {
		return ax, ay, az, 1
	}
	bx, by, bz, _ := toHook(s, s.Grapple2X, s.Grapple2Y, s.Grapple2Z)
	x, y, z = ax+bx, ay+by, az+bz
	l := math.Sqrt(x*x + y*y + z*z)
	if l < 1e-6 {
		return 0, 0, 0, 0
	}
	return x / l, y / l, z / l, l / 2
}

// endGrapple lets go of the grapple, keeping the speed (scaled by SkillGrappleExitScale); a jump adds a hop.
func endGrapple(s *PlayerState, hop bool) {
	s.Grappling = false
	s.Grapple2 = false
	s.GrappleT = 0
	s.GrappleStall = 0
	s.VX *= SkillGrappleExitScale
	s.VY *= SkillGrappleExitScale
	s.VZ *= SkillGrappleExitScale
	if hop {
		s.VY = math.Max(s.VY, SkillGrappleHop)
	}
}

// updateGrapple: charges come back one at a time (at once during overdrive). A press hooks the
// first solid surface in view within range and starts the pull. A press in the middle of a pull
// adds a second hook without letting go of the first, so the pull goes between the two (a V);
// with two out already, the older one is dropped for the new one. A jump lets go. Only the
// Assassin (in.Hero) has it.
func updateGrapple(s *PlayerState, in *Input, w *CollisionWorld, dt float64) {
	if in.Overdrive {
		s.GrappleCharges = SkillGrappleCharges
	} else {
		s.GrappleCharges = math.Min(SkillGrappleCharges, s.GrappleCharges+dt/SkillGrappleRegen)
	}
	if in.Hero != protocol.HeroKindAssassin {
		s.Grappling = false
		s.Grapple2 = false
		return
	}
	if s.Grappling && in.Jump {
		endGrapple(s, true)
	}
	if !in.SkillQ || s.GrappleCharges < 1 {
		return
	}
	cp := math.Cos(in.Pitch)
	dx, dy, dz := -math.Sin(in.Yaw)*cp, math.Sin(in.Pitch), -math.Cos(in.Yaw)*cp
	hit := CastRay(w, nil, s.X, s.Y+eyeHeight(s), s.Z, dx, dy, dz, SkillGrappleRange)
	if hit.Kind != RayWorld {
		return // nothing to hook: the charge is kept
	}
	s.GrappleCharges -= 1
	s.GrappleT = 0
	s.GrappleStall = 0
	if !s.Grappling {
		s.Grappling = true
		s.Grapple2 = false
		s.GrappleX, s.GrappleY, s.GrappleZ = hit.X, hit.Y, hit.Z
		_, _, _, s.GrappleLen = toHook(s, hit.X, hit.Y, hit.Z)
	} else {
		if s.Grapple2 {
			// Two hooks out already: the older one goes, the newer becomes the first. Pressing
			// again and again like this is how grapples are chained.
			s.GrappleX, s.GrappleY, s.GrappleZ = s.Grapple2X, s.Grapple2Y, s.Grapple2Z
			s.GrappleLen = s.Grapple2Len
		}
		s.Grapple2 = true
		s.Grapple2X, s.Grapple2Y, s.Grapple2Z = hit.X, hit.Y, hit.Z
		_, _, _, s.Grapple2Len = toHook(s, hit.X, hit.Y, hit.Z)
	}
	// The hook biting: a kick toward it, and the air jump back, so one grapple leads into the next.
	kx, ky, kz, _ := toHook(s, hit.X, hit.Y, hit.Z)
	s.VX += kx * SkillGrappleKick
	s.VY += ky * SkillGrappleKick
	s.VZ += kz * SkillGrappleKick
	s.AirJumps = MaxAirJumps
	s.DashTime = 0
	s.OnGround = false
}

// SlashLunge is the dash of the Assassin's spinning slash: a real dash straight ahead, the same
// speed and length as the Trooper's (it starts on the next tick). Called by whoever steps the
// weapon, on the tick the slash happens, on both sides. It does not let go of a grapple.
func SlashLunge(s *PlayerState, yaw float64) {
	s.DashTime = DashDuration
	s.DashDirX = -math.Sin(yaw)
	s.DashDirZ = -math.Cos(yaw)
	s.RollT = 0
}

// StartRoll starts the Assassin's rolling dive: forward and down, a slam to the front. It
// follows the view but always points down by at least SkillRollMinDive, so it comes down ahead
// of you even when you are looking level. Called like SlashLunge, on the tick the weapon step
// says the dive began. It lets go of a grapple: a dive is a commitment.
func StartRoll(s *PlayerState, yaw, pitch float64) {
	down := math.Min(pitch, -SkillRollMinDive)
	cp := math.Cos(down)
	s.RollT = SkillRollTime
	s.RollDirX = -math.Sin(yaw) * cp
	s.RollDirY = math.Sin(down)
	s.RollDirZ = -math.Cos(yaw) * cp
	s.Grappling = false
	s.Grapple2 = false
	s.DashTime = 0
}

// --- Wall run and wall jump ------------------------------------------------

// wallContact is a wall found beside the player: the unit XZ direction pointing out of it,
// toward the player. ok is false for "no wall".
type wallContact struct {
	ok     bool
	nx, nz float64
}

// wallDirs are the directions from the player to a wall, checked in this order (ties go to the first).
var wallDirs = [4][2]float64{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}

// findWall returns a wall beside (or in front of, or behind) the player that can be run on or
// jumped off: a solid box face within WallRunReach, tall enough to matter, and not the wall we
// just left (see WallCooldown). When several qualify, the one we are moving along fastest wins.
func findWall(w *CollisionWorld, s *PlayerState) wallContact {
	height := bodyHeight(s)
	var best wallContact
	bestAlong := -1.0
	for _, d := range wallDirs {
		dx, dz := d[0], d[1]
		nx, nz := -dx, -dz
		if s.WallCooldown > 0 && nx*s.WallNormalX+nz*s.WallNormalZ > 0.9 {
			continue
		}
		probe := playerBox(s.X+dx*WallRunReach, s.Y, s.Z+dz*WallRunReach, height)
		found := false
		for i := range w.Boxes {
			b := &w.Boxes[i]
			if b.MaxY > s.Y+WallRunMinHeight && overlaps(&probe, b) {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		// Speed along the wall: the velocity without its component into the wall.
		into := s.VX*nx + s.VZ*nz
		along := math.Hypot(s.VX-into*nx, s.VZ-into*nz)
		if along > bestAlong {
			bestAlong = along
			best = wallContact{ok: true, nx: nx, nz: nz}
		}
	}
	return best
}

func endWallRun(s *PlayerState) {
	if !s.WallRunning {
		return
	}
	s.WallRunning = false
	s.WallRunTime = 0
	s.WallCooldown = WallRunCooldown
}

// updateWallRun starts, keeps or ends a wall run. To start: in the air and clear of the floor,
// moving along a wall fast enough, holding a direction that follows the wall. To keep going:
// still beside the same wall, still moving along it, still holding a direction, time not up,
// slide key released.
func updateWallRun(s *PlayerState, in *Input, wi *wish, w *CollisionWorld) {
	ok := !s.OnGround && !s.Sliding && !s.Crouching && !in.Slide && wi.mag > 0 &&
		s.WallRunTime < WallRunMaxTime && !(in.Jump && s.WallJumps >= WallJumpMax)
	var c wallContact
	if ok {
		c = findWall(w, s)
	}
	if !c.ok {
		endWallRun(s)
		return
	}
	into := s.VX*c.nx + s.VZ*c.nz
	tx := s.VX - into*c.nx
	tz := s.VZ - into*c.nz
	along := math.Hypot(tx, tz)
	if !s.WallRunning {
		if along < WallRunMinSpeed {
			return
		}
		if (wi.x*tx+wi.z*tz)/along < WallRunWish {
			return
		}
		if s.Y-supportHeight(w, s.X, s.Z, s.Y) < WallRunMinHeight {
			return
		}
		s.WallRunning = true
		s.WallRunTime = 0
		s.VY = math.Min(s.VY, WallRunMaxRise) // a jump's rise does not carry up the wall
	} else if along < WallRunExitSpeed {
		endWallRun(s)
		return
	}
	s.WallNormalX = c.nx
	s.WallNormalZ = c.nz
}

// runAlongWall slides along the wall at (at least) wall-run speed, pressed lightly to it,
// barely falling.
func runAlongWall(s *PlayerState, dt float64) {
	nx, nz := s.WallNormalX, s.WallNormalZ
	into := s.VX*nx + s.VZ*nz
	tx := s.VX - into*nx
	tz := s.VZ - into*nz
	along := math.Hypot(tx, tz)
	speed := math.Max(along, WallRunSpeed)
	s.VX = (tx/along)*speed - nx*WallRunStick
	s.VZ = (tz/along)*speed - nz*WallRunStick
	s.VY = math.Max(-WallRunMaxFall, s.VY-Gravity*WallRunGravityScale*dt)
	s.WallRunTime += dt
	s.JumpBuffer = 0
}

// wallJump kicks off the wall: away from it, up, keeping the speed along it. Gives back one air jump.
func wallJump(s *PlayerState) {
	nx, nz := s.WallNormalX, s.WallNormalZ
	into := s.VX*nx + s.VZ*nz
	s.VX = s.VX - into*nx + nx*WallJumpKick
	s.VZ = s.VZ - into*nz + nz*WallJumpKick
	s.VY = WallJumpSpeed
	s.WallJumps++
	s.AirJumps = uint8(math.Min(MaxAirJumps, float64(s.AirJumps)+1))
	s.JumpBuffer = 0
	s.WallRunning = false
	s.WallRunTime = 0
	s.WallCooldown = WallRunCooldown
}

// tryWallJump: a fresh jump press in the air, touching a wall, wall jumps instead of an air jump.
func tryWallJump(s *PlayerState, in *Input, w *CollisionWorld) bool {
	if !in.Jump || s.OnGround || s.Coyote > 0 || int(s.WallJumps) >= WallJumpMax {
		return false
	}
	c := findWall(w, s)
	if !c.ok {
		return false
	}
	s.WallNormalX = c.nx
	s.WallNormalZ = c.nz
	wallJump(s)
	return true
}

// --- Mantle ----------------------------------------------------------------

func tryStartMantle(s *PlayerState, w *CollisionWorld, wi *wish, hit *wallHit) {
	if s.Sliding || s.Crouching || s.DashTime > 0 {
		return
	}
	// Must be pushing into the wall we hit.
	into := wi.z * hit.sign
	if hit.axisX {
		into = wi.x * hit.sign
	}
	if into < 0.3 {
		return
	}

	top := hit.box.MaxY
	rise := top - s.Y
	if rise <= StepHeight || rise > MantleReach {
		return
	}

	tx, tz := s.X, s.Z
	if hit.axisX {
		if hit.sign > 0 {
			tx = hit.box.MinX + HalfWidth + MantleInset
		} else {
			tx = hit.box.MaxX - HalfWidth - MantleInset
		}
	} else {
		if hit.sign > 0 {
			tz = hit.box.MinZ + HalfWidth + MantleInset
		} else {
			tz = hit.box.MaxZ - HalfWidth - MantleInset
		}
	}
	// Need room to stand at the destination, with something solid under us.
	dest := playerBox(tx, top, tz, StandHeight)
	if blocked(w, &dest) {
		return
	}
	if top-supportHeight(w, tx, tz, top) > GroundEps {
		return
	}

	endWallRun(s)
	s.Mantling = true
	s.MantleT = 0
	s.Sliding = false
	s.Crouching = false
	s.MantleFromX = s.X
	s.MantleFromY = s.Y
	s.MantleFromZ = s.Z
	s.MantleToX = tx
	s.MantleToY = top
	s.MantleToZ = tz
	s.VX = 0
	s.VY = 0
	s.VZ = 0
}

// stepMantle rises up the wall first (60%), then moves over the ledge.
func stepMantle(s *PlayerState, dt float64) {
	const split = 0.6
	s.MantleT += dt
	u := math.Min(1, s.MantleT/MantleDuration)
	if u < split {
		k := u / split
		s.X = s.MantleFromX
		s.Z = s.MantleFromZ
		s.Y = s.MantleFromY + (s.MantleToY-s.MantleFromY)*k
	} else {
		k := (u - split) / (1 - split)
		s.X = s.MantleFromX + (s.MantleToX-s.MantleFromX)*k
		s.Z = s.MantleFromZ + (s.MantleToZ-s.MantleFromZ)*k
		s.Y = s.MantleToY
	}
	s.VX = 0
	s.VY = 0
	s.VZ = 0
	if u >= 1 {
		dx := s.MantleToX - s.MantleFromX
		dz := s.MantleToZ - s.MantleFromZ
		l := math.Hypot(dx, dz)
		s.Mantling = false
		s.MantleT = 0
		s.OnGround = true
		s.AirJumps = MaxAirJumps
		if l > 0 {
			s.VX = dx / l * MantleExitSpeed
			s.VZ = dz / l * MantleExitSpeed
		}
	}
}
