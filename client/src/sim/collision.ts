import { PARAMS as P } from "./params";
import type { Aabb, CollisionWorld, Ramp } from "./types";

const TOL = 1e-9;

/** Strict overlap: touching faces do not overlap. */
export function overlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.minX < b.maxX - TOL &&
    a.maxX > b.minX + TOL &&
    a.minY < b.maxY - TOL &&
    a.maxY > b.minY + TOL &&
    a.minZ < b.maxZ - TOL &&
    a.maxZ > b.minZ + TOL
  );
}

export function playerBox(x: number, y: number, z: number, height: number): Aabb {
  const hw = P.halfWidth;
  return { minX: x - hw, minY: y, minZ: z - hw, maxX: x + hw, maxY: y + height, maxZ: z + hw };
}

/** True if the box intersects any solid box. */
export function blocked(world: CollisionWorld, pb: Aabb): boolean {
  for (const b of world.boxes) if (overlaps(pb, b)) return true;
  return false;
}

/**
 * Highest point of the ramp surface under the player's footprint, or null if
 * the footprint does not overlap the ramp. Sampled at the edge of the footprint
 * nearest the high side, so the player rides up with their leading edge.
 */
export function rampSurface(ramp: Ramp, pb: Aabb): number | null {
  const b = ramp.box;
  if (pb.minX >= b.maxX - TOL || pb.maxX <= b.minX + TOL) return null;
  if (pb.minZ >= b.maxZ - TOL || pb.maxZ <= b.minZ + TOL) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let t: number;
  switch (ramp.rises) {
    case "+x":
      t = (clamp(pb.maxX, b.minX, b.maxX) - b.minX) / (b.maxX - b.minX);
      break;
    case "-x":
      t = (b.maxX - clamp(pb.minX, b.minX, b.maxX)) / (b.maxX - b.minX);
      break;
    case "+z":
      t = (clamp(pb.maxZ, b.minZ, b.maxZ) - b.minZ) / (b.maxZ - b.minZ);
      break;
    case "-z":
      t = (b.maxZ - clamp(pb.minZ, b.minZ, b.maxZ)) / (b.maxZ - b.minZ);
      break;
  }
  return b.minY + t * (b.maxY - b.minY);
}

/**
 * Height of the highest support surface at or below feetY (plus a small
 * tolerance) under the player's footprint. -Infinity if there is none.
 */
export function supportHeight(world: CollisionWorld, x: number, z: number, feetY: number): number {
  const fp = playerBox(x, feetY, z, 0);
  const limit = feetY + P.groundEps;
  let best = Number.NEGATIVE_INFINITY;
  for (const b of world.boxes) {
    if (b.maxY > limit || b.maxY <= best) continue;
    if (
      fp.minX < b.maxX - TOL &&
      fp.maxX > b.minX + TOL &&
      fp.minZ < b.maxZ - TOL &&
      fp.maxZ > b.minZ + TOL
    ) {
      best = b.maxY;
    }
  }
  for (const r of world.ramps) {
    const h = rampSurface(r, fp);
    if (h !== null && h <= limit && h > best) best = h;
  }
  return best;
}
