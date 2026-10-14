import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { paletteMaterial } from "./characterModels";
import kitUrl from "./models/ffa-kit.glb?url";
import type { Level, LevelBox, LevelProp, LevelRamp } from "./sim/level";

/**
 * The level kit: Blockbench modules that dress the level's boxes, ramps and props, in place of
 * textured boxes. Made in `art/blockbench/ffa-kit.bbmodel` (the first props side by side in
 * `ffa-props.bbmodel`), exported as `models/ffa-kit.glb` with one node per module, each at its own
 * origin. Collision never changes: every module is laid out to fit inside the piece it dresses.
 *
 * Three kinds of module, by how they are laid out:
 *
 *   face modules  dress one face of a box. Modelled with the face in X (right) and Y (up), +Z out
 *                 of the box, and all their relief going inward (Z <= 0). A face is tiled with as
 *                 many as fit at their nominal size, each stretched a little to fill it exactly.
 *   runs          (barrier, kerb, pipe) run along X, are repeated along a box's long side.
 *   props         (crates, lamp, mast, vent, hook, pillar parts, lattice) stand on their origin.
 *
 * Every placement becomes one instance of an InstancedMesh, so the whole map costs one draw call
 * per module. Loaded once at startup with `loadLevelKit()`; without it (the unit tests) the
 * level is drawn as plain textured boxes, as before.
 */

type Kit = Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>;
let kit: Kit | undefined;

/** Is the kit loaded? */
export const hasLevelKit = (): boolean => kit !== undefined;

/** Load the kit. Call once at startup, before the level is built. */
export async function loadLevelKit(): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(kitUrl);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const materials = new Map<THREE.Texture, THREE.Material>();
  const loaded: Kit = new Map();
  for (const node of scene.children) {
    // The loader renames a node whose name is taken (a crate's "rail" part and the handrail
    // module): use the name the file gives it.
    const index = gltf.parser.associations.get(node)?.nodes;
    const json = gltf.parser.json as { nodes: { name?: string }[] };
    const name = (index === undefined ? undefined : json.nodes[index]?.name) ?? node.name;
    const geos: THREE.BufferGeometry[] = [];
    let map: THREE.Texture | null = null;
    node.traverse((n) => {
      if (!(n instanceof THREE.Mesh)) return;
      const mesh = n as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      map ??= mesh.material.map;
      geos.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    });
    if (!map || geos.length === 0) throw new Error(`level kit module "${name}" is empty`);
    if (FACE_MODULES.has(name))
      for (let i = 0; i < geos.length; i++) geos[i] = withoutBack(geos[i] as THREE.BufferGeometry);
    let material = materials.get(map);
    if (!material) materials.set(map, (material = paletteMaterial(map)));
    loaded.set(name, { geometry: mergeGeometries(geos), material });
  }
  kit = loaded;
}

/** The face modules: their -Z faces point into the box they dress, so are never seen. */
const FACE_MODULES = new Set([
  "deck_top",
  "deck_side",
  "deck_under",
  "tower_A",
  "tower_B",
  "wall_panel",
  "plate_top",
  "concrete_side",
  "concrete_top",
  "slab",
  "slab_pit",
  "slab_drain",
  "tread",
]);

/** A copy of an indexed geometry without its triangles that face -Z. */
function withoutBack(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = geo.index;
  const normal = geo.getAttribute("normal");
  if (!index) return geo;
  const keep: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    if (normal.getZ(a) < -0.99) continue;
    keep.push(a, index.getX(t + 1), index.getX(t + 2));
  }
  const out = geo.clone();
  out.setIndex(keep);
  return out;
}

/** Collects placements per module; `build()` turns them into one InstancedMesh each. */
export class KitPlacer {
  private readonly placed = new Map<string, THREE.Matrix4[]>();

  add(module: string, m: THREE.Matrix4): void {
    let list = this.placed.get(module);
    if (!list) this.placed.set(module, (list = []));
    list.push(m);
  }

  /** Place a module standing at `at`, turned by `yaw` about Y, scaled per axis. */
  stand(module: string, at: THREE.Vector3, yaw = 0, scale = ONE): void {
    this.add(module, new THREE.Matrix4().compose(at, Q.setFromAxisAngle(UP, yaw), scale));
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    if (!kit) return group;
    for (const [name, matrices] of this.placed) {
      const part = kit.get(name);
      if (!part) throw new Error(`level kit has no module "${name}"`);
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
      mesh.name = name;
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const Q = new THREE.Quaternion();

/** Cheap stable hash of a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** A face module choice: the module (or one picked per tile), its modelled size, the tile size to aim for. */
interface FaceKit {
  module: string | ((tile: number) => string);
  size: [number, number];
  tile?: [number, number];
  /** A different module for the first and last column (along u): ramp edges. */
  edge?: string;
}

/**
 * Tile a rectangle of `width` x `height` centred on `centre`, lying along `u` (width) and `v`
 * (height), facing `n` (u x v must equal n), with a face module.
 */
function tileFace(
  out: KitPlacer,
  face: FaceKit,
  centre: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  n: THREE.Vector3,
  width: number,
  height: number,
  seed: string,
  covered?: (corners: THREE.Vector3[]) => boolean,
): void {
  const [mw, mh] = face.size;
  const [tw, th] = face.tile ?? face.size;
  const nu = Math.max(1, Math.round(width / tw));
  const nv = Math.max(1, Math.round(height / th));
  const cw = width / nu;
  const ch = height / nv;
  const x = u.clone().multiplyScalar(cw / mw);
  const y = v.clone().multiplyScalar(ch / mh);
  const base = hash(seed);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const at = centre
        .clone()
        .addScaledVector(u, (i + 0.5) * cw - width / 2)
        .addScaledVector(v, (j + 0.5) * ch - height / 2);
      if (covered) {
        // Just in front of the tile's corners: if another box holds them all, the tile is hidden.
        const front = at.clone().addScaledVector(n, 0.02);
        const corners = [-1, 1].flatMap((su) =>
          [-1, 1].map((sv) =>
            front
              .clone()
              .addScaledVector(u, (su * cw) / 2 - su * 0.01)
              .addScaledVector(v, (sv * ch) / 2 - sv * 0.01),
          ),
        );
        if (covered(corners)) continue;
      }
      const module =
        face.edge && (i === 0 || i === nu - 1)
          ? face.edge
          : typeof face.module === "string"
            ? face.module
            : face.module(base + i * 7919 + j * 104729);
      out.add(module, new THREE.Matrix4().makeBasis(x, y, n).setPosition(at));
    }
}

/** How each surface's faces are dressed: sides, top, and (only for raised pieces) bottom. */
interface BoxKit {
  side?: FaceKit;
  top?: FaceKit;
  bottom?: FaceKit;
  /** Sides 3 m or taller get a plinth band along the bottom and a cap band along the top. */
  bands?: { base: FaceKit; cap: FaceKit };
}

const pick = (mods: string[], every: number) => (k: number) =>
  k % every === 0 ? (mods[1] as string) : (mods[0] as string);

/** Wall panels: mostly plain, with a vent or a service hatch here and there. */
const wallPanel = (k: number): string =>
  k % 13 === 0 ? "wall_panel_hatch" : k % 9 === 0 ? "wall_panel_vent" : "wall_panel";

/** Paving: mostly plain slabs, some worn, some with a drain or a manhole. */
const paving = (k: number): string =>
  k % 11 === 0 ? "slab_manhole" : k % 7 === 0 ? "slab_drain" : k % 5 === 0 ? "slab_patch" : "slab";

const KITS: Record<string, BoxKit> = {
  panel: {
    side: { module: wallPanel, size: [4, 3] },
    top: { module: "plate_top", size: [2, 2] },
    bottom: { module: "deck_under", size: [2, 2] },
    bands: {
      base: { module: "wall_base", size: [4, 0.8] },
      cap: { module: "wall_cap", size: [4, 0.6] },
    },
  },
  concrete: {
    side: { module: "concrete_side", size: [2, 2], tile: [4, 3.5] },
    top: { module: "concrete_top", size: [2, 2] },
    bottom: { module: "concrete_side", size: [2, 2], tile: [4, 4] },
  },
  ground: {
    side: { module: "concrete_side", size: [2, 2], tile: [4, 3] },
    top: { module: paving, size: [4, 4], tile: [8, 8] },
  },
  pit: { top: { module: "slab_pit", size: [4, 4], tile: [8, 8] } },
  metal: {
    side: { module: "deck_side", size: [1, 0.5], tile: [3, 0.5] },
    top: { module: "deck_top", size: [2, 2], tile: [3, 3] },
    bottom: { module: "deck_under", size: [2, 2], tile: [4, 4] },
  },
};

/** The level's outer extent: the outside faces of the perimeter wall lie on it. */
interface Edge {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
function edgeOf(level: Level): Edge {
  const e = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of level.boxes) {
    e.minX = Math.min(e.minX, b.pos[0] - b.size[0] / 2);
    e.maxX = Math.max(e.maxX, b.pos[0] + b.size[0] / 2);
    e.minZ = Math.min(e.minZ, b.pos[2] - b.size[2] / 2);
    e.maxZ = Math.max(e.maxZ, b.pos[2] + b.size[2] / 2);
  }
  return e;
}

type Covered = (corners: THREE.Vector3[]) => boolean;

/** Is every point inside one of the level's boxes? (Hidden tiles: floor under blocks, walls against walls.) */
function coveredBy(level: Level): Covered {
  const boxes = level.boxes.map((b) => ({
    minX: b.pos[0] - b.size[0] / 2,
    maxX: b.pos[0] + b.size[0] / 2,
    minY: b.pos[1] - b.size[1] / 2,
    maxY: b.pos[1] + b.size[1] / 2,
    minZ: b.pos[2] - b.size[2] / 2,
    maxZ: b.pos[2] + b.size[2] / 2,
  }));
  return (corners) =>
    boxes.some((b) =>
      corners.every(
        (p) =>
          p.x >= b.minX &&
          p.x <= b.maxX &&
          p.y >= b.minY &&
          p.y <= b.maxY &&
          p.z >= b.minZ &&
          p.z <= b.maxZ,
      ),
    );
}

type Solid = (p: THREE.Vector3) => boolean;

/** Is a point inside any box or ramp (its whole bounding box)? */
function solidOf(level: Level): Solid {
  const all = [...level.boxes, ...level.ramps].map((b) => ({
    minX: b.pos[0] - b.size[0] / 2,
    maxX: b.pos[0] + b.size[0] / 2,
    minY: b.pos[1] - b.size[1] / 2,
    maxY: b.pos[1] + b.size[1] / 2,
    minZ: b.pos[2] - b.size[2] / 2,
    maxZ: b.pos[2] + b.size[2] / 2,
  }));
  return (p) =>
    all.some(
      (b) =>
        p.x > b.minX &&
        p.x < b.maxX &&
        p.y > b.minY &&
        p.y < b.maxY &&
        p.z > b.minZ &&
        p.z < b.maxZ,
    );
}

/**
 * Dress a box's faces with a surface's face modules. Faces against the level's outer bounds and
 * bottoms resting on the ground are left out: nobody can see them.
 */
function dressBox(out: KitPlacer, b: LevelBox, k: BoxKit, edge: Edge, covered: Covered): void {
  const [w, h, d] = b.size;
  const [x, y, z] = b.pos;
  const c = new THREE.Vector3(x, y, z);
  const raised = y - h / 2 > 0.05;
  const face = (
    fk: FaceKit | undefined,
    n: THREE.Vector3,
    v: THREE.Vector3,
    width: number,
    height: number,
    half: number,
    tag: string,
  ) => {
    if (!fk) return;
    const at = c.clone().addScaledVector(n, half);
    // On the outside of the perimeter: never seen.
    if (
      at.x >= edge.maxX - 0.01 ||
      at.x <= edge.minX + 0.01 ||
      at.z >= edge.maxZ - 0.01 ||
      at.z <= edge.minZ + 0.01
    )
      return;
    const u = v.clone().cross(n);
    const seed = `${b.id}/${tag}`;
    const bands = fk === k.side ? k.bands : undefined;
    if (!bands || height < 3) {
      tileFace(out, fk, at, u, v, n, width, height, seed, covered);
      return;
    }
    // Plinth along the bottom, cap along the top, panels between.
    const hb = bands.base.size[1];
    const hc = bands.cap.size[1];
    const band = (kit: FaceKit, shift: number, tall: number, part: string) =>
      tileFace(
        out,
        kit,
        at.clone().addScaledVector(v, shift),
        u,
        v,
        n,
        width,
        tall,
        `${seed}/${part}`,
        covered,
      );
    band(bands.base, -(height - hb) / 2, hb, "base");
    band(bands.cap, (height - hc) / 2, hc, "cap");
    band(fk, (hb - hc) / 2, height - hb - hc, "field");
  };
  face(k.side, new THREE.Vector3(1, 0, 0), UP, d, h, w / 2, "+x");
  face(k.side, new THREE.Vector3(-1, 0, 0), UP, d, h, w / 2, "-x");
  face(k.side, new THREE.Vector3(0, 0, 1), UP, w, h, d / 2, "+z");
  face(k.side, new THREE.Vector3(0, 0, -1), UP, w, h, d / 2, "-z");
  face(k.top, UP, new THREE.Vector3(0, 0, -1), w, d, h / 2, "top");
  if (raised)
    face(k.bottom, new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), w, d, h / 2, "bot");
}

/** The yaw that turns a module modelled along X to lie along a box's long side. */
const alongYaw = (b: LevelBox): number => (b.size[0] >= b.size[2] ? 0 : Math.PI / 2);

/** Crates: the nearest of the three, stretched to the box (a little at most), turned to fit. */
function crate(out: KitPlacer, b: LevelBox): void {
  const [w, h, d] = b.size;
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const [module, ml, ms] =
    long >= 3
      ? ["crate_4x1", 4, 1]
      : short >= long * 0.75
        ? ["crate_2x2", 2, 2]
        : ["crate_2x1", 2, 1];
  const flip = hash(b.id) % 2 === 0 ? 0 : Math.PI;
  out.stand(
    module,
    new THREE.Vector3(b.pos[0], b.pos[1] - h / 2, b.pos[2]),
    alongYaw(b) + flip,
    new THREE.Vector3(long / ml, h / 1.2, short / ms),
  );
}

/** Barriers and kerbs: their 1 m module repeated along the box, stretched to its height and depth. */
function run(out: KitPlacer, b: LevelBox, module: string, height: number, depth: number): void {
  const [w, h, d] = b.size;
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const n = Math.max(1, Math.round(long));
  const step = long / n;
  const yaw = alongYaw(b);
  const along = w >= d ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const scale = new THREE.Vector3(step, h / height, short / depth);
  for (let i = 0; i < n; i++) {
    const at = new THREE.Vector3(b.pos[0], b.pos[1] - h / 2, b.pos[2]).addScaledVector(
      along,
      (i + 0.5) * step - long / 2,
    );
    out.stand(module, at, yaw, scale);
  }
}

/** Pillars: base, shaft segments about a metre tall, cap; all stretched to the footprint. */
function pillar(out: KitPlacer, b: LevelBox): void {
  const [w, h, d] = b.size;
  const bottom = b.pos[1] - h / 2;
  const at = (y: number) => new THREE.Vector3(b.pos[0], y, b.pos[2]);
  if (h < 1.5) {
    out.stand("pillar_shaft", at(bottom), 0, new THREE.Vector3(w, h, d));
    return;
  }
  out.stand("pillar_base", at(bottom), 0, new THREE.Vector3(w, 1, d));
  out.stand("pillar_cap", at(bottom + h - 0.5), 0, new THREE.Vector3(w, 1, d));
  const shaft = h - 1;
  const n = Math.max(1, Math.round(shaft));
  for (let i = 0; i < n; i++)
    out.stand(
      "pillar_shaft",
      at(bottom + 0.5 + (i * shaft) / n),
      0,
      new THREE.Vector3(w, shaft / n, d),
    );
}

/** Thin tall metal posts: lattice segments about a metre tall, with a cap and its light on top. */
function lattice(out: KitPlacer, b: LevelBox): void {
  const [w, h, d] = b.size;
  const bottom = b.pos[1] - h / 2;
  const n = Math.max(1, Math.round(h / 2)); // segments about 2 m tall
  for (let i = 0; i < n; i++)
    out.stand(
      "lattice",
      new THREE.Vector3(b.pos[0], bottom + (i * h) / n, b.pos[2]),
      0,
      new THREE.Vector3(w / 0.5, h / n, d / 0.5),
    );
  out.stand(
    "lattice_cap",
    new THREE.Vector3(b.pos[0], bottom + h - 0.1, b.pos[2]),
    0,
    new THREE.Vector3(w / 0.5, 1, d / 0.5),
  );
}

/** Surfaces dressed by the kit (containers are containers.ts's). */
const KIT_SURFACES = new Set([...Object.keys(KITS), "crate", "barrier", "stripe", "pillar"]);

/** Does the kit draw this box (so the plain box must not be drawn)? */
export function isKitBox(b: LevelBox): boolean {
  return kit !== undefined && b.surface !== undefined && KIT_SURFACES.has(b.surface);
}

/** Dress every box the kit draws. */
export function dressBoxes(out: KitPlacer, level: Level): void {
  const edge = edgeOf(level);
  const covered = coveredBy(level);
  const solid = solidOf(level);
  if (kit) laneDashes(out, level, solid);
  for (const b of level.boxes) {
    if (!isKitBox(b)) continue;
    if (b.surface === "ground") groundKerbs(out, b, solid);
    const [w, h, d] = b.size;
    switch (b.surface) {
      case "crate":
        crate(out, b);
        break;
      case "barrier":
        run(out, b, "barrier", 2.5, 1);
        break;
      case "stripe":
        run(out, b, "kerb", 2.2, 2);
        break;
      case "pillar":
        pillar(out, b);
        break;
      case "metal":
        if (Math.max(w, d) <= 0.6 && h > 2) lattice(out, b);
        else dressBox(out, b, KITS.metal as BoxKit, edge, covered);
        break;
      default:
        dressBox(out, b, KITS[b.surface as string] as BoxKit, edge, covered);
    }
  }
}

/** How far a kerb stone stands proud of the paving (so the two never share a plane). */
const KERB_LIFT = 0.03;

/**
 * Kerb stones along a raised floor's top edges, wherever the floor drops away (into the pit, a
 * basin, a trench). Edges against another box or a ramp get none.
 */
function groundKerbs(out: KitPlacer, b: LevelBox, solid: Solid): void {
  const [w, h, d] = b.size;
  const top = b.pos[1] + h / 2;
  for (const [n, length, half] of [
    [new THREE.Vector3(1, 0, 0), d, w / 2],
    [new THREE.Vector3(-1, 0, 0), d, w / 2],
    [new THREE.Vector3(0, 0, 1), w, d / 2],
    [new THREE.Vector3(0, 0, -1), w, d / 2],
  ] as const) {
    const inward = n.clone().negate(); // the stone's depth runs into the floor (module +Y)
    const along = inward.clone().cross(UP); // u = v x n, with n = up
    const count = Math.max(1, Math.round(length));
    const step = length / count;
    const x = along.clone().multiplyScalar(step);
    for (let i = 0; i < count; i++) {
      const edgeAt = new THREE.Vector3(b.pos[0], top, b.pos[2])
        .addScaledVector(n, half)
        .addScaledVector(along, (i + 0.5) * step - length / 2);
      // Open if, just past the edge and a little below the top, there is nothing.
      if (
        solid(
          edgeAt
            .clone()
            .addScaledVector(n, 0.3)
            .setY(top - 0.5),
        )
      )
        continue;
      const at = edgeAt.addScaledVector(inward, 0.25).setY(top + KERB_LIFT);
      out.add("ground_kerb", new THREE.Matrix4().makeBasis(x, inward, UP).setPosition(at));
    }
  }
}

/** Where lane lines are painted: the avenues between the districts and the ring road. */
const LANE_LINES = [-97, -33, 33, 97];
const DASH_EVERY = 4;

/** Painted dashes down the middle of the avenues and the ring road, where the floor is clear. */
function laneDashes(out: KitPlacer, level: Level, solid: Solid): void {
  const floors = level.boxes.filter((b) => b.surface === "ground");
  const floorTop = (x: number, z: number): number | undefined => {
    for (const b of floors) {
      if (Math.abs(x - b.pos[0]) < b.size[0] / 2 && Math.abs(z - b.pos[2]) < b.size[2] / 2)
        return b.pos[1] + b.size[1] / 2;
    }
    return undefined;
  };
  for (const line of LANE_LINES)
    for (const alongX of [true, false])
      for (let t = -96; t <= 96; t += DASH_EVERY) {
        const x = alongX ? t : line;
        const z = alongX ? line : t;
        const ends: [number, number][] = [-1, 1].map((s) => (alongX ? [x + s, z] : [x, z + s]));
        const tops = ends.map(([ex, ez]) => floorTop(ex, ez));
        const y = tops[0];
        if (y === undefined || tops.some((v) => v !== y)) continue;
        if (ends.some(([ex, ez]) => solid(new THREE.Vector3(ex, y + 0.3, ez)))) continue;
        out.stand("lane_dash", new THREE.Vector3(x, y + 0.004, z), alongX ? 0 : Math.PI / 2);
      }
}

/** A ramp's slope as a face: its centre, the up-slope direction and the across direction. */
function slope(r: LevelRamp) {
  const [w, h, d] = r.size;
  const alongX = r.rises[1] === "x";
  const sign = r.rises[0] === "-" ? -1 : 1;
  const run = alongX ? w : d;
  const across = alongX ? d : w;
  const a = alongX ? new THREE.Vector3(sign, 0, 0) : new THREE.Vector3(0, 0, sign);
  const up = a.clone().multiplyScalar(run).addScaledVector(UP, h).normalize(); // up the slope
  const n = UP.clone().multiplyScalar(run).addScaledVector(a, -h).normalize(); // out of the surface
  return { centre: new THREE.Vector3(...r.pos), up, n, across, length: Math.hypot(run, h) };
}

/** Handrails along a ramp's open sides. They are looks only (no collision), like every prop. */
const RAMP_RAILS = true;

/**
 * Ramps: tread plates on the slope, with darker edge plates down both sides (an ACID nosing on
 * every plate's upper edge). A solid ramp gets a skirt under each slope edge; an open stair flight
 * (`-flight-`) a girder stringer instead, since it has no wedge. A side with a drop beside it gets
 * a handrail.
 */
export function dressRamps(out: KitPlacer, level: Level): void {
  const solid = solidOf(level);
  for (const r of level.ramps) {
    const s = slope(r);
    const u = s.up.clone().cross(s.n);
    const flight = r.id.includes("-flight-");
    tileFace(
      out,
      { module: "tread", edge: "tread_edge", size: [1, 1], tile: [1, 1.5] },
      s.centre,
      u,
      s.up,
      s.n,
      s.across,
      s.length,
      r.id,
    );
    for (const side of [-1, 1]) {
      const out_ = u.clone().multiplyScalar(side);
      const along = s.n.clone().cross(out_); // u x v = n for a face on the ramp's side
      const edgeMid = s.centre.clone().addScaledVector(u, (side * s.across) / 2);
      if (flight)
        tileFace(
          out,
          { module: "deck_side", size: [1, 0.5], tile: [2, 0.5] },
          edgeMid.clone().addScaledVector(s.n, -0.25),
          along,
          s.n,
          out_,
          s.length,
          0.5,
          `${r.id}/${side}`,
        );
      else
        tileFace(
          out,
          { module: "ramp_skirt", size: [1, 0.6], tile: [2, 0.6] },
          // A hair outside the wedge's side, so the two never share a plane.
          edgeMid.clone().addScaledVector(s.n, -0.3).addScaledVector(out_, 0.01),
          along,
          s.n,
          out_,
          s.length,
          0.6,
          `${r.id}/${side}`,
        );
      if (!RAMP_RAILS) continue;
      // Open: nothing just past the side, a little under the middle of the slope.
      if (solid(edgeMid.clone().addScaledVector(out_, 0.4).addScaledVector(UP, -0.3))) continue;
      const count = Math.max(1, Math.round(s.length));
      const slopeStep = s.up.clone().multiplyScalar(s.length / count);
      const railLine = edgeMid.clone().addScaledVector(out_, -0.06);
      for (let i = 0; i < count; i++) {
        const at = railLine
          .clone()
          .addScaledVector(s.up, (i + 0.5 - count / 2) * (s.length / count));
        // Posts stand straight up and the rails follow the slope: a sheared basis. Its third
        // axis is taken from the first two, so it is never mirrored (the rail is symmetric).
        const across = slopeStep.clone().cross(UP).normalize();
        out.add("rail", new THREE.Matrix4().makeBasis(slopeStep, UP, across).setPosition(at));
      }
    }
  }
}

/** A unit vector for a prop's `face` name ("+x", "-z"...), and the yaw that turns +Z to it. */
function faceYaw(face: string | undefined): number {
  const sign = face?.[0] === "-" ? -1 : 1;
  if (face?.[1] === "x") return (sign * Math.PI) / 2;
  return sign > 0 ? 0 : Math.PI;
}

/** Place a prop from the kit. Returns false for a kind the kit has no model for. */
export function placeProp(out: KitPlacer, p: LevelProp, index: number): boolean {
  const at = new THREE.Vector3(...p.pos);
  switch (p.kind) {
    case "lamp":
      out.stand("lamp", at, p.yaw);
      return true;
    case "mast": {
      const [w, h] = p.size ?? [0.2, 6, 0.2];
      out.stand("mast", at, 0, new THREE.Vector3(w / 0.25, h / 8, w / 0.25));
      return true;
    }
    case "unit":
      out.stand("vent", at, faceYaw(p.face));
      return true;
    case "pipe": {
      const [len, t] = p.size ?? [10, 0.2, 0.2];
      const yaw = faceYaw(p.face);
      const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const along = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const centre = at.clone().addScaledVector(n, t * 0.8);
      const k = t / 0.22;
      out.stand("pipe", centre, yaw, new THREE.Vector3(len, k, k));
      for (let c = -len / 2 + 5; c < len / 2; c += 10)
        out.stand(
          "pipe_bracket",
          centre.clone().addScaledVector(along, c),
          yaw,
          new THREE.Vector3(k, k, k),
        );
      return true;
    }
    case "hook": {
      const [, drop] = p.size ?? [0.6, 3, 0.6];
      out.stand("hook_cable", at, 0, new THREE.Vector3(1, drop - 0.3, 1));
      out.stand("hook_block", at.clone().setY(at.y - drop + 0.3));
      return true;
    }
    case "tower": {
      tower(out, p, index);
      return true;
    }
    default:
      return false;
  }
}

/** Below this height a far tower is hidden by the 26 m perimeter wall: its facade starts here. */
const TOWER_FACADE_FROM = 20;

/** A city tower: window facades on its four sides above the wall line, a roof crown, sometimes an antenna. */
function tower(out: KitPlacer, p: LevelProp, index: number): void {
  const [w, h, d] = p.size ?? [16, 50, 16];
  const [x, y, z] = p.pos;
  const from = Math.min(TOWER_FACADE_FROM, h - 8);
  const tall = h - from;
  const mid = new THREE.Vector3(x, y + from + tall / 2, z);
  const facade: FaceKit = { module: pick(["tower_A", "tower_B"], 2), size: [8, 8], tile: [12, 12] };
  for (const [n, half, width] of [
    [new THREE.Vector3(1, 0, 0), w / 2, d],
    [new THREE.Vector3(-1, 0, 0), w / 2, d],
    [new THREE.Vector3(0, 0, 1), d / 2, w],
    [new THREE.Vector3(0, 0, -1), d / 2, w],
  ] as const) {
    const u = UP.clone().cross(n);
    tileFace(
      out,
      facade,
      mid.clone().addScaledVector(n, half),
      u,
      UP,
      n,
      width,
      tall,
      `tower${index}/${n.x},${n.z}`,
    );
  }
  const top = new THREE.Vector3(x, y + h, z);
  tileFace(
    out,
    { module: "plate_top", size: [2, 2], tile: [8, 8] },
    top,
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
    UP,
    w,
    d,
    `tower${index}/top`,
  );
  out.stand("tower_roof", top, 0, new THREE.Vector3(w, 1, d));
  if (index % 3 === 0) out.stand("tower_antenna", top);
}

/** The core a tower's facades are hung on: the old dark block, pulled in behind the windows. */
export const TOWER_CORE_INSET = 0.6;
