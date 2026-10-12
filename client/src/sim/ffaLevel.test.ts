import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseLevel } from "./level";
import { hSpeed, spawnState, stepPlayer } from "./movement";
import { PARAMS as P } from "./params";
import { DT } from "./testutil";
import { emptyInput } from "./types";
import { loadWorld } from "./vectors/node";

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../levels/ffa.json", import.meta.url)), "utf8"),
) as unknown;
const level = parseLevel(raw);
const world = loadWorld({ level: "ffa" });

describe("the FFA map", () => {
  it("is named ffa and has no practice targets", () => {
    expect(level.name).toBe("ffa");
    expect(level.targets).toHaveLength(0);
  });

  it("has a spawn pad for every player", () => {
    expect(level.spawnZones).toHaveLength(8);
  });

  it("keeps every piece of geometry inside the arena bounds", () => {
    for (const b of level.boxes) {
      const [w, h, d] = b.size;
      const [x, y, z] = b.pos;
      if (b.id === "floor" || b.id.startsWith("wall-")) continue; // the shell goes out to the edge
      expect(Math.abs(x) + w / 2, `${b.id} x`).toBeLessThanOrEqual(30);
      expect(Math.abs(z) + d / 2, `${b.id} z`).toBeLessThanOrEqual(30);
      expect(y - h / 2, `${b.id} sits on the floor`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has perimeter walls too tall to wall-jump out of", () => {
    for (const id of ["wall-n", "wall-s", "wall-w", "wall-e"]) {
      const wall = level.boxes.find((b) => b.id === id);
      expect(wall, id).toBeDefined();
      expect((wall?.pos[1] ?? 0) + (wall?.size[1] ?? 0) / 2).toBeGreaterThanOrEqual(16);
    }
  });

  it("lets a player stand at every spawn pad", () => {
    for (const pad of level.spawnZones) {
      let s = spawnState(pad.pos[0], pad.pos[1], pad.pos[2]);
      for (let i = 0; i < 90; i++) s = stepPlayer(s, emptyInput(), world, DT);
      expect(s.onGround, pad.id).toBe(true);
      expect(Math.abs(s.y - pad.pos[1]), `${pad.id} height`).toBeLessThan(0.01);
      expect(hSpeed(s), `${pad.id} did not get pushed`).toBeLessThan(1e-6);
    }
  });

  it("has a corridor you can wall run in (north lane)", () => {
    // Start beside the west wall of the corridor, at the south end, running north (-Z).
    let s = spawnState(-1.7, 0, -10);
    let ran = false;
    for (let i = 0; i < 120; i++) {
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, jump: i === 25 }, world, DT);
      if (s.wallRunning) ran = true;
    }
    expect(ran).toBe(true);
  });

  it("has a tower that can be climbed", () => {
    let s = spawnState(-20, 0, 12);
    let top = 0;
    for (let i = 0; i < 240; i++) {
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, jumpHeld: i > 20, jump: i === 20 }, world, DT);
      top = Math.max(top, s.y);
    }
    expect(top).toBeGreaterThan(5);
  });

  it("can be crossed on foot from every spawn to the centre hill without leaving the map", () => {
    // Each pad runs straight at the middle for 6 seconds, jumping now and then: no one may
    // end up outside the walls or stuck at the pad.
    for (const pad of level.spawnZones) {
      let s = spawnState(pad.pos[0], pad.pos[1], pad.pos[2]);
      const yaw = Math.atan2(pad.pos[0], pad.pos[2]); // forward is (-sin, -cos): toward the origin
      const start = { x: s.x, z: s.z };
      for (let i = 0; i < 360; i++) {
        s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw, jump: i % 45 === 0 }, world, DT);
        expect(Math.abs(s.x), pad.id).toBeLessThan(30.5);
        expect(Math.abs(s.z), pad.id).toBeLessThan(30.5);
      }
      expect(Math.hypot(s.x - start.x, s.z - start.z), `${pad.id} got moving`).toBeGreaterThan(8);
    }
  });

  it("uses only abilities the movement code has", () => {
    // The map is built for the full kit: a wall run needs the speed it asks for to be reachable.
    expect(P.wallRunMinSpeed).toBeLessThan(P.runSpeed);
  });
});
