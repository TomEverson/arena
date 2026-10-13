import * as THREE from "three";

import { PALETTE } from "./palette";
import { type Brick, BRICK_MAG_HOME } from "./rifle";

/**
 * The thunder spear launchers (the Assassin's second gun): one on each arm, each a rocket
 * launcher the size of an RPG: a long fat tube with a flared back end, a heat shield, two grips
 * and a sight, and the spear loaded from the front with its big explosive head sticking out of
 * the muzzle. Built from boxes like the other guns and with the same interface, so the
 * viewmodel, the body and the viewer treat all three alike.
 *
 * The spears in the tubes are the ammo display: two loaded shows one in each arm's, one loaded
 * shows only the right arm's. Firing knocks that launcher's muzzle ring back.
 *
 * Gun space: +X right, +Y up, -Z toward the muzzle; grip at z = -0.1.
 */

export const SPEAR_NAME = "Spears";

/** Height of a tube's axis above the grip line, and how wide and long a tube is. */
const TUBE_Y = 0.085;
const TUBE_W = 0.115;
const TUBE_FRONT = -0.78;
const TUBE_BACK = 0.2;
/** Where a spear leaves. */
export const SPEAR_MUZZLE = new THREE.Vector3(0, TUBE_Y, -1.12);
/** Height of the spear above the grip line: aiming lines it up with screen centre. */
export const SPEAR_SIGHT_Y = 0.19;

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

/**
 * A spear on its own (the launcher's round, and what flies): shaft along -Z, the fat explosive
 * head at the front. `fins` false leaves the tail fins off (folded, for one inside a tube).
 */
export function buildSpearShaft(fins = true): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const head = new THREE.MeshLambertMaterial({
    color: PALETTE.HAZARD,
    emissive: PALETTE.HAZARD.clone().multiplyScalar(0.5),
    flatShading: true,
  });
  const band = new THREE.MeshLambertMaterial({ color: PALETTE.BONE, flatShading: true });
  box(g, shaft, [0.05, 0.05, 0.8], [0, 0, 0]);
  box(g, head, [0.14, 0.14, 0.28], [0, 0, -0.5]); // the charge
  box(g, head, [0.09, 0.09, 0.1], [0, 0, -0.69]); // its nose
  box(g, band, [0.148, 0.148, 0.03], [0, 0, -0.37]);
  box(g, shaft, [0.03, 0.03, 0.08], [0, 0, -0.78]); // the spike
  if (fins) {
    box(g, band, [0.2, 0.014, 0.14], [0, 0, 0.33]); // tail fins
    box(g, band, [0.014, 0.2, 0.14], [0, 0, 0.33]);
  }
  return g;
}

/** Where a loaded spear sits in its tube (gun space z): the head out in front of the muzzle. */
const SPEAR_LOADED = TUBE_FRONT + 0.34;
/** How far to the left of the right launcher the left one sits (gun space). */
export const SPEAR_PAIR_GAP = 0.4;

/**
 * How big the launchers are drawn in your own view, against their real size (the body's and the
 * viewer's): at full size the pair fills the screen (Tom: "blocking the entire pov, reduce it
 * like 50%").
 */
export const SPEAR_VIEW_SCALE = 0.5;

/**
 * The pair of launchers. `leftAt` is where the left arm's sits relative to the right's (gun
 * space x): the body passes the other side, because it holds its guns turned round. `scale`
 * shrinks each launcher about its own grip, leaving the two as far apart as before.
 */
export function buildSpear(leftAt = -SPEAR_PAIR_GAP, scale = 1): Brick {
  const root = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const plate = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE, flatShading: true });
  const shield = new THREE.MeshLambertMaterial({ color: PALETTE.BONE, flatShading: true });
  const ink = new THREE.MeshLambertMaterial({ color: PALETTE.INK, flatShading: true });
  const strip = new THREE.MeshLambertMaterial({
    color: PALETTE.SIGNAL,
    emissive: PALETTE.SIGNAL,
    flatShading: true,
  });

  // One launcher on each arm, as in the series: the right one at the grip, the left beside it.
  // Each is a tube with a flared back end and a heat shield round its middle, a grip and a
  // fore grip under it, a sight on top, and a ring at the muzzle that kicks back on a shot.
  const strips: THREE.Mesh[] = [];
  const launcher = (x: number) => {
    const g = new THREE.Group();
    g.position.x = x;
    g.scale.setScalar(scale);
    const len = TUBE_BACK - TUBE_FRONT;
    const mid = (TUBE_BACK + TUBE_FRONT) / 2;
    box(g, body, [TUBE_W, TUBE_W, len], [0, TUBE_Y, mid]); // the tube
    box(g, shield, [TUBE_W + 0.014, TUBE_W + 0.014, 0.3], [0, TUBE_Y, -0.08]); // heat shield
    box(g, plate, [TUBE_W + 0.012, TUBE_W + 0.012, 0.04], [0, TUBE_Y, -0.52]); // band
    box(g, ink, [TUBE_W + 0.04, TUBE_W + 0.04, 0.09], [0, TUBE_Y, TUBE_BACK + 0.02]); // back flare
    box(g, ink, [TUBE_W + 0.07, TUBE_W + 0.07, 0.04], [0, TUBE_Y, TUBE_BACK + 0.08]);
    box(g, ink, [0.055, 0.13, 0.06], [0, -0.04, -0.095], 0.25); // grip
    box(g, ink, [0.03, 0.05, 0.03], [0, 0.0, -0.17]); // trigger guard
    box(g, ink, [0.05, 0.11, 0.05], [0, -0.03, -0.42], 0.1); // fore grip
    box(g, plate, [0.03, 0.035, 0.1], [0, TUBE_Y + TUBE_W / 2 + 0.017, -0.3]); // sight base
    box(g, ink, [0.016, 0.05, 0.02], [0, TUBE_Y + TUBE_W / 2 + 0.05, -0.34]); // sight post
    const clamp = new THREE.Group();
    clamp.position.set(0, TUBE_Y, TUBE_FRONT + 0.03);
    box(clamp, plate, [TUBE_W + 0.03, TUBE_W + 0.03, 0.05], [0, 0, 0]); // muzzle ring
    g.add(clamp);
    const loaded = buildSpearShaft(false);
    loaded.position.set(0, TUBE_Y, SPEAR_LOADED);
    g.add(loaded);
    for (const side of [-1, 1])
      strips.push(box(g, strip, [0.006, 0.022, 0.16], [side * (TUBE_W / 2 + 0.002), TUBE_Y, -0.4]));
    root.add(g);
    return { g, clamp, loaded, kick: 0 };
  };
  const right = launcher(0);
  const left = launcher(leftAt);
  const clampHome = right.clamp.position.z;

  // The gas canister under the right tube is the "magazine" the reload swaps.
  const mag = new THREE.Group();
  mag.position.copy(BRICK_MAG_HOME);
  box(mag, plate, [0.05, 0.1, 0.09], [0, -0.02, 0.02]);
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
      // A fresh spear slides back into each tube from the front, the left arm's first, then
      // the right's; each muzzle ring opens (slides back) to take it and snaps shut on it.
      [left, right].forEach((l, i) => {
        const from = 0.3 + i * 0.25; // when this arm's spear starts going on
        const u = t < 0 ? 1 : Math.min(1, Math.max(0, (t - from) / 0.2));
        if (t >= 0) l.loaded.visible = t >= from;
        l.loaded.position.z = SPEAR_LOADED - (1 - u) * 0.5;
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
