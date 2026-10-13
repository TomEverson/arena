/**
 * Bullet physics (projectile weapons). Pure and deterministic, locked to the Go twin
 * (server/internal/game/bullet.go) by the vectors in /testvectors/bullet.
 *
 * A bullet leaves the muzzle at its gun's `bulletSpeed` and falls under its `bulletGravity` (the
 * rifle's unless the caller says otherwise). Each step moves
 * it along its path and casts the whole segment it travelled (so a fast bullet cannot skip
 * through a thin wall or a player) against the level and the target boxes the caller supplies.
 * Which boxes, and where they are, is the caller's job: the server passes the targets where the
 * shooter saw them (lag compensation), a client passes what it can see.
 */
import { castRay, type Hitbox, type RayHit } from "./hitscan";
import { WEAPON as W } from "./params";
import type { CollisionWorld } from "./types";

export interface Bullet {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Metres flown so far. */
  travelled: number;
  /** Hit something or ran out of range: it is gone. */
  done: boolean;
}

/** A bullet leaving `origin` along the unit vector `dir`. */
export function spawnBullet(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  speed: number = W.bulletSpeed,
): Bullet {
  return {
    x: origin[0],
    y: origin[1],
    z: origin[2],
    vx: dir[0] * speed,
    vy: dir[1] * speed,
    vz: dir[2] * speed,
    travelled: 0,
    done: false,
  };
}

/**
 * Fly the bullet for `dt` seconds. Gravity acts first, then it moves; returns what the path hit
 * (kind "none" while it is still flying). Sets `done` on a hit or at `range` metres.
 */
export function stepBullet(
  b: Bullet,
  dt: number,
  world: CollisionWorld,
  targets: readonly Hitbox[],
  range: number = W.range,
  gravity: number = W.bulletGravity,
): RayHit {
  b.vy -= gravity * dt;
  const mx = b.vx * dt;
  const my = b.vy * dt;
  const mz = b.vz * dt;
  const len = Math.sqrt(mx * mx + my * my + mz * mz);
  const maxDist = Math.min(len, range - b.travelled);
  const hit = castRay(world, targets, [b.x, b.y, b.z], [mx / len, my / len, mz / len], maxDist);
  b.x = hit.x;
  b.y = hit.y;
  b.z = hit.z;
  b.travelled += hit.t;
  if (hit.kind !== "none" || b.travelled >= range - 1e-9) b.done = true;
  return hit;
}
