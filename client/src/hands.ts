import * as THREE from "three";

import { PALETTE, type PaletteName } from "./palette";

/**
 * First-person arms holding the rifle (visual only). Built from boxes like the
 * dummies: each arm is a pivot at the hand, with the forearm reaching back
 * toward the camera from it. Added to the gun group so they follow aim, kick
 * and future viewmodel animations automatically.
 *
 * Gun space: +X right, +Y up, -Z toward the muzzle. Grip at z -0.1, handguard at z -0.45.
 * Colors follow the hero you play (`ARM_LOOKS`), so the arms match the body others see.
 */

/** The three materials every first-person arm is made of (the gun hands and the bare fists share them). */
export type ArmMaterials = Record<"glove" | "sleeve" | "cuff", THREE.MeshLambertMaterial>;

/**
 * Each hero's arm colours, taken from its character model (spec/art/style-guide.md):
 * the trooper's GRAPHITE gloves and BONE forearm plates with a COBALT stripe, the assassin's INK
 * gloves and GRAPHITE gauntlets with a BRASS edge. Any other look gets the plain arms.
 */
const PLAIN = { glove: "INK", sleeve: "CONCRETE", cuff: "HAZE" } as const;
export const ARM_LOOKS: Record<string, Record<keyof ArmMaterials, PaletteName>> = {
  trooper: { glove: "GRAPHITE", sleeve: "BONE", cuff: "COBALT" },
  assassin: { glove: "INK", sleeve: "GRAPHITE", cuff: "BRASS" },
};

export function armMaterials(look: string): ArmMaterials {
  const mats = {
    glove: new THREE.MeshLambertMaterial(),
    sleeve: new THREE.MeshLambertMaterial(),
    cuff: new THREE.MeshLambertMaterial(),
  };
  paintArms(mats, look);
  return mats;
}

/** Recolour the arms for a hero look. */
export function paintArms(mats: ArmMaterials, look: string): void {
  const colors = ARM_LOOKS[look] ?? PLAIN;
  for (const part of ["glove", "sleeve", "cuff"] as const) {
    mats[part].color.copy(PALETTE[colors[part]]);
  }
}

export interface Hands {
  right: THREE.Group;
  left: THREE.Group;
}

const box = (
  parent: THREE.Object3D,
  mat: THREE.Material,
  [w, h, d]: [number, number, number],
  [x, y, z]: [number, number, number],
) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
};

/**
 * One arm: glove at the pivot, cuff and sleeve extending along +Z (back toward the camera).
 * `pitch` > 0 tips the elbow end down; `yaw` < 0 swings it left.
 */
function arm(
  gun: THREE.Group,
  mats: ArmMaterials,
  hand: [number, number, number],
  pitch: number,
  yaw: number,
  length: number,
): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(...hand);
  pivot.rotation.set(pitch, yaw, 0, "YXZ");
  box(pivot, mats.glove, [0.075, 0.085, 0.1], [0, 0, 0]); // hand wrapped around the gun
  box(pivot, mats.cuff, [0.085, 0.085, 0.03], [0, 0, 0.065]);
  box(pivot, mats.sleeve, [0.09, 0.09, length], [0, 0, 0.08 + length / 2]); // forearm
  gun.add(pivot);
  return pivot;
}

export function buildHands(gun: THREE.Group, mats: ArmMaterials): Hands {
  return {
    // Trigger hand on the grip, forearm going down and back to the bottom right of the screen.
    right: arm(gun, mats, [0.005, -0.075, -0.09], 0.55, 0.15, 0.32),
    // Support hand under the handguard, forearm reaching back to the left.
    left: arm(gun, mats, [-0.005, -0.06, -0.45], 0.6, -0.8, 0.4),
  };
}
