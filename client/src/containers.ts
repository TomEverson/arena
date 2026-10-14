import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { paletteMaterial } from "./characterModels";
import containerUrl from "./models/container.glb?url";
import blueUrl from "./models/container-blue.png?url";
import graphiteUrl from "./models/container-graphite.png?url";
import redUrl from "./models/container-red.png?url";
import whiteUrl from "./models/container-white.png?url";
import type { Level, LevelBox } from "./sim/level";

/**
 * Shipping containers: a Blockbench model (corrugated walls, corner castings, door end with lock
 * rods, an ID plate) in two lengths and four paints. Made in `art/blockbench/container-game.bbmodel`
 * (the paints side by side in `container.bbmodel`), exported as `models/container.glb` with a node
 * per length (`c14`, `c10`: 14 or 10 m long along X, 3 m wide and tall, standing on its origin,
 * doors at +X) and one texture per paint (`models/container-*.png`, same layout).
 *
 * A level box whose surface is `container` or `container-light` is drawn with these instead of a
 * textured box. Its collision does not change: the model fits the box exactly. A 6 m box is a
 * stack of two. `container-light` is always white; `container` is graphite, red or blue, picked
 * from the box id so the map looks the same for everyone. Loaded once at startup with
 * `loadContainerModels()`; without it (the unit tests) containers stay plain boxes.
 */

type Paint = "graphite" | "red" | "blue" | "white";
type Length = 14 | 10;

const TEXTURES: Record<Paint, string> = {
  graphite: graphiteUrl,
  red: redUrl,
  blue: blueUrl,
  white: whiteUrl,
};
/** The paints a dark (`container`) box picks from. */
const DARK_PAINTS: readonly Paint[] = ["graphite", "red", "blue"];
/** Height of one container: taller boxes are stacks. */
const UNIT = 3;

let geometries: Map<Length, THREE.BufferGeometry> | undefined;
let materials: Map<Paint, THREE.Material> | undefined;

/** Load the model and its paints. Call once at startup, before the level is built. */
export async function loadContainerModels(): Promise<void> {
  const [gltf, ...maps] = await Promise.all([
    new GLTFLoader().loadAsync(containerUrl),
    ...(Object.keys(TEXTURES) as Paint[]).map((p) =>
      new THREE.TextureLoader().loadAsync(TEXTURES[p]),
    ),
  ]);
  gltf.scene.updateMatrixWorld(true);
  const geos = new Map<Length, THREE.BufferGeometry>();
  for (const len of [14, 10] as const) {
    const node = gltf.scene.getObjectByName(`c${len}`);
    if (!node) throw new Error(`container model has no node "c${len}"`);
    const parts: THREE.BufferGeometry[] = [];
    node.traverse((n) => {
      if (n instanceof THREE.Mesh) {
        const mesh = n as THREE.Mesh<THREE.BufferGeometry>;
        parts.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      }
    });
    if (parts.length === 0) throw new Error(`container model node "c${len}" has no parts`);
    geos.set(len, mergeGeometries(parts));
  }
  geometries = geos;
  // The glb's own texture has flipY off (glTF convention); the PNGs must match it.
  const mats = new Map<Paint, THREE.Material>();
  (Object.keys(TEXTURES) as Paint[]).forEach((p, i) => {
    const map = maps[i] as THREE.Texture;
    map.flipY = false;
    mats.set(p, paletteMaterial(map));
  });
  materials = mats;
}

/** Is this box a container the model can draw (loaded, a known length, 3 m wide, whole stacks)? */
export function isModelContainer(b: LevelBox): boolean {
  if (!geometries || !b.surface?.startsWith("container")) return false;
  const [w, h, d] = b.size;
  const long = Math.max(w, d);
  return (
    Math.min(w, d) === UNIT &&
    (long === 14 || long === 10) &&
    h >= UNIT &&
    Number.isInteger(h / UNIT)
  );
}

/** Cheap stable hash of a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** All the level's containers: one instanced mesh per length and paint (at most eight draws). */
export function buildContainers(level: Level): THREE.Group {
  const group = new THREE.Group();
  if (!geometries || !materials) return group;
  const placed = new Map<string, { len: Length; paint: Paint; matrices: THREE.Matrix4[] }>();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  for (const b of level.boxes) {
    if (!isModelContainer(b)) continue;
    const [w, h, d] = b.size;
    const len = Math.max(w, d) as Length;
    const tiers = h / UNIT;
    for (let t = 0; t < tiers; t++) {
      const k = hash(`${b.id}/${t}`);
      const paint =
        b.surface === "container-light" ? "white" : (DARK_PAINTS[k % DARK_PAINTS.length] as Paint);
      // Long along X as modelled, or turned to lie along Z; doors at either end.
      const yaw = (w >= d ? 0 : Math.PI / 2) + ((k >>> 8) % 2 === 0 ? 0 : Math.PI);
      q.setFromAxisAngle(up, yaw);
      const at = new THREE.Vector3(b.pos[0], b.pos[1] - h / 2 + t * UNIT, b.pos[2]);
      const key = `${len}/${paint}`;
      let slot = placed.get(key);
      if (!slot) placed.set(key, (slot = { len, paint, matrices: [] }));
      slot.matrices.push(new THREE.Matrix4().compose(at, q, one));
    }
  }
  for (const { len, paint, matrices } of placed.values()) {
    const mesh = new THREE.InstancedMesh(
      geometries.get(len),
      materials.get(paint),
      matrices.length,
    );
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
