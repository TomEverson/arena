import * as THREE from "three";

import { PALETTE } from "./palette";
import { type Brick, buildBrick } from "./rifle";

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
  /** Carrying the Brick: arms hold it, in every animation. Turning this on plays the draw. */
  armed?: boolean;
  /** Which way the body faces (radians, the figure's own yaw), instead of toward its movement. */
  yaw?: number;
}

const FLASH_SECONDS = 0.09;
const EQUIP_SECONDS = 0.5; // drawing the rifle: arms come up onto it with a little overshoot
const AIR_JUMP_SECONDS = 0.4; // the second jump in the air: knees up, then push off
const SHOT_SECONDS = 0.09; // recoil and muzzle flash after a shot
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

/** The arms are two bones: shoulder to elbow, elbow to the middle of the fist. */
const ARM_UPPER = 0.28;
const ARM_FORE = 0.32;
const SHOULDER_X = 0.2;

/** Where the rifle sits (in the upper body's space) for each way of carrying it. */
interface GunSpot {
  x: number;
  y: number;
  z: number;
  /** Tilt about X: positive points the muzzle down. */
  pitch: number;
}
const GUN_HOLSTER: GunSpot = { x: 0.2, y: 0.02, z: 0.02, pitch: 1.4 }; // slung at the hip
const GUN_LOW: GunSpot = { x: 0.05, y: 0.18, z: 0.12, pitch: 0.1 }; // held low and ready
const GUN_AIM: GunSpot = { x: 0.06, y: 0.4, z: 0.14, pitch: 0 }; // up at the shoulder
/** Where each hand grips, in the rifle's own space: the grip, and under the front of the receiver. */
const GRIP_RIGHT = [0, -0.075, 0] as const;
const GRIP_LEFT = [0, -0.07, 0.3] as const;

/** Joint pose that puts a hand at a point. */
export interface ArmSolution {
  /** Rotation of the shoulder group (the arm hangs along -Y when this is the identity). */
  q: THREE.Quaternion;
  /** Elbow bend about X (negative = forearm forward). */
  elbow: number;
}

// Scratch objects, so solving an arm allocates nothing.
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _euler = new THREE.Euler();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/**
 * Two-bone arm IK. The shoulder is at (shoulderX, SHOULDER_Y, 0) in the upper body's space; the
 * hand (the middle of the fist) should be at (tx, ty, tz). A target out of reach gets a fully
 * straight arm pointing at it. The elbow bends about its own X axis, and the arm is rolled
 * about the shoulder-to-hand line so the elbow points down and a little outward and back.
 */
export function solveArm(
  shoulderX: number,
  tx: number,
  ty: number,
  tz: number,
  out: ArmSolution,
): ArmSolution {
  _v.set(tx - shoulderX, ty - SHOULDER_Y, tz);
  let d = _v.length();
  const reach = ARM_UPPER + ARM_FORE - 1e-4;
  if (d > reach) {
    _v.multiplyScalar(reach / d);
    d = reach;
  }
  const cosE = Math.min(
    1,
    Math.max(
      -1,
      (d * d - ARM_UPPER * ARM_UPPER - ARM_FORE * ARM_FORE) / (2 * ARM_UPPER * ARM_FORE),
    ),
  );
  const elbow = -Math.acos(cosE);
  // The hand in the shoulder's own frame with the arm hanging: P. Turn P onto the shoulder-to-hand line.
  _p.set(0, -(ARM_UPPER + ARM_FORE * cosE), -ARM_FORE * Math.sin(elbow));
  _c.copy(_v).divideScalar(d || 1);
  const q = _qa.setFromUnitVectors(_p.normalize(), _c);
  // Roll about that line so the elbow lies toward the pole (down, a little out and back).
  _e.set(0, -ARM_UPPER, 0).applyQuaternion(q);
  _pole.set(Math.sign(shoulderX) * 0.3, -1, -0.3);
  _e.addScaledVector(_c, -_e.dot(_c));
  _pole.addScaledVector(_c, -_pole.dot(_c));
  if (_e.lengthSq() > 1e-12 && _pole.lengthSq() > 1e-12) {
    _e.normalize();
    _pole.normalize();
    const angle = Math.atan2(_c.dot(_e.clone().cross(_pole)), _e.dot(_pole));
    _qb.setFromAxisAngle(_c, angle);
    q.premultiply(_qb);
  }
  out.q.copy(q);
  out.elbow = elbow;
  return out;
}

const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

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
  /** Elbow bend (negative = forearm forward). */
  elbowL: number;
  elbowR: number;
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
  elbowL: 0,
  elbowR: 0,
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
  private readonly elbows: [THREE.Group, THREE.Group];
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
  /** 0 = the rifle is slung and the arms are free; 1 = both hands on it (overshoots when drawing). */
  private holdW = 0;
  private equipT = 0;
  private wasArmed = false;
  private armInit = false;
  private firstPerson = false;
  private readonly ik: ArmSolution = { q: new THREE.Quaternion(), elbow: 0 };
  /** The solved shoulder rotations for the two hands, and how much of them to use. */
  private readonly handQ: [THREE.Quaternion, THREE.Quaternion] = [
    new THREE.Quaternion(),
    new THREE.Quaternion(),
  ];
  private handMix = 0;
  /** 0 = not air jumping; 0..1 = how far through the second jump it is. */
  private airJumpT = 0;
  private shootT = 0;
  private prevRawVy = 0;
  private readonly gun = new THREE.Group();
  private readonly muzzleFlash: THREE.Mesh;
  private readonly brick: Brick;
  /** Helmet, face, ears, neck and collar: hidden in first person, where the camera sits inside the head. */
  private readonly headParts: THREE.Mesh[] = [];
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
    this.headParts.push(part(upper, suit, box(0.32, 0.08, 0.21), [0, 0.48, 0])); // collar
    this.headParts.push(part(upper, ink, tube(0.05, 0.05, 0.06), [0, 0.54, 0])); // neck

    // Big round helmet: wide rather than tall, so it stays inside the head hitbox (1.5..1.8 m).
    const helmet = part(upper, armor, new THREE.SphereGeometry(0.16, 8, 6), [0, 0.73, -0.01]);
    this.headParts.push(helmet);
    helmet.scale.set(1.18, 0.9, 1.05); // wider than the body, like a big-headed hero
    this.headParts.push(part(upper, face, box(0.2, 0.13, 0.06), [0, 0.7, 0.13])); // face, set into the helmet
    for (const side of [-1, 1]) {
      this.headParts.push(part(upper, ink, box(0.045, 0.065, 0.01), [side * 0.05, 0.715, 0.162])); // eye
      // Ear disc with a SIGNAL light (technology).
      this.headParts.push(
        part(upper, metal, tube(0.06, 0.06, 0.04), [side * 0.19, 0.72, 0], [0, 0, Math.PI / 2]),
      );
      this.headParts.push(
        part(upper, light, tube(0.028, 0.028, 0.012), [side * 0.213, 0.72, 0], [0, 0, Math.PI / 2]),
      );
    }

    // Arms: slim upper arm, then an elbow, chunky forearm and fist (outer edge 0.285 m: inside
    // the 0.3 hitbox). Two bones, so the hands can reach the rifle.
    const elbows: THREE.Group[] = [];
    this.arms = [-1, 1].map((side) => {
      const shoulder = pivot(upper, side * SHOULDER_X, SHOULDER_Y);
      part(shoulder, suit, tube(0.045, 0.04, ARM_UPPER), [0, -ARM_UPPER / 2, 0]); // upper arm
      const elbow = pivot(shoulder, 0, -ARM_UPPER);
      part(elbow, armor, tube(0.072, 0.085, ARM_FORE - 0.06), [
        0,
        -(ARM_FORE - 0.06) / 2 - 0.02,
        0,
      ]); // forearm
      part(elbow, armor, box(0.12, 0.11, 0.13), [0, -ARM_FORE, 0.01]); // fist
      elbows.push(elbow);
      return shoulder;
    }) as [THREE.Group, THREE.Group];
    this.elbows = elbows as [THREE.Group, THREE.Group];

    // The rifle: slung at the hip while walking, up at the shoulder when aiming.
    const gun = this.gun;
    upper.add(gun);
    // The Brick (rifle.ts) is built facing -Z; turn it to face +Z with the grip at the origin.
    this.brick = buildBrick();
    this.brick.root.rotation.y = Math.PI;
    this.brick.root.position.z = -0.1;
    gun.add(this.brick.root);
    this.muzzleFlash = part(
      gun,
      new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
      box(0.12, 0.12, 0.14),
      [0, 0.012, 0.76],
    );
    this.muzzleFlash.visible = false;

    scene.add(this.root);
  }

  /**
   * Make this the player's own body: seen from inside, so the head, the arms and the rifle are
   * hidden (the first-person viewmodel supplies the arms and the rifle). What is left is the
   * torso and legs you see when you look down, with every pose the body has.
   */
  setFirstPerson(on: boolean): void {
    for (const m of this.headParts) m.visible = !on;
    for (const a of this.arms) a.visible = !on;
    this.firstPerson = on;
    this.gun.visible = false;
  }

  /** Fired a shot: recoil and a muzzle flash for a moment (raises the rifle too). */
  shoot(): void {
    this.shootT = 1;
    this.brick.shoot();
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
    if (s.alive && s.yaw !== undefined) this.yaw = s.yaw;
    else if (s.alive) this.yaw += angleDelta(this.yaw, targetYaw) * follow(10, dt);
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

    // Double jump: a sudden upward kick while already in the air starts the second jump.
    if (inAir && this.airTime > 0.12 && rawVy - this.prevRawVy > 5 && this.airJumpT === 0) {
      this.airJumpT = 1e-6;
    }
    this.prevRawVy = rawVy;
    if (!inAir || !s.alive) this.airJumpT = 0;
    else if (this.airJumpT > 0)
      this.airJumpT =
        this.airJumpT + dt / AIR_JUMP_SECONDS >= 1 ? 0 : this.airJumpT + dt / AIR_JUMP_SECONDS;

    const crouching = s.alive && s.crouching === true && !s.sliding;
    this.crouchW += ((crouching ? 1 : 0) - this.crouchW) * follow(BLEND_RATE, dt);
    this.dashW += ((s.alive && s.dashing ? 1 : 0) - this.dashW) * follow(BLEND_RATE * 1.5, dt);
    this.shootT = Math.max(0, this.shootT - dt / SHOT_SECONDS);
    // The rifle: draw it when armed turns on; the arms follow its hold weight.
    const armed = s.armed === true;
    if (!armed) this.equipT = 0;
    if (!this.armInit) {
      this.armInit = true;
      this.holdW = armed ? 1 : 0; // already carrying it when first seen: no draw
    } else if (armed && !this.wasArmed) {
      this.equipT = 1e-6;
      this.holdW = 0;
    }
    this.wasArmed = armed;
    if (this.equipT > 0) {
      this.equipT += dt / EQUIP_SECONDS;
      if (this.equipT >= 1) {
        this.equipT = 0;
        this.holdW = 1;
      } else this.holdW = easeOutBack(this.equipT);
    } else {
      this.holdW += ((armed ? 1 : 0) - this.holdW) * follow(BLEND_RATE, dt);
    }
    const aiming = s.alive && armed && (s.aiming === true || this.shootT > 0);
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

    // Second jump in the air: sink a little with the knees pulled up, then drive off and
    // stretch out with the arms thrown up, like jumping again from nothing.
    if (this.airJumpT > 0) {
      const u = this.airJumpT;
      const bump = (from: number, to: number) =>
        u <= from || u >= to ? 0 : Math.sin((Math.PI * (u - from)) / (to - from));
      const knees = bump(0, 0.6);
      const swing = bump(0.15, 1);
      p.bodyY += -0.12 * bump(0, 0.35) + 0.05 * bump(0.35, 1);
      p.legL = lerp(p.legL, -1.25, knees);
      p.legR = lerp(p.legR, -0.8, knees);
      p.upperPitch = lerp(p.upperPitch, 0.35, knees);
      p.armLX = lerp(p.armLX, -2.3, swing);
      p.armRX = lerp(p.armRX, -2.3, swing);
      p.armLZ = lerp(p.armLZ, -0.45, swing);
      p.armRZ = lerp(p.armRZ, 0.45, swing);
    }

    // Aiming lifts the torso a touch (the arms and rifle are handled below).
    if (this.aimW > 0.001) {
      p.upperPitch = lerp(p.upperPitch, 0.05 - 0.08 * this.shootT, this.aimW);
    }

    // The rifle goes where the carry says (slung, low and ready, or up at the shoulder, with a
    // kick on each shot), and BOTH HANDS ARE SOLVED TO IT, so the arms follow the rifle in every
    // animation instead of swinging on their own.
    const g = this.gun;
    g.visible = !this.firstPerson && (this.holdW > 0.02 || this.equipT > 0);
    const hw = this.holdW;
    const aw = this.aimW;
    const kick = this.shootT;
    const gx = lerp(lerp(GUN_HOLSTER.x, GUN_LOW.x, hw), GUN_AIM.x, aw);
    const gy = lerp(lerp(GUN_HOLSTER.y, GUN_LOW.y, hw), GUN_AIM.y, aw);
    const gz = lerp(lerp(GUN_HOLSTER.z, GUN_LOW.z, hw), GUN_AIM.z, aw) - 0.04 * kick;
    const gp = lerp(lerp(GUN_HOLSTER.pitch, GUN_LOW.pitch, hw), GUN_AIM.pitch, aw) - 0.05 * kick;
    g.position.set(gx, gy, gz);
    g.rotation.set(gp, 0, 0);
    this.handMix = 0;
    if (hw > 0.001) {
      const cp = Math.cos(gp);
      const sp = Math.sin(gp);
      const w = clamp01(hw);
      this.handMix = w;
      // A point in the rifle's space (about X only) to the upper body's space, then the arm.
      const grip = (o: readonly [number, number, number], shoulderX: number, left: boolean) => {
        const y = gy + o[1] * cp - o[2] * sp;
        const z = gz + o[1] * sp + o[2] * cp;
        const r = solveArm(shoulderX, gx + o[0], y, z, this.ik);
        this.handQ[left ? 0 : 1].copy(r.q);
        if (left) p.elbowL = lerp(p.elbowL, r.elbow, w);
        else p.elbowR = lerp(p.elbowR, r.elbow, w);
      };
      grip(GRIP_LEFT, -SHOULDER_X, true);
      grip(GRIP_RIGHT, SHOULDER_X, false);
    }
    this.muzzleFlash.visible = this.shootT > 0.55;
    this.brick.update(dt, 1, this.time);

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
    this.arms[0].quaternion.setFromEuler(_euler.set(p.armLX, 0, p.armLZ));
    this.arms[1].quaternion.setFromEuler(_euler.set(p.armRX, 0, p.armRZ));
    if (this.handMix > 0) {
      this.arms[0].quaternion.slerp(this.handQ[0], this.handMix);
      this.arms[1].quaternion.slerp(this.handQ[1], this.handMix);
    }
    this.elbows[0].rotation.x = p.elbowL;
    this.elbows[1].rotation.x = p.elbowR;
  }
}
