import * as THREE from "three";

import sniperUrl from "./models/sniper.glb?url";
import { PALETTE } from "./palette";
import {
  type Brick,
  BRICK_MAG_HOME,
  type GunModel,
  gunModelParts,
  type GunParts,
  loadGunModel,
  SIGHT_CLEAR_AT,
  sightMask,
} from "./rifle";

/**
 * "Needle": the sniper rifle (weapon slot 2). A long, mostly BONE rifle in the same family as the
 * Brick: a stock with a raised cheek rest, a big hollow scope along the top, a bolt on the right that
 * cycles after every shot, a long handguard with a folded bipod, a thin fluted barrel with an
 * angular muzzle brake, and the same SIGNAL ammo strip on the receiver (five rounds, so the
 * strip drops in big steps). Same gun space and the same interface as the Brick, so the
 * viewmodel, the body and the viewer treat both alike.
 *
 * The model is made in Blockbench (`art/blockbench/sniper.bbmodel`, exported as
 * `models/sniper.glb`, same rules as the rifle's: see rifle.ts) and loaded once at startup with
 * `loadSniperModel()`. Without it (the unit tests) the sniper falls back to an older look built
 * from boxes. Either way the reticle is drawn in code at the eyepiece; aiming lines the scope's
 * axis up with the middle of the screen and the world zooms behind it.
 *
 * Gun space: +X right, +Y up, -Z toward the muzzle; grip at z = -0.1.
 */

export const SNIPER_NAME = "Needle";

/** Height of the scope's axis above the bore (gun space): aiming lines this up with screen centre. */
export const SNIPER_SIGHT_Y = 0.12;

/** Where bullets (the tracer) leave. */
export const SNIPER_MUZZLE = new THREE.Vector3(0, 0.02, -1.36);

/** Where the bolt handle sits at rest (its group origin). */
const BOLT_HOME = new THREE.Vector3(0.05, 0.03, -0.2);
const BOLT_KICK = 0.09; // metres the bolt handle travels back
const BOLT_SECONDS = 0.9; // the cycle after a shot: back, then forward
const STRIP_LENGTH = 0.22;
const STRIP_REAR_Z = -0.14;
const LOW_AMMO = 0.4; // two rounds or fewer of five

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

let model: GunModel | undefined;

/** Load the Blockbench sniper. Call once at startup, before building any sniper. */
export async function loadSniperModel(): Promise<void> {
  model = await loadGunModel(sniperUrl, SNIPER_MUZZLE, BOLT_HOME);
}

/** The older look, built from boxes: what the sniper is when the model is not loaded. */
function boxParts(): GunParts & { rods: THREE.Group } {
  const root = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const shroud = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE, flatShading: true });
  const ink = new THREE.MeshLambertMaterial({ color: PALETTE.INK, flatShading: true });
  const glass = new THREE.MeshLambertMaterial({
    color: PALETTE.SIGNAL,
    emissive: PALETTE.SIGNAL,
    flatShading: true,
  });
  const strip = glass.clone();

  // Receiver and stock.
  box(root, body, [0.07, 0.1, 0.5], [0, 0, -0.3]);
  box(root, shroud, [0.04, 0.02, 0.5], [0, 0.06, -0.3]); // top rail
  box(root, body, [0.06, 0.12, 0.12], [0, -0.01, -0.02]); // rear block
  box(root, body, [0.045, 0.1, 0.26], [0, -0.025, 0.14]); // stock
  box(root, shroud, [0.05, 0.12, 0.025], [0, -0.025, 0.28]); // butt pad
  box(root, ink, [0.045, 0.04, 0.16], [0, 0.04, 0.12]); // cheek riser
  box(root, ink, [0.055, 0.12, 0.06], [0, -0.095, -0.095], 0.25); // grip

  // Handguard and the long barrel with a muzzle brake.
  box(root, shroud, [0.065, 0.065, 0.42], [0, 0, -0.74]);
  box(root, body, [0.07, 0.025, 0.4], [0, -0.04, -0.74]);
  box(root, ink, [0.025, 0.025, 0.42], [0, 0.01, -1.16]);
  box(root, shroud, [0.05, 0.05, 0.1], [0, 0.01, -1.3]);
  box(root, ink, [0.052, 0.018, 0.03], [0, 0.01, -1.3]);

  // The scope: a hollow tube (so you can see through it), on two rings, with a thin reticle at the
  // eyepiece. Four bars make each square section; the window is 0.074 m across.
  const tube = (z: number, depth: number, outer: number, mat: THREE.Material) => {
    const t = 0.008;
    const y = SNIPER_SIGHT_Y;
    box(root, mat, [outer, t, depth], [0, y + (outer - t) / 2, z]);
    box(root, mat, [outer, t, depth], [0, y - (outer - t) / 2, z]);
    box(root, mat, [t, outer - 2 * t, depth], [(outer - t) / 2, y, z]);
    box(root, mat, [t, outer - 2 * t, depth], [-(outer - t) / 2, y, z]);
  };
  // The scope body is four thin corner rods between two thin rings, not a solid tube: looking
  // through it, the view is open and the frame only edges it.
  // Aimed, the eye sits at the eyepiece and the rest of the gun (rail, mounts, barrel) would fill
  // the lower half of the window: a mask across the eyepiece keeps the window clear.
  // The rods run back past the eyepiece, so they hide too when aimed (they would sit in the corners of the view).
  const rods = new THREE.Group();
  root.add(rods);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      box(rods, ink, [0.01, 0.01, 0.32], [sx * 0.04, SNIPER_SIGHT_Y + sy * 0.04, -0.34]);
    }
  }
  tube(-0.5, 0.02, 0.11, body); // objective ring
  tube(-0.22, 0.02, 0.1, body); // eyepiece ring
  box(root, ink, [0.02, 0.05, 0.04], [0, 0.085, -0.26]); // rings
  box(root, ink, [0.02, 0.05, 0.04], [0, 0.085, -0.42]);
  // The bolt: a handle on the right side that kicks back and forward after every shot.
  const bolt = new THREE.Group();
  bolt.position.copy(BOLT_HOME);
  box(bolt, ink, [0.05, 0.012, 0.012], [0.03, 0, 0]);
  box(bolt, shroud, [0.022, 0.022, 0.022], [0.06, 0, 0]);
  root.add(bolt);

  // A small box magazine under the receiver, in its own group for the reload.
  const mag = new THREE.Group();
  mag.position.copy(BRICK_MAG_HOME);
  box(mag, body, [0.05, 0.1, 0.1], [0, -0.01, -0.07]);
  box(mag, shroud, [0.054, 0.014, 0.104], [0, -0.065, -0.07]);
  root.add(mag);

  // Ammo strips on both sides.
  const stripGeo = new THREE.BoxGeometry(0.006, 0.014, STRIP_LENGTH);
  stripGeo.translate(0, 0, -STRIP_LENGTH / 2);
  const stripMeshes = [-1, 1].map((side) => {
    const m = new THREE.Mesh(stripGeo, strip);
    m.position.set(side * 0.0365, 0.012, STRIP_REAR_Z);
    root.add(m);
    return m;
  });
  return { root, mag, slide: bolt, strips: stripMeshes, strip, rods };
}

export function buildSniper(): Brick {
  // The box look's scope rods stick out past the eyepiece, so they hide when aimed.
  const boxes = model ? undefined : boxParts();
  const rods = boxes?.rods;
  const parts: GunParts = boxes ?? gunModelParts(model as GunModel, BOLT_HOME);
  const { root, mag, slide: bolt, strips: stripMeshes, strip } = parts;
  // The reticle: thin crosshair bars across the window and a SIGNAL dot, near the eye end.
  // Four hairlines that stop short of the middle and a small SIGNAL dot, unlit so they stay crisp:
  // the target is never hidden behind the reticle.
  const hair = new THREE.MeshBasicMaterial({ color: PALETTE.INK });
  const dot = new THREE.MeshBasicMaterial({ color: PALETTE.SIGNAL });
  const [reach, gap, thick] = [0.042, 0.004, 0.0006];
  for (const side of [-1, 1]) {
    const mid = (side * (reach + gap)) / 2;
    box(root, hair, [reach - gap, thick, 0.001], [mid, SNIPER_SIGHT_Y, -0.2]);
    box(root, hair, [thick, reach - gap, 0.001], [0, SNIPER_SIGHT_Y + mid, -0.2]);
  }
  box(root, dot, [0.001, 0.001, 0.001], [0, SNIPER_SIGHT_Y, -0.2]);
  const mask = sightMask(0.084, 0.084, [0, SNIPER_SIGHT_Y, -0.209]);
  root.add(mask);

  const boltHome = bolt.position.z;

  let cycle = 0; // 1 right after a shot, falling to 0 over BOLT_SECONDS

  return {
    root,
    mag,
    slide: bolt,
    strips: stripMeshes,
    shoot() {
      cycle = 1;
    },
    aim(t) {
      mask.visible = t >= SIGHT_CLEAR_AT;
      if (rods) rods.visible = !mask.visible;
    },
    update(dt, ammo, time) {
      cycle = Math.max(0, cycle - dt / BOLT_SECONDS);
      // Back fast for the first fifth of the cycle, then forward over the rest.
      const u = 1 - cycle;
      const out = cycle <= 0 ? 0 : u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8;
      bolt.position.z = boltHome + BOLT_KICK * Math.max(0, out);
      const frac = Math.min(1, Math.max(0, ammo));
      for (const s of stripMeshes) {
        s.scale.z = Math.max(0.0001, frac);
        s.visible = frac > 0;
      }
      const low = frac <= LOW_AMMO;
      const on = !low || Math.floor(time * 8) % 2 === 0;
      const color = low ? PALETTE.HAZARD : PALETTE.SIGNAL;
      strip.color.copy(on ? color : PALETTE.INK);
      strip.emissive.copy(on ? color : PALETTE.INK);
    },
  };
}
