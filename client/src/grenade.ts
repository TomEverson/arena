import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { paletteMaterial } from "./characterModels";
import beaconUrl from "./models/beacon.glb?url";
import grenadeUrl from "./models/grenade.glb?url";
import { PALETTE } from "./palette";

/**
 * The Trooper's thrown things, two colour schemes of one Blockbench model (a canister about
 * 18 cm tall with a lever, a pin and a wide HAZARD band, so both read as danger):
 *
 *   grenade  the frag grenade (Q): GRAPHITE with grooves, black stripes on the band.
 *   beacon   the marker that calls the bombardment (F): BONE, with down-pointing chevrons on the
 *            band and a SIGNAL light.
 *
 * Made in Blockbench (`art/blockbench/grenade.bbmodel` and `beacon.bbmodel`, exported as
 * `models/*.glb`, 32 units per metre), loaded once at startup with `loadGrenadeModels()`. Each
 * has a locator named `centre`: the model tumbles about it. Without the models (the unit tests)
 * both are the old plain HAZARD box.
 */

export type GrenadeLook = "grenade" | "beacon";

const URLS: Record<GrenadeLook, string> = { grenade: grenadeUrl, beacon: beaconUrl };
const models = new Map<GrenadeLook, { geometry: THREE.BufferGeometry; material: THREE.Material }>();

/** Load both models. Call once at startup, before any grenade is drawn. */
export async function loadGrenadeModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    (Object.keys(URLS) as GrenadeLook[]).map(async (look) => {
      const scene = (await loader.loadAsync(URLS[look])).scene;
      scene.updateMatrixWorld(true);
      const centre = scene.getObjectByName("centre");
      if (!centre) throw new Error(`${look} model has no locator "centre"`);
      const at = centre.getWorldPosition(new THREE.Vector3());
      const geos: THREE.BufferGeometry[] = [];
      let map: THREE.Texture | null = null;
      scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        map ??= mesh.material.map;
        geos.push(
          mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).translate(-at.x, -at.y, -at.z),
        );
      });
      if (!map || geos.length === 0) throw new Error(`${look} model has no textured parts`);
      models.set(look, { geometry: mergeGeometries(geos), material: paletteMaterial(map) });
    }),
  );
}

let box: THREE.Mesh | undefined;

/** A new grenade or beacon, centred on its own origin. Every one of a look shares its geometry and material. */
export function buildGrenade(look: GrenadeLook): THREE.Mesh {
  const model = models.get(look);
  if (model) return new THREE.Mesh(model.geometry, model.material);
  box ??= new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
  );
  return box.clone();
}
