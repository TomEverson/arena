import * as THREE from "three";

import { PALETTE } from "./palette";

/**
 * Third-person character body: chunky armored humanoid built from boxes and low-poly
 * cylinders, animated in code (visual only). Used for practice dummies today and for
 * other players once they arrive over the network: it only needs a position each frame
 * plus "on the ground?" and "sliding?" (see BodyState); speed and vertical motion are
 * worked out from how far it moved.
 *
 * Each limb hangs from a pivot at its joint, so rotating the pivot swings the limb:
 *
 *   root (feet position, facing)
 *   └─ body (leans for slides, falls on death)
 *      ├─ legs: pivots at the hips
 *      └─ upper (pivot at the hips: lean, bob, flinch)
 *         ├─ shorts, chest, collar, helmet, face, ear discs
 *         └─ arms: pivots at the shoulders
 *
 * Animations are poses blended by weights that fade in and out:
 * ground (idle -> walk -> run by speed), air (rising / falling), slide, plus landing squash,
 * hit flinch, death fall and respawn grow on top. Tune the numbers in the pose functions.
 *
 * Style (spec/art/style-guide.md, Characters): HAZARD armor (enemy), GRAPHITE suit,
 * INK shorts and eyes, BONE face, CONCRETE ear discs with SIGNAL lights.
 */

export interface BodyState {
  /** Feet position (centre of the hitbox footprint, at floor level). */
  x: number;
  y: number;
  z: number;
  onGround: boolean;
  sliding: boolean;
  alive: boolean;
  /** Running along a wall (airborne, but moving like a sprint). */
  wallRunning?: boolean;
  /** Crouched (low and slow, feet planted). */
  crouching?: boolean;
  /** In the middle of a dash. */
  dashing?: boolean;
  /** Aiming down the sights: the rifle comes up to the shoulder. */
  aiming?: boolean;
}

const FLASH_SECONDS = 0.09;
const FLIP_SECONDS = 0.5; // the double-jump somersault
const SHOT_SECONDS = 0.09; // recoil and muzzle flash after a shot
const CENTER_Y = 0.9; // the somersault turns about the middle of the body
const FLINCH_DECAY = 10; // per second
const DEATH_SECONDS = 0.6;
const SPAWN_SECONDS = 0.25;
const HIP_Y = 0.92;
const SHOULDER_Y = 0.46; // above the hips

/** Speeds (m/s) that shape the ground animation. Movement tops out at runSpeed = 11. */
const WALK_FULL = 3.5; // walk swing reaches full size
const RUN_START = 5; // starts blending from walk into run
const RUN_FULL = 11; // fully running
const WALK_STRIDE = 1.4; // metres per full step cycle when walking
const RUN_STRIDE = 2.6; // ... and when running

/** How fast pose weights fade in and out (per second; higher = snappier). */
const BLEND_RATE = 12;

const FLASH_GLOW = new THREE.Color(0x888888);
const NO_GLOW = new THREE.Color(0);
/** Armor glows a little so it reads as solid HAZARD even in shadow (readability rule). */
const HAZARD_GLOW = PALETTE.HAZARD.clone().multiplyScalar(0.4);

/** Every joint value an animation can set. Angles in radians, offsets in metres. */
interface Pose {
  /** Whole body lean (negative = lean back) and offset, used by the slide. */
  bodyPitch: number;
  bodyY: number;
  bodyZ: number;
  /** Upper body lean (positive = forward) and bob. */
  upperPitch: number;
  upperY: number;
  /** Leg swing (negative = foot forward). */
  legL: number;
  legR: number;
  /** Arm swing (negative = hand forward) and spread (left negative / right positive = out). */
  armLX: number;
  armRX: number;
  armLZ: number;
  armRZ: number;
  /** Leg length multiplier (1 = full; the crouch squashes the legs so the feet stay planted). */
  legScale: number;
}

const zeroPose = (): Pose => ({
  bodyPitch: 0,
  bodyY: 0,
  bodyZ: 0,
  upperPitch: 0,
  upperY: 0,
  legL: 0,
  legR: 0,
  armLX: 0,
  armRX: 0,
  armLZ: 0,
  armRZ: 0,
  legScale: 1,
});

/** out = a + (b - a) * t, for every joint. */
function blendPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (const k of Object.keys(out) as (keyof Pose)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential smoothing factor for one frame. */
const follow = (rate: number, dt: number) => 1 - Math.exp(-dt * rate);
/** Shortest signed difference between two angles, in -PI..PI. */
const angleDelta = (from: number, to: number) =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** Place `geo` in `parent` with its centre at (x, y, z), optionally rotated. */
function part(
  parent: THREE.Object3D,
  mat: THREE.Material,
  geo: THREE.BufferGeometry,
  [x, y, z]: [number, number, number],
  [rx, ry, rz]: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Low-poly (8-sided) tapered cylinder, standing upright: chunky facets once pixelated. */
const tube = (top: number, bottom: number, h: number) =>
  new THREE.CylinderGeometry(top, bottom, h, 8);

/** An empty group placed at a joint; limbs are built hanging down from it. */
function pivot(parent: THREE.Object3D, x: number, y: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, 0);
  parent.add(g);
  return g;
}

export class CharacterBody {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly upper: THREE.Group;
  private readonly legs: [THREE.Group, THREE.Group];
  private readonly arms: [THREE.Group, THREE.Group];
  private readonly materials: {
    mat: THREE.MeshLambertMaterial;
    color: THREE.Color;
    glow: THREE.Color;
  }[] = [];

  // Animation state.
  private flashT = 0;
  private flinch = 0;
  private phase = 0;
  private speed = 0;
  private vy = 0;
  private yaw = 0;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private started = false;
  private wasAlive = true;
  private deadFor = 0;
  private aliveFor = SPAWN_SECONDS;
  private time: number;
  private airW = 0;
  private slideW = 0;
  private wallW = 0;
  private crouchW = 0;
  private dashW = 0;
  private aimW = 0;
  /** 0 = no somersault; 0..1 = how far through it is. */
  private flipT = 0;
  private shootT = 0;
  private prevRawVy = 0;
  private readonly gun = new THREE.Group();
  private readonly muzzleFlash: THREE.Mesh;
  private airTime = 0;
  private land = 0;
  private readonly ground = zeroPose();
  private readonly air = zeroPose();
  private readonly slide = zeroPose();
  private readonly wall = zeroPose();
  private readonly crouch = zeroPose();
  private readonly dash = zeroPose();
  private readonly pose = zeroPose();

  /** `seed` offsets the idle animation so several characters don't breathe in sync. */
  constructor(scene: THREE.Scene, seed = 0) {
    this.time = seed * 1.7;
    const material = (color: THREE.Color, glow = NO_GLOW) => {
      const m = {
        mat: new THREE.MeshLambertMaterial({ color, emissive: glow, flatShading: true }),
        color,
        glow,
      };
      this.materials.push(m);
      return m.mat;
    };
    const armor = material(PALETTE.HAZARD, HAZARD_GLOW);
    const suit = material(PALETTE.GRAPHITE);
    const ink = material(PALETTE.INK);
    const face = material(PALETTE.BONE);
    const metal = material(PALETTE.CONCRETE);
    const light = material(PALETTE.SIGNAL, PALETTE.SIGNAL);

    // The figure faces +Z in its own space; `root.rotation.y` turns it.
    this.root.add(this.body);

    // Legs: slim thigh, big flared boot with a toe cap (feet touch y = 0).
    this.legs = [-1, 1].map((side) => {
      const hip = pivot(this.body, side * 0.1, HIP_Y);
      part(hip, suit, tube(0.055, 0.05, 0.36), [0, -0.18, 0]); // thigh
      part(hip, ink, tube(0.105, 0.105, 0.03), [0, -0.46, 0]); // boot rim
      part(hip, armor, tube(0.1, 0.12, 0.46), [0, -0.69, 0]); // boot
      part(hip, armor, box(0.19, 0.14, 0.14), [0, -0.85, 0.11]); // toe cap
      return hip;
    }) as [THREE.Group, THREE.Group];

    // Upper body, measured from the hips.
    const upper = pivot(this.body, 0, HIP_Y);
    this.upper = upper;
    part(upper, ink, box(0.3, 0.16, 0.21), [0, 0, 0]); // shorts
    part(upper, armor, box(0.3, 0.42, 0.2), [0, 0.29, 0]); // chest
    part(upper, suit, box(0.32, 0.08, 0.21), [0, 0.48, 0]); // collar
    part(upper, ink, tube(0.05, 0.05, 0.06), [0, 0.54, 0]); // neck

    // Big round helmet: wide rather than tall, so it stays inside the head hitbox (1.5..1.8 m).
    const helmet = part(upper, armor, new THREE.SphereGeometry(0.16, 8, 6), [0, 0.73, -0.01]);
    helmet.scale.set(1.18, 0.9, 1.05); // wider than the body, like a big-headed hero
    part(upper, face, box(0.2, 0.13, 0.06), [0, 0.7, 0.13]); // face, set into the helmet
    for (const side of [-1, 1]) {
      part(upper, ink, box(0.045, 0.065, 0.01), [side * 0.05, 0.715, 0.162]); // eye
      // Ear disc with a SIGNAL light (technology).
      part(upper, metal, tube(0.06, 0.06, 0.04), [side * 0.19, 0.72, 0], [0, 0, Math.PI / 2]);
      part(upper, light, tube(0.028, 0.028, 0.012), [side * 0.213, 0.72, 0], [0, 0, Math.PI / 2]);
    }

    // Arms: slim upper arm, chunky forearm and fist (outer edge 0.285 m: inside the 0.3 hitbox).
    this.arms = [-1, 1].map((side) => {
      const shoulder = pivot(upper, side * 0.2, SHOULDER_Y);
      part(shoulder, suit, tube(0.045, 0.04, 0.24), [0, -0.12, 0]); // upper arm
      part(shoulder, armor, tube(0.072, 0.085, 0.24), [0, -0.35, 0]); // forearm
      part(shoulder, armor, box(0.12, 0.11, 0.13), [0, -0.52, 0.01]); // fist
      return shoulder;
    }) as [THREE.Group, THREE.Group];

    // The rifle: slung at the hip while walking, up at the shoulder when aiming.
    const gun = this.gun;
    upper.add(gun);
    part(gun, ink, box(0.07, 0.12, 0.46), [0, 0, 0.1]); // receiver
    part(gun, metal, tube(0.022, 0.022, 0.34), [0, 0.02, 0.5], [Math.PI / 2, 0, 0]); // barrel
    part(gun, suit, box(0.06, 0.1, 0.2), [0, -0.02, -0.2]); // stock
    part(gun, ink, box(0.05, 0.16, 0.07), [0, -0.12, 0.08], [0.2, 0, 0]); // magazine
    this.muzzleFlash = part(
      gun,
      new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
      box(0.12, 0.12, 0.14),
      [0, 0.02, 0.76],
    );
    this.muzzleFlash.visible = false;

    scene.add(this.root);
  }

  /** Fired a shot: recoil and a muzzle flash for a moment (raises the rifle too). */
  shoot(): void {
    this.shootT = 1;
  }

  /** Got shot: flash BONE and flinch. */
  hit(): void {
    this.flashT = FLASH_SECONDS;
    this.flinch = 1;
  }

  /**
   * Per frame. `viewer` is the camera position: a character standing still turns to face it.
   * (Real players will later pass their look direction instead.)
   */
  update(s: BodyState, dt: number, viewer: THREE.Vector3): void {
    if (dt <= 0) return;
    this.time += dt;

    // Life cycle: fall over when killed, grow back when respawned.
    if (!this.started || (!this.wasAlive && s.alive)) {
      this.started = true;
      if (s.alive && this.wasAlive === false) this.aliveFor = 0;
      this.lastX = s.x; // don't count a spawn teleport as movement
      this.lastY = s.y;
      this.lastZ = s.z;
    }
    if (this.wasAlive && !s.alive) this.deadFor = 0;
    this.wasAlive = s.alive;
    if (s.alive) this.aliveFor += dt;
    else this.deadFor += dt;
    this.root.visible = s.alive || this.deadFor < DEATH_SECONDS;
    if (!this.root.visible) return;

    // Movement since last frame. Positions only change on sim ticks, so smooth the speeds.
    const dx = s.x - this.lastX;
    const dz = s.z - this.lastZ;
    const dist = Math.hypot(dx, dz);
    this.speed += (dist / dt - this.speed) * follow(10, dt);
    const rawVy = (s.y - this.lastY) / dt;
    this.vy += (rawVy - this.vy) * follow(10, dt);
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastZ = s.z;

    // Facing: the way it's moving, otherwise toward the viewer.
    const moving = s.alive && this.speed > 0.5 && dist > 1e-4;
    const targetYaw = moving ? Math.atan2(dx, dz) : Math.atan2(viewer.x - s.x, viewer.z - s.z);
    if (s.alive) this.yaw += angleDelta(this.yaw, targetYaw) * follow(10, dt);
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = this.yaw;

    // Pose weights fade toward the current state.
    const wallRun = s.alive && s.wallRunning === true;
    const inAir = s.alive && !s.onGround && !s.sliding && !wallRun;
    this.airW += ((inAir ? 1 : 0) - this.airW) * follow(BLEND_RATE, dt);
    this.slideW += ((s.alive && s.sliding ? 1 : 0) - this.slideW) * follow(BLEND_RATE, dt);
    this.wallW += ((wallRun ? 1 : 0) - this.wallW) * follow(BLEND_RATE, dt);
    if (inAir) this.airTime += dt;
    else {
      if (this.airTime > 0.15) this.land = 1; // touched down after a real jump: squash
      this.airTime = 0;
    }
    this.land = Math.max(0, this.land - dt * 5);

    // Double jump: a sudden upward kick while already in the air starts a somersault.
    if (inAir && this.airTime > 0.12 && rawVy - this.prevRawVy > 5 && this.flipT === 0) {
      this.flipT = 1e-6;
    }
    this.prevRawVy = rawVy;
    if (!inAir || !s.alive) this.flipT = 0;
    else if (this.flipT > 0)
      this.flipT = this.flipT + dt / FLIP_SECONDS >= 1 ? 0 : this.flipT + dt / FLIP_SECONDS;

    const crouching = s.alive && s.crouching === true && !s.sliding;
    this.crouchW += ((crouching ? 1 : 0) - this.crouchW) * follow(BLEND_RATE, dt);
    this.dashW += ((s.alive && s.dashing ? 1 : 0) - this.dashW) * follow(BLEND_RATE * 1.5, dt);
    this.shootT = Math.max(0, this.shootT - dt / SHOT_SECONDS);
    const aiming = s.alive && (s.aiming === true || this.shootT > 0);
    this.aimW += ((aiming ? 1 : 0) - this.aimW) * follow(BLEND_RATE, dt);

    // Walk/run cycle advances with distance, so feet keep pace with the ground.
    const runW = clamp01((this.speed - RUN_START) / (RUN_FULL - RUN_START));
    if ((s.onGround && !s.sliding) || wallRun)
      this.phase += (dist / lerp(WALK_STRIDE, RUN_STRIDE, runW)) * Math.PI * 2;

    this.groundPose(runW);
    this.airPose();
    this.slidePose();
    this.wallPose();
    this.crouchPose();
    this.dashPose();
    const p = blendPose(this.pose, this.ground, this.air, this.airW);
    blendPose(p, p, this.slide, this.slideW);
    blendPose(p, p, this.wall, this.wallW);
    blendPose(p, p, this.crouch, this.crouchW);
    blendPose(p, p, this.dash, this.dashW);

    // Double-jump somersault about the middle of the body, tucked up while it spins.
    if (this.flipT > 0) {
      const phi = this.flipT * Math.PI * 2;
      const tuck = Math.sin(this.flipT * Math.PI);
      p.bodyPitch += phi;
      p.bodyY += CENTER_Y * (1 - Math.cos(phi));
      p.bodyZ -= CENTER_Y * Math.sin(phi);
      p.legL = lerp(p.legL, -1.3, tuck);
      p.legR = lerp(p.legR, -1.3, tuck);
      p.armLX = lerp(p.armLX, -1.1, tuck);
      p.armRX = lerp(p.armRX, -1.1, tuck);
    }

    // Aiming: both arms up on the rifle, whatever the legs are doing.
    if (this.aimW > 0.001) {
      const k = this.aimW;
      const recoil = this.shootT;
      p.upperPitch = lerp(p.upperPitch, 0.05 - 0.08 * recoil, k);
      p.armLX = lerp(p.armLX, -1.35 + 0.18 * recoil, k);
      p.armRX = lerp(p.armRX, -1.45 + 0.18 * recoil, k);
      p.armLZ = lerp(p.armLZ, 0.28, k);
      p.armRZ = lerp(p.armRZ, -0.12, k);
    }
    // The rifle follows: hip carry to shoulder aim, kicking back a little on each shot.
    const g = this.gun;
    g.position.set(
      lerp(0.22, 0.03, this.aimW),
      lerp(0.2, 0.4, this.aimW),
      lerp(0.12, 0.28, this.aimW) - 0.04 * this.shootT,
    );
    g.rotation.set(lerp(1.0, 0, this.aimW) - 0.05 * this.shootT, 0, 0);
    this.muzzleFlash.visible = this.shootT > 0.55;

    // Landing squash: dip and lean forward for a moment.
    p.upperY -= 0.08 * this.land;
    p.upperPitch += 0.25 * this.land;

    // Hit flinch: upper body snaps back, arms fling out, then recover.
    this.flinch = Math.max(0, this.flinch - dt * FLINCH_DECAY * this.flinch - dt);
    p.upperPitch -= 0.35 * this.flinch;
    p.armLZ -= 0.4 * this.flinch;
    p.armRZ += 0.4 * this.flinch;

    // Death: tip over backward around the feet (replaces the lean).
    if (!s.alive) {
      const fall = Math.min(1, this.deadFor / (DEATH_SECONDS * 0.6));
      p.bodyPitch = -(1 - (1 - fall) ** 2) * (Math.PI / 2);
      p.bodyY = 0;
      p.bodyZ = 0;
    }
    this.apply(p);

    // Respawn: grow up from the floor.
    const grow = Math.min(1, this.aliveFor / SPAWN_SECONDS);
    this.root.scale.set(1, s.alive ? 1 - (1 - grow) ** 3 : 1, 1);

    // Hit flash: every part turns BONE for a moment.
    this.flashT = Math.max(0, this.flashT - dt);
    for (const m of this.materials) {
      m.mat.color.copy(this.flashT > 0 ? PALETTE.BONE : m.color);
      m.mat.emissive.copy(this.flashT > 0 ? FLASH_GLOW : m.glow);
    }
  }

  /** Idle -> walk -> run, by speed. */
  private groundPose(runW: number): void {
    const g = this.ground;
    const walkW = clamp01(this.speed / WALK_FULL);
    const swing = Math.sin(this.phase) * walkW * lerp(0.6, 1.0, runW);
    const breathe = Math.sin(this.time * 2) * 0.008 * (1 - walkW);
    const idleSway = Math.sin(this.time * 1.5) * 0.04 * (1 - walkW);
    g.bodyPitch = 0;
    g.bodyY = 0;
    g.bodyZ = 0;
    g.upperPitch = 0.25 * runW; // lean into the run
    g.upperY = breathe + Math.abs(Math.cos(this.phase)) * lerp(0.04, 0.07, runW) * walkW;
    g.legL = swing;
    g.legR = -swing;
    // Arms swing opposite the legs, wider and pumping forward when running.
    g.armLX = -swing * lerp(0.8, 1.2, runW) + idleSway - 0.2 * runW;
    g.armRX = swing * lerp(0.8, 1.2, runW) - idleSway - 0.2 * runW;
    g.armLZ = -0.1 * runW;
    g.armRZ = 0.1 * runW;
  }

  /** Rising: one knee up, arms forward. Falling: legs reach down, arms out for balance. */
  private airPose(): void {
    const a = this.air;
    const falling = clamp01(0.5 - this.vy / 10); // 0 = going up fast, 1 = coming down fast
    a.bodyPitch = 0;
    a.bodyY = 0;
    a.bodyZ = 0;
    a.upperPitch = lerp(0.15, 0.05, falling);
    a.upperY = 0;
    a.legL = lerp(-0.9, -0.25, falling);
    a.legR = lerp(0.35, 0.1, falling);
    a.armLX = lerp(-0.6, -0.2, falling);
    a.armRX = lerp(-0.6, -0.2, falling);
    a.armLZ = lerp(-0.3, -0.9, falling);
    a.armRZ = lerp(0.3, 0.9, falling);
  }

  /** Feet-first slide: lean back, legs out front, one hand trailing on the floor. */
  private slidePose(): void {
    const sl = this.slide;
    // Worked out so the head and chest stay inside the 1.0 m slide hitbox; only the legs
    // reach out in front of it (a sliding person is longer than the box).
    sl.bodyPitch = -0.6;
    sl.bodyY = -0.48; // drop so the boots touch the floor
    sl.bodyZ = 0.6; // shift forward so the chest sits over the hitbox centre
    sl.upperPitch = 0.15; // sit up a little so the head stays up, looking ahead
    sl.upperY = 0;
    sl.legL = -0.8;
    sl.legR = -0.6;
    sl.armLX = 0.6;
    sl.armLZ = -0.6;
    sl.armRX = -1.0; // gun arm forward
    sl.armRZ = 0.15;
  }

  /** Wall run: a fast sprint leaning into it, arms out wide for balance. */
  private wallPose(): void {
    const w = this.wall;
    const swing = Math.sin(this.phase) * 1.1;
    w.bodyPitch = 0;
    w.bodyY = 0;
    w.bodyZ = 0;
    w.upperPitch = 0.4;
    w.upperY = 0;
    w.legL = swing;
    w.legR = -swing;
    w.armLX = -0.3;
    w.armRX = -0.3;
    w.armLZ = -0.9;
    w.armRZ = 0.9;
  }

  /** Crouch: hips dropped, legs squashed and planted in a low stance, leaning forward. */
  private crouchPose(): void {
    const c = this.crouch;
    const walkW = clamp01(this.speed / WALK_FULL);
    const swing = Math.sin(this.phase) * 0.18 * walkW;
    c.bodyPitch = 0;
    c.bodyY = -0.5;
    c.bodyZ = 0;
    c.upperPitch = 0.5;
    c.upperY = 0;
    c.legScale = 0.65;
    c.legL = -0.8 + swing;
    c.legR = 0.8 - swing;
    c.armLX = -0.5;
    c.armRX = -0.5;
    c.armLZ = -0.15;
    c.armRZ = 0.15;
  }

  /** Dash: stretched out forward, arms swept back, legs split. */
  private dashPose(): void {
    const d = this.dash;
    d.bodyPitch = 0.35;
    d.bodyY = 0;
    d.bodyZ = 0;
    d.upperPitch = 0.5;
    d.upperY = 0;
    d.legL = -1.0;
    d.legR = 1.0;
    d.armLX = 1.0;
    d.armRX = 1.0;
    d.armLZ = -0.25;
    d.armRZ = 0.25;
  }

  private apply(p: Pose): void {
    this.body.rotation.x = p.bodyPitch;
    this.body.position.set(0, p.bodyY, p.bodyZ);
    this.upper.rotation.x = p.upperPitch;
    this.upper.position.y = HIP_Y + p.upperY;
    this.legs[0].scale.y = p.legScale;
    this.legs[1].scale.y = p.legScale;
    this.legs[0].rotation.x = p.legL;
    this.legs[1].rotation.x = p.legR;
    this.arms[0].rotation.set(p.armLX, 0, p.armLZ);
    this.arms[1].rotation.set(p.armRX, 0, p.armRZ);
  }
}
