import { describe, expect, it } from "vitest";

import { bearing } from "./damageIndicator";

describe("bearing", () => {
  it("reads straight ahead, right, behind and left when facing -Z (yaw 0)", () => {
    expect(bearing(0, 0, 0, 0, -5)).toBeCloseTo(0);
    expect(bearing(0, 0, 0, 5, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(bearing(0, 0, 0, 0, 5))).toBeCloseTo(Math.PI);
    expect(bearing(0, 0, 0, -5, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it("turns with the player: after a quarter turn left, what was on the left is ahead", () => {
    const yaw = Math.PI / 2; // facing -X
    expect(bearing(0, 0, yaw, -5, 0)).toBeCloseTo(0);
    expect(bearing(0, 0, yaw, 0, -5)).toBeCloseTo(Math.PI / 2); // the old ahead is now on the right
  });

  it("is measured from where the player stands", () => {
    expect(bearing(10, 10, 0, 15, 10)).toBeCloseTo(Math.PI / 2);
  });
});
