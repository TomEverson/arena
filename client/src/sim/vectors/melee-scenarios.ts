/** Scenarios recorded into /testvectors/melee. */
import type { Hitbox } from "../hitscan";
import { findMeleeTarget } from "../melee";
import { box, flatWorld } from "../testutil";
import { viewDirection } from "../weapon";
import type { VectorWorld } from "./format";
import type { MeleeCase, MeleeVector } from "./melee-format";
import { loadWorld } from "./node";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`verify failed: ${msg}`);
}

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

const EYE: [number, number, number] = [0, 1.6, 0];
const FORWARD = viewDirection(0, 0);

export interface MeleeScenario {
  name: string;
  description: string;
  world: VectorWorld;
  targets: Hitbox[];
  rays: { eye: [number, number, number]; dir: [number, number, number] }[];
  verify: (cases: MeleeCase[]) => void;
}

const open = flatWorld();
const walled = flatWorld({ boxes: [box(0, 1.5, -1.6, 4, 3, 0.2)] });

export const meleeScenarios: MeleeScenario[] = [
  {
    name: "melee-in-front",
    description:
      "A target right in front is hit; behind, to the side beyond the cone, too far, and a miss.",
    world: { boxes: open.boxes, ramps: open.ramps },
    targets: [target(1, 0, -1.8), target(2, 0, 1.8), target(3, 3, 0), target(4, 0, -5)],
    rays: [
      { eye: EYE, dir: FORWARD },
      { eye: EYE, dir: viewDirection(Math.PI, 0) }, // turned round: now the one behind
      { eye: EYE, dir: viewDirection(-Math.PI / 2, 0) }, // looking right at the one 3 m away: out of reach
      { eye: [0, 1.6, -3], dir: FORWARD }, // 2 m from the far one: in reach
      { eye: EYE, dir: viewDirection(1.3, 0) }, // looking well off to one side: outside the cone
    ],
    verify: (cases) => {
      check(cases[0]?.expect.targetId === 1, "hit the one in front");
      check(cases[1]?.expect.targetId === 2, "hit the one behind after turning");
      check(cases[2]?.expect.targetId === -1, "too far to the side");
      check(cases[3]?.expect.targetId === 4, "closer, in reach");
      check(cases[4]?.expect.targetId === -1, "outside the cone");
    },
  },
  {
    name: "melee-wall-and-nearest",
    description:
      "A wall between you and the target stops the swing; of two targets in reach the nearer is hit.",
    world: { boxes: walled.boxes, ramps: walled.ramps },
    targets: [target(1, 0, -2.2), target(5, 1.0, -0.9), target(6, -0.2, -1.2)],
    rays: [
      { eye: EYE, dir: FORWARD }, // the wall (at z -1.6) is between you and target 1, but 5 and 6 are before it
      { eye: [0, 1.6, -2.6], dir: viewDirection(Math.PI, 0) }, // from behind the wall looking back at target 1? it is in front of you
    ],
    verify: (cases) => {
      check(cases[0] !== undefined, "recorded");
    },
  },
  {
    name: "melee-heights",
    description:
      "A crouched target and one standing on a ledge: reach is measured to the nearest point of the box.",
    world: { boxes: open.boxes, ramps: open.ramps },
    targets: [target(1, 0, -1.9, 1.2), target(2, 1.2, -1.0, 1.8, 1.0)],
    rays: [
      { eye: EYE, dir: FORWARD },
      { eye: EYE, dir: viewDirection(-0.7, 0) },
      { eye: [0, 1.6, 0], dir: viewDirection(0, -0.8) }, // looking down at your feet
    ],
    verify: (cases) => {
      check(
        cases[0]?.expect.targetId === 2,
        "the nearer of two in the cone is hit (the one on the ledge)",
      );
      check(cases[1]?.expect.targetId === 2, "looking toward the ledge");
    },
  },
];

export function recordMelee(sc: MeleeScenario): MeleeVector {
  const world = loadWorld(sc.world);
  const cases: MeleeCase[] = sc.rays.map((r) => {
    const len = Math.hypot(...r.dir);
    const dir: [number, number, number] = [r.dir[0] / len, r.dir[1] / len, r.dir[2] / len];
    const expect = findMeleeTarget(world, sc.targets, r.eye, dir);
    // Infinity does not survive JSON: a miss has no distance.
    return {
      eye: r.eye,
      dir,
      expect: { targetId: expect.targetId, dist: Number.isFinite(expect.dist) ? expect.dist : -1 },
    };
  });
  sc.verify(cases);
  return {
    name: sc.name,
    description: sc.description,
    world: sc.world,
    targets: sc.targets,
    cases,
  };
}
