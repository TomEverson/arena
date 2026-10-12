import { describe, expect, it } from "vitest";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { WEAPON } from "./sim/params";

const pose = (t: number) => reloadPose(t, { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 });
const atRest: ReloadPose = { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 };

describe("reload animation", () => {
  it("starts and ends in the ready pose, so nothing pops", () => {
    expect(pose(0)).toEqual(atRest);
    expect(pose(1)).toEqual(atRest);
  });

  it("has the magazine out and the hand on it mid-reload", () => {
    const mid = pose(0.4);
    expect(mid.mag).toBeLessThan(-0.3);
    expect(mid.hand).toBe(1);
    expect(mid.roll).toBeGreaterThan(0.4);
  });

  it("moves smoothly (no jumps between frames at 60 fps)", () => {
    const frame = 1 / 60 / WEAPON.reloadTime; // reload progress per frame
    for (let t = 0; t < 1; t += frame) {
      const a = pose(t);
      const b = pose(t + frame);
      for (const k of Object.keys(a) as (keyof ReloadPose)[])
        expect(Math.abs(b[k] - a[k])).toBeLessThan(0.1);
    }
  });
});
