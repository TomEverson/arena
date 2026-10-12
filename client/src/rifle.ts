import * as THREE from "three";

import { PALETTE } from "./palette";

/**
 * "Brick": the rifle. A compact, chunky SMG-style body (short and fat, with the magazine just
 * ahead of the grip, a big angular shroud over the barrel and a small optic on a top rail),
 * built from boxes so it survives the low-resolution look: a strong silhouette, three colour
 * blocks (GRAPHITE body, CONCRETE shroud, INK details) and one SIGNAL accent.
 *
 * The one signature feature is the ammo strip: a SIGNAL light on each side of the receiver that
 * shrinks as the magazine empties and turns HAZARD and blinks when it is nearly out, so the
 * ammo can be read off the gun itself.
 *
 * Moving parts: the top slide kicks back on every shot, and the magazine is its own group so a
 * reload can pull it out and slot it back in.
 *
 * Gun space (the first-person convention): +X right, +Y up, -Z toward the muzzle. The bore is
 * the Z axis; the grip is at z = -0.1 and the shroud's underside is at about z = -0.5.
 * For the third-person body, rotate `root` half a turn about Y so the muzzle points +Z.
 */

export const BRICK_NAME = "Brick";

/** Where bullets leave and the muzzle flash sits. */
export const BRICK_MUZZLE = new THREE.Vector3(0, 0.012, -0.78);
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
  /**
   * Per frame. `ammo` is the share of a full magazine left (0..1); `time` is seconds, for the
   * blink. Also settles the slide.
   */
  update(dt: number, ammo: number, time: number): void;
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

export function buildBrick(): Brick {
  const root = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE, flatShading: true });
  const shroud = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE, flatShading: true });
  const ink = new THREE.MeshLambertMaterial({ color: PALETTE.INK, flatShading: true });
  const lens = new THREE.MeshBasicMaterial({ color: PALETTE.SIGNAL, side: THREE.DoubleSide });
  // The ammo strip's own material: it changes colour and blinks, the optic lens does not.
  const strip = new THREE.MeshLambertMaterial({
    color: PALETTE.SIGNAL,
    emissive: PALETTE.SIGNAL,
    flatShading: true,
  });

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
  slide.position.set(0, 0.075, -0.36);
  box(slide, shroud, [0.034, 0.022, 0.06], [0, 0, 0]);
  box(slide, ink, [0.012, 0.012, 0.03], [0, 0.015, 0.01]);
  root.add(slide);
  const slideHome = slide.position.z;

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

  let kick = 0;

  return {
    root,
    mag,
    slide,
    strips: stripMeshes,
    shoot() {
      kick = 1;
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
