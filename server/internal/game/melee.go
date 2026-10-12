package game

// Melee: who a swing hits. A line-for-line port of client/src/sim/melee.ts, locked to it by
// /testvectors/melee. Never allocates.
//
// A swing hits the nearest target that is within reach (measured from the eye to the nearest
// point of its box), inside the cone in front of the view, with no wall in between.

import "math"

// FindMeleeTarget returns the Hitbox ID struck by a swing from eye (ex, ey, ez) along the unit
// view direction (dx, dy, dz), and its distance, or -1 for a miss.
func FindMeleeTarget(w *CollisionWorld, targets []Hitbox, ex, ey, ez, dx, dy, dz float64) (int, float64) {
	cosCone := math.Cos(WeaponMeleeConeDeg * math.Pi / 180)
	bestID, bestDist := -1, math.Inf(1)
	for i := range targets {
		t := &targets[i]
		cx := math.Min(math.Max(ex, t.MinX), t.MaxX)
		cy := math.Min(math.Max(ey, t.MinY), t.MaxY)
		cz := math.Min(math.Max(ez, t.MinZ), t.MaxZ)
		dist := math.Sqrt((cx-ex)*(cx-ex) + (cy-ey)*(cy-ey) + (cz-ez)*(cz-ez))
		if dist > WeaponMeleeRange || dist >= bestDist {
			continue
		}
		// Aim at the middle of the target.
		mx := (t.MinX+t.MaxX)/2 - ex
		my := (t.MinY+t.MaxY)/2 - ey
		mz := (t.MinZ+t.MaxZ)/2 - ez
		l := math.Sqrt(mx*mx + my*my + mz*mz)
		if l < 1e-9 {
			bestID, bestDist = int(t.ID), dist
			continue
		}
		if (mx*dx+my*dy+mz*dz)/l < cosCone {
			continue
		}
		if los := CastRay(w, nil, ex, ey, ez, mx/l, my/l, mz/l, l); los.Kind != RayNone {
			continue // a wall is in the way
		}
		bestID, bestDist = int(t.ID), dist
	}
	return bestID, bestDist
}
