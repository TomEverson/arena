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
// Forward is (-sin yaw, -cos yaw): yaw 0 faces north (-Z).
const WEST = Math.PI / 2;
const EAST = -Math.PI / 2;

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
      if (b.id.startsWith("floor-") || b.id.startsWith("wall-")) continue; // the shell goes out to the edge
      expect(Math.abs(x) + w / 2, `${b.id} x`).toBeLessThanOrEqual(30);
      expect(Math.abs(z) + d / 2, `${b.id} z`).toBeLessThanOrEqual(30);
      expect(y - h / 2, `${b.id} is not below the pit floor`).toBeGreaterThanOrEqual(-3);
    }
  });

  it("has no two pieces overlapping (overlapping faces flicker when drawn)", () => {
    const solids = [...world.boxes, ...world.ramps.map((r) => r.box)];
    const ids = [...level.boxes, ...level.ramps].map((b) => b.id);
    const EPS = 1e-6;
    solids.forEach((a, i) => {
      solids.slice(i + 1).forEach((b, k) => {
        const apart =
          a.maxX <= b.minX + EPS ||
          b.maxX <= a.minX + EPS ||
          a.maxY <= b.minY + EPS ||
          b.maxY <= a.minY + EPS ||
          a.maxZ <= b.minZ + EPS ||
          b.maxZ <= a.minZ + EPS;
        expect(apart, `${ids[i]} and ${ids[i + 1 + k]}`).toBe(true);
      });
    });
  });

  it("has perimeter walls too tall to wall-jump out of", () => {
    for (const id of ["wall-n", "wall-s", "wall-w", "wall-e"]) {
      const wall = level.boxes.find((b) => b.id === id);
      expect(wall, id).toBeDefined();
      expect((wall?.pos[1] ?? 0) + (wall?.size[1] ?? 0) / 2).toBeGreaterThanOrEqual(26);
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

  it("has a corridor you can wall run in (north-east)", () => {
    // Start beside the west wall of the corridor, at the south end, running north (-Z).
    let s = spawnState(14.9, 0, -9);
    let ran = false;
    for (let i = 0; i < 120; i++) {
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, jump: i === 12 }, world, DT);
      if (s.wallRunning) ran = true;
    }
    expect(ran).toBe(true);
  });

  it("has a room whose wall can be climbed to the roof (south-west)", () => {
    let s = spawnState(-12, 0, 17.5);
    let top = 0;
    for (let i = 0; i < 240; i++) {
      const input = { ...emptyInput(), moveZ: 1, yaw: WEST, jumpHeld: i > 15, jump: i === 15 };
      s = stepPlayer(s, input, world, DT);
      top = Math.max(top, s.y);
    }
    expect(top).toBeGreaterThan(6.9);
  });

  it("has a pit you can walk into by the tunnel and mantle out of", () => {
    // From the west edge, running east: down the trench ramp, through the tunnel, into the pit.
    let s = spawnState(-28, 0, 0);
    for (let i = 0; i < 150; i++)
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw: EAST }, world, DT);
    expect(s.y).toBeCloseTo(-3);
    expect(Math.abs(s.x)).toBeLessThan(10);
    // From the pit floor, run at the west wall and jump: the mantle puts you on the ground above.
    s = spawnState(0, -3, 6.5);
    for (let i = 0; i < 120; i++) {
      const jump = s.onGround && s.x < -9.3;
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw: WEST, jump }, world, DT);
      if (s.y >= 0) break;
    }
    expect(s.y).toBeCloseTo(0);
  });

  it("has ramps up to the decks", () => {
    // From the north-west corner, running east: up the ramp and along the north deck.
    let s = spawnState(-24, 0, -28);
    for (let i = 0; i < 150; i++)
      s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw: EAST }, world, DT);
    expect(s.y).toBeCloseTo(4);
    // From the south-east corner, running north: up the ramp and along the east deck.
    s = spawnState(28, 0, 24);
    for (let i = 0; i < 150; i++) s = stepPlayer(s, { ...emptyInput(), moveZ: 1 }, world, DT);
    expect(s.y).toBeCloseTo(4);
  });

  it("lets every spawn walk to the middle of the bridges (no jumping, no pad sealed in)", () => {
    // Flood fill over half-metre cells of ground-level standing room: a cell is open when there
    // is ground under it (top at 0) and nothing solid in the player's height above it.
    const CELL = 0.5;
    const N = 120;
    const open = (i: number, j: number): boolean => {
      const x = -30 + (i + 0.5) * CELL;
      const z = -30 + (j + 0.5) * CELL;
      let ground = false;
      for (const b of world.boxes) {
        if (x + P.halfWidth <= b.minX || x - P.halfWidth >= b.maxX) continue;
        if (z + P.halfWidth <= b.minZ || z - P.halfWidth >= b.maxZ) continue;
        if (b.maxY > 0.001 && b.minY < P.standHeight) return false;
        if (Math.abs(b.maxY) < 0.001 && x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ)
          ground = true;
      }
      return ground;
    };
    const cell = (v: number) => Math.floor((v + 30) / CELL);
    const seen = new Uint8Array(N * N);
    const queue = [cell(0) + cell(5) * N]; // on the north-south bridge, south of the column
    seen[queue[0] as number] = 1;
    for (let q = 0; q < queue.length; q++) {
      const at = queue[q] as number;
      const i = at % N;
      const j = Math.floor(at / N);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N || seen[ni + nj * N] || !open(ni, nj)) continue;
        seen[ni + nj * N] = 1;
        queue.push(ni + nj * N);
      }
    }
    for (const pad of level.spawnZones)
      expect(seen[cell(pad.pos[0]) + cell(pad.pos[2]) * N], pad.id).toBe(1);
  });

  it("uses only abilities the movement code has", () => {
    // The map is built for the full kit: a wall run needs the speed it asks for to be reachable.
    expect(P.wallRunMinSpeed).toBeLessThan(P.runSpeed);
  });
});
