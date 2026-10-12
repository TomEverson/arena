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

import "math"

// SpawnState returns the initial movement state standing at (x, y, z).
func SpawnState(x, y, z float64) PlayerState {
	return PlayerState{X: x, Y: y, Z: z, DashCharges: DashCharges, AirJumps: MaxAirJumps}
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

// wallHit describes a wall the player ran into (or is climbing). ok is false for "no wall".
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
	// Ground speed multiplier (less than 1 while aiming down sights).
	speed float64
}

func wishOf(in *Input) wish {
	mx, mz := in.MoveX, in.MoveZ
	l := math.Hypot(mx, mz)
	if l < 1e-9 {
		return wish{speed: 1}
	}
	mag := math.Min(1, l)
	mx /= l
	mz /= l
	sin := math.Sin(in.Yaw)
	cos := math.Cos(in.Yaw)
	speed := 1.0
	if in.ADS {
		speed = AdsSpeedMult
	}
	// forward = (-sin, -cos), right = (cos, -sin)
	return wish{x: cos*mx - sin*mz, z: -sin*mx - cos*mz, mag: mag, speed: speed}
}

// StepPlayer advances the player by dt seconds, in place.
func StepPlayer(s *PlayerState, in *Input, w *CollisionWorld, dt float64) {
	// Timers
	s.SlideCooldown = math.Max(0, s.SlideCooldown-dt)
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
	if in.Dash && s.DashCharges >= 1 && !wasDashing {
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

	var wall wallHit
	if !(s.DashTime > 0 || s.Sliding || s.Crouching || !in.JumpHeld) {
		wall = findClimbWall(w, s, in.Yaw)
	}
	s.Climbing = wall.ok

	switch {
	case s.DashTime > 0:
		// Dash overrides everything: constant velocity, no gravity.
		s.VX = s.DashDirX * DashSpeed
		s.VZ = s.DashDirZ * DashSpeed
		s.VY = 0
		s.DashTime = math.Max(0, s.DashTime-dt)
	case wall.ok:
		// Climbing: stuck to the wall, moving straight up, no gravity.
		s.VX = 0
		s.VZ = 0
		s.VY = ClimbSpeed
		s.JumpBuffer = 0
	default:
		updateSlide(s, in, w, dt)
		updateCrouch(s, in, w)
		updateHorizontalVelocity(s, &wi, dt)
		tryJump(s, in, w)
		if !s.OnGround {
			s.VY = math.Max(-TerminalVelocity, s.VY-Gravity*dt)
		} else if s.VY < 0 {
			s.VY = 0
		}
	}

	hit := integrate(s, w, dt)

	if wasDashing && s.DashTime <= 0 {
		// Dash just ended: keep some momentum.
		s.VX = s.DashDirX * DashExitSpeed
		s.VZ = s.DashDirZ * DashExitSpeed
	}

	probeGround(s, w, wasGround)

	if hit.ok && !s.OnGround {
		tryStartMantle(s, w, &wi, &hit)
	} else if wall.ok && s.Climbing && !s.OnGround {
		// Near the top of a climbable wall: pull over the edge.
		rise := wall.box.MaxY - s.Y
		if rise <= ClimbTopOut {
			facing := wish{x: -math.Sin(in.Yaw), z: -math.Cos(in.Yaw), mag: 1, speed: 1}
			tryStartMantle(s, w, &facing, &wall)
		}
	}
	if s.Mantling {
		s.Climbing = false
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

func updateHorizontalVelocity(s *PlayerState, wi *wish, dt float64) {
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
		wishSpeed := base * wi.mag * wi.speed
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
		accelerate(s, wi, RunSpeed*wi.mag, AirAccel, dt)
	}
	limit := math.Max(before, RunSpeed)
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
	if in.Jump && !canGroundJump && s.AirJumps > 0 {
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
		if surf, ok := rampSurface(&w.Ramps[i], &pb); ok && s.Y < surf {
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
		s.Y = support
		s.VY = 0
	} else {
		s.OnGround = false
	}
}

// --- Climb -----------------------------------------------------------------

// findClimbWall returns the climbable surface the player is touching and
// facing, if any.
func findClimbWall(w *CollisionWorld, s *PlayerState, yaw float64) wallHit {
	fx := -math.Sin(yaw)
	fz := -math.Cos(yaw)
	height := bodyHeight(s)
	axisX := math.Abs(fx) >= math.Abs(fz)
	facing := fz
	if axisX {
		facing = fx
	}
	if math.Abs(facing) < ClimbFacing {
		return wallHit{}
	}
	sign := -1.0
	if facing > 0 {
		sign = 1
	}
	px, pz := s.X, s.Z
	if axisX {
		px += sign * ClimbReach
	} else {
		pz += sign * ClimbReach
	}
	probe := playerBox(px, s.Y, pz, height)
	for i := range w.Boxes {
		b := &w.Boxes[i]
		if b.Climbable && overlaps(&probe, b) && b.MaxY > s.Y+1e-6 {
			return wallHit{ok: true, box: b, axisX: axisX, sign: sign}
		}
	}
	return wallHit{}
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
