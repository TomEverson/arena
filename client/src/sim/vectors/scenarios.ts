/**
 * Scenarios recorded into /testvectors/movement. Each one demonstrates a movement
 * feature and carries a `verify` that must hold, so a recording can never freeze a
 * broken behaviour. Inline worlds keep most of them independent of greybox.json.
 */
import { PARAMS as P, SKILL } from "../params";
import { box, flatWorld } from "../testutil";
import type { Aabb, PlayerInput, PlayerState, Ramp } from "../types";
import type { Scenario } from "./record";

type Trace = PlayerState[];
type Input = Partial<PlayerInput>;
type InputFn = (tick: number, s: PlayerState) => Input;

const F: Input = { moveZ: 1 };
const SLIDE_F: Input = { moveZ: 1, slide: true };

function inline(boxes: Aabb[] = [], ramps: Ramp[] = []) {
  const w = flatWorld({ boxes, ramps });
  return { boxes: w.boxes, ramps: w.ramps };
}

/** Input factory from [ticks, input] phases (the last phase repeats forever). */
function phases(list: [number, Input][]): { total: number; input: () => InputFn } {
  const total = list.reduce((n, [t]) => n + t, 0);
  return {
    total,
    input: () => (tick) => {
      let t = tick;
      for (const [len, input] of list) {
        if (t < len) return input;
        t -= len;
      }
      return list[list.length - 1]?.[1] ?? {};
    },
  };
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`verify failed: ${msg}`);
}
const last = (t: Trace): PlayerState => t[t.length - 1] as PlayerState;
const speed = (s: PlayerState) => Math.hypot(s.vx, s.vz);
const maxOf = (t: Trace, f: (s: PlayerState) => number) => Math.max(...t.map(f));
const any = (t: Trace, f: (s: PlayerState) => boolean) => t.some(f);

function scenario(
  name: string,
  description: string,
  world: Scenario["world"],
  start: [number, number, number],
  p: { total: number; input: () => InputFn },
  verify: (t: Trace) => void,
  overrides?: Partial<PlayerState>,
): Scenario {
  return { name, description, world, start, overrides, ticks: p.total, input: p.input, verify };
}

const PI = Math.PI;
const GREYBOX = { level: "greybox" };

// --- Pseudo-random input scripts (seeded, recorded as data) -----------------
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

export function fuzzInput(seed: number): () => InputFn {
  return () => {
    const rnd = mulberry32(seed);
    let left = 0;
    let held: Input = {};
    let yaw = 0;
    return () => {
      if (left <= 0) {
        left = 10 + Math.floor(rnd() * 35);
        yaw += (rnd() - 0.5) * 1.2;
        const axis = () => (rnd() < 0.3 ? 0 : rnd() < 0.5 ? -1 : 1) * (rnd() < 0.8 ? 1 : 0.5);
        held = {
          moveX: axis(),
          moveZ: rnd() < 0.8 ? 1 : axis(),
          yaw,
          slide: rnd() < 0.25,
          ads: rnd() < 0.15,
        };
      }
      left--;
      return { ...held, jump: rnd() < 0.04, dash: rnd() < 0.015 };
    };
  };
}

const fuzzBoxes: Aabb[] = [
  box(0, 0.5, -8, 4, 1, 4),
  box(8, 1, -4, 6, 2, 2),
  box(-8, 2, 4, 3, 4, 3),
  box(10, 4, 10, 3, 8, 3),
  box(0, 3, 14, 8, 1, 6),
  box(-14, 0.15, -2, 4, 0.3, 4),
  box(0, 1.7, 22, 6, 1, 10), // low ceiling
  box(0, 5, -31, 62, 10, 2),
  box(0, 5, 31, 62, 10, 2),
  box(-31, 5, 0, 2, 10, 62),
  box(31, 5, 0, 2, 10, 62),
];
const fuzzRamps: Ramp[] = [{ box: box(-14, 1.5, 12, 6, 3, 10), rises: "+z" }];
const fuzzWall: Aabb = box(0, 1.5, -12, 6, 3, 20);

export const scenarios: Scenario[] = [
  (() => {
    const p = phases([[120, {}]]);
    return scenario(
      "stand-and-fall",
      "Dropped from 5 m, lands and stays grounded.",
      inline(),
      [0, 5, 0],
      p,
      (t) => {
        check(last(t).onGround && last(t).y === 0, "should land on the floor");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [90, F],
    ]);
    return scenario(
      "run-accel",
      "Accelerates to exactly run speed, forward is -Z.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(Math.abs(speed(last(t)) - P.runSpeed) < 1e-9, "should reach run speed");
        check(last(t).vz < 0, "forward should be -Z");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [30, F],
    ]);
    const slowTicks = Math.round(P.hitSlowTime * 60);
    return scenario(
      "hit-slow",
      "Slowed by a bullet hit: running drops to the slowed speed, then comes back.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        const slowed = P.runSpeed * P.hitSlowMult;
        check(speed(t[3 + slowTicks] as PlayerState) < slowed + 0.05, "slowed while it lasts");
        check(speed(t[3 + slowTicks] as PlayerState) > slowed - 0.5, "but still running");
        check(last(t).slowT === 0, "the slow runs out");
        check(Math.abs(speed(last(t)) - P.runSpeed) < 0.05, "back to run speed");
      },
      { vx: 0, vz: -P.runSpeed, slowT: P.hitSlowTime + 3 / 60 },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [80, { moveX: 1, moveZ: 1, yaw: 0.7 }],
    ]);
    return scenario(
      "run-diagonal-yawed",
      "Diagonal input while turned is not faster.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(Math.abs(speed(last(t)) - P.runSpeed) < 1e-9, "diagonal must not exceed run speed");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, F],
      [60, {}],
    ]);
    return scenario(
      "stop-friction",
      "Friction brings the player to rest.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(speed(last(t)) < 0.01, "should stop");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [1, { jump: true }],
      [89, {}],
    ]);
    return scenario(
      "jump-apex",
      "Single jump reaches the expected height and lands.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        const apex = (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity);
        const peak = maxOf(t, (s) => s.y);
        check(peak > apex * 0.9 && peak < apex * 1.1, `apex ${peak}`);
        check(last(t).onGround, "should land");
      },
    );
  })(),

  (() => {
    const p = phases([
      [1, { jump: true }],
      [39, {}],
    ]);
    return scenario(
      "jump-buffer",
      "A jump pressed just before landing is buffered and fires on touchdown.",
      inline(),
      [0, 0.1, 0],
      p,
      (t) => check(maxOf(t, (s) => s.y) > 1, "buffered jump should fire"),
      { airJumps: 0 },
    );
  })(),

  (() => {
    const w = inline([box(0, 1, 0, 10, 2, 10)]);
    const input = (): InputFn => (t) => (t < 2 ? {} : { moveX: 1, jump: t === 10 });
    return scenario(
      "coyote-jump",
      "A jump a few ticks after running off a ledge still works.",
      w,
      [4, 2, 0],
      { total: 62, input },
      (t) => check(maxOf(t, (s) => s.y) > 3, "coyote jump should rise above the ledge"),
      { airJumps: 0 },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [1, { jump: true }],
      [17, {}],
      [1, { jump: true }],
      [100, {}],
    ]);
    return scenario(
      "double-jump",
      "A second press in the air gives extra height; landing refills it.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(maxOf(t, (s) => s.y) > 2.4, "double jump should go higher than a single jump");
        check(
          any(t, (s) => s.airJumps === 0),
          "air jump should be spent",
        );
        check(last(t).airJumps === P.maxAirJumps, "landing refills it");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 1, 0, 10, 2, 10)]);
    const input = (): InputFn => (t) => (t < 2 ? {} : { moveX: 1, jump: t === 32 });
    return scenario(
      "walk-off-then-air-jump",
      "After walking off a ledge the air jump is still available.",
      w,
      [4, 2, 0],
      { total: 70, input },
      (t) => {
        const y32 = (t[32] as PlayerState).y;
        check(maxOf(t.slice(32), (s) => s.y) - y32 > 1, "air jump should rise");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, F],
      [40, SLIDE_F],
      [40, {}],
    ]);
    return scenario(
      "slide-boost-and-end",
      "Running + slide boosts speed up to slide speed, decays, ends on release.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(
          any(t, (s) => s.sliding),
          "should slide",
        );
        check(
          maxOf(t, speed) <= P.slideSpeed + 1e-9 && maxOf(t, speed) > P.runSpeed + 1,
          "boosted to slide speed",
        );
        check(!last(t).sliding && !last(t).crouching, "released");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, F],
      [10, SLIDE_F],
      [1, { ...SLIDE_F, jump: true }],
      [40, F],
    ]);
    return scenario(
      "slide-jump",
      "Jumping out of a slide keeps most of its momentum, not all.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        const j = t[75] as PlayerState;
        check(!j.sliding && j.vy > 0, "jumped out of the slide");
        check(speed(j) > 10, "kept speed");
        const before = speed(t[73] as PlayerState);
        check(Math.abs(speed(j) - before * P.slideJumpKeep) < 0.3, "but paid for the jump");
      },
    );
  })(),

  (() => {
    // Hold the slide key and jump the moment each slide starts: the old endless slide-jump.
    const input = (): InputFn => (t, s) =>
      t < 63 ? (t < 3 ? {} : F) : { ...SLIDE_F, jump: s.onGround && s.sliding };
    return scenario(
      "slide-jump-chain",
      "Chained slide-jumps wind down: each jump costs speed and the boost is on a cooldown.",
      inline(),
      [0, 0, 0],
      { total: 63 + 600, input },
      (t) => {
        const chain = t.slice(63);
        const dist = Math.abs(last(t).z - (t[63] as PlayerState).z);
        check(maxOf(chain, speed) > 14, "the first slide still boosts");
        check(dist / 10 > P.runSpeed - 0.2, "never slower than running");
        check(dist / 10 < 10, "but far from holding slide speed");
        check(
          Math.min(...chain.slice(120).map(speed)) > P.runSpeed - 0.5,
          "no dip below run speed",
        );
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, F],
      [2, SLIDE_F],
      [200, { slide: true }],
    ]);
    return scenario(
      "slide-to-crouch",
      "A slide that runs out with the key held settles into a crouch.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(
          any(t, (s) => s.sliding),
          "should slide first",
        );
        check(last(t).crouching && !last(t).sliding, "should end crouched");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [10, { slide: true }],
      [90, SLIDE_F],
    ]);
    return scenario(
      "crouch-walk",
      "Crouching from standing; walking while crouched is capped at crouch speed.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(last(t).crouching, "crouching");
        check(Math.abs(speed(last(t)) - P.crouchSpeed) < 1e-9, "crouch speed");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 1.7, -10, 4, 1, 20)]); // underside at 1.2
    const p = phases([
      [3, {}],
      [20, F],
      [50, SLIDE_F],
      [30, F],
      [400, F],
    ]);
    return scenario(
      "crouch-low-ceiling",
      "Slide into a low tunnel, cannot stand inside, crawl out and stand.",
      w,
      [0, 0, 10],
      p,
      (t) => {
        check(
          any(t, (s) => s.z < -1 && s.z > -19 && (s.sliding || s.crouching)),
          "stayed low under the ceiling",
        );
        check(
          last(t).z < -20.5 && !last(t).sliding && !last(t).crouching,
          "stood up after leaving",
        );
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [1, { ...F, dash: true }],
      [40, F],
    ]);
    return scenario(
      "dash-ground",
      "Dash covers a fixed distance and spends a charge.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(t[0] !== undefined && -last(t).z > 5, "dash distance");
        check(
          any(t, (s) => s.dashTime > 0),
          "dashed",
        );
      },
    );
  })(),

  (() => {
    const D: Input = { ...F, dash: true };
    const REGEN = Math.ceil(P.dashRegenTime * 60) + 20; // long enough for one charge to come back
    const p = phases([
      [3, {}],
      [1, D],
      [19, F],
      [1, D],
      [19, F],
      [1, D],
      [REGEN, F],
      [1, D],
      [40, F],
    ]);
    return scenario(
      "dash-charges",
      "Two dashes, the third has no charge, one regenerates later.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check((t[4] as PlayerState).dashTime > 0, "first dash");
        check((t[24] as PlayerState).dashTime > 0, "second dash");
        check((t[44] as PlayerState).dashTime === 0, "no charge for the third");
        check((t[45 + REGEN] as PlayerState).dashTime > 0, "regenerated charge");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [1, { ...F, dash: true }],
      [10, F],
    ]);
    return scenario(
      "dash-air",
      "Dashing in mid-air ignores gravity.",
      inline(),
      [0, 10, 0],
      p,
      (t) => {
        const y3 = (t[3] as PlayerState).y;
        check(Math.abs((t[8] as PlayerState).y - y3) < 0.5, "held height during the dash");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 2, -5, 10, 4, 0.2)]);
    const input = (): InputFn => (t) => (t < 3 ? {} : { ...F, dash: (t - 3) % 20 === 0 });
    return scenario(
      "dash-thin-wall",
      "Dashing into a 0.2 m wall never tunnels through.",
      w,
      [0, 0, 0],
      { total: 123, input },
      (t) => {
        check(last(t).z > -5 + 0.1 + P.halfWidth - 1e-6, "stayed in front of the wall");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 2, -10, 4, 4, 4)]);
    const p = phases([
      [3, {}],
      [120, { moveZ: 1, yaw: -PI / 4 }],
    ]);
    return scenario(
      "corner-outer",
      "Running diagonally into an outer corner slides around it.",
      w,
      [-4, 0, -6],
      p,
      (t) => {
        const s = last(t);
        check(!(Math.abs(s.x) < 2.3 && s.z < -7.7 && s.z > -12.3), "not inside the pillar");
        check(s.z < -6, "made progress");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 2, -12, 12, 4, 1), box(6, 2, -6, 1, 4, 12)]);
    const p = phases([
      [3, {}],
      [150, { moveZ: 1, yaw: -PI / 4 }],
    ]);
    return scenario(
      "corner-inner",
      "Running diagonally into an inner corner stops cleanly.",
      w,
      [0, 0, -2],
      p,
      (t) => {
        const s = last(t);
        check(
          s.x <= 5.5 - P.halfWidth + 1e-6 && s.z >= -11.5 + P.halfWidth - 1e-6,
          "stopped inside the corner",
        );
        check(speed(s) < 0.5, "at rest");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 0.15, -30, 4, 0.3, 56)]);
    const p = phases([
      [3, {}],
      [90, F],
    ]);
    return scenario(
      "step-up",
      "A 0.3 m ledge is stepped onto without leaving the ground.",
      w,
      [0, 0, 0],
      p,
      (t) => {
        check(Math.abs(last(t).y - 0.3) < 1e-9 && last(t).onGround, "on top of the step");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 3.5, 0, 10, 1, 10)]);
    const p = phases([
      [3, {}],
      [1, { jump: true }],
      [40, {}],
    ]);
    return scenario(
      "ceiling-bonk",
      "Jumping under a ceiling stops the rise.",
      w,
      [0, 0, 0],
      p,
      (t) => {
        check(maxOf(t, (s) => s.y) + P.standHeight <= 3 + 1e-6, "head stopped by the ceiling");
      },
    );
  })(),

  (() => {
    const w = inline(
      [box(0, 1.5, -46, 6, 3, 60)],
      [{ box: box(0, 1.5, -10, 6, 3, 12), rises: "-z" }],
    );
    const p = phases([
      [3, {}],
      [240, F],
      [200, { moveZ: 1, yaw: PI }],
    ]);
    return scenario(
      "ramp-up-down",
      "Walk up a 3 m ramp onto a platform and back down without hopping.",
      w,
      [0, 0, 0],
      p,
      (t) => {
        check(maxOf(t, (s) => s.y) > 2.99, "reached the top");
        check(t.slice(250).filter((s) => !s.onGround).length < 3, "stays grounded on the way down");
        check(last(t).y < 3, "came back down");
      },
    );
  })(),

  (() => {
    const w = inline([], [{ box: box(0, 1.5, -10, 6, 3, 12), rises: "+z" }]);
    const p = phases([
      [3, {}],
      [200, F],
    ]);
    return scenario(
      "ramp-tall-side",
      "The tall side of a ramp is a wall.",
      w,
      [0, 0, 10],
      p,
      (t) => {
        check(last(t).y === 0 && last(t).z > -4, "blocked by the tall side");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 1, -12, 6, 2, 20)]);
    const input = (): InputFn => (t) => (t < 3 ? {} : { ...F, jump: t === 43 });
    return scenario(
      "mantle-2m",
      "A jump into a 2 m ledge mantles up onto it.",
      w,
      [0, 0, 3],
      { total: 123, input },
      (t) => {
        check(
          any(t, (s) => s.mantling),
          "mantled",
        );
        check(Math.abs(last(t).y - 2) < 1e-9 && last(t).onGround, "on top");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 3.5, -12, 6, 7, 20)]);
    const input = (): InputFn => (t) => (t < 3 ? {} : { ...F, jump: t % 30 === 0 });
    return scenario(
      "mantle-too-high",
      "A 7 m wall is out of mantle reach, even kicking up it with wall jumps.",
      w,
      [0, 0, 3],
      { total: 123, input },
      (t) => {
        check(
          !any(t, (s) => s.mantling) && maxOf(t, (s) => s.y) < 7,
          "could not mantle onto the 7 m wall",
        );
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, { moveZ: 1, ads: true }],
    ]);
    return scenario(
      "ads-run",
      "Aiming down sights slows ground movement.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(Math.abs(speed(last(t)) - P.runSpeed * P.adsSpeedMult) < 1e-9, "ads speed");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, { moveZ: 1, ads: true, adsSpeedMult: 0.35 }],
    ]);
    return scenario(
      "ads-run-sniper",
      "Aiming a sniper slows ground movement much more than the rifle (0.35 of run speed).",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        check(Math.abs(speed(last(t)) - P.runSpeed * 0.35) < 1e-9, "sniper ads speed");
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [60, { moveZ: 1, runSpeedMult: 1.15 }],
      [1, { moveZ: 1, runSpeedMult: 1.15, jump: true }],
      [40, { moveZ: 1, runSpeedMult: 1.15 }],
    ]);
    return scenario(
      "run-empty-hands",
      "Empty hands run faster (1.15 of run speed), on the ground and through a jump.",
      inline(),
      [0, 0, 0],
      p,
      (t) => {
        const onGroundRun = t[63] as PlayerState;
        check(Math.abs(speed(onGroundRun) - P.runSpeed * 1.15) < 1e-9, "faster on the ground");
        check(
          t.slice(65).every((s) => speed(s) >= P.runSpeed * 1.15 - 1e-9),
          "keeps the speed through the jump",
        );
      },
    );
  })(),

  // --- Routes through the real greybox level ---
  (() => {
    const p = phases([
      [3, {}],
      [210, { moveZ: 1, yaw: PI }],
    ]);
    return scenario(
      "greybox-ramp-platform",
      "Greybox: walk up the 3 m ramp onto its platform.",
      GREYBOX,
      [30, 0, -32],
      p,
      (t) => {
        check(Math.abs(last(t).y - 3) < 1e-9 && last(t).onGround, "on the platform");
      },
    );
  })(),

  (() => {
    const input = (): InputFn => (t) => (t < 3 ? {} : { ...F, jump: t > 33 && t % 20 === 0 });
    return scenario(
      "greybox-mantle-wall",
      "Greybox: jump-mantle the 2 m wall.",
      GREYBOX,
      [12, 0, -4],
      { total: 153, input },
      (t) => {
        check(
          any(t, (s) => s.mantling) && any(t, (s) => s.onGround && Math.abs(s.y - 2) < 1e-9),
          "mantled onto the 2 m wall",
        );
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [22, { ...F }],
      [65, SLIDE_F],
      [240, F],
    ]);
    return scenario(
      "greybox-slide-tunnel",
      "Greybox: slide through the low tunnel and stand up beyond.",
      GREYBOX,
      [-20, 0, 30],
      p,
      (t) => {
        check(
          any(t, (s) => s.z < 18 && s.z > 6 && s.sliding),
          "slid under the ceiling",
        );
        check(last(t).z < 3 && !last(t).sliding && !last(t).crouching, "stood up on the far side");
      },
    );
  })(),

  (() => {
    const input = (): InputFn => {
      let airTicks = 0;
      return (_t, s) => {
        if (!s.onGround) airTicks++;
        return {
          ...F,
          yaw: -PI / 2,
          jump: s.onGround && s.x > 7.2 && s.x < 8,
          dash: airTicks === 6,
        };
      };
    };
    return scenario(
      "greybox-dash-gap",
      "Greybox: run, jump and dash across the 9 m gap.",
      GREYBOX,
      [3, 2, 15],
      { total: 150, input },
      (t) => {
        check(
          any(t, (s) => s.onGround && s.x > 17 && s.x < 23 && Math.abs(s.y - 2) < 1e-6),
          "landed on the far platform",
        );
      },
    );
  })(),

  (() => {
    const p = phases([
      [3, {}],
      [120, F],
    ]);
    return scenario(
      "greybox-step",
      "Greybox: walk over the 0.3 m step without leaving the ground.",
      GREYBOX,
      [-30, 0, 36],
      p,
      (t) => {
        check(
          t.slice(3).every((s) => s.onGround),
          "never airborne",
        );
      },
    );
  })(),

  // --- Wall run and wall jump ---
  // A long tall wall on the right (+X side, face at x = 0.8), run along it facing -Z.
  (() => {
    const w = inline([box(1.8, 5, -30, 2, 10, 70)]);
    const input = (): InputFn => (t) => ({ ...F, jump: t === 25 });
    return scenario(
      "wallrun-basic",
      "Jump beside a tall wall at run speed: run along it with almost no fall, until the time limit.",
      w,
      [0.5, 0, 0],
      { total: 230, input },
      (t) => {
        const run = t.filter((s) => s.wallRunning);
        check(run.length > 60, "wall-ran for a good while");
        check(
          run.every((s) => speed(s) >= P.wallRunSpeed - 0.3 && speed(s) < P.wallRunSpeed + 2.5),
          "kept wall-run speed",
        );
        check(maxOf(t, (s) => s.wallRunTime) <= P.wallRunMaxTime + 0.02, "time limit");
        check(!last(t).wallRunning && last(t).onGround, "ended and landed");
        const startY = (run[0] as PlayerState).y;
        const endY = (run[run.length - 1] as PlayerState).y;
        check(Math.abs(endY - startY) < 3, "stayed at about the same height while running");
      },
    );
  })(),

  (() => {
    const w = inline([box(1.8, 5, -30, 2, 10, 70)]);
    const input = (): InputFn => (t, s) => ({ ...F, jump: t === 25 || (s.wallRunning && t > 50) });
    return scenario(
      "wallrun-jump",
      "Jump off a wall run: kicked away from the wall and up, one air jump given back.",
      w,
      [0.5, 0, 0],
      { total: 110, input },
      (t) => {
        const i = t.findIndex(
          (s, k) => k > 50 && !s.wallRunning && (t[k - 1] as PlayerState).wallRunning,
        );
        check(i > 0, "left the wall run");
        const before = t[i - 1] as PlayerState;
        const after = t[i] as PlayerState;
        check(after.vx < before.vx - 4, "kicked away from the wall (-X)");
        check(after.vy > P.wallJumpSpeed - 1, "kicked up");
        check(after.wallJumps === 1, "counted the wall jump");
        check(after.airJumps === P.maxAirJumps, "air jump available");
      },
    );
  })(),

  (() => {
    const w = inline([box(1.8, 5, -30, 2, 10, 70)]);
    const input = (): InputFn => (t) => ({ moveZ: 0.3, jump: t === 25 });
    return scenario(
      "wallrun-too-slow",
      "Walking pace beside a wall is too slow to wall run.",
      w,
      [0.5, 0, 0],
      { total: 80, input },
      (t) => {
        check(!any(t, (s) => s.wallRunning), "never wall ran");
      },
    );
  })(),

  (() => {
    // A tall wall 20 m ahead (face at z = -20). The Assassin looks up at it, hooks it and reels in.
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({ hero: 1, pitch: 0.4, skillQ: t === 5, reel: t >= 5 });
    return scenario(
      "grapple-pull",
      "The Assassin hooks a wall and holds the button: reeled in faster and faster up to grapple speed, then let go at the wall with the speed kept.",
      w,
      [0, 0, 0],
      { total: 120, input },
      (t) => {
        check(
          any(t, (s) => s.grappling),
          "grappled",
        );
        check(
          Math.abs(maxOf(t, (s) => Math.hypot(s.vx, s.vy, s.vz)) - SKILL.grappleSpeed) < 0.01,
          "reached grapple speed and no more",
        );
        check(Math.min(...t.map((s) => s.z)) < -19, "reached the wall");
        check(!last(t).grappling, "let go");
        check(maxOf(t, (s) => s.y) > 8, "flung on up the wall");
        check(
          t.every((s) => s.z > -20 + P.halfWidth - 1e-6),
          "never went into the wall",
        );
        const used = t.find((s) => s.grappling);
        check(
          used !== undefined && used.grappleCharges < SKILL.grappleCharges - 0.9,
          "spent a charge",
        );
        check(used !== undefined && used.airJumps === P.maxAirJumps, "the air jump is back");
      },
    );
  })(),

  (() => {
    // A beam 13 m up. Run at it, hook it, reel for half a second, then let go of the button.
    const w = inline([box(0, 14, -12, 30, 2, 4)]);
    const input = (): InputFn => (t) => ({
      hero: 1,
      moveZ: 1,
      pitch: 0.5,
      skillQ: t === 20,
      reel: t >= 20 && t < 50,
      slide: t === 120,
    });
    return scenario(
      "grapple-swing",
      "Reel for a moment, then let go of the button: the line stays as long as it is and you swing under the hook like a pendulum, until crouch drops you.",
      w,
      [0, 0, 14],
      { total: 150, input },
      (t) => {
        const swing = t.slice(51, 120);
        check(
          swing.every((s) => s.grappling),
          "stayed on the line",
        );
        const len = swing[0]?.grappleLen ?? 0;
        check(
          swing.every((s) => s.grappleLen === len),
          "the line keeps its length when not reeling",
        );
        const hook = swing[0] as PlayerState;
        const dist = (s: PlayerState) =>
          Math.hypot(
            hook.grappleX - s.x,
            hook.grappleY - (s.y + P.standHeight / 2),
            hook.grappleZ - s.z,
          );
        check(
          swing.every((s) => dist(s) < len + 0.6),
          "never further from the hook than the line is long",
        );
        check(
          swing.some((s) => s.vy < -2) && swing.some((s) => s.vy > 5),
          "swung down and back up",
        );
        check(t[121]?.grappling === false, "crouch lets go");
        check(
          Math.hypot(t[121]?.vx ?? 0, t[121]?.vy ?? 0, t[121]?.vz ?? 0) > 8,
          "with the speed kept",
        );
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 14, -12, 30, 2, 4)]);
    const input = (): InputFn => (t) => ({ hero: 1, pitch: 0.55, skillQ: t === 5, reel: t >= 5 });
    return scenario(
      "grapple-stall",
      "Reeling into a hook you cannot reach (the underside of a beam): it circles, stops getting closer, and lets go.",
      w,
      [0, 0, 6],
      { total: 110, input },
      (t) => {
        check(t[60]?.grappling === true, "reeled in");
        check(!last(t).grappling, "let go once stalled");
        check(
          maxOf(t, (s) => s.grappleStall) >= SKILL.grappleStallTime - 0.02,
          "because it stalled",
        );
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({
      hero: 1,
      moveZ: t < 60 ? 1 : 0,
      pitch: 0.4,
      skillQ: t === 5,
      jump: t === 75,
    });
    return scenario(
      "grapple-landing",
      "A tap from the ground without reeling: the hook kicks you forward, and landing keeps the line (you walk as usual on it); only the jump lets it go.",
      w,
      [0, 0, 0],
      { total: 100, input },
      (t) => {
        check(t[6]?.grappling === true, "hooked");
        check(
          t.slice(6, 75).every((s) => s.grappling),
          "the line is kept with the button up, in the air and on the ground",
        );
        check(
          t.filter((s) => s.grappling && s.onGround).length > 30,
          "also standing on the ground",
        );
        check(
          Math.abs(speed(t[58] as PlayerState) - P.runSpeed) < 0.5,
          "walking as usual on the line",
        );
        check(speed(t[74] as PlayerState) < 0.5, "and standing still on it");
        check(t[77]?.grappling === false, "the jump lets go");
      },
    );
  })(),

  (() => {
    // Hook the wall up to the left, then up to the right without letting go: a V.
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({
      hero: 1,
      pitch: 0.4,
      yaw: t < 8 ? 0.5 : -0.5,
      skillQ: t === 5 || t === 9,
      reel: t >= 5,
    });
    return scenario(
      "grapple-v",
      "A second grapple in the middle of a pull adds a hook: reeling goes up the middle of the two, and lets go once between them.",
      w,
      [0, 0, 0],
      { total: 120, input },
      (t) => {
        const both = t.filter((s) => s.grappling && s.grapple2);
        check(both.length > 10, "pulled by two hooks for a while");
        const first = both[0] as PlayerState;
        check(first.grappleX < -5 && first.grapple2X > 5, "one hook to the left, one to the right");
        const end = both[both.length - 1] as PlayerState;
        check(Math.abs(end.x) < 5, "stayed between the hooks");
        check(end.z < -8 && end.z > -19.5, "let go before the wall, once between the hooks");
        check(end.vz < -10, "going up the middle, fast");
        check(!last(t).grappling && !last(t).grapple2, "both hooks released");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({
      hero: 1,
      pitch: 0.4,
      skillQ: t === 5,
      reel: t >= 5,
      jump: t === 15,
    });
    return scenario(
      "grapple-jump-release",
      "A jump in the middle of a pull lets go with a hop, keeping the speed.",
      w,
      [0, 0, 0],
      { total: 90, input },
      (t) => {
        check(t[12]?.grappling === true && t[16]?.grappling === false, "let go on the jump");
        check((t[16]?.vy ?? 0) >= SKILL.grappleHop - 1, "hopped");
        check((t[16]?.vz ?? 0) < -8, "kept its speed toward the wall");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const AIM = { hero: 1, pitch: 0.4 };
    const input = (): InputFn => (t) => ({ ...AIM, skillQ: t % 3 === 0 });
    return scenario(
      "grapple-out-of-range",
      "Grapple pressed with nothing within range: no pull, and no charge is spent.",
      w,
      [0, 0, 80],
      { total: 60, input },
      (t) => {
        check(!any(t, (s) => s.grappling), "out of range: no pull");
        check(last(t).grappleCharges === SKILL.grappleCharges, "no charge spent on a miss");
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({ hero: 1, pitch: 0.4, skillQ: t % 3 === 0, reel: true });
    const total = Math.round(SKILL.grappleRegen * 60 + 60);
    return scenario(
      "grapple-charges",
      "Grapple pressed over and over: two hooks in a row, then nothing until a charge comes back.",
      w,
      [0, 0, -5],
      { total, input },
      (t) => {
        const before = (i: number) =>
          i > 0 ? (t[i - 1]?.grappleCharges ?? 0) : SKILL.grappleCharges;
        const spent = t
          .map((s, i) => (s.grappleCharges < before(i) - 0.5 ? i : -1))
          .filter((i) => i >= 0);
        check(spent.length >= 3, `three hooks or more in all (got ${spent.length})`);
        check((spent[1] ?? 99) - (spent[0] ?? 0) <= 3, "the second straight after the first");
        check(
          (spent[2] ?? 0) - (spent[0] ?? 0) >= SKILL.grappleRegen * 60 - 6,
          "the third only when a charge is back",
        );
      },
    );
  })(),

  (() => {
    const w = inline([box(0, 10, -25, 40, 20, 10)]);
    const input = (): InputFn => (t) => ({ hero: 0, pitch: 0.4, skillQ: t === 5, reel: t >= 5 });
    return scenario(
      "grapple-not-trooper",
      "The Trooper pressing the same button does not grapple.",
      w,
      [0, 0, 0],
      { total: 40, input },
      (t) => {
        check(!any(t, (s) => s.grappling), "no pull");
        check(last(t).z === 0 && last(t).onGround, "stood still");
      },
    );
  })(),

  (() => {
    const input = (): InputFn => (t) => ({ hero: 1, moveZ: 1, dash: t === 20 });
    return scenario(
      "assassin-no-dash",
      "The Assassin has no dash: the button does nothing to its movement (it is the spinning slash).",
      inline([]),
      [0, 0, 0],
      { total: 60, input },
      (t) => {
        check(!any(t, (s) => s.dashTime > 0), "never dashed");
        check(maxOf(t, speed) <= P.runSpeed + 1e-6, "never faster than a run");
      },
    );
  })(),

  (() => {
    const input = (): InputFn => (t) => ({ hero: 1, jump: t === 5 || t === 25 });
    return scenario(
      "assassin-no-air-jump",
      "The Assassin has no double jump: a second press in the air does nothing.",
      inline([]),
      [0, 0, 0],
      { total: 80, input },
      (t) => {
        const peak = maxOf(t, (s) => s.y);
        check(
          peak < (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity) + 0.05,
          "only one jump's height",
        );
        check(last(t).onGround, "back on the ground");
      },
    );
  })(),

  (() => {
    // Already diving (the dive is started by the weapon step, outside the movement function):
    // forward and down from 60 m up, high enough not to reach the ground.
    const dir = { rollDirX: 0, rollDirY: -Math.SQRT1_2, rollDirZ: -Math.SQRT1_2 };
    return scenario(
      "roll-dive",
      "The rolling dive: straight along its aim at dive speed with no gravity, ending when its time is up, with part of the speed kept.",
      inline([]),
      [0, 60, 0],
      phases([[Math.round(SKILL.rollTime * 60) + 12, { hero: 1 }]]),
      (t) => {
        // (t[0] is the state before the first tick: diving, but not yet moving.)
        const diving = t.slice(1).filter((s) => s.rollT > 0);
        check(diving.length >= Math.round(SKILL.rollTime * 60) - 3, "dived for its time");
        check(
          diving.every((s) => Math.abs(Math.hypot(s.vx, s.vy, s.vz) - SKILL.rollSpeed) < 1e-6),
          "at dive speed, in a straight line",
        );
        const after = t[diving.length + 1] as PlayerState;
        check(
          Math.abs(
            Math.hypot(after.vx, after.vy, after.vz) - SKILL.rollSpeed * SKILL.rollExitScale,
          ) < 0.6,
          "then let go with part of the speed",
        );
      },
      { rollT: SKILL.rollTime, ...dir, onGround: false },
    );
  })(),

  (() => {
    const dir = { rollDirX: 0, rollDirY: -1, rollDirZ: 0 };
    return scenario(
      "roll-slam",
      "A dive straight down ends the moment it hits the ground.",
      inline([]),
      [0, 4, 0],
      phases([[40, { hero: 1 }]]),
      (t) => {
        const landed = t.findIndex((s) => s.onGround);
        check(
          landed > 0 && landed < Math.round(SKILL.rollTime * 60),
          "hit the ground before its time was up",
        );
        check((t[landed]?.rollT ?? 1) === 0, "and the dive ended there");
        check(last(t).y === 0, "on the floor");
      },
      { rollT: SKILL.rollTime, ...dir, onGround: false },
    );
  })(),

  (() => {
    // Facing the wall (it is in front, face at z = -8): jump presses in the air kick off it.
    const w = inline([box(0, 5, -13, 40, 10, 10)]);
    const input = (): InputFn => (t) => ({ ...F, jump: t === 30 || t % 24 === 0 });
    return scenario(
      "walljump-touch",
      "Jump into a wall face and press jump again in the air: kicks off it, at most wallJumpMax times.",
      w,
      [0, 0, -4],
      { total: 240, input },
      (t) => {
        check(
          any(t, (s) => s.wallJumps >= 1),
          "wall jumped",
        );
        check(maxOf(t, (s) => s.wallJumps) === P.wallJumpMax, "limited to wallJumpMax");
        check(
          any(t, (s) => s.vz > 5),
          "kicked away from the wall (+Z)",
        );
      },
    );
  })(),

  (() => {
    // Two parallel walls 3 m apart (faces at x = -1.5 and x = 1.5): zig-zag between them.
    const w = inline([box(3, 5, -40, 3, 10, 120), box(-3, 5, -40, 3, 10, 120)]);
    const input = (): InputFn => (t, s) => ({
      ...F,
      jump: t === 25 || (s.wallRunning && s.wallRunTime > 0.25),
    });
    return scenario(
      "wallrun-zigzag",
      "Wall run, kick across to the other wall, wall run again: both walls get used.",
      w,
      [1.2, 0, 0],
      { total: 120, input },
      (t) => {
        const sides = new Set(t.filter((s) => s.wallRunning).map((s) => Math.sign(s.wallNormalX)));
        check(sides.has(1) && sides.has(-1), "ran on both walls");
        check(maxOf(t, (s) => s.wallJumps) >= 1, "kicked between them");
      },
    );
  })(),

  // --- Seeded pseudo-random runs ---
  scenario(
    "fuzz-inline",
    "900 ticks of seeded random input in a small arena with boxes, a ramp, a pillar and a low ceiling.",
    { boxes: flatWorld({ boxes: fuzzBoxes }).boxes, ramps: fuzzRamps },
    [0, 0, 0],
    { total: 900, input: fuzzInput(12345) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
      check(
        t.every((s) => Math.abs(s.x) < 31 && Math.abs(s.z) < 31),
        "stayed in the arena",
      );
    },
  ),
  scenario(
    "fuzz-greybox",
    "900 ticks of seeded random input through the greybox level.",
    GREYBOX,
    [0, 0, 34],
    { total: 900, input: fuzzInput(987654) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
      check(
        t.every((s) => Math.abs(s.x) < 41 && Math.abs(s.z) < 41),
        "stayed in the arena",
      );
    },
  ),
  scenario(
    "fuzz-ffa",
    "900 ticks of seeded random input through the FFA map (pit, bridges, decks, buildings).",
    { level: "ffa" },
    [0, 0, 26],
    { total: 900, input: fuzzInput(424242) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
      check(
        t.every((s) => Math.abs(s.x) < 101 && Math.abs(s.z) < 101),
        "stayed in the arena",
      );
    },
  ),
  scenario(
    "fuzz-ffa-pit",
    "900 ticks of seeded random input starting in the pit of the FFA map (ramps, tunnel, pillars).",
    { level: "ffa" },
    [7, -3, 2],
    { total: 900, input: fuzzInput(515151) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
      check(
        t.every((s) => Math.abs(s.x) < 101 && Math.abs(s.z) < 101),
        "stayed in the arena",
      );
    },
  ),
  scenario(
    "fuzz-ffa-high",
    "900 ticks of seeded random input starting on the north deck of the FFA map (decks, roofs, catwalks).",
    { level: "ffa" },
    [10, 4, -27],
    { total: 900, input: fuzzInput(626262) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
      check(
        t.every((s) => Math.abs(s.x) < 101 && Math.abs(s.z) < 101),
        "stayed in the arena",
      );
    },
  ),
  scenario(
    "fuzz-inline-2",
    "A second seeded random run (different seed, start in a corner of the inline arena).",
    { boxes: flatWorld({ boxes: [...fuzzBoxes, fuzzWall] }).boxes, ramps: fuzzRamps },
    [-20, 0, 20],
    { total: 900, input: fuzzInput(424242) },
    (t) => {
      check(
        t.every((s) => [s.x, s.y, s.z, s.vx, s.vy, s.vz].every(Number.isFinite)),
        "finite",
      );
    },
  ),
];
