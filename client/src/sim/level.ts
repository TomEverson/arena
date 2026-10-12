import type { Aabb, CollisionWorld, RiseDir } from "./types";

/** Level data as stored in /levels/*.json. Units are metres, Y is up. */
export interface Level {
  name: string;
  boxes: LevelBox[];
  ramps: LevelRamp[];
  spawnZones: LevelSpawn[];
  /** Practice dummies (Phase 1 gunplay testing). */
  targets: LevelTarget[];
}

export interface LevelBox {
  id: string;
  /** Centre of the box. */
  pos: [number, number, number];
  size: [number, number, number];
  /** Hold jump while facing it to climb. */
  climbable?: boolean;
}

export interface LevelRamp extends LevelBox {
  /** Which side is high. */
  rises: RiseDir;
}

export interface LevelSpawn {
  id: string;
  /** Centre of the zone footprint, at floor level: players spawn with their feet at pos.y. */
  pos: [number, number, number];
  size: [number, number, number];
}

export interface LevelTarget {
  id: string;
  /** Feet position. */
  pos: [number, number, number];
  kind: "static" | "strafe";
  /** Strafe axis and half-range in metres (strafe only). */
  axis: "x" | "z";
  range: number;
}

const RISES: readonly string[] = ["+x", "-x", "+z", "-z"];

function fail(path: string, msg: string): never {
  throw new Error(`level: ${path}: ${msg}`);
}

function vec3(v: unknown, path: string, positive = false): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) fail(path, "expected [x, y, z]");
  for (const n of v) {
    if (typeof n !== "number" || !Number.isFinite(n)) fail(path, "expected finite numbers");
    if (positive && n <= 0) fail(path, "sizes must be positive");
  }
  const [x, y, z] = v as [number, number, number]; // checked above
  return [x, y, z];
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "expected an object");
  return v as Record<string, unknown>;
}

function list(v: unknown, path: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(path, "expected an array");
  return v;
}

function parseBox(v: unknown, path: string): LevelBox {
  const o = record(v, path);
  if (typeof o.id !== "string") fail(`${path}.id`, "expected a string");
  if (o.climbable !== undefined && typeof o.climbable !== "boolean") {
    fail(`${path}.climbable`, "expected true or false");
  }
  const box: LevelBox = {
    id: o.id,
    pos: vec3(o.pos, `${path}.pos`),
    size: vec3(o.size, `${path}.size`, true),
  };
  if (o.climbable) box.climbable = true;
  return box;
}

function parseTarget(v: unknown, path: string): LevelTarget {
  const o = record(v, path);
  if (typeof o.id !== "string") fail(`${path}.id`, "expected a string");
  const kind = o.kind ?? "static";
  if (kind !== "static" && kind !== "strafe") fail(`${path}.kind`, "expected static or strafe");
  const axis = o.axis ?? "x";
  if (axis !== "x" && axis !== "z") fail(`${path}.axis`, "expected x or z");
  const range = o.range ?? 0;
  if (typeof range !== "number" || !Number.isFinite(range) || range < 0)
    fail(`${path}.range`, "expected a number >= 0");
  return { id: o.id, pos: vec3(o.pos, `${path}.pos`), kind, axis, range };
}

/** Validate untyped JSON into a Level. Unknown fields (e.g. controlPoints) are ignored. */
export function parseLevel(json: unknown): Level {
  const o = record(json, "root");
  return {
    name: typeof o.name === "string" ? o.name : "unnamed",
    boxes: list(o.boxes, "boxes").map((b, i) => parseBox(b, `boxes[${i}]`)),
    ramps: list(o.ramps, "ramps").map((r, i) => {
      const box = parseBox(r, `ramps[${i}]`);
      const rises = record(r, `ramps[${i}]`).rises;
      if (typeof rises !== "string" || !RISES.includes(rises)) {
        fail(`ramps[${i}].rises`, `expected one of ${RISES.join(", ")}`);
      }
      return { ...box, rises: rises as RiseDir };
    }),
    spawnZones: list(o.spawnZones, "spawnZones").map((z, i) => parseBox(z, `spawnZones[${i}]`)),
    targets: list(o.targets, "targets").map((t, i) => parseTarget(t, `targets[${i}]`)),
  };
}

export function toAabb(b: LevelBox): Aabb {
  const [x, y, z] = b.pos;
  const [w, h, d] = b.size;
  const aabb: Aabb = {
    minX: x - w / 2,
    maxX: x + w / 2,
    minY: y - h / 2,
    maxY: y + h / 2,
    minZ: z - d / 2,
    maxZ: z + d / 2,
  };
  if (b.climbable) aabb.climbable = true;
  return aabb;
}

export function buildCollisionWorld(level: Level): CollisionWorld {
  return {
    boxes: level.boxes.map(toAabb),
    ramps: level.ramps.map((r) => ({ box: toAabb(r), rises: r.rises })),
  };
}
