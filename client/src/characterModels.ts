import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import assassinUrl from "./models/assassin.glb?url";
import trooperUrl from "./models/trooper.glb?url";
import { PALETTE } from "./palette";

/**
 * Character models made in Blockbench (source files in `art/blockbench/`, exported as .glb into
 * `client/src/models/`). Loaded once at startup with `loadCharacterModels()`; `CharacterBody`
 * then hangs each model's parts on its code joints, so the code animations, the rifle IK and the
 * hitbox work unchanged. A look without a loaded model falls back to its code-built parts (as in
 * the unit tests, which have no browser to load images).
 *
 * The rules for a model (spec/art/style-guide.md, "Blockbench models"):
 * - Generic Model format, 32 units per metre, exported as glTF binary with scale 32.
 * - Bones named after the joints: body > hip_l, hip_r, upper > head, shoulder_l > elbow_l,
 *   shoulder_r > elbow_r, with pivots exactly at the joints in `character.ts`
 *   (`characterModels.test.ts` checks this).
 * - The texture uses palette colours only. HAZARD and the team colours (COBALT, VIOLET) glow a little and SIGNAL
 *   pixels glow fully, worked out here from the texture, so accents stay readable in shadow.
 */

export type ModelLook = "trooper" | "assassin";

const URLS: Record<ModelLook, string> = { trooper: trooperUrl, assassin: assassinUrl };

/** The joints a model's bones attach to, by bone name. */
export const MODEL_BONES = [
  "hip_l",
  "hip_r",
  "upper",
  "head",
  "shoulder_l",
  "shoulder_r",
  "elbow_l",
  "elbow_r",
] as const;
export type ModelBone = (typeof MODEL_BONES)[number];

export interface CharacterModel {
  /** The parts of each bone: meshes positioned relative to that bone's pivot. */
  parts: Record<ModelBone, THREE.Mesh[]>;
  /** Shared by every character with this look. */
  material: THREE.MeshLambertMaterial;
  /** Swapped in for a moment when the character is hit. */
  flash: THREE.MeshBasicMaterial;
}

/** How much of its own colour each accent glows with. */
const GLOW: [THREE.Color, number][] = [
  [PALETTE.HAZARD, 0.4],
  [PALETTE.SIGNAL, 1],
  [PALETTE.COBALT, 0.3],
  [PALETTE.VIOLET, 0.3],
];

const models = new Map<ModelLook, CharacterModel>();

/** The loaded model for a look, if there is one. */
export function characterModel(look: string): CharacterModel | undefined {
  return models.get(look as ModelLook);
}

/** Load every character model. Call once at startup, before creating any `CharacterBody`. */
export async function loadCharacterModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    (Object.keys(URLS) as ModelLook[]).map(async (look) => {
      const gltf = await loader.loadAsync(URLS[look]);
      models.set(look, toCharacterModel(gltf.scene));
    }),
  );
}

function toCharacterModel(scene: THREE.Object3D): CharacterModel {
  let map: THREE.Texture | null = null;
  const parts = Object.fromEntries(MODEL_BONES.map((b) => [b, [] as THREE.Mesh[]])) as Record<
    ModelBone,
    THREE.Mesh[]
  >;
  for (const bone of MODEL_BONES) {
    const node = scene.getObjectByName(bone);
    if (!node) throw new Error(`character model has no bone "${bone}"`);
    for (const child of node.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      map ??= mesh.material.map;
      parts[bone].push(mesh);
    }
  }
  if (!map) throw new Error("character model has no texture");
  const material = paletteMaterial(map);
  const flash = new THREE.MeshBasicMaterial({ color: PALETTE.BONE });
  for (const meshes of Object.values(parts)) for (const m of meshes) m.material = material;
  return { parts, material, flash };
}

/**
 * The material for a Blockbench model's texture: sharp pixels, and the accents glow (see GLOW).
 * Also used by the rifle (rifle.ts).
 */
export function paletteMaterial(map: THREE.Texture): THREE.MeshLambertMaterial {
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map, emissive: 0xffffff, emissiveMap: glowMap(map) });
}

/** A copy of the texture where only the glowing accents are lit (everything else black). */
function glowMap(map: THREE.Texture): THREE.Texture {
  const image = map.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas");
  ctx.drawImage(image, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  // Texture pixels are sRGB; the glow is written as linear light (like HAZARD_GLOW in character.ts).
  const glows = GLOW.map(([c, k]) => ({
    hex: c.getHex(THREE.SRGBColorSpace),
    glow: c.clone().multiplyScalar(k),
  }));
  for (let i = 0; i < px.length; i += 4) {
    const hex = ((px[i] ?? 0) << 16) | ((px[i + 1] ?? 0) << 8) | (px[i + 2] ?? 0);
    const g = glows.find((x) => x.hex === hex)?.glow;
    px[i] = g ? Math.round(g.r * 255) : 0;
    px[i + 1] = g ? Math.round(g.g * 255) : 0;
    px[i + 2] = g ? Math.round(g.b * 255) : 0;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas); // no colour space: the values are already linear
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = map.flipY;
  return tex;
}
