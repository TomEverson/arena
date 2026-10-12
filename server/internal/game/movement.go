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

	switch {
	case s.DashTime > 0:
		// Dash overrides everything: constant velocity, no gravity.
		endWallRun(s)
		s.VX = s.DashDirX * DashSpeed
		s.VZ = s.DashDirZ * DashSpeed
		s.VY = 0
		s.DashTime = math.Max(0, s.DashTime-dt)
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
			updateHorizontalVelocity(s, &wi, dt)
			if !tryWallJump(s, in, w) {
				tryJump(s, in, w)
			}
			if !s.OnGround {
				s.VY = math.Max(-TerminalVelocity, s.VY-Gravity*dt)
			} else if s.VY < 0 {
				s.VY = 0
			}
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
		accelerate(s, wi, RunSpeed*wi.run*wi.mag, AirAccel, dt)
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
		s.WallJumps = 0
		endWallRun(s)
		s.Y = support
		s.VY = 0
	} else {
		s.OnGround = false
	}
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
