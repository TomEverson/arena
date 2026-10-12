/** Hitscan ray casts against the level and target hitboxes. Pure and deterministic. */
import { rampSurface } from "./collision";
import { WEAPON as W } from "./params";
import type { Aabb, CollisionWorld } from "./types";

export interface Hitbox extends Aabb {
  id: number;
  /** Hits at or above this height are headshots (the top of the target). */
  headMinY: number;
}

export interface RayHit {
  kind: "none" | "world" | "target";
  /** Distance along the ray. */
  t: number;
  x: number;
  y: number;
  z: number;
  targetId: number;
  headshot: boolean;
}

/** Distance at which the ray enters the box (0 if it starts inside), or null for a miss. */
export function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: Aabb,
): number | null {
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    return tMin <= tMax;
  };
  if (!slab(ox, dx, b.minX, b.maxX)) return null;
  if (!slab(oy, dy, b.minY, b.maxY)) return null;
  if (!slab(oz, dz, b.minZ, b.maxZ)) return null;
  if (tMax < 0) return null;
  return Math.max(0, tMin);
}

const RAMP_STEP = 0.05;

/** Nearest world hit distance (boxes and ramps) within maxDist, or null. */
function rayWorld(
  world: CollisionWorld,
  o: [number, number, number],
  d: [number, number, number],
  maxDist: number,
): number | null {
  let best = maxDist;
  let found = false;
  for (const b of world.boxes) {
    const t = rayAabb(o[0], o[1], o[2], d[0], d[1], d[2], b);
    if (t !== null && t < best) {
      best = t;
      found = true;
    }
  }
  for (const r of world.ramps) {
    const t0 = rayAabb(o[0], o[1], o[2], d[0], d[1], d[2], r.box);
    if (t0 === null || t0 >= best) continue;
    // March through the wedge's bounding box; hit where the point is under the surface.
    for (let t = t0; t < best; t += RAMP_STEP) {
      const x = o[0] + d[0] * t;
      const y = o[1] + d[1] * t;
      const z = o[2] + d[2] * t;
      const surf = rampSurface(r, { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z });
      if (surf !== null && y <= surf) {
        best = t;
        found = true;
        break;
      }
      if (x < r.box.minX - 1 || x > r.box.maxX + 1 || z < r.box.minZ - 1 || z > r.box.maxZ + 1)
        break;
    }
  }
  return found ? best : null;
}

export function castRay(
  world: CollisionWorld,
  targets: readonly Hitbox[],
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number = W.range,
): RayHit {
  const worldT = rayWorld(world, origin, dir, maxDist);
  let bestT = worldT ?? maxDist;
  let hit: RayHit = {
    kind: worldT === null ? "none" : "world",
    t: bestT,
    x: 0,
    y: 0,
    z: 0,
    targetId: -1,
    headshot: false,
  };

  for (const tg of targets) {
    const t = rayAabb(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], tg);
    if (t === null || t >= bestT) continue;
    bestT = t;
    const y = origin[1] + dir[1] * t;
    hit = {
      kind: "target",
      t,
      x: 0,
      y,
      z: 0,
      targetId: tg.id,
      headshot: y >= tg.headMinY,
    };
  }
  hit.t = bestT;
  hit.x = origin[0] + dir[0] * bestT;
  hit.y = origin[1] + dir[1] * bestT;
  hit.z = origin[2] + dir[2] * bestT;
  return hit;
}
