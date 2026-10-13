/**
 * Weapon and hitscan test vectors, shared with the Go tests
 * (server/internal/game/combat_vectors_test.go). Recorded from the TypeScript
 * implementation by `pnpm vectors`, like the movement vectors.
 */
import type { WeaponState } from "../../net/protocol.gen";
import { castRay, type Hitbox, type RayHit } from "../hitscan";
import type { CollisionWorld } from "../types";
import { type ShotResult, stepWeapon, type WeaponContext, type WeaponInput } from "../weapon";
import { type Mismatch, VECTOR_DT, VECTOR_TOLERANCE, type VectorWorld } from "./format";

export { VECTOR_DT };

export interface WeaponEvent extends ShotResult {
  tick: number;
}

export interface WeaponVector {
  name: string;
  description: string;
  dt: number;
  initial: WeaponState;
  steps: { ticks: number; input: WeaponInput; ctx: WeaponContext }[];
  /** Every tick on which something happened (a shot, a reload start or end, a dry fire). */
  events: WeaponEvent[];
  checkpoints: { tick: number; weapon: WeaponState }[];
}

export interface HitscanCase {
  origin: [number, number, number];
  dir: [number, number, number];
  maxDist: number;
  expect: RayHit;
}

export interface HitscanVector {
  name: string;
  description: string;
  world: VectorWorld;
  targets: Hitbox[];
  cases: HitscanCase[];
}

const near = (a: number, b: number) => Math.abs(a - b) <= VECTOR_TOLERANCE;

function compareRecord(
  tick: number,
  prefix: string,
  expected: object,
  actual: object,
  out: Mismatch[],
): void {
  const e = expected as Record<string, number | boolean | string>;
  const a = actual as Record<string, number | boolean | string>;
  for (const key of Object.keys(e)) {
    const ev = e[key];
    const av = a[key];
    const ok = typeof ev === "number" && typeof av === "number" ? near(ev, av) : ev === av;
    if (!ok) out.push({ tick, field: `${prefix}${key}`, expected: ev, actual: av });
  }
}

const interesting = (r: ShotResult) =>
  r.fired ||
  r.reloadStarted ||
  r.reloadFinished ||
  r.dryFire ||
  r.meleeStarted ||
  r.meleeStrike ||
  r.switched ||
  r.grenade ||
  r.barrier ||
  r.slash ||
  r.slashStarted ||
  r.roll ||
  r.rollStarted;

/** Run steps through the live weapon sim, collecting events and checkpoints. */
export function runWeaponSteps(
  initial: WeaponState,
  steps: WeaponVector["steps"],
  dt: number,
  checkpointEvery: number,
): { events: WeaponEvent[]; checkpoints: WeaponVector["checkpoints"]; trace: WeaponState[] } {
  let w = initial;
  const events: WeaponEvent[] = [];
  const checkpoints: WeaponVector["checkpoints"] = [];
  const trace: WeaponState[] = [initial];
  let tick = 0;
  const total = steps.reduce((n, s) => n + s.ticks, 0);
  for (const step of steps) {
    for (let i = 0; i < step.ticks; i++) {
      const r = stepWeapon(w, step.input, step.ctx, dt);
      w = r.state;
      tick++;
      trace.push(w);
      if (interesting(r.shot)) events.push({ tick, ...r.shot });
      if (tick % checkpointEvery === 0 || tick === total) checkpoints.push({ tick, weapon: w });
    }
  }
  return { events, checkpoints, trace };
}

export function replayWeapon(v: WeaponVector): Mismatch[] {
  const out: Mismatch[] = [];
  const run = runWeaponSteps(v.initial, v.steps, v.dt, 10);
  if (run.events.length !== v.events.length) {
    out.push({ tick: 0, field: "<events>", expected: v.events.length, actual: run.events.length });
    return out;
  }
  v.events.forEach((e, i) => {
    const a = run.events[i];
    if (a) compareRecord(e.tick, "event.", e, a, out);
  });
  v.checkpoints.forEach((c, i) => {
    const a = run.checkpoints[i];
    if (a) compareRecord(c.tick, "weapon.", c.weapon, a.weapon, out);
    else out.push({ tick: c.tick, field: "<checkpoint>", expected: "present", actual: "missing" });
  });
  return out;
}

export function replayHitscan(v: HitscanVector, world: CollisionWorld): Mismatch[] {
  const out: Mismatch[] = [];
  v.cases.forEach((c, i) => {
    const hit = castRay(world, v.targets, c.origin, c.dir, c.maxDist);
    compareRecord(i, "ray.", c.expect, hit, out);
  });
  return out;
}
