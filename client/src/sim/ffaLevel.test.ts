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
/** The arena is the square |x|, |z| <= HALF. */
const HALF = 100;
const EAST = -Math.PI / 2;

describe("the FFA map", () => {
  it("is named ffa and has no practice targets", () => {
    expect(level.name).toBe("ffa");
    expect(level.targets).toHaveLength(0);
  });

  it("carries its looks: night, a surface on every piece, district signs and props", () => {
    expect(level.sky).toBe("night");
    expect(level.boxes.every((b) => typeof b.surface === "string")).toBe(true);
    expect(level.ramps.every((r) => r.surface === "ramp")).toBe(true);
    // Every district's code is on the perimeter wall behind it and on the avenues into it.
    for (const code of ["NW", "N", "NE", "W", "C", "E", "SW", "S", "SE"])
      expect(level.signs.some((s) => s.text === code && s.face === "up")).toBe(true);
    expect(level.signs.filter((s) => s.face !== "up")).toHaveLength(12);
    // Props are looks only, so none may stand where a player walks: every one is thin (a lamp
    // post), up on the wall, above head height, or outside the arena.
    for (const p of level.props) {
      const outside = Math.abs(p.pos[0]) >= HALF || Math.abs(p.pos[2]) >= HALF;
      expect(p.kind === "lamp" || outside || p.pos[1] >= 5).toBe(true);
    }
    expect(level.props.filter((p) => p.kind === "lamp").length).toBeGreaterThan(20);
  });

  it("has spawn pads all over the map, more than there are players", () => {
    expect(level.spawnZones.length).toBeGreaterThanOrEqual(16);
    // Every third of the map (a 3 x 3 grid of districts) has at least one.
    for (const cx of [-66, 0, 66])
      for (const cz of [-66, 0, 66])
        expect(
          level.spawnZones.some(
            (p) => Math.abs(p.pos[0] - cx) < 33 && Math.abs(p.pos[2] - cz) < 33,
          ),
          `district at ${cx}, ${cz}`,
        ).toBe(true);
  });

  it("keeps every piece of geometry inside the arena bounds", () => {
    for (const b of level.boxes) {
      const [w, h, d] = b.size;
      const [x, y, z] = b.pos;
      if (b.id.startsWith("floor-") || b.id.startsWith("wall-")) continue; // the shell goes out to the edge
      expect(Math.abs(x) + w / 2, `${b.id} x`).toBeLessThanOrEqual(HALF);
      expect(Math.abs(z) + d / 2, `${b.id} z`).toBeLessThanOrEqual(HALF);
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

  it("has steps up to the west catwalk and the south gantry (jump and mantle)", () => {
    // Run at the step and jump (mantle onto it), then run on and jump again (mantle onto the walkway).
    const climbTo = (x: number, z: number, yaw: number) => {
      let s = spawnState(x, 0, z);
      let top = 0;
      for (let i = 0; i < 200; i++) {
        s = stepPlayer(
          s,
          { ...emptyInput(), moveZ: 1, yaw, jump: s.onGround && i > 10 },
          world,
          DT,
        );
        if (s.onGround) top = Math.max(top, s.y);
      }
      return top;
    };
    expect(climbTo(-21, -4, WEST), "catwalk").toBeCloseTo(5);
    expect(climbTo(-7.5, 29, 0), "gantry").toBeCloseTo(5.5);
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
    const N = (2 * HALF) / CELL;
    const open = (i: number, j: number): boolean => {
      const x = -HALF + (i + 0.5) * CELL;
      const z = -HALF + (j + 0.5) * CELL;
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
    const cell = (v: number) => Math.floor((v + HALF) / CELL);
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

  it("has six spires you can climb floor by floor", () => {
    // One hop of the climb, on the south centre spire: from a half-floor, run at the wall under
    // the edge of the next one (3.5 m up, on the other side) and jump; the mantle puts you on it.
    // `hero` 1 is the Assassin, who has no second jump: its single jump has to be enough.
    const hop = (hero: number, fromY: number, x: number, yaw: number) => {
      let s = spawnState(x, fromY, 17);
      let top = fromY;
      for (let i = 0; i < 150; i++) {
        s = stepPlayer(
          s,
          { ...emptyInput(), hero, moveZ: 1, yaw, jump: s.onGround && i > 5 },
          world,
          DT,
        );
        if (s.onGround) top = Math.max(top, s.y);
        if (top > fromY + 1) break;
      }
      return top;
    };
    for (const hero of [0, 1]) {
      expect(hop(hero, 3, -6.2, EAST), `hero ${hero}: step to the first floor`).toBeCloseTo(5.5);
      expect(hop(hero, 5.5, -2, EAST), `hero ${hero}: first floor to second`).toBeCloseTo(9);
      expect(hop(hero, 9, 2, WEST), `hero ${hero}: second floor to third`).toBeCloseTo(12.5);
    }
    // One in the centre north and south, and one in each corner district; every top is the 30 m
    // the rolling dive wants, and every one has a step beside it.
    // (A corner spire's pieces carry their district's prefix: "nw-spire-nw-floor-7".)
    const tops = level.boxes.filter((b) => /^(\w+-)?spire-\w+-floor-7$/.test(b.id));
    expect(tops.map((t) => /spire-(\w+)-floor/.exec(t.id)?.[1]).sort()).toEqual([
      "n",
      "ne",
      "nw",
      "s",
      "se",
      "sw",
    ]);
    for (const t of tops) expect(t.pos[1] + t.size[1] / 2).toBe(30);
    expect(level.boxes.filter((b) => /^(\w+-)?spire-\w+-step$/.test(b.id))).toHaveLength(6);
  });

  it("joins the spires with skybridges you can walk: a ring and a spine", () => {
    const SKY = 26.5;
    // Walk a straight line along the bridges at their height, and stay at it all the way.
    const walk = (x: number, z: number, yaw: number, ticks: number) => {
      let s = spawnState(x, SKY, z);
      for (let i = 0; i < ticks; i++) {
        s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw }, world, DT);
        if (s.y < SKY - 0.01) break;
      }
      return s;
    };
    // The spine: from the middle of the ring's north side, south through both centre spires
    // and over the pit, to the middle of its south side.
    let s = walk(-0.75, -64.5, Math.PI, 1000);
    expect(s.y, "spine").toBeCloseTo(SKY);
    expect(s.z).toBeGreaterThan(62);
    // The ring: each side, from just off one corner spire to the next.
    s = walk(-60, -64.5, EAST, 950);
    expect(s.y, "north side").toBeCloseTo(SKY);
    expect(s.x).toBeGreaterThan(60);
    s = walk(-60, 64.5, EAST, 950);
    expect(s.y, "south side").toBeCloseTo(SKY);
    expect(s.x).toBeGreaterThan(60);
    s = walk(-66, -58, Math.PI, 950);
    expect(s.y, "west side").toBeCloseTo(SKY);
    expect(s.z).toBeGreaterThan(58);
    s = walk(66, -58, Math.PI, 950);
    expect(s.y, "east side").toBeCloseTo(SKY);
    expect(s.z).toBeGreaterThan(58);
  });

  it("uses only abilities the movement code has", () => {
    // The map is built for the full kit: a wall run needs the speed it asks for to be reachable.
    expect(P.wallRunMinSpeed).toBeLessThan(P.runSpeed);
  });
});
