import { describe, expect, it } from "vitest";

import { bodyHeight, eyeHeight, hSpeed, spawnState, stepPlayer } from "./movement";
import { PARAMS as P } from "./params";
import { box, DT, flatWorld, grounded, run } from "./testutil";
import { emptyInput } from "./types";

const FORWARD = { moveZ: 1 };

describe("ground movement", () => {
  const world = flatWorld();

  it("stands still on the floor", () => {
    const s = run(spawnState(0, 0, 0), world, 60, {});
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(0);
    expect(hSpeed(s)).toBe(0);
  });

  it("falls and lands", () => {
    const s = run(spawnState(0, 5, 0), world, 120, {});
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(0);
    expect(s.vy).toBe(0);
  });

  it("reaches exactly run speed, forward is -Z at yaw 0", () => {
    const s = run(grounded(world), world, 60, FORWARD);
    expect(hSpeed(s)).toBeCloseTo(P.runSpeed, 6);
    expect(s.vz).toBeLessThan(0);
    expect(s.vx).toBeCloseTo(0, 6);
  });

  it("is not faster diagonally", () => {
    const s = run(grounded(world), world, 60, { moveX: 1, moveZ: 1 });
    expect(hSpeed(s)).toBeCloseTo(P.runSpeed, 6);
  });

  it("stops when input is released", () => {
    const moving = run(grounded(world), world, 60, FORWARD);
    const s = run(moving, world, 60, {});
    expect(hSpeed(s)).toBeLessThan(0.01);
  });
});

describe("aim down sights", () => {
  const world = flatWorld();

  it("slows ground movement", () => {
    const hip = run(grounded(world), world, 60, { moveZ: 1 });
    const ads = run(grounded(world), world, 60, { moveZ: 1, ads: true });
    expect(hSpeed(hip)).toBeCloseTo(P.runSpeed, 6);
    expect(hSpeed(ads)).toBeCloseTo(P.runSpeed * P.adsSpeedMult, 6);
  });

  it("does not change jumping or dashing", () => {
    const s = run(grounded(world), world, 2, { jump: true, ads: true });
    expect(s.vy).toBeGreaterThan(0);
    const d = run(grounded(world), world, 1, { dash: true, moveZ: 1, ads: true });
    expect(hSpeed(d)).toBeCloseTo(P.dashSpeed, 6);
  });
});

describe("jump", () => {
  const world = flatWorld();

  it("reaches the expected apex", () => {
    let peak = 0;
    let s = grounded(world);
    s = run(s, world, 90, (i, st) => {
      peak = Math.max(peak, st.y);
      return { jump: i === 0 };
    });
    const expected = (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity);
    expect(peak).toBeGreaterThan(expected * 0.9);
    expect(peak).toBeLessThan(expected * 1.1);
    expect(s.onGround).toBe(true);
  });

  it("buffers a jump pressed just before landing", () => {
    // 0.1 m up: lands in ~5 ticks, inside the 6-tick buffer.
    let peak = 0;
    run({ ...spawnState(0, 0.1, 0), airJumps: 0 }, world, 40, (i, st) => {
      peak = Math.max(peak, st.y);
      return { jump: i === 0 };
    });
    expect(peak).toBeGreaterThan(1);
  });

  it("ignores a jump pressed too early", () => {
    let peak = 0;
    run({ ...spawnState(0, 1.5, 0), airJumps: 0 }, world, 60, (i, st) => {
      peak = Math.max(peak, st.y);
      return { jump: i === 0 };
    });
    expect(peak).toBeLessThan(1.6);
  });

  it("allows a jump shortly after walking off a ledge (coyote time)", () => {
    const w = flatWorld({ boxes: [box(0, 1, 0, 10, 2, 10)] }); // top at y = 2, edge at x = 5
    const start = { ...run(spawnState(4.0, 2, 0), w, 2, {}), airJumps: 0 }; // no air jumps: isolate coyote time
    const peakWith = (jumpTick: number) => {
      let peak = 0;
      run(start, w, 60, (i, st) => {
        peak = Math.max(peak, st.y);
        return { moveX: 1, jump: i === jumpTick };
      });
      return peak;
    };
    expect(peakWith(8)).toBeGreaterThan(3); // a few ticks after leaving the edge
    expect(peakWith(30)).toBeLessThan(2.01); // far too late
  });
});

describe("double jump", () => {
  const world = flatWorld();
  const peakOf = (presses: number[]) => {
    let peak = 0;
    run(grounded(world), world, 150, (i, st) => {
      peak = Math.max(peak, st.y);
      return { jump: presses.includes(i) };
    });
    return peak;
  };
  const single = (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity);

  it("gives extra height when pressed again near the apex", () => {
    expect(peakOf([0, 18])).toBeGreaterThan(single * 1.6);
  });

  it("allows only one air jump", () => {
    const double = peakOf([0, 18]);
    const triple = peakOf([0, 18, 36]);
    expect(triple).toBeCloseTo(double, 1);
  });

  it("is still available after walking off a ledge without jumping", () => {
    const w = flatWorld({ boxes: [box(0, 1, 0, 10, 2, 10)] }); // top at y = 2, edge at x = 5
    const start = run(spawnState(4.0, 2, 0), w, 2, {});
    let yAtPress = 0;
    let peakAfter = 0;
    run(start, w, 60, (i, st) => {
      if (i === 30) yAtPress = st.y; // well past coyote time, falling
      if (i >= 30) peakAfter = Math.max(peakAfter, st.y);
      return { moveX: 1, jump: i === 30 };
    });
    expect(start.airJumps).toBe(P.maxAirJumps);
    expect(peakAfter - yAtPress).toBeGreaterThan(1);
  });

  it("is refilled by landing", () => {
    let s = run(grounded(world), world, 20, (i) => ({ jump: i === 0 || i === 12 }));
    expect(s.airJumps).toBe(0);
    s = run(s, world, 120, {});
    expect(s.onGround).toBe(true);
    expect(s.airJumps).toBe(P.maxAirJumps);
  });
});

describe("slide", () => {
  const world = flatWorld();
  const running = () => run(grounded(world), world, 60, FORWARD);

  it("boosts speed and lowers the hitbox", () => {
    const s = run(running(), world, 2, { ...FORWARD, slide: true });
    expect(s.sliding).toBe(true);
    expect(hSpeed(s)).toBeGreaterThan(P.runSpeed + 1);
    expect(hSpeed(s)).toBeLessThanOrEqual(P.slideSpeed + 1e-6);
  });

  it("decays and ends on release", () => {
    let s = run(running(), world, 20, { ...FORWARD, slide: true });
    const during = hSpeed(s);
    s = run(s, world, 10, { slide: false });
    expect(s.sliding).toBe(false);
    expect(during).toBeLessThanOrEqual(P.slideSpeed);
  });

  it("needs minimum speed to start", () => {
    const s = run(grounded(world), world, 5, { slide: true });
    expect(s.sliding).toBe(false);
  });

  it("keeps its momentum through a slide jump", () => {
    let s = run(running(), world, 10, { ...FORWARD, slide: true });
    const before = hSpeed(s);
    s = run(s, world, 1, { ...FORWARD, slide: true, jump: true });
    expect(s.sliding).toBe(false);
    expect(s.vy).toBeGreaterThan(0);
    expect(hSpeed(s)).toBeGreaterThan(before * 0.95);
  });

  it("cannot re-boost during the cooldown", () => {
    let s = run(running(), world, 5, { ...FORWARD, slide: true });
    s = run(s, world, 2, { slide: false });
    const speed = hSpeed(s);
    expect(s.sliding).toBe(false);
    const again = run(s, world, 1, { ...FORWARD, slide: true });
    expect(again.sliding).toBe(true);
    expect(hSpeed(again)).toBeLessThanOrEqual(Math.max(speed, P.runSpeed) + 1);
  });

  it("stays low under a low ceiling, can still crawl out, and stands up after", () => {
    const tunnel = flatWorld({ boxes: [box(0, 1.7, -10, 4, 1, 20)] }); // underside at y = 1.2, z -20..0
    let s = run(spawnState(0, 0, 10), tunnel, 20, FORWARD);
    // slide into the tunnel, then let go of slide while still under the ceiling
    s = run(s, tunnel, 50, { ...FORWARD, slide: true });
    expect(s.sliding).toBe(true);
    expect(s.z).toBeLessThan(-1); // under the ceiling now
    let sawLowRelease = false;
    s = run(s, tunnel, 30, (_i, st) => {
      if (st.z < -1 && st.z > -19) sawLowRelease = true;
      return FORWARD;
    });
    expect(sawLowRelease).toBe(true);
    expect(s.z).toBeLessThan(-1);
    // keep walking: must get out the far end and stand back up
    s = run(s, tunnel, 400, FORWARD);
    expect(s.z).toBeLessThan(-20.5);
    expect(s.sliding).toBe(false);
  });
});

describe("crouch", () => {
  const world = flatWorld();
  const walking = () => run(grounded(world), world, 30, { moveZ: 0.3 }); // slow: below slide speed

  it("crouches when the key is held while standing", () => {
    const s = run(grounded(world), world, 3, { slide: true });
    expect(s.crouching).toBe(true);
    expect(s.sliding).toBe(false);
    expect(bodyHeight(s)).toBe(P.crouchHeight);
    expect(eyeHeight(s)).toBe(P.crouchEye);
  });

  it("crouches (does not slide) when moving slowly", () => {
    const s = run(walking(), world, 3, { moveZ: 0.3, slide: true });
    expect(hSpeed(s)).toBeLessThan(P.slideMinSpeed);
    expect(s.crouching).toBe(true);
    expect(s.sliding).toBe(false);
  });

  it("still slides when running fast", () => {
    const running = run(grounded(world), world, 60, { moveZ: 1 });
    const s = run(running, world, 2, { moveZ: 1, slide: true });
    expect(s.sliding).toBe(true);
    expect(s.crouching).toBe(false);
  });

  it("crouch-walks at the crouch speed", () => {
    const s = run(grounded(world), world, 90, { moveZ: 1, slide: true });
    expect(s.crouching).toBe(true);
    expect(hSpeed(s)).toBeCloseTo(P.crouchSpeed, 6);
  });

  it("stands up on release", () => {
    let s = run(grounded(world), world, 10, { slide: true });
    s = run(s, world, 2, { slide: false });
    expect(s.crouching).toBe(false);
    expect(bodyHeight(s)).toBe(P.standHeight);
  });

  it("settles into a crouch when a slide runs out while the key is held", () => {
    let s = run(run(grounded(world), world, 60, { moveZ: 1 }), world, 2, { moveZ: 1, slide: true });
    expect(s.sliding).toBe(true);
    s = run(s, world, 200, { slide: true });
    expect(s.sliding).toBe(false);
    expect(s.crouching).toBe(true);
  });

  it("cannot stand or jump under a low ceiling, but can walk out and stand", () => {
    const low = flatWorld({ boxes: [box(0, 1.7, -10, 4, 1, 20)] }); // underside at 1.2
    let s = run(spawnState(0, 0, 10), low, 5, { slide: true });
    s = run(s, low, 200, { moveZ: 1, slide: true }); // crouch-walk into the tunnel
    expect(s.z).toBeLessThan(-1);
    s = run(s, low, 20, { moveZ: 0.1, slide: false, jump: true });
    expect(s.crouching).toBe(true); // no room to stand
    expect(s.onGround).toBe(true); // jump refused
    s = run(s, low, 400, { moveZ: 1 });
    expect(s.z).toBeLessThan(-20.5);
    expect(s.crouching).toBe(false);
  });

  it("jumping from a crouch stands up", () => {
    let s = run(grounded(world), world, 10, { slide: true });
    s = run(s, world, 1, { slide: true, jump: true });
    expect(s.crouching).toBe(false);
    expect(s.vy).toBeGreaterThan(0);
  });

  it("does not start a crouch in mid-air", () => {
    const s = run(spawnState(0, 5, 0), world, 3, { slide: true });
    expect(s.crouching).toBe(false);
  });
});

describe("dash", () => {
  const world = flatWorld();

  it("covers the expected distance and spends a charge", () => {
    const start = grounded(world);
    const s = run(start, world, 1, { ...FORWARD, dash: true });
    expect(s.dashCharges).toBeLessThan(P.dashCharges);
    const done = run(s, world, 15, FORWARD);
    expect(start.z - done.z).toBeGreaterThan(P.dashSpeed * P.dashDuration * 0.9);
    expect(P.dashSpeed * P.dashDuration).toBeGreaterThan(5); // about 5.7 m
  });

  it("has two charges, then none, then regenerates", () => {
    let s = grounded(world);
    const dashAt = (tick: number) => (i: number) => ({ ...FORWARD, dash: i === tick });
    s = run(s, world, 20, dashAt(0));
    s = run(s, world, 20, dashAt(0));
    expect(s.dashCharges).toBeLessThan(1);
    const third = run(s, world, 1, { ...FORWARD, dash: true });
    expect(third.dashTime).toBe(0);
    const later = run(s, world, Math.ceil((P.dashRegenTime * 60) / 1), FORWARD);
    expect(later.dashCharges).toBeGreaterThanOrEqual(1);
  });

  it("dashes in the air without gravity", () => {
    let s = run(spawnState(0, 10, 0), world, 3, {});
    const y0 = s.y;
    s = run(s, world, 4, { ...FORWARD, dash: true });
    expect(Math.abs(s.y - y0)).toBeLessThan(0.5);
  });

  it("dashes forward when there is no move input", () => {
    const s = run(grounded(world), world, 5, { dash: true });
    expect(s.z).toBeLessThan(-0.5);
  });
});

describe("collision", () => {
  it("is stopped by a wall, even a thin one at dash speed", () => {
    const w = flatWorld({ boxes: [box(0, 2, -5, 10, 4, 0.2)] });
    let s = grounded(w);
    s = run(s, w, 120, (i) => ({ ...FORWARD, dash: i % 20 === 0 }));
    expect(s.z).toBeGreaterThan(-5 + 0.1 + P.halfWidth - 1e-6);
  });

  it("steps up a small ledge", () => {
    const w = flatWorld({ boxes: [box(0, 0.15, -30, 4, 0.3, 56)] });
    const s = run(grounded(w), w, 90, FORWARD);
    expect(s.y).toBeCloseTo(0.3, 6);
    expect(s.onGround).toBe(true);
  });

  it("is blocked by a tall wall on the ground", () => {
    const w = flatWorld({ boxes: [box(0, 5, -4, 6, 10, 1)] });
    const s = run(grounded(w), w, 90, FORWARD);
    expect(s.y).toBe(0);
    expect(s.z).toBeGreaterThan(-3.5);
  });

  it("bonks its head on a ceiling", () => {
    const w = flatWorld({ boxes: [box(0, 3.5, 0, 10, 1, 10)] }); // underside at 3
    let s = grounded(w);
    s = run(s, w, 30, (i) => ({ jump: i === 0 }));
    expect(s.y + 1.8).toBeLessThanOrEqual(3 + 1e-6);
  });
});

describe("ramps", () => {
  const ramp = { box: box(0, 1.5, -10, 6, 3, 12), rises: "-z" as const }; // high at z = -16
  const world = flatWorld({
    boxes: [box(0, 1.5, -46, 6, 3, 60)], // long platform at the top, from z = -16
    ramps: [ramp],
  });

  it("can be walked up to the top", () => {
    const s = run(grounded(world, 0, 0), world, 240, FORWARD);
    expect(s.onGround).toBe(true);
    expect(s.y).toBeCloseTo(3, 6);
  });

  it("stays grounded walking back down", () => {
    let s = run(grounded(world, 0, 0), world, 240, FORWARD);
    let airborne = 0;
    s = run(s, world, 200, (_i, st) => {
      if (!st.onGround) airborne++;
      return { moveZ: -1, yaw: 0 };
    });
    expect(s.y).toBeLessThan(3);
    expect(airborne).toBeLessThan(3);
  });

  it("treats the tall side as a wall", () => {
    // Approach the ramp's high edge from the side where the wall is: from +z end of the platform side is solid anyway.
    const w = flatWorld({ ramps: [{ box: box(0, 1.5, -10, 6, 3, 12), rises: "+z" }] });
    // high side at z = -4; walking from +z toward -z hits the 3 m wall
    const s = run(grounded(w, 0, 10), w, 200, FORWARD);
    expect(s.y).toBe(0);
    expect(s.z).toBeGreaterThan(-4);
  });
});

describe("mantle", () => {
  const w = flatWorld({ boxes: [box(0, 1, -12, 6, 2, 20)] }); // 2 m high block, near face at z = -2

  it("pulls the player up onto a 2 m ledge after a jump", () => {
    const s = run(grounded(w, 0, 3), w, 120, (i) => ({ ...FORWARD, jump: i === 40 }));
    expect(s.y).toBeCloseTo(2, 6);
    expect(s.onGround).toBe(true);
    expect(s.z).toBeLessThan(-1.9);
  });

  it("does not climb a ledge that is too high", () => {
    const tall = flatWorld({ boxes: [box(0, 3.5, -12, 6, 7, 20)] });
    let mantled = false;
    let top = 0;
    run(grounded(tall, 0, 3), tall, 120, (i, st) => {
      if (st.mantling) mantled = true;
      top = Math.max(top, st.y);
      return { ...FORWARD, jump: i % 30 === 0 };
    });
    // Wall jumps may kick it up the face, but it never gets over the 7 m top.
    expect(mantled).toBe(false);
    expect(top).toBeLessThan(7);
  });

  it("does not mantle when not pushing into the wall", () => {
    let mantled = false;
    run(grounded(w, 0, 3), w, 120, (i, st) => {
      if (st.mantling) mantled = true;
      return { moveZ: i < 35 ? 1 : 0, jump: i === 40 };
    });
    expect(mantled).toBe(false);
  });
});

describe("determinism and purity", () => {
  const world = flatWorld({ boxes: [box(5, 1, -5, 4, 2, 4)] });
  const script = (i: number) => ({
    moveX: Math.sin(i / 17),
    moveZ: Math.cos(i / 11) > -0.5 ? 1 : 0,
    yaw: i / 60,
    jump: i % 47 === 0,
    dash: i % 83 === 0,
    slide: i % 120 > 100,
  });

  it("same inputs give bit-identical states", () => {
    const a = run(spawnState(0, 0, 0), world, 600, script);
    const b = run(spawnState(0, 0, 0), world, 600, script);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the previous state", () => {
    const s0 = grounded(world);
    const snapshot = JSON.stringify(s0);
    stepPlayer(s0, { ...emptyInput(), moveZ: 1, jump: true }, world, DT);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it("never produces NaN", () => {
    let s = spawnState(0, 0, 0);
    for (let i = 0; i < 2000; i++) {
      s = stepPlayer(s, { ...emptyInput(), ...script(i) }, world, DT);
      for (const v of [s.x, s.y, s.z, s.vx, s.vy, s.vz]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("wall run and wall jump", () => {
  // A tall wall on the right, face at x = 0.8; run along it facing -Z.
  const wall = flatWorld({ boxes: [box(1.8, 5, -30, 2, 10, 70)] });
  const start = () => grounded(wall, 0.5, 0);
  /** Run until the player is wall running (jumping at tick 25). */
  const untilRunning = (input: (i: number) => object = () => ({})) => {
    let s = start();
    for (let i = 0; i < 80; i++) {
      s = stepPlayer(s, { ...emptyInput(), ...FORWARD, jump: i === 25, ...input(i) }, wall, DT);
      if (s.wallRunning) return s;
    }
    throw new Error("never wall ran");
  };

  it("starts when fast, in the air, beside a wall, holding forward", () => {
    const s = untilRunning();
    expect(s.wallNormalX).toBe(-1); // the wall is on +X, so it faces -X
    expect(hSpeed(s)).toBeGreaterThanOrEqual(P.wallRunSpeed - 1e-6);
  });

  it("does not carry a jump's rise up the wall", () => {
    expect(untilRunning().vy).toBeLessThanOrEqual(P.wallRunMaxRise);
  });

  it("ends when the slide key is pressed, and the wall is not re-grabbed straight away", () => {
    let s = { ...untilRunning(), y: 8 }; // high up, so it stays in the air while cooling down
    s = stepPlayer(s, { ...emptyInput(), ...FORWARD, slide: true }, wall, DT);
    expect(s.wallRunning).toBe(false);
    s = stepPlayer(s, { ...emptyInput(), ...FORWARD }, wall, DT);
    expect(s.wallRunning).toBe(false); // cooling down
    for (let i = 0; i < Math.ceil(P.wallRunCooldown / DT) + 2; i++) {
      s = stepPlayer(s, { ...emptyInput(), ...FORWARD }, wall, DT);
    }
    expect(s.wallRunning).toBe(true); // free to grab it again
  });

  it("ends when the player lets go of the keys", () => {
    let s = untilRunning();
    s = stepPlayer(s, emptyInput(), wall, DT);
    expect(s.wallRunning).toBe(false);
  });

  it("a wall jump kicks away and up, keeps the speed along the wall, and refills an air jump", () => {
    let s = untilRunning();
    s = stepPlayer(s, { ...emptyInput(), ...FORWARD, jump: true }, wall, DT);
    expect(s.wallRunning).toBe(false);
    expect(s.vx).toBeLessThan(-P.wallJumpKick + 1);
    expect(s.vy).toBeGreaterThan(P.wallJumpSpeed - 1);
    expect(s.vz).toBeLessThan(-P.wallRunSpeed + 1);
    expect(s.wallJumps).toBe(1);
    expect(s.airJumps).toBe(P.maxAirJumps);
  });

  it("the wall jump count resets on landing", () => {
    let s = untilRunning();
    s = stepPlayer(s, { ...emptyInput(), ...FORWARD, jump: true }, wall, DT);
    for (let i = 0; i < 240 && !s.onGround; i++) s = stepPlayer(s, emptyInput(), wall, DT);
    expect(s.onGround).toBe(true);
    expect(s.wallJumps).toBe(0);
  });

  it("falls off when the time is up", () => {
    let s = untilRunning();
    for (let i = 0; i < 200 && s.wallRunning; i++) {
      s = stepPlayer(s, { ...emptyInput(), ...FORWARD }, wall, DT);
    }
    expect(s.wallRunning).toBe(false);
    expect(s.wallRunTime).toBe(0);
  });

  it("dashing cancels it", () => {
    let s = untilRunning();
    s = stepPlayer(s, { ...emptyInput(), ...FORWARD, dash: true }, wall, DT);
    expect(s.wallRunning).toBe(false);
    expect(s.dashTime).toBeGreaterThan(0);
  });

  it("is never on the floor: touching a wall on the ground does nothing", () => {
    let s = start();
    for (let i = 0; i < 60; i++) {
      s = stepPlayer(s, { ...emptyInput(), ...FORWARD }, wall, DT);
      expect(s.wallRunning).toBe(false);
    }
  });
});
