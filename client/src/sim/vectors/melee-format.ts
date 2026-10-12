/**
 * Melee test vectors, shared with the Go tests (server/internal/game/melee_vectors_test.go).
 * Recorded from the TypeScript melee code by `pnpm vectors`.
 */
import type { Hitbox } from "../hitscan";
import { findMeleeTarget, type MeleeHit } from "../melee";
import type { CollisionWorld } from "../types";
import { type Mismatch, VECTOR_TOLERANCE, type VectorWorld } from "./format";

export interface MeleeCase {
  eye: [number, number, number];
  dir: [number, number, number];
  expect: MeleeHit;
}

export interface MeleeVector {
  name: string;
  description: string;
  world: VectorWorld;
  targets: Hitbox[];
  cases: MeleeCase[];
}

export function replayMelee(v: MeleeVector, world: CollisionWorld): Mismatch[] {
  const out: Mismatch[] = [];
  v.cases.forEach((c, i) => {
    const got = findMeleeTarget(world, v.targets, c.eye, c.dir);
    if (got.targetId !== c.expect.targetId) {
      out.push({ tick: i, field: "targetId", expected: c.expect.targetId, actual: got.targetId });
    }
    if (c.expect.targetId >= 0 && Math.abs(got.dist - c.expect.dist) > VECTOR_TOLERANCE) {
      out.push({ tick: i, field: "dist", expected: c.expect.dist, actual: got.dist });
    }
  });
  return out;
}
