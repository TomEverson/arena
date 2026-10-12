/**
 * Melee: who a swing hits. Pure and deterministic, locked to the Go twin
 * (server/internal/game/melee.go) by the vectors in /testvectors/melee.
 *
 * A swing hits the nearest target that is within reach (measured from the eye to the nearest
 * point of its box), inside the cone in front of the view, with no wall in between. One hit per
 * swing. Which boxes, and where they are, is the caller's job (the server rewinds them to what
 * the shooter's screen showed, like a bullet).
 */
import { castRay, type Hitbox } from "./hitscan";
import { WEAPON as W } from "./params";
import type { CollisionWorld } from "./types";

export interface MeleeHit {
  /** The Hitbox id struck, or -1 for a miss. */
  targetId: number;
  /** Distance from the eye to the nearest point of that box. */
  dist: number;
}

export function findMeleeTarget(
  world: CollisionWorld,
  targets: readonly Hitbox[],
  eye: readonly [number, number, number],
  dir: readonly [number, number, number],
  range: number = W.meleeRange,
  coneDeg: number = W.meleeConeDeg,
): MeleeHit {
  const cosCone = Math.cos((coneDeg * Math.PI) / 180);
  let best: MeleeHit = { targetId: -1, dist: Number.POSITIVE_INFINITY };
  for (const t of targets) {
    const cx = Math.min(Math.max(eye[0], t.minX), t.maxX);
    const cy = Math.min(Math.max(eye[1], t.minY), t.maxY);
    const cz = Math.min(Math.max(eye[2], t.minZ), t.maxZ);
    const dist = Math.sqrt(
      (cx - eye[0]) * (cx - eye[0]) + (cy - eye[1]) * (cy - eye[1]) + (cz - eye[2]) * (cz - eye[2]),
    );
    if (dist > range || dist >= best.dist) continue;
    // Aim at the middle of the target.
    const mx = (t.minX + t.maxX) / 2 - eye[0];
    const my = (t.minY + t.maxY) / 2 - eye[1];
    const mz = (t.minZ + t.maxZ) / 2 - eye[2];
    const len = Math.sqrt(mx * mx + my * my + mz * mz);
    if (len < 1e-9) {
      best = { targetId: t.id, dist };
      continue;
    }
    if ((mx * dir[0] + my * dir[1] + mz * dir[2]) / len < cosCone) continue;
    const los = castRay(world, [], [eye[0], eye[1], eye[2]], [mx / len, my / len, mz / len], len);
    if (los.kind !== "none") continue; // a wall is in the way
    best = { targetId: t.id, dist };
  }
  return best;
}
