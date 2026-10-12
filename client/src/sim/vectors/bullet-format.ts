/**
 * Bullet test vectors, shared with the Go tests (server/internal/game/bullet_vectors_test.go).
 * Recorded from the TypeScript bullet physics by `pnpm vectors`, like the other vectors.
 */
import { type Bullet, spawnBullet, stepBullet } from "../bullet";
import type { Hitbox, RayHit } from "../hitscan";
import type { CollisionWorld } from "../types";
import { type Mismatch, VECTOR_DT, VECTOR_TOLERANCE, type VectorWorld } from "./format";

export interface BulletStepRecord {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  travelled: number;
  done: boolean;
  hit: RayHit;
}

export interface BulletVector {
  name: string;
  description: string;
  dt: number;
  world: VectorWorld;
  origin: [number, number, number];
  dir: [number, number, number];
  speed: number;
  range: number;
  /** The target boxes for each step (entry i is used for step i; the last repeats if short). */
  targets: Hitbox[][];
  /** What the bullet looked like after each step, until it was done. */
  steps: BulletStepRecord[];
}

const MAX_STEPS = 120;

export function targetsAt(v: Pick<BulletVector, "targets">, step: number): Hitbox[] {
  return v.targets[Math.min(step, v.targets.length - 1)] ?? [];
}

/** Fly the bullet of this vector through `world` and return the record of every step. */
export function runBullet(
  v: Omit<BulletVector, "steps" | "name" | "description" | "world">,
  world: CollisionWorld,
): BulletStepRecord[] {
  const b: Bullet = spawnBullet(v.origin, v.dir, v.speed);
  const out: BulletStepRecord[] = [];
  for (let i = 0; i < MAX_STEPS && !b.done; i++) {
    const hit = stepBullet(b, v.dt, world, targetsAt(v, i), v.range);
    out.push({
      x: b.x,
      y: b.y,
      z: b.z,
      vx: b.vx,
      vy: b.vy,
      vz: b.vz,
      travelled: b.travelled,
      done: b.done,
      hit,
    });
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= VECTOR_TOLERANCE;

function compareFlat(
  step: number,
  prefix: string,
  e: Record<string, unknown>,
  a: Record<string, unknown>,
  out: Mismatch[],
): void {
  for (const key of Object.keys(e)) {
    const ev = e[key];
    const av = a[key];
    if (typeof ev === "object" && ev !== null) {
      compareFlat(
        step,
        `${key}.`,
        ev as Record<string, unknown>,
        av as Record<string, unknown>,
        out,
      );
      continue;
    }
    const ok = typeof ev === "number" && typeof av === "number" ? near(ev, av) : ev === av;
    if (!ok) out.push({ tick: step, field: `${prefix}${key}`, expected: ev, actual: av });
  }
}

export function replayBullet(v: BulletVector, world: CollisionWorld): Mismatch[] {
  const out: Mismatch[] = [];
  const run = runBullet(v, world);
  if (run.length !== v.steps.length) {
    out.push({ tick: 0, field: "<steps>", expected: v.steps.length, actual: run.length });
    return out;
  }
  v.steps.forEach((e, i) => {
    const a = run[i];
    if (a)
      compareFlat(
        i,
        "",
        e as unknown as Record<string, unknown>,
        a as unknown as Record<string, unknown>,
        out,
      );
  });
  return out;
}

export { VECTOR_DT };
