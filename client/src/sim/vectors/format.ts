/**
 * Movement test-vector format, shared with the Go tests (server/internal/game/vectors_test.go).
 * Vectors are DATA in /testvectors/movement/*.json, recorded from this TypeScript
 * implementation by `pnpm vectors`. Both languages replay the exact same inputs
 * and compare the state at every checkpoint.
 */
import { stepPlayer } from "../movement";
import type { Aabb, CollisionWorld, PlayerInput, PlayerState, Ramp } from "../types";

/** Allowed absolute difference for numbers. Booleans must match exactly. */
export const VECTOR_TOLERANCE = 1e-6;
export const CHECKPOINT_EVERY = 10;
export const VECTOR_DT = 1 / 60;

export type VectorWorld = { level: string } | { boxes: Aabb[]; ramps: Ramp[] };

export interface Vector {
  name: string;
  description: string;
  dt: number;
  world: VectorWorld;
  initial: PlayerState;
  /** Run-length encoded inputs: each step applies `input` for `ticks` ticks. */
  steps: { ticks: number; input: PlayerInput }[];
  /** State after `tick` ticks have been applied. */
  checkpoints: { tick: number; state: PlayerState }[];
}

export interface Mismatch {
  tick: number;
  field: string;
  expected: unknown;
  actual: unknown;
}

export function compareStates(
  tick: number,
  expected: PlayerState,
  actual: PlayerState,
): Mismatch[] {
  const out: Mismatch[] = [];
  const e = expected as unknown as Record<string, number | boolean>;
  const a = actual as unknown as Record<string, number | boolean>;
  for (const field of Object.keys(e)) {
    const ev = e[field];
    const av = a[field];
    if (typeof ev === "number" && typeof av === "number") {
      if (!(Math.abs(ev - av) <= VECTOR_TOLERANCE))
        out.push({ tick, field, expected: ev, actual: av });
    } else if (ev !== av) {
      out.push({ tick, field, expected: ev, actual: av });
    }
  }
  return out;
}

/** Replay a vector against the TypeScript sim and report every mismatch. */
export function replayVector(v: Vector, world: CollisionWorld): Mismatch[] {
  const mismatches: Mismatch[] = [];
  let s = v.initial;
  let tick = 0;
  let next = 0;
  for (const step of v.steps) {
    for (let i = 0; i < step.ticks; i++) {
      s = stepPlayer(s, step.input, world, v.dt);
      tick++;
      const cp = v.checkpoints[next];
      if (cp && cp.tick === tick) {
        mismatches.push(...compareStates(tick, cp.state, s));
        next++;
      }
    }
  }
  if (next !== v.checkpoints.length) {
    mismatches.push({ tick, field: "<checkpoints>", expected: v.checkpoints.length, actual: next });
  }
  return mismatches;
}
