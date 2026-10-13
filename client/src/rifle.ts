import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { paletteMaterial } from "./characterModels";
import rifleUrl from "./models/rifle.glb?url";
import { PALETTE } from "./palette";

/**
 * "Brick": the rifle. An assault rifle in the Apex R-301 / Flatline family: a skeleton stock, a
 * two-tone receiver with a raked BONE armour plate, a forward-raked magazine, an angular BONE
 * handguard with slanted vents, a short barrel with a chunky muzzle brake and a wedge-shaped
 * holo sight on a toothed top rail. Its sides are painted as pixel art (panel lines, vents,
 * edge highlights), in palette colours only.
 *
 * The model is made in Blockbench (`art/blockbench/rifle.bbmodel`, exported as
 * `models/rifle.glb`) and loaded once at startup with `loadBrickModel()`. Without it (as in the
 * unit tests, which have no browser to load images) the rifle falls back to an older look built
 * from boxes. Rules for the model: 32 units per metre, facing north (-Z), a locator named
 * `muzzle` at the muzzle (the whole model is placed by it, so it may sit anywhere in Blockbench),
 * and the moving parts in bones named `mag`, `slide`, `strip_l` and `strip_r`.
 *
 * The one signature feature is the ammo strip: a SIGNAL light on each side of the receiver, in a
 * black channel under the armour plate, that shrinks as the magazine empties and turns HAZARD
 * and blinks when it is nearly out, so the ammo can be read off the gun itself.
 *
 * Moving parts: the charging handle kicks back on every shot (the "slide"), and the magazine is
 * its own group so a reload can pull it out and slot it back in.
 *
 * Gun space (the first-person convention): +X right, +Y up, -Z toward the muzzle. The bore is
 * the Z axis; the grip is at z = -0.1 and the handguard starts at about z = -0.4.
 * For the third-person body, rotate `root` half a turn about Y so the muzzle points +Z.
 */

export const BRICK_NAME = "Brick";

/** Where bullets leave and the muzzle flash sits. */
export const BRICK_MUZZLE = new THREE.Vector3(0, 0.012, -0.85);
/** Height of the optic's reticle above the bore (gun space): ADS lines this up with screen centre. */
export const BRICK_SIGHT_Y = 0.107;
/** Where the magazine sits when seated (its group origin). */
export const BRICK_MAG_HOME = new THREE.Vector3(0, -0.1, -0.28);

/** The strip blinks (HAZARD) at or under this share of a full magazine. */
export const LOW_AMMO = 0.25;
const BLINK_HZ = 4;
const SLIDE_KICK = 0.035; // metres the slide travels back on a shot
const SLIDE_RECOVER = 14; // per second

const STRIP_LENGTH = 0.2;
const STRIP_REAR_Z = -0.14; // the strip shrinks toward the rear
const SLIDE_HOME = new THREE.Vector3(0, 0.075, -0.36);

export interface Brick {
  /** The whole rifle. */
  readonly root: THREE.Group;
  /** The magazine, at BRICK_MAG_HOME when seated. Move it for the reload. */
  readonly mag: THREE.Group;
  /** The slide on the top rail (kicks back on a shot). */
  readonly slide: THREE.Group;
  /** The two ammo strips (left and right), for tests and tuning. */
  readonly strips: readonly THREE.Mesh[];
  /** A shot was fired: the slide kicks back. */
  shoot(): void;
  /** How far aimed down sights the gun is (0 hip, 1 aimed): lets a gun clear its sight window (see `sightMask`). */
  aim?(t: number): void;
  /**
   * A reload of its own, for a gun the standard one (tilt, magazine out and in) does not suit:
   * `t` is how far through it is (0..1), or a negative number when not reloading. Called after
   * `update` each frame.
   */
  reload?(t: number): void;
  /**
   * Per frame. `ammo` is the share of a full magazine left (0..1); `time` is seconds, for the
   * blink. Also settles the slide.
   */
  update(dt: number, ammo: number, time: number): void;
}

/** How far aimed (0..1) before a gun's sight window clears. */
export const SIGHT_CLEAR_AT = 0.3;

/**
 * An invisible pane filling a sight's window. It draws nothing but is drawn first and fills the
 * depth buffer, so the parts of the gun behind it (rail, slide, barrel) are not drawn there and
 * the world shows through the sight instead. Only right when looking down the sight: show it
 * while aimed and hide it otherwise.
 */
export function sightMask(w: number, h: number, [x, y, z]: [number, number, number]): THREE.Mesh {
  const mask = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  mask.position.set(x, y, z);
  mask.renderOrder = -1;
  mask.visible = false;
  return mask;
}

function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  [w, h, d]: [number, number, number],
  [x, y, z]: [number, number, number],
  rotX = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rotX;
  parent.add(mesh);
  return mesh;
}

/** A gun's parts before it is given its behaviour. */
export interface GunParts {
  root: THREE.Group;
  mag: THREE.Group;
  slide: THREE.Group;
  strips: THREE.Mesh[];
  /** The ammo strips' own material: it changes colour and blinks. */
  strip: THREE.MeshLambertMaterial;
}

function stripMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color: PALETTE.SIGNAL,
    emissive: PALETTE.SIGNAL,
    flatShading: true,
  });
}

/** A Blockbench gun model, baked into gun space: one geometry per moving part. */
export interface GunModel {
  fixed: THREE.BufferGeometry;
  /** Relative to BRICK_MAG_HOME. */
  mag: THREE.BufferGeometry;
  /** Relative to the slide's home. */
  slide: THREE.BufferGeometry;
  /** Left and right, each relative to its rear end (z = stripZ). */
  strips: THREE.BufferGeometry[];
  /** Where the strips' rear end is: the pivot of the model's strip bones. */
  stripZ: number;
  material: THREE.MeshLambertMaterial;
}

const MODEL_BONES = ["mag", "slide", "strip_l", "strip_r"] as const;
type ModelPart = (typeof MODEL_BONES)[number] | "fixed";

let model: GunModel | undefined;

/** Load the Blockbench rifle. Call once at startup, before building any rifle. */
export async function loadBrickModel(): Promise<void> {
  model = await loadGunModel(rifleUrl, BRICK_MUZZLE, SLIDE_HOME);
}

/**
 * Load a Blockbench gun (the rules are at the top of this file) and bake it into gun space:
 * its `muzzle` locator goes to `muzzleAt`, and the `slide` bone's parts are stored relative to
 * `slideHome`. Shared with the sniper (sniper.ts).
 */
export async function loadGunModel(
  url: string,
  muzzleAt: THREE.Vector3,
  slideHome: THREE.Vector3,
): Promise<GunModel> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return toGunModel(gltf.scene, muzzleAt, slideHome);
}

function toGunModel(
  scene: THREE.Object3D,
  muzzleAt: THREE.Vector3,
  slideHome: THREE.Vector3,
): GunModel {
  scene.updateMatrixWorld(true);
  const muzzle = scene.getObjectByName("muzzle");
  if (!muzzle) throw new Error('gun model has no locator "muzzle"');
  // Wherever the model sits in Blockbench, its muzzle goes to `muzzleAt`.
  const shift = muzzleAt.clone().sub(muzzle.getWorldPosition(new THREE.Vector3()));
  // The strips shrink toward their bones' pivot, so that is their rear end.
  const stripBone = scene.getObjectByName("strip_l");
  if (!stripBone) throw new Error('gun model has no bone "strip_l"');
  const stripZ = stripBone.getWorldPosition(new THREE.Vector3()).z + shift.z;
  const homes: Record<ModelPart, THREE.Vector3> = {
    fixed: new THREE.Vector3(),
    mag: BRICK_MAG_HOME,
    slide: slideHome,
    strip_l: new THREE.Vector3(0, 0, stripZ),
    strip_r: new THREE.Vector3(0, 0, stripZ),
  };
  const geos: Record<ModelPart, THREE.BufferGeometry[]> = {
    fixed: [],
    mag: [],
    slide: [],
    strip_l: [],
    strip_r: [],
  };
  let map: THREE.Texture | null = null;
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    map ??= mesh.material.map;
    let part: ModelPart = "fixed";
    for (let p = mesh.parent; p; p = p.parent) {
      const bone = MODEL_BONES.find((b) => b === p.name);
      if (bone) {
        part = bone;
        break;
      }
    }
    const home = homes[part];
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geo.translate(shift.x - home.x, shift.y - home.y, shift.z - home.z);
    geos[part].push(geo);
  });
  if (!map) throw new Error("gun model has no texture");
  const merged = (part: ModelPart) => {
    if (geos[part].length === 0) throw new Error(`gun model has no parts in "${part}"`);
    return mergeGeometries(geos[part]);
  };
  return {
    fixed: merged("fixed"),
    mag: merged("mag"),
    slide: merged("slide"),
    strips: [merged("strip_l"), merged("strip_r")],
    stripZ,
    material: paletteMaterial(map),
  };
}

/** A new gun from a loaded model: its own groups and strip material, sharing the model's geometry. */
export function gunModelParts(m: GunModel, slideHome: THREE.Vector3): GunParts {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(m.fixed, m.material));
  const mag = new THREE.Group();
  mag.position.copy(BRICK_MAG_HOME);
  mag.add(new THREE.Mesh(m.mag, m.material));
  const slide = new THREE.Group();
  slide.position.copy(slideHome);
  slide.add(new THREE.Mesh(m.slide, m.material));
  root.add(mag, slide);
  const strip = stripMaterial();
  const strips = m.strips.map((geo) => {
    const mesh = new THREE.Mesh(geo, strip);
    mesh.position.z = m.stripZ;
    root.add(mesh);
    return mesh;
  });
  return { root, mag, slide, strips, strip };
}

/** The older look, built from boxes: what the rifle is when the model is not loaded. */
function boxParts(): GunParts {
  const root = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const shroud = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE, flatShading: true });
  const ink = new THREE.MeshLambertMaterial({ color: PALETTE.INK, flatShading: true });
  const lens = new THREE.MeshBasicMaterial({ color: PALETTE.SIGNAL, side: THREE.DoubleSide });
  const strip = stripMaterial();

  // Receiver, with a raised rail along the top and a stub of stock behind it.
  box(root, body, [0.075, 0.095, 0.3], [0, 0, -0.26]);
  box(root, shroud, [0.04, 0.018, 0.34], [0, 0.056, -0.28]); // top rail
  box(root, body, [0.06, 0.11, 0.1], [0, -0.005, -0.06]); // rear block
  box(root, body, [0.04, 0.075, 0.12], [0, -0.012, 0.04]); // stock
  box(root, shroud, [0.046, 0.085, 0.02], [0, -0.012, 0.11]); // butt pad

  // Lighter side plates break up the dark body, so it reads in the low-res image.
  box(root, shroud, [0.079, 0.05, 0.12], [0, -0.016, -0.2]);

  // Grip, slanted back.
  box(root, body, [0.055, 0.12, 0.06], [0, -0.095, -0.095], 0.25);

  // Angular shroud over the barrel: a tall block with a lighter top and dark vent slots.
  box(root, shroud, [0.09, 0.075, 0.22], [0, 0, -0.52]);
  box(root, body, [0.094, 0.03, 0.2], [0, -0.042, -0.52]); // darker underside
  for (const z of [-0.45, -0.5, -0.55]) box(root, ink, [0.094, 0.026, 0.016], [0, 0.008, z]); // vents
  box(root, ink, [0.03, 0.03, 0.1], [0, 0.012, -0.68]); // barrel
  box(root, shroud, [0.052, 0.052, 0.04], [0, 0.012, -0.74]); // muzzle brake
  box(root, ink, [0.054, 0.02, 0.024], [0, 0.012, -0.74]); // brake slot

  // Open-frame optic on the rail: a base and a square frame with nothing in the window, so you
  // can see the target through it, and a single SIGNAL dot as the reticle at the back of the frame.
  // The reticle sits at height BRICK_SIGHT_Y: the aim-down-sights position lines it up with the
  // middle of the screen, which is where the bullets go.
  box(root, ink, [0.04, 0.012, 0.08], [0, 0.071, -0.22]);
  box(root, ink, [0.07, 0.005, 0.04], [0, 0.0795, -0.22]); // bottom bar
  box(root, ink, [0.07, 0.005, 0.04], [0, 0.1345, -0.22]); // top bar
  for (const side of [-1, 1])
    box(root, ink, [0.005, 0.06, 0.04], [side * 0.0325, BRICK_SIGHT_Y, -0.22]);
  const reticle = new THREE.Group();
  reticle.position.set(0, BRICK_SIGHT_Y, -0.2);
  reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.0035, 12), lens)); // a single dot
  root.add(reticle);

  // The slide on the rail: kicks back on every shot.
  const slide = new THREE.Group();
  slide.position.copy(SLIDE_HOME);
  box(slide, shroud, [0.034, 0.022, 0.06], [0, 0, 0]);
  box(slide, ink, [0.012, 0.012, 0.03], [0, 0.015, 0.01]);
  root.add(slide);

  // Magazine ahead of the grip: its own group so a reload can move it.
  const mag = new THREE.Group();
  mag.position.copy(BRICK_MAG_HOME);
  box(mag, body, [0.05, 0.13, 0.07], [0, -0.02, 0]);
  box(mag, shroud, [0.054, 0.018, 0.074], [0, -0.095, 0]); // base plate
  box(mag, ink, [0.052, 0.02, 0.02], [0, -0.01, 0.03]); // follower window
  root.add(mag);

  // Ammo strips on both sides. Their geometry hangs forward from its rear end, so scaling Z
  // shrinks the strip toward the rear.
  const stripGeo = new THREE.BoxGeometry(0.006, 0.014, STRIP_LENGTH);
  stripGeo.translate(0, 0, -STRIP_LENGTH / 2);
  const stripMeshes = [-1, 1].map((side) => {
    const m = new THREE.Mesh(stripGeo, strip);
    m.position.set(side * 0.0395, 0.012, STRIP_REAR_Z);
    root.add(m);
    return m;
  });
  return { root, mag, slide, strips: stripMeshes, strip };
}

export function buildBrick(): Brick {
  const {
    root,
    mag,
    slide,
    strips: stripMeshes,
    strip,
  } = model ? gunModelParts(model, SLIDE_HOME) : boxParts();
  // Both looks have the same sight window, so they share its mask.
  const mask = sightMask(0.06, 0.05, [0, BRICK_SIGHT_Y, -0.205]);
  root.add(mask);
  const slideHome = slide.position.z;

  let kick = 0;

  return {
    root,
    mag,
    slide,
    strips: stripMeshes,
    shoot() {
      kick = 1;
    },
    aim(t) {
      mask.visible = t >= SIGHT_CLEAR_AT;
    },
    update(dt, ammo, time) {
      kick = Math.max(0, kick - dt * SLIDE_RECOVER);
      slide.position.z = slideHome + SLIDE_KICK * kick;
      const frac = Math.min(1, Math.max(0, ammo));
      for (const s of stripMeshes) {
        s.scale.z = Math.max(0.0001, frac);
        s.visible = frac > 0;
      }
      const low = frac <= LOW_AMMO;
      const blinkOn = !low || Math.floor(time * BLINK_HZ * 2) % 2 === 0;
      const color = low ? PALETTE.HAZARD : PALETTE.SIGNAL;
      strip.color.copy(blinkOn ? color : PALETTE.INK);
      strip.emissive.copy(blinkOn ? color : PALETTE.INK);
    },
  };
}
