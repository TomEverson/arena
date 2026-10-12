import { describe, expect, it } from "vitest";

import { aliveHitboxes, killDummy, makeDummies, stepDummies } from "./dummies";
import type { LevelTarget } from "./sim/level";

const targets: LevelTarget[] = [
  { id: "still", pos: [0, 0, -10], kind: "static", axis: "x", range: 0 },
  { id: "mover", pos: [5, 0, -10], kind: "strafe", axis: "x", range: 3 },
];

describe("dummies", () => {
  it("static dummies stay put and strafing ones stay within their range", () => {
    const d = makeDummies(targets);
    let minX = 99;
    let maxX = -99;
    for (let i = 0; i < 1200; i++) {
      stepDummies(d, 1 / 60, false);
      minX = Math.min(minX, d[1]?.x ?? 0);
      maxX = Math.max(maxX, d[1]?.x ?? 0);
    }
    expect(d[0]?.x).toBe(0);
    expect(minX).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(maxX).toBeLessThanOrEqual(8 + 1e-9);
    expect(maxX - minX).toBeGreaterThan(5);
  });

  it("freezes during hitstop", () => {
    const d = makeDummies(targets);
    stepDummies(d, 1, true);
    expect(d[1]?.x).toBe(5);
  });

  it("respawns dead dummies at full health, and dead ones have no hitbox", () => {
    const d = makeDummies(targets);
    const first = d[0];
    if (!first) throw new Error("no dummy");
    first.health = 0;
    first.shield = 0;
    killDummy(first);
    expect(aliveHitboxes(d).length).toBe(1);
    for (let i = 0; i < 180; i++) stepDummies(d, 1 / 60, false);
    expect(first.alive).toBe(true);
    expect(first.health).toBe(100);
    expect(first.shield).toBe(50);
    expect(aliveHitboxes(d).length).toBe(2);
  });
});
