import * as THREE from "three";

import { buildHands } from "./hands";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { type Brick, BRICK_MAG_HOME, BRICK_MUZZLE, BRICK_SIGHT_Y, buildBrick } from "./rifle";
import { type Bullet, spawnBullet, stepBullet } from "./sim/bullet";
import type { Hitbox } from "./sim/hitscan";
import { SKILL, WEAPON } from "./sim/params";
import type { CollisionWorld } from "./sim/types";
import { buildSniper, SNIPER_MUZZLE, SNIPER_SIGHT_Y } from "./sniper";
import { buildSpear, SPEAR_MUZZLE, SPEAR_PAIR_GAP, SPEAR_SIGHT_Y } from "./spear";

/** Visual and audio-free feedback for shooting: crosshair, hit markers, shake, viewmodel, tracers. */

const HIP = new THREE.Vector3(0.2, -0.2, -0.45);
/** Aiming down sights: the optic's reticle sits exactly at the middle of the screen. */
const ADS = new THREE.Vector3(0, -BRICK_SIGHT_Y, -0.36);
/** The sniper's scope axis is lined up with the middle of the screen when aiming. */
/** The spear launcher comes up so the spear points at the middle of the screen. */
const ADS_SPEAR = new THREE.Vector3(SPEAR_PAIR_GAP / 2, -SPEAR_SIGHT_Y - 0.02, -0.3); // the pair either side of the middle
/** Each gun's aimed position and muzzle, by its index in WEAPON_DEFS. */
const ADS_SNIPER = new THREE.Vector3(0, -SNIPER_SIGHT_Y, 0.1); // eye right up at the eyepiece, so the view through the scope is big
/** A hitscan shot's tracer is drawn as a very fast bullet. */
export const HITSCAN_TRACER_SPEED = 2000;
/** How long the streak behind a flying bullet is, in seconds of flight. */
const TRAIL_SECONDS = 0.025;
const IMPACT_SECONDS = 0.12;
const POOL = 8;
/** The punching fist in camera space: resting low on the right, wound back, and struck out. */
const FIST_REST: readonly [number, number, number] = [0.2, -0.32, -0.3];
const FIST_WIND: readonly [number, number, number] = [0.27, -0.28, -0.12];
const FIST_STRIKE: readonly [number, number, number] = [0.04, -0.1, -0.72];
const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const mix = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
/** How long the spinning slash takes to go right round. */
const SLASH_SECONDS = SKILL.slashSpin;
/** How long the rolling dive's forward tumble takes: one turn, as quick as the spin. */
const ROLL_SECONDS = SKILL.slashSpin;
/** How long the melee swing animation lasts (matches the weapon's melee lock). */
const MELEE_SECONDS = 0.35;
/** Where the left hand grips the magazine during a reload (gun space). */
const MAG_GRIP = new THREE.Vector3(-0.01, -0.17, -0.28);
/** With the spear launchers the left hand is on the left launcher's grip: the right hand's pose, mirrored. */
const SPEAR_LEFT_HAND = new THREE.Vector3(-SPEAR_PAIR_GAP - 0.005, -0.075, -0.09);
const SPEAR_LEFT_TURN = new THREE.Euler(0.55, -0.15, 0, "YXZ");
/** Seconds, for the ammo strip's low-ammo blink. */
const clockSeconds = () => performance.now() / 1000;

export type HitKind = "body" | "head" | "kill";

export class Fx {
  private readonly crosshair = document.getElementById("crosshair") as HTMLDivElement;
  private readonly marker = document.getElementById("hitmarker") as HTMLDivElement;
  private readonly gun = new THREE.Group();
  private readonly flashMesh: THREE.Mesh;
  private readonly models: [Brick, Brick, Brick];
  /** A blade in each fist: the Assassin's hands slot is the pair of blades. */
  private readonly blade: THREE.Mesh;
  /** The left fist and its blade (the right is `fist`, which also throws the punch). */
  private readonly leftFist = new THREE.Group();
  private blades = false;
  /** Seconds left of the spinning slash (0 = none). */
  private slashLeft = 0;
  /** Seconds left of the rolling dive's tumble (0 = none). */
  private rollLeft = 0;
  /** Which gun's model is showing (0 rifle, 1 sniper), and whether any gun is in hand. */
  private gunIdx = 0;
  private held = true;
  /** Seconds left of the draw (the gun rising into view after a switch). */
  private drawLeft = 0;
  private drawTotal = 0.4;
  private readonly leftHand: THREE.Group;
  private readonly leftHandHome = new THREE.Vector3();
  private readonly leftHandTurn = new THREE.Euler();
  private readonly reload: ReloadPose = { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 };
  /** The model of the gun in hand. */
  private get brick(): Brick {
    return this.models[this.gunIdx] as Brick;
  }

  private readonly bullets: { b: Bullet; line: THREE.Line; active: boolean }[] = [];
  private readonly impacts: { mesh: THREE.Mesh; life: number }[] = [];
  private flashLife = 0;
  private kickBack = 0;
  private shake = 0;
  /** Seconds left of the melee swing animation (0 = none). */
  private meleeLeft = 0;
  /** The fist that throws the punch (camera space), shown only while meleeing. */
  private readonly fist = new THREE.Group();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    viewScene: THREE.Scene,
    viewCamera: THREE.PerspectiveCamera,
  ) {
    // The guns (rifle.ts, sniper.ts), parented to the view camera.
    this.models = [buildBrick(), buildSniper(), buildSpear()];
    for (const m of this.models) this.gun.add(m.root);
    this.models[1].root.visible = false;
    this.models[2].root.visible = false;
    this.flashMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.05),
      new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
    );
    this.flashMesh.position.copy(BRICK_MUZZLE);
    this.flashMesh.visible = false;
    this.gun.add(this.flashMesh);
    this.leftHand = buildHands(this.gun).left;
    this.leftHandHome.copy(this.leftHand.position);
    this.leftHandTurn.copy(this.leftHand.rotation);
    this.gun.position.copy(HIP);
    // The punching fist: an INK glove on a CONCRETE sleeve with a HAZE cuff, reaching back to the corner.
    const glove = new THREE.MeshLambertMaterial({ color: PALETTE.INK });
    const sleeve = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE });
    const cuff = new THREE.MeshLambertMaterial({ color: PALETTE.HAZE });
    const box = (
      mat: THREE.Material,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      this.fist.add(m);
    };
    box(glove, 0.11, 0.1, 0.14, 0, 0, 0); // the fist
    box(cuff, 0.1, 0.1, 0.03, 0, 0, 0.09);
    box(sleeve, 0.1, 0.1, 0.5, 0, 0, 0.36); // the forearm, back toward the camera
    // The blade: a long BONE edge held in the fist, pointing forward and a little up.
    this.blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.07, 0.85),
      new THREE.MeshLambertMaterial({ color: PALETTE.BONE, flatShading: true }),
    );
    this.blade.position.set(0, 0.06, -0.5);
    this.blade.visible = false;
    this.fist.add(this.blade);
    // The left hand: the same fist and blade, mirrored.
    for (const m of this.fist.children) this.leftFist.add(m.clone());
    (this.leftFist.children[this.leftFist.children.length - 1] as THREE.Mesh).visible = true;
    this.leftFist.visible = false;
    viewCamera.add(this.leftFist);
    this.fist.rotation.set(0.15, -0.12, 0);
    this.fist.visible = false;
    // The gun and fist live in the renderer's own view scene (fixed field of view), lit like the world.
    viewScene.add(new THREE.HemisphereLight(PALETTE.BONE, PALETTE.GRAPHITE, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.5, 1, 0.4);
    viewScene.add(sun);
    viewCamera.add(this.fist);
    viewCamera.add(this.gun);
    viewScene.add(viewCamera);
    scene.add(camera);

    for (let i = 0; i < POOL; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, -1),
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: PALETTE.HAZARD }));
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.bullets.push({ b: spawnBullet([0, 0, 0], [0, 0, -1], 0), line, active: false });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
      );
      mesh.visible = false;
      scene.add(mesh);
      this.impacts.push({ mesh, life: 0 });
    }
  }

  /** Where the gun in hand fires from (gun space). */
  private muzzle(): THREE.Vector3 {
    return this.gunIdx === 1 ? SNIPER_MUZZLE : this.gunIdx === 2 ? SPEAR_MUZZLE : BRICK_MUZZLE;
  }

  /** Whose hands these are: the Assassin's empty hands hold a blade each. */
  setBlades(on: boolean): void {
    this.blades = on;
    this.blade.visible = on;
  }

  /** The spinning slash: the view turns right round once, flat like a fan, with both blades out. */
  slash(): void {
    this.slashLeft = SLASH_SECONDS;
  }

  /** The rolling dive: the view tumbles forward right over once, like a ball, blades leading. */
  roll(): void {
    this.rollLeft = ROLL_SECONDS;
  }

  /** You fired: muzzle flash, rifle kick and camera shake. (The bullet itself is `fireOwn`.) */
  shot(ads: boolean): void {
    this.flashLife = 0.04;
    this.brick.shoot();
    this.kickBack = ads ? 0.015 : 0.035;
    this.shake = Math.min(1, this.shake + (ads ? 0.15 : 0.3));
  }

  /**
   * Your bullet: drawn leaving the muzzle and heading for where your aim line is about 40 m out,
   * so it looks like it comes from the gun but flies the true path. `eye` and `dir` are what the
   * shot was fired with (the game simulates the real bullet; this is only the picture of it).
   */
  fireOwn(
    eye: readonly [number, number, number],
    dir: readonly [number, number, number],
    speed?: number,
  ): void {
    this.camera.updateMatrixWorld();
    const muzzle = this.camera.localToWorld(this.muzzle().clone().add(this.gun.position));
    const aim = new THREE.Vector3(eye[0] + dir[0] * 40, eye[1] + dir[1] * 40, eye[2] + dir[2] * 40);
    const d = aim.sub(muzzle).normalize();
    this.spawnVisual([muzzle.x, muzzle.y, muzzle.z], [d.x, d.y, d.z], speed);
  }

  /** Someone else's bullet, from their eye (the picture only; the server decides hits). */
  fireRemote(
    eye: readonly [number, number, number],
    dir: readonly [number, number, number],
    speed?: number,
  ): void {
    this.spawnVisual(
      [eye[0] + dir[0] * 0.6, eye[1] - 0.2 + dir[1] * 0.6, eye[2] + dir[2] * 0.6],
      [dir[0], dir[1], dir[2]],
      speed,
    );
  }

  private spawnVisual(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    speed?: number,
  ): void {
    const slot = this.bullets.find((x) => !x.active);
    if (!slot) return;
    slot.b = spawnBullet(origin, dir, speed);
    slot.active = true;
    slot.line.visible = true;
    this.moveLine(slot);
  }

  private moveLine(slot: { b: Bullet; line: THREE.Line }): void {
    const b = slot.b;
    const speed = Math.hypot(b.vx, b.vy, b.vz) || 1;
    const tail = Math.min(TRAIL_SECONDS * speed, b.travelled + 0.4); // short while it is new
    const pos = slot.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(
      0,
      b.x - (b.vx / speed) * tail,
      b.y - (b.vy / speed) * tail,
      b.z - (b.vz / speed) * tail,
    );
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
  }

  /**
   * Fly the bullets you can see. `targets` are the boxes the screen shows people in (a bullet that
   * reaches one ends there with a spark, like a wall); `world` is the level.
   */
  stepBullets(frameDt: number, world: CollisionWorld, targets: readonly Hitbox[]): void {
    for (const slot of this.bullets) {
      if (!slot.active) continue;
      const hit = stepBullet(slot.b, frameDt, world, targets);
      this.moveLine(slot);
      if (hit.kind === "world" || hit.kind === "target") {
        const i = this.impacts.find((x) => x.life <= 0);
        if (i) {
          i.mesh.position.set(hit.x, hit.y, hit.z);
          i.mesh.visible = true;
          i.life = IMPACT_SECONDS;
        }
      }
      if (slot.b.done) {
        slot.active = false;
        slot.line.visible = false;
      }
    }
  }

  /**
   * Which gun is in hand: 0 rifle, 1 sniper; `held` false means empty hands. Shows that model,
   * moves the muzzle flash to its muzzle, and starts the draw (the gun rising into view over
   * `drawSeconds`).
   */
  setWeapon(gun: number, held: boolean, drawSeconds = 0): void {
    this.gunIdx = gun === 1 || gun === 2 ? gun : 0;
    this.held = held;
    this.models.forEach((m, i) => (m.root.visible = i === this.gunIdx));
    this.flashMesh.position.copy(this.muzzle());
    if (drawSeconds > 0) {
      this.drawTotal = drawSeconds;
      this.drawLeft = drawSeconds;
    }
  }

  /** You swung: the rifle is thrust forward and twisted for a moment (the hands go with it). */
  melee(): void {
    this.meleeLeft = MELEE_SECONDS;
  }

  /** An instant kick of camera shake (e.g. you were just shoved by a melee blow). */
  bump(strength: number): void {
    this.shake = Math.min(1, this.shake + strength);
  }

  hitMarker(kind: HitKind): void {
    this.marker.className = "";
    void this.marker.offsetWidth; // restart the CSS animation
    this.marker.className = `on ${kind}`;
    if (kind === "kill") this.shake = Math.min(1, this.shake + 0.6);
  }

  /**
   * Per-frame: animate viewmodel, effects and crosshair. Returns a camera offset (radians): the
   * shake, plus the full turn of a spinning slash (in the yaw) or of a rolling dive (in the
   * pitch). Your aim itself does not move.
   * `reloadT` is the weapon's remaining reload time in seconds (0 when not reloading);
   * `ammoFraction` is the share of a full magazine left, for the rifle's ammo strip.
   */
  update(
    frameDt: number,
    adsT: number,
    spreadDeg: number,
    fovDeg: number,
    reloadT: number,
    ammoFraction = 1,
    reloadTotal: number = WEAPON.reloadTime,
  ): { yaw: number; pitch: number } {
    const aimed = this.gunIdx === 1 ? ADS_SNIPER : this.gunIdx === 2 ? ADS_SPEAR : ADS;
    this.gun.position.lerpVectors(HIP, aimed, adsT);
    this.kickBack = Math.max(0, this.kickBack - frameDt * 0.5);
    this.gun.position.z += this.kickBack;

    // Reload: follow the keyframe timeline in reloadAnim.ts.
    const reloadU = reloadT > 0 ? 1 - reloadT / reloadTotal : 0;
    // A gun with a reload of its own (the spear launchers) does not do the standard one.
    const own = this.brick.reload !== undefined;
    const r = reloadPose(own ? 0 : reloadU, this.reload);
    this.gun.rotation.set(r.pitch, 0, r.roll);
    this.gun.position.y += r.drop;
    if (own && reloadT > 0) {
      // Both launchers drop and tip up while the spears go on, then come back level.
      const down = smooth(reloadU / 0.2) * (1 - smooth((reloadU - 0.85) / 0.15));
      this.gun.position.y -= 0.1 * down;
      this.gun.rotation.x = 0.35 * down;
    }
    // Drawing a gun: it rises into view from below.
    if (this.drawLeft > 0) {
      this.drawLeft = Math.max(0, this.drawLeft - frameDt);
      const rise = (this.drawLeft / this.drawTotal) ** 2;
      this.gun.position.y -= 0.5 * rise;
      this.gun.rotation.x += 0.7 * rise;
    }
    // Melee: the rifle dips down and away while a gloved fist throws a punch (wind back, strike
    // toward the middle of the screen, return), then the rifle comes back up.
    // Empty hands show a resting fist; a punch moves it (and, with a gun, brings the fist in).
    this.fist.visible = !this.held;
    this.fist.position.set(FIST_REST[0], FIST_REST[1], FIST_REST[2]);
    /** How far through a melee swing this frame is (0..1), or -1 when there is none. */
    let cut = -1;
    if (this.meleeLeft > 0) {
      this.meleeLeft = Math.max(0, this.meleeLeft - frameDt);
      const u = 1 - this.meleeLeft / MELEE_SECONDS;
      const dip = smooth(u / 0.2) * (1 - smooth((u - 0.8) / 0.2));
      this.gun.position.y -= 0.34 * dip;
      this.gun.position.x += 0.1 * dip;
      this.gun.rotation.x -= 0.5 * dip;
      const f =
        u < 0.2
          ? FIST_REST
          : u < 0.4
            ? mix(FIST_REST, FIST_WIND, smooth((u - 0.2) / 0.2))
            : u < 0.55
              ? mix(FIST_WIND, FIST_STRIKE, smooth((u - 0.4) / 0.15))
              : mix(FIST_STRIKE, FIST_REST, smooth((u - 0.55) / 0.45));
      this.fist.position.set(f[0], f[1], f[2]);
      this.fist.visible = true;
      cut = u;
    }
    // Blades: the left hand mirrors the right at rest. During the spinning slash both come up
    // and out to the sides, edges level, whatever was in hand (a gun dips out of the way).
    let spin = 0;
    let tumble = 0;
    this.leftFist.visible = this.blades && !this.held;
    this.leftFist.position.set(-FIST_REST[0], FIST_REST[1], FIST_REST[2]);
    this.leftFist.rotation.set(0.15, 0.12, 0);
    this.fist.rotation.set(0.15, -0.12, 0);
    if (this.slashLeft > 0) {
      this.slashLeft = Math.max(0, this.slashLeft - frameDt);
      const u = 1 - this.slashLeft / SLASH_SECONDS;
      spin = Math.PI * 2 * smooth(u);
      const out = smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2));
      this.gun.position.y -= 0.4 * out;
      this.fist.visible = this.leftFist.visible = true;
      this.blade.visible = true;
      this.fist.position.set(
        FIST_REST[0] + 0.22 * out,
        FIST_REST[1] + 0.2 * out,
        FIST_REST[2] - 0.15 * out,
      );
      this.leftFist.position.set(
        -FIST_REST[0] - 0.22 * out,
        FIST_REST[1] + 0.2 * out,
        FIST_REST[2] - 0.15 * out,
      );
      this.fist.rotation.set(0.05, -0.12 - 1.1 * out, 0);
      this.leftFist.rotation.set(0.05, 0.12 + 1.1 * out, 0);
    } else if (this.rollLeft > 0) {
      // The rolling dive: tumbling forward, both blades held out ahead, edges up.
      this.rollLeft = Math.max(0, this.rollLeft - frameDt);
      const u = 1 - this.rollLeft / ROLL_SECONDS;
      tumble = -Math.PI * 2 * smooth(u);
      const out = smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2));
      this.gun.position.y -= 0.4 * out;
      this.fist.visible = this.leftFist.visible = true;
      this.blade.visible = true;
      this.fist.position.set(
        FIST_REST[0] - 0.08 * out,
        FIST_REST[1] + 0.16 * out,
        FIST_REST[2] - 0.25 * out,
      );
      this.leftFist.position.set(
        -FIST_REST[0] + 0.08 * out,
        FIST_REST[1] + 0.16 * out,
        FIST_REST[2] - 0.25 * out,
      );
      this.fist.rotation.set(0.15 + 0.6 * out, -0.12, 0);
      this.leftFist.rotation.set(0.15 + 0.6 * out, 0.12, 0);
    } else {
      this.blade.visible = this.blades;
      if (this.blades && cut >= 0) {
        // The Assassin's melee is a cut with both blades at once: out and up together, then
        // down and in across each other, and back. (The punch above moved only the right fist.)
        const wind = smooth(cut / 0.3) * (1 - smooth((cut - 0.3) / 0.2));
        const strike = smooth((cut - 0.3) / 0.2) * (1 - smooth((cut - 0.55) / 0.45));
        const x = FIST_REST[0] + 0.2 * wind - 0.16 * strike;
        const y = FIST_REST[1] + 0.24 * wind + 0.06 * strike;
        const z = FIST_REST[2] - 0.05 * wind - 0.3 * strike;
        this.fist.visible = this.leftFist.visible = true;
        this.fist.position.set(x, y, z);
        this.leftFist.position.set(-x, y, z);
        this.fist.rotation.set(
          0.15 - 0.5 * wind + 0.3 * strike,
          -0.12 - 0.5 * wind + 0.9 * strike,
          0,
        );
        this.leftFist.rotation.set(
          0.15 - 0.5 * wind + 0.3 * strike,
          0.12 + 0.5 * wind - 0.9 * strike,
          0,
        );
      }
    }
    this.brick.mag.position.y = BRICK_MAG_HOME.y + r.mag;
    // The left hand holds the gun's fore-end, except with the spear launchers: there it holds
    // the left launcher's grip, as the right hand holds the right one's.
    const pair = this.gunIdx === 2;
    this.leftHand.position.copy(pair ? SPEAR_LEFT_HAND : this.leftHandHome).lerp(MAG_GRIP, r.hand);
    this.leftHand.rotation.copy(pair ? SPEAR_LEFT_TURN : this.leftHandTurn);
    this.leftHand.position.y += r.mag * r.hand;
    this.brick.aim?.(adsT);
    this.brick.update(frameDt, ammoFraction, clockSeconds());
    this.brick.reload?.(reloadT > 0 ? reloadU : -1);
    this.flashLife = Math.max(0, this.flashLife - frameDt);
    this.flashMesh.visible = this.flashLife > 0;

    for (const i of this.impacts) {
      i.life = Math.max(0, i.life - frameDt);
      i.mesh.visible = i.life > 0;
    }

    // Crosshair gap grows with the real spread cone, in screen pixels.
    const px =
      (Math.tan((spreadDeg * Math.PI) / 180) / Math.tan((fovDeg * Math.PI) / 360)) *
      (window.innerHeight / 2);
    this.crosshair.style.setProperty("--gap", `${Math.max(2, px).toFixed(1)}px`);
    // Aiming down sights, the optic's reticle is the crosshair: the HUD one is gone.
    this.crosshair.style.opacity = String(adsT > 0.2 ? 0 : 1 - adsT * 5);

    this.gun.visible = this.held;

    this.shake = Math.max(0, this.shake - frameDt * 6);
    const a = this.shake * this.shake * 0.012;
    return { yaw: (Math.random() - 0.5) * a + spin, pitch: (Math.random() - 0.5) * a + tumble };
  }
}
