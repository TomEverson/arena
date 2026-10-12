package game

import "math"

// Collision helpers: a line-for-line port of client/src/sim/collision.ts.
// Part of the designated movement files (see AGENTS.md). No allocations.

const collisionTol = 1e-9

// overlaps is a strict overlap test: touching faces do not overlap.
func overlaps(a, b *Aabb) bool {
	return a.MinX < b.MaxX-collisionTol &&
		a.MaxX > b.MinX+collisionTol &&
		a.MinY < b.MaxY-collisionTol &&
		a.MaxY > b.MinY+collisionTol &&
		a.MinZ < b.MaxZ-collisionTol &&
		a.MaxZ > b.MinZ+collisionTol
}

func playerBox(x, y, z, height float64) Aabb {
	return Aabb{
		MinX: x - HalfWidth, MinY: y, MinZ: z - HalfWidth,
		MaxX: x + HalfWidth, MaxY: y + height, MaxZ: z + HalfWidth,
	}
}

// blocked reports whether pb intersects any solid box.
func blocked(w *CollisionWorld, pb *Aabb) bool {
	for i := range w.Boxes {
		if overlaps(pb, &w.Boxes[i]) {
			return true
		}
	}
	return false
}

func clamp(v, lo, hi float64) float64 {
	return math.Min(hi, math.Max(lo, v))
}

// rampSurface returns the highest point of the ramp surface under the player's
// footprint, sampled at the edge nearest the high side, and false if the
// footprint does not overlap the ramp.
func rampSurface(r *Ramp, pb *Aabb) (float64, bool) {
	b := &r.Box
	if pb.MinX >= b.MaxX-collisionTol || pb.MaxX <= b.MinX+collisionTol {
		return 0, false
	}
	if pb.MinZ >= b.MaxZ-collisionTol || pb.MaxZ <= b.MinZ+collisionTol {
		return 0, false
	}
	var t float64
	switch r.Rises {
	case RisePlusX:
		t = (clamp(pb.MaxX, b.MinX, b.MaxX) - b.MinX) / (b.MaxX - b.MinX)
	case RiseMinusX:
		t = (b.MaxX - clamp(pb.MinX, b.MinX, b.MaxX)) / (b.MaxX - b.MinX)
	case RisePlusZ:
		t = (clamp(pb.MaxZ, b.MinZ, b.MaxZ) - b.MinZ) / (b.MaxZ - b.MinZ)
	default: // RiseMinusZ
		t = (b.MaxZ - clamp(pb.MinZ, b.MinZ, b.MaxZ)) / (b.MaxZ - b.MinZ)
	}
	return b.MinY + t*(b.MaxY-b.MinY), true
}

// supportHeight is the height of the highest support surface at or below feetY
// (plus a small tolerance) under the player's footprint, or -Inf if none.
func supportHeight(w *CollisionWorld, x, z, feetY float64) float64 {
	fp := playerBox(x, feetY, z, 0)
	limit := feetY + GroundEps
	best := math.Inf(-1)
	for i := range w.Boxes {
		b := &w.Boxes[i]
		if b.MaxY > limit || b.MaxY <= best {
			continue
		}
		if fp.MinX < b.MaxX-collisionTol && fp.MaxX > b.MinX+collisionTol &&
			fp.MinZ < b.MaxZ-collisionTol && fp.MaxZ > b.MinZ+collisionTol {
			best = b.MaxY
		}
	}
	for i := range w.Ramps {
		if h, ok := rampSurface(&w.Ramps[i], &fp); ok && h <= limit && h > best {
			best = h
		}
	}
	return best
}
