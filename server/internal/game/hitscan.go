package game

// Hitscan ray casts against the level and target hitboxes: a line-for-line port
// of client/src/sim/hitscan.ts, locked to it by /testvectors/hitscan. Never allocates.

import "math"

// Hitbox is a target box. Hits at or above HeadMinY are headshots.
type Hitbox struct {
	ID       uint32  `json:"id"`
	HeadMinY float64 `json:"headMinY"`
	Aabb
}

const (
	RayNone   = "none"
	RayWorld  = "world"
	RayTarget = "target"
)

// RayHit is the result of casting a ray.
type RayHit struct {
	Kind string  `json:"kind"`
	T    float64 `json:"t"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z"`
	// TargetID is the Hitbox ID hit, or -1.
	TargetID int  `json:"targetId"`
	Headshot bool `json:"headshot"`
}

// slab narrows [tMin, tMax] by one axis and reports whether the ray can still hit.
func slab(o, d, lo, hi float64, tMin, tMax *float64) bool {
	if math.Abs(d) < 1e-12 {
		return o >= lo && o <= hi
	}
	t1 := (lo - o) / d
	t2 := (hi - o) / d
	if t1 > t2 {
		t1, t2 = t2, t1
	}
	*tMin = math.Max(*tMin, t1)
	*tMax = math.Min(*tMax, t2)
	return *tMin <= *tMax
}

// rayAabb returns the distance at which the ray enters the box (0 if it starts inside), or false for a miss.
func rayAabb(ox, oy, oz, dx, dy, dz float64, b *Aabb) (float64, bool) {
	tMin := math.Inf(-1)
	tMax := math.Inf(1)
	if !slab(ox, dx, b.MinX, b.MaxX, &tMin, &tMax) {
		return 0, false
	}
	if !slab(oy, dy, b.MinY, b.MaxY, &tMin, &tMax) {
		return 0, false
	}
	if !slab(oz, dz, b.MinZ, b.MaxZ, &tMin, &tMax) {
		return 0, false
	}
	if tMax < 0 {
		return 0, false
	}
	return math.Max(0, tMin), true
}

const rampStep = 0.05

// rayWorld returns the nearest world hit distance (boxes and ramps) within maxDist.
func rayWorld(w *CollisionWorld, ox, oy, oz, dx, dy, dz, maxDist float64) (float64, bool) {
	best := maxDist
	found := false
	for i := range w.Boxes {
		if t, ok := rayAabb(ox, oy, oz, dx, dy, dz, &w.Boxes[i]); ok && t < best {
			best = t
			found = true
		}
	}
	for i := range w.Ramps {
		r := &w.Ramps[i]
		t0, ok := rayAabb(ox, oy, oz, dx, dy, dz, &r.Box)
		if !ok || t0 >= best {
			continue
		}
		// March through the wedge's bounding box; hit where the point is under the surface.
		for t := t0; t < best; t += rampStep {
			x := ox + dx*t
			y := oy + dy*t
			z := oz + dz*t
			pt := Aabb{MinX: x, MaxX: x, MinY: y, MaxY: y, MinZ: z, MaxZ: z}
			if surf, hit := rampSurface(r, &pt); hit && y <= surf {
				best = t
				found = true
				break
			}
			if x < r.Box.MinX-1 || x > r.Box.MaxX+1 || z < r.Box.MinZ-1 || z > r.Box.MaxZ+1 {
				break
			}
		}
	}
	return best, found
}

// CastRay casts a ray (unit direction) and returns the nearest hit among the level and the targets.
func CastRay(w *CollisionWorld, targets []Hitbox, ox, oy, oz, dx, dy, dz, maxDist float64) RayHit {
	worldT, worldHit := rayWorld(w, ox, oy, oz, dx, dy, dz, maxDist)
	bestT := maxDist
	hit := RayHit{Kind: RayNone, TargetID: -1}
	if worldHit {
		bestT = worldT
		hit.Kind = RayWorld
	}
	for i := range targets {
		tg := &targets[i]
		t, ok := rayAabb(ox, oy, oz, dx, dy, dz, &tg.Aabb)
		if !ok || t >= bestT {
			continue
		}
		bestT = t
		y := oy + dy*t
		hit = RayHit{Kind: RayTarget, TargetID: int(tg.ID), Headshot: y >= tg.HeadMinY}
	}
	hit.T = bestT
	hit.X = ox + dx*bestT
	hit.Y = oy + dy*bestT
	hit.Z = oz + dz*bestT
	return hit
}
