import * as THREE from "three";

import { PALETTE } from "./palette";
import { type Brick, BRICK_MAG_HOME } from "./rifle";

/**
 * The thunder spear launchers (the Assassin's second gun): one on each arm, each a short rail
 * on a grip with a spear lying along the top, its fat explosive head forward. Built from boxes like the other guns and
 * with the same interface, so the viewmodel and the body treat all three alike.
 *
 * The spears on the rails are the ammo display: two loaded shows one on each arm, one loaded
 * shows only the right arm's. Firing knocks that launcher's clamp back.
 *
 * Gun space: +X right, +Y up, -Z toward the muzzle; grip at z = -0.1.
 */

export const SPEAR_NAME = "Spears";

/** Where a spear leaves. */
export const SPEAR_MUZZLE = new THREE.Vector3(0, 0.07, -0.95);
/** Height of the spear above the grip line: aiming lines it up with screen centre. */
export const SPEAR_SIGHT_Y = 0.13;

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

/** A spear on its own (the launcher's round, and what flies): shaft along -Z, head at the front. */
export function buildSpearShaft(): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const head = new THREE.MeshLambertMaterial({
    color: PALETTE.HAZARD,
    emissive: PALETTE.HAZARD.clone().multiplyScalar(0.5),
    flatShading: true,
  });
  const band = new THREE.MeshLambertMaterial({ color: PALETTE.BONE, flatShading: true });
  box(g, shaft, [0.03, 0.03, 0.8], [0, 0, 0]);
  box(g, head, [0.07, 0.07, 0.26], [0, 0, -0.5]); // the charge
  box(g, band, [0.075, 0.075, 0.03], [0, 0, -0.38]);
  box(g, shaft, [0.02, 0.02, 0.08], [0, 0, -0.67]); // the spike
  box(g, band, [0.09, 0.012, 0.1], [0, 0, 0.36]); // tail fins
  box(g, band, [0.012, 0.09, 0.1], [0, 0, 0.36]);
  return g;
}

/** Where a loaded spear sits along its rail (gun space z). */
const SPEAR_ON_RAIL = -0.45;
/** How far to the left of the right launcher the left one sits (gun space). */
export const SPEAR_PAIR_GAP = 0.4;

export function buildSpear(): Brick {
  const root = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const plate = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE, flatShading: true });
  const ink = new THREE.MeshLambertMaterial({ color: PALETTE.INK, flatShading: true });
  const strip = new THREE.MeshLambertMaterial({
    color: PALETTE.SIGNAL,
    emissive: PALETTE.SIGNAL,
    flatShading: true,
  });

  // One launcher on each arm, as in the series: the right one at the grip, the left beside it.
  // Each is a rail the spear lies on, a housing under it, a grip, a brace, and the clamp that
  // holds the spear and kicks back on a shot.
  const strips: THREE.Mesh[] = [];
  const launcher = (x: number) => {
    const g = new THREE.Group();
    g.position.x = x;
    box(g, plate, [0.05, 0.02, 0.6], [0, 0.035, -0.4]);
    box(g, body, [0.07, 0.07, 0.3], [0, -0.01, -0.25]);
    box(g, ink, [0.055, 0.12, 0.06], [0, -0.095, -0.095], 0.25); // grip
    box(g, body, [0.05, 0.06, 0.12], [0, -0.005, 0.0]); // brace
    box(g, ink, [0.03, 0.05, 0.03], [0, -0.06, -0.3]); // trigger guard
    const clamp = new THREE.Group();
    clamp.position.set(0, 0.075, -0.2);
    box(clamp, ink, [0.085, 0.07, 0.04], [0, 0, 0]);
    g.add(clamp);
    const loaded = buildSpearShaft();
    loaded.position.set(0, 0.075, SPEAR_ON_RAIL);
    g.add(loaded);
    for (const side of [-1, 1])
      strips.push(box(g, strip, [0.006, 0.014, 0.12], [side * 0.0365, 0.0, -0.3]));
    root.add(g);
    return { g, clamp, loaded, kick: 0 };
  };
  const right = launcher(0);
  const left = launcher(-SPEAR_PAIR_GAP);
  const clampHome = right.clamp.position.z;

  // The gas canister under the right housing is the "magazine" the reload swaps.
  const mag = new THREE.Group();
  mag.position.copy(BRICK_MAG_HOME);
  box(mag, plate, [0.05, 0.11, 0.09], [0, -0.015, 0.02]);
  box(mag, ink, [0.054, 0.016, 0.094], [0, -0.075, 0.02]);
  root.add(mag);

  /** How full the pair was last frame, to tell which launcher just fired. */
  let was = 1;
  return {
    root,
    mag,
    slide: right.clamp,
    strips,
    shoot() {
      // The left spear goes first (it is the one a full pair still has), then the right.
      (was > 0.75 ? left : right).kick = 1;
    },
    reload(t) {
      // A fresh spear slides forward onto each rail from behind, the left arm's first, then
      // the right's; each clamp opens (slides back) to take it and snaps shut on it.
      [left, right].forEach((l, i) => {
        const from = 0.3 + i * 0.25; // when this arm's spear starts going on
        const u = t < 0 ? 1 : Math.min(1, Math.max(0, (t - from) / 0.2));
        if (t >= 0) l.loaded.visible = t >= from;
        l.loaded.position.z = SPEAR_ON_RAIL + (1 - u) * 0.45;
        if (t >= 0) l.clamp.position.z = clampHome + 0.08 * (u > 0 && u < 1 ? 1 : 0);
      });
    },
    update(dt, ammo) {
      was = ammo;
      for (const l of [left, right]) {
        l.kick = Math.max(0, l.kick - dt * 6);
        l.clamp.position.z = clampHome + 0.06 * l.kick;
      }
      // Two spears: one on each arm. One left: the right arm's.
      left.loaded.visible = ammo > 0.75;
      right.loaded.visible = ammo > 0.25;
      strip.color.copy(ammo > 0 ? PALETTE.SIGNAL : PALETTE.INK);
      strip.emissive.copy(ammo > 0 ? PALETTE.SIGNAL : PALETTE.INK);
    },
  };
}
