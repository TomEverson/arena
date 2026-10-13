package game

// Bullet physics (projectile weapons): a line-for-line port of client/src/sim/bullet.ts,
// locked to it by /testvectors/bullet. Never allocates.
//
// A bullet leaves the muzzle at its gun's speed and falls under its gun's gravity. Each
// step moves it along its path and casts the whole segment it travelled (so a fast bullet cannot
// skip through a thin wall or a player) against the level and the target boxes the caller
// supplies. Which boxes, and where they are, is the caller's job: the world passes the targets
// where the shooter saw them while the bullet catches up with real time, then where they are.

import "math"

// Bullet is a projectile in flight.
type Bullet struct {
	X, Y, Z    float64
	VX, VY, VZ float64
	// Travelled is the number of metres flown so far.
	Travelled float64
	// Done is set when it hit something or ran out of range: it is gone.
	Done bool
}

// SpawnBullet returns a bullet leaving (ox, oy, oz) along the unit vector (dx, dy, dz) at speed.
func SpawnBullet(ox, oy, oz, dx, dy, dz, speed float64) Bullet {
	return Bullet{X: ox, Y: oy, Z: oz, VX: dx * speed, VY: dy * speed, VZ: dz * speed}
}

// StepBullet flies b for dt seconds. Gravity acts first, then it moves; it returns what the path
// hit (RayNone while it is still flying) and sets Done on a hit or at `maxRange` metres.
func StepBullet(b *Bullet, dt float64, w *CollisionWorld, targets []Hitbox, maxRange, gravity float64) RayHit {
	b.VY -= gravity * dt
	mx := b.VX * dt
	my := b.VY * dt
	mz := b.VZ * dt
	l := math.Sqrt(mx*mx + my*my + mz*mz)
	maxDist := math.Min(l, maxRange-b.Travelled)
	hit := CastRay(w, targets, b.X, b.Y, b.Z, mx/l, my/l, mz/l, maxDist)
	b.X, b.Y, b.Z = hit.X, hit.Y, hit.Z
	b.Travelled += hit.T
	if hit.Kind != RayNone || b.Travelled >= maxRange-1e-9 {
		b.Done = true
	}
	return hit
}
