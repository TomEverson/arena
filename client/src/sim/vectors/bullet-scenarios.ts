/** Scenarios recorded into /testvectors/bullet. */
import type { Hitbox } from "../hitscan";
import { PARAMS as P, SNIPER, WEAPON as W } from "../params";
import { box, flatWorld } from "../testutil";
import { viewDirection } from "../weapon";
import { type BulletStepRecord, type BulletVector, runBullet, VECTOR_DT } from "./bullet-format";
import type { VectorWorld } from "./format";
import { loadWorld } from "./node";

export interface BulletScenario {
  name: string;
  description: string;
  world: VectorWorld;
  origin: [number, number, number];
  dir: [number, number, number];
  speed?: number;
  range?: number;
  gravity?: number;
  /** Target boxes at step i. */
  targets?: (step: number) => Hitbox[];
  /** How many steps' worth of targets to record. */
  targetSteps?: number;
  verify: (steps: BulletStepRecord[]) => void;
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`verify failed: ${msg}`);
}
const last = (s: BulletStepRecord[]) => s[s.length - 1] as BulletStepRecord;

function target(id: number, x: number, z: number, height = 1.8, feetY = 0): Hitbox {
  return {
    id,
    headMinY: feetY + height - 0.3,
    minX: x - 0.3,
    maxX: x + 0.3,
    minY: feetY,
    maxY: feetY + height,
    minZ: z - 0.3,
    maxZ: z + 0.3,
  };
}

const open = flatWorld();
const wallWorld = flatWorld({
  boxes: [box(0, 2, -30, 20, 4, 1), box(8, 1, -12, 0.1, 2, 6)], // a wall 30 m away, and a thin wall
});

const FORWARD: [number, number, number] = [0, 0, -1];
const EYE: [number, number, number] = [0, 1.6, 0];

export const bulletScenarios: BulletScenario[] = [
  {
    name: "bullet-flat-flight",
    description:
      "Fired level over open ground: constant speed, falls under gravity, and is gone at the weapon's range.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: [0, 40, 0], // high enough that it never reaches the floor
    dir: FORWARD,
    verify: (steps) => {
      check(last(steps).done && last(steps).hit.kind === "none", "ran out of range");
      check(Math.abs(last(steps).travelled - W.range) < 1e-6, "flew exactly the range");
      const s = steps[9] as BulletStepRecord;
      const t = 10 * VECTOR_DT;
      check(Math.abs(s.vy + W.bulletGravity * t) < 1e-6, "vy is -g t");
      check(Math.abs(s.vz + W.bulletSpeed) < 1e-9, "forward speed does not change");
      check(Math.abs(40 - s.y - 0.5 * W.bulletGravity * t * t) < 0.2, "dropped about g t^2 / 2");
    },
  },
  {
    name: "bullet-wall",
    description: "Hits a wall 30 m away at the height it should be after the drop.",
    world: { boxes: wallWorld.boxes, ramps: wallWorld.ramps },
    origin: EYE,
    dir: FORWARD,
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "world" && l.done, "hit the wall");
      check(Math.abs(l.z + 29.5) < 1e-6, "stopped at the wall face");
      check(l.y < 1.6 && l.y > 1.4, "a little lower than it left");
    },
  },
  {
    name: "bullet-thin-wall",
    description:
      "A 10 cm wall in the path of a 5 m-per-tick bullet: swept, so it cannot tunnel through.",
    world: { boxes: wallWorld.boxes, ramps: wallWorld.ramps },
    origin: [8, 1.2, 0],
    dir: FORWARD,
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "world", "hit the thin wall");
      check(Math.abs(l.z + 9) < 0.1, "stopped at the thin wall's near face (z about -9)");
    },
  },
  {
    name: "bullet-hits-floor",
    description: "Fired slightly downward: lands on the floor.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: EYE,
    dir: viewDirection(0, -0.05),
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "world" && Math.abs(l.y) < 1e-6, "hit the floor");
    },
  },
  {
    name: "bullet-standing-target",
    description: "Aimed straight at a standing target's chest 40 m away: hits the body.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: [0, 1.2, 0],
    dir: FORWARD,
    targets: () => [target(7, 0, -40)],
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "target" && l.hit.targetId === 7, "hit the target");
      check(!l.hit.headshot, "a body shot");
    },
  },
  {
    name: "bullet-headshot",
    description:
      "Level from eye height at a target 40 m away: the drop still leaves it in the head zone.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: EYE,
    dir: FORWARD,
    targets: () => [target(5, 0, -40)],
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "target" && l.hit.headshot, "a headshot");
    },
  },
  {
    name: "bullet-moving-target",
    description:
      "A target runs across at 10 m/s, 30 m ahead: a shot aimed at where it will be hits; a shot at where it is misses.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: EYE,
    // The target runs 10 m/s for as long as the bullet takes to fly 30 m: lead it by that much.
    dir: viewDirection(-Math.atan2((10 * 30) / W.bulletSpeed, 30), 0.003),
    targetSteps: 40,
    targets: (i) => [target(3, (10 * i) / 60, -30)],
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "target" && l.hit.targetId === 3, "led shot hits");
    },
  },
  {
    name: "bullet-miss-moving-target",
    description:
      "The same runner, shot at where it was: the bullet goes behind it and hits the wall behind.",
    world: { boxes: wallWorld.boxes, ramps: wallWorld.ramps },
    origin: EYE,
    dir: viewDirection(0, 0.003),
    targetSteps: 40,
    targets: (i) => [target(3, 6 - (10 * i) / 60, -20)],
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind !== "target", "did not hit the runner");
    },
  },
  {
    name: "bullet-slow-speed",
    description: "A slower bullet (100 m/s) drops much more over the same distance.",
    world: { boxes: wallWorld.boxes, ramps: wallWorld.ramps },
    origin: EYE,
    dir: FORWARD,
    speed: 100,
    verify: (steps) => {
      const l = last(steps);
      check(l.hit.kind === "world" && l.y < 1.3, "dropped over 30 cm before the wall");
    },
  },
  {
    name: "bullet-sniper",
    description:
      "The sniper's bullet (its own speed, drop and range): level from eye height at a target 100 m away, it takes time to arrive and still lands on the head.",
    world: { boxes: open.boxes, ramps: open.ramps },
    origin: EYE,
    dir: FORWARD,
    speed: SNIPER.bulletSpeed,
    range: SNIPER.range,
    gravity: SNIPER.bulletGravity,
    targets: () => [target(9, 0, -100)],
    verify: (steps) => {
      const l = last(steps);
      check(steps.length > 3, "not instant: it flies for several ticks");
      check(l.hit.kind === "target" && l.hit.targetId === 9 && l.hit.headshot, "a headshot");
      check(l.y < 1.6 - 0.05, "it dropped on the way");
    },
  },
];

export function recordBullet(sc: BulletScenario): BulletVector {
  const len = Math.hypot(...sc.dir);
  const dir: [number, number, number] = [sc.dir[0] / len, sc.dir[1] / len, sc.dir[2] / len];
  const targetSteps = sc.targetSteps ?? 1;
  const base: Omit<BulletVector, "steps" | "name" | "description" | "world"> = {
    dt: VECTOR_DT,
    origin: sc.origin,
    dir,
    speed: sc.speed ?? W.bulletSpeed,
    range: sc.range ?? W.range,
    gravity: sc.gravity ?? W.bulletGravity,
    targets: Array.from({ length: targetSteps }, (_, i) => sc.targets?.(i) ?? []),
  };
  const steps = runBullet(base, loadWorld(sc.world));
  sc.verify(steps);
  return { name: sc.name, description: sc.description, world: sc.world, ...base, steps };
}

void P;
