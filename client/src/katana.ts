import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { paletteMaterial } from "./characterModels";
import katanaUrl from "./models/katana.glb?url";
import { PALETTE } from "./palette";

/**
 * The Assassin's blade: a katana. A curved blade with a darker spine and a bright edge, a dark
 * guard with a BRASS collar, and a handle in a VIOLET wrap (the Assassin's colour) with BONE
 * diamonds and BRASS caps. One model for every place a blade is held: both fists in first person
 * (fx.ts), both hands and the slash in third person (character.ts).
 *
 * The model is made in Blockbench (`art/blockbench/katana.bbmodel`, exported as
 * `models/katana.glb`, 32 units per metre) and loaded once at startup with `loadKatanaModel()`.
 * Only the parts in its `katana` group are the sword; the `saya` group is the sheath, for the
 * Assassin's hips later. A locator named `grip` marks the middle of the handle. Without the
 * model (the unit tests) a blade is a plain BONE bar.
 *
 * Sword space: the grip at the origin, the blade pointing -Z, its cutting edge down (-Y).
 */

/** From the grip to the tip (metres). */
export const KATANA_REACH = 0.875;

let model: { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined;

/** Load the Blockbench katana. Call once at startup, before building any blade. */
export async function loadKatanaModel(): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(katanaUrl);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const sword = scene.getObjectByName("katana");
  const grip = scene.getObjectByName("grip");
  if (!sword || !grip) throw new Error('katana model needs a group "katana" and a locator "grip"');
  const at = grip.getWorldPosition(new THREE.Vector3());
  const geos: THREE.BufferGeometry[] = [];
  let map: THREE.Texture | null = null;
  sword.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    map ??= mesh.material.map;
    geos.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).translate(-at.x, -at.y, -at.z));
  });
  if (!map || geos.length === 0) throw new Error("katana model has no textured parts");
  model = { geometry: mergeGeometries(geos), material: paletteMaterial(map) };
}

/** A new katana in sword space. Every one shares the same geometry and material. */
export function buildKatana(): THREE.Mesh {
  if (model) return new THREE.Mesh(model.geometry, model.material);
  const bar = new THREE.BoxGeometry(0.012, 0.06, KATANA_REACH);
  bar.translate(0, 0, -KATANA_REACH / 2);
  return new THREE.Mesh(
    bar,
    new THREE.MeshLambertMaterial({ color: PALETTE.BONE, flatShading: true }),
  );
}
