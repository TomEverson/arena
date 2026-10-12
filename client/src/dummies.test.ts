import { describe, expect, it } from "vitest";

import {
  aliveHitboxes,
  killDummy,
  knockDummy,
  makeDummies,
  stepDummies,
  wallRunArc,
} from "./dummies";
import type { LevelTarget } from "./sim/level";
import { PARAMS as P } from "./sim/params";

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

describe("wall-running dummies", () => {
  const target: LevelTarget = {
    id: "wr",
    pos: [0, 2.5, -20],
    kind: "wallrun",
    axis: "x",
    range: 6,
  };

  it("follow the same arc as the player's wall run: up and back down, not a straight line", () => {
    expect(wallRunArc(0)).toBe(0);
    expect(wallRunArc(P.wallRunMaxTime)).toBeCloseTo(0, 9);
    expect(wallRunArc(P.wallRunMaxTime / 2)).toBeGreaterThan(0.5);
    for (let t = 0; t <= P.wallRunMaxTime; t += 0.05)
      expect(wallRunArc(t)).toBeGreaterThanOrEqual(-1e-9);
  });

  it("run end to end along the wall, turn, and keep to their line and range", () => {
    const [d] = makeDummies([target]);
    if (!d) throw new Error("no dummy");
    expect(d.x).toBeCloseTo(-6, 9); // starts at one end
    let maxY = d.y;
    let turned = false;
    for (let i = 0; i < 200; i++) {
      stepDummies([d], 1 / 60, false);
      expect(d.z).toBe(-20);
      expect(Math.abs(d.x)).toBeLessThanOrEqual(6 + 1e-9);
      if (d.dir === -1) turned = true;
      maxY = Math.max(maxY, d.y);
    }
    expect(turned).toBe(true);
    expect(maxY).toBeGreaterThan(2.5 + 0.5);
  });
});

describe("knocked dummies", () => {
  const still: LevelTarget = { id: "s", pos: [0, 0, -10], kind: "static", axis: "x", range: 0 };
  const mover: LevelTarget = { id: "m", pos: [0, 0, -10], kind: "strafe", axis: "x", range: 3 };
  const runner: LevelTarget = { id: "w", pos: [0, 2.5, -10], kind: "wallrun", axis: "x", range: 4 };

  it("a shove pushes a static dummy away and up, and a spring brings it home again", () => {
    const [d] = makeDummies([still]);
    if (!d) throw new Error("no dummy");
    knockDummy(d, 0, -1); // away from someone standing at +Z
    let farthest = 0;
    let highest = 0;
    for (let i = 0; i < 150; i++) {
      stepDummies([d], 1 / 60, false);
      farthest = Math.max(farthest, -(d.z + 10));
      highest = Math.max(highest, d.y);
    }
    expect(farthest).toBeGreaterThan(0.6);
    expect(highest).toBeGreaterThan(0.05);
    expect(d.z).toBeCloseTo(-10, 2);
    expect(d.y).toBe(0);
  });

  it("a strafing dummy keeps strafing, and its range is not eaten by the shove", () => {
    const [d] = makeDummies([mover]);
    if (!d) throw new Error("no dummy");
    knockDummy(d, 1, 0); // shoved the way it is moving, past the edge of its range
    let maxX = -Infinity;
    for (let i = 0; i < 600; i++) {
      stepDummies([d], 1 / 60, false);
      maxX = Math.max(maxX, d.x);
    }
    expect(maxX).toBeGreaterThan(3); // the shove carried it past its edge for a moment
    // Once settled it is back on its script: always within its range.
    for (let i = 0; i < 200; i++) {
      stepDummies([d], 1 / 60, false);
      expect(Math.abs(d.x)).toBeLessThanOrEqual(3 + 1e-6);
      expect(d.z).toBeCloseTo(-10, 6);
    }
  });

  it("a wall runner stays on its wall", () => {
    const [d] = makeDummies([runner]);
    if (!d) throw new Error("no dummy");
    knockDummy(d, 0, -1);
    for (let i = 0; i < 60; i++) {
      stepDummies([d], 1 / 60, false);
      expect(d.z).toBe(-10);
    }
  });
});
