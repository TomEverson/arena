import type { Aabb, CollisionWorld, RiseDir } from "./types";

/** Level data as stored in /levels/*.json. Units are metres, Y is up. */
export interface Level {
  name: string;
  boxes: LevelBox[];
  ramps: LevelRamp[];
  spawnZones: LevelSpawn[];
  /** Practice dummies (Phase 1 gunplay testing). */
  targets: LevelTarget[];
  /** Looks only, like `surface` and `glow`: movement and the server never read these three. */
  sky?: string;
  signs: LevelSign[];
  props: LevelProp[];
}

/** Looks only: text painted flat on a wall or on the ground. */
export interface LevelSign {
  id: string;
  text: string;
  /** Centre of the text. */
  pos: [number, number, number];
  /** Height of the letters, metres. */
  size: number;
  /** Which way it faces: "up" (on the ground) or a wall's outward direction. */
  face: string;
  /** On the ground: turned this far about Y (0 = the letters' tops point north, -Z). */
  yaw: number;
}

/** Looks only: a prop built from boxes by the renderer. It is not in the collision world. */
export interface LevelProp {
  id: string;
  kind: string;
  pos: [number, number, number];
  size?: [number, number, number];
  face?: string;
  yaw: number;
}

export interface LevelBox {
  id: string;
  /** Centre of the box. */
  pos: [number, number, number];
  size: [number, number, number];
  /** Looks only (the renderer's; movement and the server ignore them): which surface it is drawn with. */
  surface?: string;
  /** Looks only: where it carries a light strip ("edges", "door-x" or "door-z"). */
  glow?: string;
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
  kind: "static" | "strafe" | "wallrun";
  /** Strafe axis and half-range in metres (strafe and wallrun only). A wallrun target runs along a wall in the air. */
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
  const box: LevelBox = {
    id: o.id,
    pos: vec3(o.pos, `${path}.pos`),
    size: vec3(o.size, `${path}.size`, true),
  };
  if (typeof o.surface === "string") box.surface = o.surface;
  if (typeof o.glow === "string") box.glow = o.glow;
  return box;
}

function parseTarget(v: unknown, path: string): LevelTarget {
  const o = record(v, path);
  if (typeof o.id !== "string") fail(`${path}.id`, "expected a string");
  const kind = o.kind ?? "static";
  if (kind !== "static" && kind !== "strafe" && kind !== "wallrun")
    fail(`${path}.kind`, "expected static, strafe or wallrun");
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
    ...(typeof o.sky === "string" ? { sky: o.sky } : {}),
    signs: list(o.signs, "signs").map((v, i) => {
      const s = record(v, `signs[${i}]`);
      return {
        id: String(s.id),
        text: String(s.text),
        pos: vec3(s.pos, `signs[${i}].pos`),
        size: typeof s.size === "number" ? s.size : 1,
        face: typeof s.face === "string" ? s.face : "up",
        yaw: typeof s.yaw === "number" ? s.yaw : 0,
      };
    }),
    props: list(o.props, "props").map((v, i) => {
      const p = record(v, `props[${i}]`);
      const prop: LevelProp = {
        id: String(p.id),
        kind: String(p.kind),
        pos: vec3(p.pos, `props[${i}].pos`),
        yaw: typeof p.yaw === "number" ? p.yaw : 0,
      };
      if (p.size !== undefined) prop.size = vec3(p.size, `props[${i}].size`, true);
      if (typeof p.face === "string") prop.face = p.face;
      return prop;
    }),
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
  return aabb;
}

export function buildCollisionWorld(level: Level): CollisionWorld {
  return {
    boxes: level.boxes.map(toAabb),
    ramps: level.ramps.map((r) => ({ box: toAabb(r), rises: r.rises })),
  };
}
