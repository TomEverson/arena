import { describe, expect, it } from "vitest";

import { castRay, type Hitbox, rayAabb } from "./hitscan";
import { PARAMS, WEAPON as W } from "./params";
import { box, flatWorld } from "./testutil";
import {
  applyDamage,
  damageFor,
  fullHealth,
  spawnWeapon,
  spreadDegrees,
  stepWeapon,
  viewDirection,
  type WeaponInput,
  type WeaponState,
} from "./weapon";

const DT = 1 / 60;
const idle: WeaponInput = { fire: false, reload: false, melee: false, ads: false };
const still = { hSpeed: 0, onGround: true, crouching: false, sliding: false };

function fire(
  w: WeaponState,
  ticks: number,
  input: Partial<WeaponInput> = {},
  ctx = still,
): { w: WeaponState; shots: number; kicks: number[] } {
  let shots = 0;
  const kicks: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = stepWeapon(w, { ...idle, fire: true, ...input }, ctx, DT);
    w = r.state;
    if (r.shot.fired) {
      shots++;
      kicks.push(r.shot.kickPitch);
    }
  }
  return { w, shots, kicks };
}

describe("fire control", () => {
  it("fires at the configured rate", () => {
    const { shots } = fire(spawnWeapon(), 60); // 1 second
    expect(shots).toBeGreaterThanOrEqual(W.rpm / 60 - 1);
    expect(shots).toBeLessThanOrEqual(W.rpm / 60 + 1);
  });

  it("does not fire when the button is not held", () => {
    const r = stepWeapon(spawnWeapon(), idle, still, DT);
    expect(r.shot.fired).toBe(false);
  });

  it("empties the magazine and then reloads by itself", () => {
    let w = spawnWeapon();
    let shots = 0;
    for (let i = 0; i < 1000 && w.ammo > 0; i++) {
      const r = stepWeapon(w, { ...idle, fire: true }, still, DT);
      w = r.state;
      if (r.shot.fired) shots++;
    }
    expect(shots).toBe(W.magSize);
    expect(w.ammo).toBe(0);
    w = fire(w, 10, { fire: false }).w; // let the shot cooldown expire
    const r = stepWeapon(w, { ...idle, fire: true }, still, DT);
    expect(r.shot.fired).toBe(false);
    expect(r.shot.dryFire).toBe(true);
    expect(r.state.reloadT).toBeGreaterThan(0);
  });

  it("reloads in the configured time and cannot fire meanwhile", () => {
    let w = { ...spawnWeapon(), ammo: 3 };
    w = stepWeapon(w, { ...idle, reload: true }, still, DT).state;
    expect(w.reloadT).toBeGreaterThan(0);
    const during = fire(w, 30);
    expect(during.shots).toBe(0);
    const after = fire(during.w, Math.ceil(W.reloadTime * 60), { fire: false });
    expect(after.w.ammo).toBe(W.magSize);
    expect(after.w.reloadT).toBe(0);
  });

  it("ignores reload on a full magazine", () => {
    const r = stepWeapon(spawnWeapon(), { ...idle, reload: true }, still, DT);
    expect(r.shot.reloadStarted).toBe(false);
  });
});

describe("recoil and spread", () => {
  it("plays the same recoil pattern every spray", () => {
    const a = fire(spawnWeapon(1), 120).kicks;
    const b = fire(spawnWeapon(999), 120).kicks;
    expect(a.slice(0, 20)).toEqual(b.slice(0, 20));
    expect(a[0]).toBeCloseTo((W.recoilPitch[0] ?? 0) * (Math.PI / 180), 9);
  });

  it("resets the pattern after a pause", () => {
    let { w } = fire(spawnWeapon(), 30);
    expect(w.burst).toBeGreaterThan(3);
    w = fire(w, Math.ceil((W.recoilResetTime + 0.1) * 60), { fire: false }).w;
    expect(w.burst).toBe(0);
  });

  it("first shot has no bloom beyond the base cone; ADS is tighter than hip", () => {
    expect(spreadDegrees(0, false, still)).toBeCloseTo(W.hipSpread, 9);
    expect(spreadDegrees(0, true, still)).toBeLessThan(spreadDegrees(0, false, still));
    expect(spreadDegrees(0, true, still)).toBeCloseTo(W.adsSpread, 9);
  });

  it("spread grows with movement, air time and sustained fire", () => {
    const base = spreadDegrees(0, false, still);
    expect(spreadDegrees(0, false, { ...still, hSpeed: PARAMS.runSpeed })).toBeGreaterThan(base);
    expect(spreadDegrees(0, false, { ...still, onGround: false })).toBeGreaterThan(base);
    expect(spreadDegrees(20, false, still)).toBeGreaterThan(base);
  });

  it("crouching tightens hipfire but does not change ADS", () => {
    const crouched = { ...still, crouching: true };
    expect(spreadDegrees(0, false, crouched)).toBeCloseTo(W.hipSpread * W.crouchHipMult, 9);
    expect(spreadDegrees(0, false, crouched)).toBeLessThan(spreadDegrees(0, false, still));
    expect(spreadDegrees(0, true, crouched)).toBe(spreadDegrees(0, true, still));
    // still gets worse with sustained fire, but stays tighter than standing
    expect(spreadDegrees(20, false, crouched)).toBeLessThan(spreadDegrees(20, false, still));
  });

  it("sliding tightens hipfire a little, less than crouching, and not ADS", () => {
    const sliding = { ...still, sliding: true };
    const crouched = { ...still, crouching: true };
    expect(spreadDegrees(0, false, sliding)).toBeCloseTo(W.hipSpread * W.slideHipMult, 9);
    expect(spreadDegrees(0, false, sliding)).toBeLessThan(spreadDegrees(0, false, still));
    expect(spreadDegrees(0, false, sliding)).toBeGreaterThan(spreadDegrees(0, false, crouched));
    expect(spreadDegrees(0, true, sliding)).toBe(spreadDegrees(0, true, still));
  });

  it("sliding at speed has far less movement bloom than running at the same speed", () => {
    const fast = PARAMS.slideSpeed;
    const running = spreadDegrees(0, false, { ...still, hSpeed: fast });
    const sliding = spreadDegrees(0, false, { ...still, hSpeed: fast, sliding: true });
    expect(sliding).toBeLessThan(running - 0.8);
    // Still a bit looser than standing still, since you are moving.
    expect(sliding).toBeGreaterThan(spreadDegrees(0, false, { ...still, sliding: true }));
  });

  it("keeps every bullet inside the cone and is deterministic for a seed", () => {
    const run = (seed: number) => {
      const out: [number, number][] = [];
      let w = spawnWeapon(seed);
      for (let i = 0; i < 600; i++) {
        const r = stepWeapon(w, { ...idle, fire: true, ads: true }, still, DT);
        w = r.state;
        if (r.shot.fired) out.push([r.shot.spreadYaw, r.shot.spreadPitch]);
        if (w.ammo === 0) w = { ...w, ammo: W.magSize, reloadT: 0 };
      }
      return out;
    };
    const a = run(7);
    expect(a).toEqual(run(7));
    expect(a).not.toEqual(run(8));
    const limit = (spreadDegrees(W.magSize, true, still) * Math.PI) / 180 + 1e-12;
    for (const [y, p] of a) expect(Math.hypot(y, p)).toBeLessThanOrEqual(limit);
  });
});

describe("damage", () => {
  it("shield absorbs first, then health", () => {
    const h = fullHealth();
    const r1 = applyDamage(h, 40);
    expect(h).toEqual({ health: 100, shield: 10 });
    expect(r1.shieldDamage).toBe(40);
    const r2 = applyDamage(h, 30);
    expect(h).toEqual({ health: 80, shield: 0 });
    expect(r2.healthDamage).toBe(20);
    expect(r2.killed).toBe(false);
  });

  it("kills at zero and does not go negative", () => {
    const h = { health: 5, shield: 0 };
    const r = applyDamage(h, 50);
    expect(h.health).toBe(0);
    expect(r.killed).toBe(true);
  });

  it("headshots do more damage", () => {
    expect(damageFor(true)).toBeCloseTo(W.damage * W.headshotMult, 9);
    expect(damageFor(false)).toBe(W.damage);
  });
});

describe("time to kill", () => {
  /** Fire until a full-health target dies, every bullet hitting. Returns seconds from the first shot. */
  function ttk(headshots: boolean): number {
    const h = fullHealth();
    let w = spawnWeapon();
    let firstShotTick = -1;
    for (let i = 0; i < 1200; i++) {
      const r = stepWeapon(w, { ...idle, fire: true }, still, DT);
      w = r.state;
      if (!r.shot.fired) continue;
      if (firstShotTick < 0) firstShotTick = i;
      if (applyDamage(h, damageFor(headshots)).killed) return (i - firstShotTick) * DT;
    }
    throw new Error("target never died");
  }

  it("is about 1.5-2 s with perfect body shots", () => {
    const t = ttk(false);
    expect(t).toBeGreaterThanOrEqual(1.4);
    expect(t).toBeLessThanOrEqual(2.0);
  });

  it("is clearly faster with headshots", () => {
    expect(ttk(true)).toBeLessThan(ttk(false) - 0.3);
  });
});

describe("hitscan", () => {
  const dummy = (id: number, x: number, z: number): Hitbox => ({
    id,
    headMinY: 1.5,
    minX: x - 0.3,
    maxX: x + 0.3,
    minY: 0,
    maxY: 1.8,
    minZ: z - 0.3,
    maxZ: z + 0.3,
  });
  const world = flatWorld();
  const eye: [number, number, number] = [0, 1.6, 0];
  const north = viewDirection(0, 0);

  it("view direction faces -Z at yaw 0 and rises with pitch", () => {
    expect(north[2]).toBeCloseTo(-1, 9);
    expect(viewDirection(0, Math.PI / 4)[1]).toBeGreaterThan(0.7);
    expect(viewDirection(Math.PI / 2, 0)[0]).toBeCloseTo(-1, 9);
  });

  it("hits a target in front and reports distance", () => {
    const r = castRay(world, [dummy(5, 0, -10)], eye, north);
    expect(r.kind).toBe("target");
    expect(r.targetId).toBe(5);
    expect(r.t).toBeCloseTo(9.7, 6);
  });

  it("misses a target off to the side", () => {
    const r = castRay(world, [dummy(5, 3, -10)], eye, north);
    expect(r.kind).not.toBe("target");
  });

  it("classifies headshots by height", () => {
    const head = castRay(world, [dummy(1, 0, -10)], [0, 1.65, 0], north);
    const body = castRay(world, [dummy(1, 0, -10)], [0, 1.0, 0], north);
    expect(head.headshot).toBe(true);
    expect(body.headshot).toBe(false);
  });

  it("is blocked by walls in front of the target", () => {
    const w = flatWorld({ boxes: [box(0, 2, -5, 10, 4, 1)] });
    const r = castRay(w, [dummy(1, 0, -10)], eye, north);
    expect(r.kind).toBe("world");
    expect(r.t).toBeCloseTo(4.5, 6);
  });

  it("picks the nearest of several targets", () => {
    const r = castRay(world, [dummy(1, 0, -20), dummy(2, 0, -8)], eye, north);
    expect(r.targetId).toBe(2);
  });

  it("hits the floor when aimed down and nothing when aimed at the sky", () => {
    const down = castRay(world, [], eye, viewDirection(0, -Math.PI / 4));
    expect(down.kind).toBe("world");
    expect(down.y).toBeCloseTo(0, 6);
    const up = castRay(world, [], eye, viewDirection(0, Math.PI / 4));
    expect(up.kind).toBe("none");
  });

  it("is blocked by a ramp surface", () => {
    // 1 m high at its far (-z) end, so a level ray at 0.5 m is blocked and one at 1.5 m passes over.
    const w = flatWorld({ ramps: [{ box: box(0, 0.5, -10, 6, 1, 6), rises: "-z" }] });
    const r = castRay(w, [dummy(1, 0, -20)], [0, 0.5, 0], north);
    expect(r.kind).toBe("world");
    const over = castRay(w, [dummy(1, 0, -20)], [0, 1.5, 0], north);
    expect(over.kind).toBe("target");
  });

  it("rayAabb handles an origin inside the box", () => {
    expect(rayAabb(0, 0, 0, 1, 0, 0, box(0, 0, 0, 2, 2, 2))).toBe(0);
    expect(rayAabb(5, 0, 0, 1, 0, 0, box(0, 0, 0, 2, 2, 2))).toBeNull();
  });
});
