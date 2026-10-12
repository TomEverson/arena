/** Scenarios recorded into /testvectors/weapon and /testvectors/hitscan. */
import type { WeaponState } from "../../net/protocol.gen";
import type { Hitbox } from "../hitscan";
import { castRay } from "../hitscan";
import { PARAMS as P } from "../params";
import { box, flatWorld } from "../testutil";
import { spawnWeapon, viewDirection, type WeaponContext, type WeaponInput } from "../weapon";
import type { HitscanCase, HitscanVector, WeaponVector } from "./combat-format";
import { runWeaponSteps, VECTOR_DT } from "./combat-format";
import type { VectorWorld } from "./format";
import { loadWorld } from "./node";

const P_WINDUP = 0.12; // WEAPON.meleeWindup, for the check below
const STILL: WeaponContext = { hSpeed: 0, onGround: true, crouching: false, sliding: false };
const HOLD: WeaponInput = { fire: true, reload: false, melee: false, slot: 0, ads: false };
const check = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`verify failed: ${msg}`);
};

export interface WeaponScenario {
  name: string;
  description: string;
  seed: number;
  steps: WeaponVector["steps"];
  verify: (trace: WeaponState[], events: WeaponVector["events"]) => void;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzSteps(seed: number, ticks: number): WeaponVector["steps"] {
  const rnd = mulberry32(seed);
  const steps: WeaponVector["steps"] = [];
  let left = ticks;
  while (left > 0) {
    const n = Math.min(left, 3 + Math.floor(rnd() * 40));
    left -= n;
    steps.push({
      ticks: n,
      input: {
        fire: rnd() < 0.7,
        reload: rnd() < 0.08,
        melee: rnd() < 0.06,
        slot: 0,
        ads: rnd() < 0.3,
      },
      ctx: {
        hSpeed: rnd() < 0.4 ? 0 : rnd() * 15,
        onGround: rnd() < 0.8,
        crouching: rnd() < 0.2,
        sliding: rnd() < 0.15,
      },
    });
  }
  return steps;
}

export const weaponScenarios: WeaponScenario[] = [
  {
    name: "weapon-spray-hip",
    description: "Holding fire standing still: fire rate, recoil pattern and bloom growth.",
    seed: 1,
    steps: [{ ticks: 190, input: HOLD, ctx: STILL }], // 30 rounds at 10 per second = 3 s
    verify: (_t, ev) => {
      const shots = ev.filter((e) => e.fired);
      check(shots.length === 30, `a full magazine of shots, got ${shots.length}`);
      check(
        ev.some((e) => e.dryFire && e.reloadStarted),
        "auto reload after the magazine empties",
      );
    },
  },
  {
    name: "weapon-spray-ads-moving",
    description: "Aimed spray while running: ADS spread with movement bloom.",
    seed: 7,
    steps: [{ ticks: 90, input: { ...HOLD, ads: true }, ctx: { ...STILL, hSpeed: P.runSpeed } }],
    verify: (_t, ev) => check(ev.filter((e) => e.fired).length >= 14, "sprayed"),
  },
  {
    name: "weapon-reload-cycle",
    description: "Empty the magazine, reload automatically, keep firing afterwards.",
    seed: 3,
    steps: [{ ticks: 400, input: HOLD, ctx: STILL }],
    verify: (_t, ev) => {
      check(
        ev.some((e) => e.reloadFinished),
        "reload finished",
      );
      check(ev.filter((e) => e.fired).length > 30, "fired again after reloading");
    },
  },
  {
    name: "weapon-manual-reload",
    description: "Reload pressed mid magazine, no firing during it, then fire.",
    seed: 5,
    steps: [
      { ticks: 30, input: HOLD, ctx: STILL },
      {
        ticks: 1,
        input: { fire: false, reload: true, melee: false, slot: 0, ads: false },
        ctx: STILL,
      },
      { ticks: 20, input: HOLD, ctx: STILL }, // held fire during reload does nothing
      {
        ticks: 120,
        input: { fire: false, reload: false, melee: false, slot: 0, ads: false },
        ctx: STILL,
      },
      { ticks: 30, input: HOLD, ctx: STILL },
    ],
    verify: (_t, ev) => {
      check(
        ev.some((e) => e.reloadStarted && !e.dryFire),
        "manual reload started",
      );
      check(
        ev.some((e) => e.reloadFinished),
        "reload finished",
      );
    },
  },
  {
    name: "weapon-melee",
    description:
      "A melee swing: it lands after the wind-up, firing is locked while it plays out, and the next swing waits for the cooldown.",
    seed: 3,
    steps: [
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: true, slot: 0, ads: false },
        ctx: STILL,
      },
      { ticks: 10, input: HOLD, ctx: STILL }, // fire is held: locked out while swinging
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: true, slot: 0, ads: false },
        ctx: STILL,
      }, // too soon
      {
        ticks: 60,
        input: { fire: false, reload: false, melee: false, slot: 0, ads: false },
        ctx: STILL,
      },
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: true, slot: 0, ads: false },
        ctx: STILL,
      }, // cooled down
      { ticks: 30, input: HOLD, ctx: STILL },
    ],
    verify: (_t, ev) => {
      const started = ev.filter((e) => e.meleeStarted);
      const struck = ev.filter((e) => e.meleeStrike);
      check(started.length === 2 && struck.length === 2, "two swings, two blows");
      const first = started[0];
      const blow = struck[0];
      check(
        !!first && !!blow && blow.tick - first.tick === Math.ceil(P_WINDUP * 60),
        "the blow lands after the wind-up",
      );
      const firedEarly = ev.some((e) => e.fired && e.tick < 1 + Math.round(0.35 * 60));
      check(!firedEarly, "no shots while swinging");
      check(
        ev.some((e) => e.fired),
        "firing works again afterwards",
      );
    },
  },
  {
    name: "weapon-switch",
    description:
      "Switching guns: a draw time with no shooting, each gun keeps its own rounds, empty hands cannot shoot, and a reload is lost by switching.",
    seed: 6,
    steps: [
      { ticks: 12, input: HOLD, ctx: STILL }, // rifle: some shots
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: false, slot: 2, ads: false },
        ctx: STILL,
      },
      { ticks: 10, input: HOLD, ctx: STILL }, // switching: held fire does nothing yet
      { ticks: 120, input: HOLD, ctx: STILL }, // the sniper fires, slowly
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: false, slot: 1, ads: false },
        ctx: STILL,
      }, // back to the rifle
      { ticks: 30, input: HOLD, ctx: STILL },
      {
        ticks: 1,
        input: { fire: false, reload: true, melee: false, slot: 0, ads: false },
        ctx: STILL,
      }, // start a reload...
      {
        ticks: 5,
        input: { fire: false, reload: false, melee: false, slot: 0, ads: false },
        ctx: STILL,
      },
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: false, slot: 3, ads: false },
        ctx: STILL,
      }, // ...and drop to empty hands
      { ticks: 60, input: HOLD, ctx: STILL }, // empty hands: no shots, no reload
    ],
    verify: (trace, ev) => {
      const switches = ev.filter((e) => e.switched);
      check(switches.length === 3, "three switches");
      const first = switches[0];
      const firstShotAfter = ev.find((e) => e.fired && first && e.tick > first.tick);
      check(
        !!first && !!firstShotAfter && firstShotAfter.tick - first.tick >= Math.floor(0.4 * 60),
        "no shot until the draw is over",
      );
      const sniperShots = ev.filter(
        (e) => e.fired && first && e.tick > first.tick && e.tick < first.tick + 140,
      );
      check(sniperShots.length >= 2, "the sniper fired");
      const gap = (sniperShots[1]?.tick ?? 0) - (sniperShots[0]?.tick ?? 0);
      check(gap >= 80 && gap <= 88, "sniper shots are about 1.4 s apart");
      const last = trace[trace.length - 1];
      check(!!last && last.slot === 2, "ended with empty hands");
      check(!!last && last.reloadT === 0, "switching away lost the reload");
      const lastSwitch = switches[2];
      check(
        !ev.some((e) => lastSwitch && e.fired && e.tick > lastSwitch.tick),
        "empty hands cannot shoot",
      );
      check(
        (!!last && last.stash === 5 - 0) || (last?.stash ?? 0) <= 5,
        "the sniper's rounds were kept",
      );
    },
  },
  {
    name: "weapon-sniper",
    description:
      "The sniper alone: a shot every 1.4 s, five rounds, then an automatic 2.6 s reload, with pinpoint aim while scoped.",
    seed: 8,
    steps: [
      {
        ticks: 1,
        input: { fire: false, reload: false, melee: false, slot: 2, ads: true },
        ctx: STILL,
      },
      {
        ticks: 30,
        input: { fire: false, reload: false, melee: false, slot: 0, ads: true },
        ctx: STILL,
      },
      {
        ticks: 700,
        input: { fire: true, reload: false, melee: false, slot: 0, ads: true },
        ctx: STILL,
      },
    ],
    verify: (_t, ev) => {
      const shots = ev.filter((e) => e.fired);
      check(shots.length >= 6, "fired six shots in 12 seconds");
      check(
        shots
          .slice(0, 5)
          .every((e) => Math.abs(e.spreadYaw) < 1e-9 && Math.abs(e.spreadPitch) < 1e-9),
        "no spread while scoped and still",
      );
      check(
        ev.some((e) => e.dryFire && e.reloadStarted),
        "the empty magazine reloads by itself",
      );
      const done = ev.find((e) => e.reloadFinished);
      const start = ev.find((e) => e.reloadStarted);
      check(
        !!done && !!start && Math.abs(done.tick - start.tick - Math.ceil(2.6 * 60)) <= 1,
        "the reload takes 2.6 s",
      );
    },
  },
  {
    name: "weapon-tap-fire-resets-recoil",
    description: "Taps separated by pauses restart the recoil pattern each time.",
    seed: 9,
    steps: [
      { ticks: 12, input: HOLD, ctx: STILL },
      {
        ticks: 40,
        input: { fire: false, reload: false, melee: false, slot: 0, ads: false },
        ctx: STILL,
      },
      { ticks: 12, input: HOLD, ctx: STILL },
    ],
    verify: (_t, ev) => {
      const shots = ev.filter((e) => e.fired);
      const first = shots[0];
      const afterPause = shots.find((e) => e.tick > 40);
      check(
        !!first && !!afterPause && first.kickPitch === afterPause.kickPitch,
        "pattern restarted",
      );
    },
  },
  {
    name: "weapon-stance-changes",
    description: "Spread while standing, crouching, sliding and airborne during one spray.",
    seed: 11,
    steps: [
      { ticks: 30, input: HOLD, ctx: STILL },
      { ticks: 30, input: HOLD, ctx: { ...STILL, crouching: true } },
      {
        ticks: 30,
        input: HOLD,
        ctx: { hSpeed: 15, onGround: true, crouching: false, sliding: true },
      },
      {
        ticks: 30,
        input: HOLD,
        ctx: { hSpeed: 8, onGround: false, crouching: false, sliding: false },
      },
    ],
    verify: (_t, ev) =>
      check(ev.filter((e) => e.fired).length >= 19, "sprayed through every stance"),
  },
  {
    name: "weapon-fuzz",
    description: "1500 ticks of seeded random fire, reload, aim and movement context.",
    seed: 20260101,
    steps: fuzzSteps(4242, 1500),
    verify: (t, ev) => {
      check(
        ev.some((e) => e.fired) && ev.some((e) => e.reloadFinished),
        "exercised fire and reload",
      );
      check(
        t.every((w) => w.ammo >= 0 && w.ammo <= 30),
        "ammo in range",
      );
    },
  },
];

export function recordWeapon(sc: WeaponScenario): { vector: WeaponVector; trace: WeaponState[] } {
  const initial = spawnWeapon(sc.seed);
  const run = runWeaponSteps(initial, sc.steps, VECTOR_DT, 10);
  return {
    vector: {
      name: sc.name,
      description: sc.description,
      dt: VECTOR_DT,
      initial,
      steps: sc.steps,
      events: run.events,
      checkpoints: run.checkpoints,
    },
    trace: run.trace,
  };
}

// --- Hitscan ---------------------------------------------------------------

export interface HitscanScenario {
  name: string;
  description: string;
  world: VectorWorld;
  targets: Hitbox[];
  rays: { origin: [number, number, number]; dir: [number, number, number]; maxDist?: number }[];
  verify: (cases: HitscanCase[]) => void;
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

/** Rays from one eye point fanning out over a grid of yaw and pitch angles. */
function fan(
  origin: [number, number, number],
  yaws: number,
  pitches: number,
  yawRange: number,
  pitchRange: number,
  centreYaw = 0,
): HitscanScenario["rays"] {
  const rays: HitscanScenario["rays"] = [];
  for (let i = 0; i < yaws; i++) {
    for (let j = 0; j < pitches; j++) {
      const yaw = centreYaw + (i / (yaws - 1) - 0.5) * yawRange;
      const pitch = (j / (pitches - 1) - 0.5) * pitchRange;
      rays.push({ origin, dir: viewDirection(yaw, pitch) });
    }
  }
  return rays;
}

const inlineWorld = flatWorld({
  boxes: [box(0, 1, -12, 6, 2, 1), box(10, 2, -6, 2, 4, 6)],
  ramps: [{ box: box(-8, 0.75, -10, 4, 1.5, 6), rises: "-z" }],
});

export const hitscanScenarios: HitscanScenario[] = [
  {
    name: "hitscan-inline-fan",
    description:
      "A fan of rays through an arena with walls, a ramp, standing and crouched targets.",
    world: { boxes: inlineWorld.boxes, ramps: inlineWorld.ramps },
    targets: [target(1, 0, -6), target(2, 3, -8, 1.2), target(3, -3, -9, 1.0), target(4, 0, -20)],
    rays: fan([0, 1.6, 0], 41, 15, 1.6, 0.6),
    verify: (cases) => {
      check(
        cases.some((c) => c.expect.kind === "target" && c.expect.headshot),
        "a headshot",
      );
      check(
        cases.some((c) => c.expect.kind === "target" && !c.expect.headshot),
        "a body shot",
      );
      check(
        cases.some((c) => c.expect.kind === "world"),
        "a wall hit",
      );
      check(
        cases.some((c) => c.expect.kind === "none"),
        "a miss into the sky",
      );
      check(
        new Set(cases.filter((c) => c.expect.kind === "target").map((c) => c.expect.targetId))
          .size >= 3,
        "several targets",
      );
    },
  },
  {
    name: "hitscan-greybox-fan",
    description: "Rays from a greybox spawn across the level with targets at several ranges.",
    world: { level: "greybox" },
    targets: [target(1, 0, 22), target(2, 0, 8), target(3, -8, 14), target(4, 6, 20, 1.2)],
    rays: fan([0, 1.6, 34], 61, 17, 1.2, 0.5),
    verify: (cases) => {
      check(
        cases.some((c) => c.expect.kind === "target"),
        "hit a target",
      );
      check(
        cases.some((c) => c.expect.kind === "world"),
        "hit the level",
      );
    },
  },
  {
    name: "hitscan-edge-cases",
    description:
      "Hand-picked rays: from inside geometry, grazing edges, pointing down and up, short range.",
    world: { boxes: inlineWorld.boxes, ramps: inlineWorld.ramps },
    targets: [target(1, 0, -6)],
    rays: [
      { origin: [0, 1.6, 0], dir: [0, 0, -1] },
      { origin: [0, 1.6, 0], dir: [0, -1, 0] },
      { origin: [0, 1.6, 0], dir: [0, 1, 0] },
      { origin: [0.299, 1.0, 0], dir: [0, 0, -1] },
      { origin: [0.301, 1.0, 0], dir: [0, 0, -1] },
      { origin: [0, 1.5, 0], dir: [0, 0, -1] },
      { origin: [0, 1.4999, 0], dir: [0, 0, -1] },
      { origin: [0, 1.6, 0], dir: [0, 0, -1], maxDist: 3 },
      { origin: [0, 0.9, -11.6], dir: [0, 0, -1] },
      { origin: [-8, 0.2, 0], dir: [0, 0, -1] },
      { origin: [-8, 1.4, 0], dir: [0, 0, -1] },
      { origin: [-8, 3, 0], dir: [0, -0.3, -1] },
    ],
    verify: (cases) => {
      const first = cases[0];
      check(
        first?.expect.kind === "target" && first.expect.targetId === 1,
        "straight ahead hits the target",
      );
      check(cases[7]?.expect.kind !== "target", "max distance respected");
    },
  },
];

export function recordHitscan(sc: HitscanScenario): HitscanVector {
  const world = loadWorld(sc.world);
  const cases: HitscanCase[] = sc.rays.map((r) => {
    const dir = r.dir;
    const len = Math.hypot(...dir);
    const unit: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
    const maxDist = r.maxDist ?? 250;
    return {
      origin: r.origin,
      dir: unit,
      maxDist,
      expect: castRay(world, sc.targets, r.origin, unit, maxDist),
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
