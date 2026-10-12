import * as THREE from "three";

import { buildHands } from "./hands";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { type Brick, BRICK_MAG_HOME, BRICK_MUZZLE, BRICK_SIGHT_Y, buildBrick } from "./rifle";
import { type Bullet, spawnBullet, stepBullet } from "./sim/bullet";
import type { Hitbox } from "./sim/hitscan";
import { WEAPON } from "./sim/params";
import type { CollisionWorld } from "./sim/types";

/** Visual and audio-free feedback for shooting: crosshair, hit markers, shake, viewmodel, tracers. */

const HIP = new THREE.Vector3(0.2, -0.2, -0.45);
/** Aiming down sights: the optic's reticle sits exactly at the middle of the screen. */
const ADS = new THREE.Vector3(0, -BRICK_SIGHT_Y, -0.36);
const MUZZLE_LOCAL = BRICK_MUZZLE;
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
/** How long the melee swing animation lasts (matches the weapon's melee lock). */
const MELEE_SECONDS = 0.35;
/** Where the left hand grips the magazine during a reload (gun space). */
const MAG_GRIP = new THREE.Vector3(-0.01, -0.17, -0.28);
/** Seconds, for the ammo strip's low-ammo blink. */
const clockSeconds = () => performance.now() / 1000;

export type HitKind = "body" | "head" | "kill";

export class Fx {
  private readonly crosshair = document.getElementById("crosshair") as HTMLDivElement;
  private readonly marker = document.getElementById("hitmarker") as HTMLDivElement;
  private readonly gun = new THREE.Group();
  private readonly flashMesh: THREE.Mesh;
  private readonly brick: Brick;
  private readonly leftHand: THREE.Group;
  private readonly leftHandHome = new THREE.Vector3();
  private readonly reload: ReloadPose = { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 };
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
  ) {
    // The rifle (rifle.ts), parented to the camera.
    this.brick = buildBrick();
    this.gun.add(this.brick.root);
    this.flashMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.05),
      new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
    );
    this.flashMesh.position.copy(MUZZLE_LOCAL);
    this.flashMesh.visible = false;
    this.gun.add(this.flashMesh);
    this.leftHand = buildHands(this.gun).left;
    this.leftHandHome.copy(this.leftHand.position);
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
    this.fist.rotation.set(0.15, -0.12, 0);
    this.fist.visible = false;
    camera.add(this.fist);
    camera.add(this.gun);
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
  fireOwn(eye: readonly [number, number, number], dir: readonly [number, number, number]): void {
    this.camera.updateMatrixWorld();
    const muzzle = this.camera.localToWorld(MUZZLE_LOCAL.clone().add(this.gun.position));
    const aim = new THREE.Vector3(eye[0] + dir[0] * 40, eye[1] + dir[1] * 40, eye[2] + dir[2] * 40);
    const d = aim.sub(muzzle).normalize();
    this.spawnVisual([muzzle.x, muzzle.y, muzzle.z], [d.x, d.y, d.z]);
  }

  /** Someone else's bullet, from their eye (the picture only; the server decides hits). */
  fireRemote(eye: readonly [number, number, number], dir: readonly [number, number, number]): void {
    this.spawnVisual(
      [eye[0] + dir[0] * 0.6, eye[1] - 0.2 + dir[1] * 0.6, eye[2] + dir[2] * 0.6],
      [dir[0], dir[1], dir[2]],
    );
  }

  private spawnVisual(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
  ): void {
    const slot = this.bullets.find((x) => !x.active);
    if (!slot) return;
    slot.b = spawnBullet(origin, dir);
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
   * Per-frame: animate viewmodel, effects and crosshair. Returns a camera shake offset (radians).
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
  ): { yaw: number; pitch: number } {
    this.gun.position.lerpVectors(HIP, ADS, adsT);
    this.kickBack = Math.max(0, this.kickBack - frameDt * 0.5);
    this.gun.position.z += this.kickBack;

    // Reload: follow the keyframe timeline in reloadAnim.ts.
    const r = reloadPose(reloadT > 0 ? 1 - reloadT / WEAPON.reloadTime : 0, this.reload);
    this.gun.rotation.set(r.pitch, 0, r.roll);
    this.gun.position.y += r.drop;
    // Melee: the rifle dips down and away while a gloved fist throws a punch (wind back, strike
    // toward the middle of the screen, return), then the rifle comes back up.
    this.fist.visible = false;
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
    }
    this.brick.mag.position.y = BRICK_MAG_HOME.y + r.mag;
    this.leftHand.position.copy(this.leftHandHome).lerp(MAG_GRIP, r.hand);
    this.leftHand.position.y += r.mag * r.hand;
    this.brick.update(frameDt, ammoFraction, clockSeconds());
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

    this.shake = Math.max(0, this.shake - frameDt * 6);
    const a = this.shake * this.shake * 0.012;
    return { yaw: (Math.random() - 0.5) * a, pitch: (Math.random() - 0.5) * a };
  }
}
