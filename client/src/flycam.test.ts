import { describe, expect, it } from "vitest";
import { emptyKeys, FLY_SPEED, type FlyState, stepFly } from "./flycam";

const origin = (): FlyState => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });

describe("stepFly", () => {
  it("moves forward along -Z at yaw 0", () => {
    const s = origin();
    stepFly(s, { ...emptyKeys(), forward: true }, 1);
    expect(s.z).toBeCloseTo(-FLY_SPEED);
    expect(s.x).toBeCloseTo(0);
  });

  it("does not move faster diagonally", () => {
    const s = origin();
    stepFly(s, { ...emptyKeys(), forward: true, right: true }, 1);
    expect(Math.hypot(s.x, s.z)).toBeCloseTo(FLY_SPEED);
  });

  it("moves vertically", () => {
    const s = origin();
    stepFly(s, { ...emptyKeys(), up: true }, 0.5);
    expect(s.y).toBeCloseTo(FLY_SPEED / 2);
  });
});
