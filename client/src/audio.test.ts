import { describe, expect, it } from "vitest";

import { type MoveSound, MoveSoundTracker, StepCounter, STRIDE } from "./audio";
import type { PlayerState } from "./net/protocol.gen";

function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    onGround: true,
    climbing: false,
    crouching: false,
    sliding: false,
    slideTime: 0,
    slideCooldown: 0,
    dashCharges: 2,
    dashTime: 0,
    dashDirX: 0,
    dashDirZ: 0,
    airJumps: 1,
    coyote: 0,
    jumpBuffer: 0,
    mantling: false,
    mantleT: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleFromZ: 0,
    mantleToX: 0,
    mantleToY: 0,
    mantleToZ: 0,
    ...over,
  };
}

function run(states: PlayerState[], dt = 1 / 60): MoveSound[] {
  const t = new MoveSoundTracker();
  const out: MoveSound[] = [];
  for (const s of states) t.update(s, dt, out);
  return out;
}

describe("MoveSoundTracker", () => {
  it("is silent standing still", () => {
    expect(run(Array.from({ length: 120 }, () => state()))).toEqual([]);
  });

  it("steps once per stride walked, so faster means more often", () => {
    const walk = (speed: number) =>
      run(Array.from({ length: 121 }, (_, i) => state({ x: (i / 60) * speed }))).length;
    expect(walk(4.6)).toBe(Math.floor((4.6 * 2) / STRIDE));
    expect(walk(9.2)).toBeGreaterThan(walk(4.6));
  });

  it("plays jump, then land once back down", () => {
    const air = (y: number, vy: number) => state({ y, vy, onGround: false });
    const frames = [state(), air(0.1, 8)];
    for (let i = 0; i < 30; i++) frames.push(air(1 + i * 0.01, 0));
    frames.push(state({ y: 0, vy: -10 }));
    const sounds = run(frames);
    expect(sounds[0]).toBe("jump");
    expect(sounds.at(-1)).toBe("land");
  });

  it("plays a double jump when an air jump is spent", () => {
    const sounds = run([
      state({ onGround: false, y: 1, airJumps: 1 }),
      state({ onGround: false, y: 1.1, airJumps: 0, vy: 8 }),
    ]);
    expect(sounds).toContain("airJump");
  });

  it("plays dash and slide on their first frame only", () => {
    const sounds = run([
      state(),
      state({ dashTime: 0.2 }),
      state({ dashTime: 0.1, sliding: true }),
      state({ sliding: true }),
    ]);
    expect(sounds.filter((s) => s === "dash")).toHaveLength(1);
    expect(sounds.filter((s) => s === "slide")).toHaveLength(1);
  });

  it("does not step on a respawn teleport", () => {
    expect(run([state(), state({ x: 40 })])).toEqual([]);
  });
});

describe("StepCounter", () => {
  it("counts footsteps for someone else, but not while they are in the air", () => {
    const c = new StepCounter();
    let steps = 0;
    for (let i = 0; i <= 60; i++) if (c.update(i * 0.1, 0, 0)) steps++;
    expect(steps).toBe(Math.floor(6 / STRIDE));
    const air = new StepCounter();
    let airSteps = 0;
    for (let i = 0; i <= 60; i++) if (air.update(i * 0.1, i * 0.1, 0)) airSteps++;
    expect(airSteps).toBe(0);
  });
});
