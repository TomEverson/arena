import { describe, expect, it } from "vitest";
import example from "../../../levels/example.json";
import greybox from "../../../levels/greybox.json";
import { buildCollisionWorld, parseLevel } from "./level";
import { hSpeed, spawnState } from "./movement";
import { DT, run } from "./testutil";

describe("level loading", () => {
  it("parses the shipped levels", () => {
    for (const json of [example, greybox]) {
      const level = parseLevel(json);
      expect(level.boxes.length).toBeGreaterThan(0);
      expect(level.spawnZones.length).toBeGreaterThan(0);
    }
  });

  it("carries the climbable flag into collision", () => {
    const level = parseLevel(greybox);
    expect(level.boxes.some((b) => b.climbable)).toBe(true);
    const world = buildCollisionWorld(level);
    expect(world.boxes.filter((b) => b.climbable).length).toBe(
      level.boxes.filter((b) => b.climbable).length,
    );
    expect(() =>
      parseLevel({ boxes: [{ id: "a", pos: [0, 0, 0], size: [1, 1, 1], climbable: "yes" }] }),
    ).toThrow(/climbable/);
  });

  it("parses practice targets and rejects bad ones", () => {
    const level = parseLevel(greybox);
    expect(level.targets.length).toBeGreaterThan(0);
    expect(level.targets.some((t) => t.kind === "strafe" && t.range > 0)).toBe(true);
    expect(() => parseLevel({ targets: [{ id: "t", pos: [0, 0, 0], kind: "flying" }] })).toThrow(
      /kind/,
    );
  });

  it("builds collision from boxes and ramps", () => {
    const world = buildCollisionWorld(parseLevel(greybox));
    expect(world.boxes.length).toBe(greybox.boxes.length);
    expect(world.ramps.length).toBe(greybox.ramps.length);
    const floor = world.boxes[0];
    expect(floor?.maxY).toBe(0);
  });

  it("rejects malformed levels with a useful path", () => {
    expect(() => parseLevel({ boxes: [{ id: "a", pos: [0, 0], size: [1, 1, 1] }] })).toThrow(
      /boxes\[0\]\.pos/,
    );
    expect(() =>
      parseLevel({ ramps: [{ id: "r", pos: [0, 0, 0], size: [1, 1, 1], rises: "up" }] }),
    ).toThrow(/rises/);
    expect(() => parseLevel({ boxes: [{ id: "a", pos: [0, 0, 0], size: [0, 1, 1] }] })).toThrow(
      /positive/,
    );
    expect(() => parseLevel(null)).toThrow();
  });

  it("a player can spawn in every greybox spawn zone and settle on the floor", () => {
    const level = parseLevel(greybox);
    const world = buildCollisionWorld(level);
    for (const z of level.spawnZones) {
      const s = run(spawnState(z.pos[0], z.pos[1] + 2, z.pos[2]), world, 120, {});
      expect(s.onGround).toBe(true);
      expect(s.y).toBe(0);
      expect(hSpeed(s)).toBe(0);
    }
    expect(DT).toBeGreaterThan(0);
  });
});
