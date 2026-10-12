import * as THREE from "three";

import { buildHands } from "./hands";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { type Brick, BRICK_MAG_HOME, BRICK_MUZZLE, BRICK_SIGHT_Y, buildBrick } from "./rifle";
import { WEAPON } from "./sim/params";

/** Visual and audio-free feedback for shooting: crosshair, hit markers, shake, viewmodel, tracers. */

const HIP = new THREE.Vector3(0.2, -0.2, -0.45);
/** Aiming down sights: the optic's reticle sits exactly at the middle of the screen. */
const ADS = new THREE.Vector3(0, -BRICK_SIGHT_Y, -0.36);
const MUZZLE_LOCAL = BRICK_MUZZLE;
const TRACER_SECONDS = 0.07;
const IMPACT_SECONDS = 0.12;
const POOL = 8;
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
  private readonly tracers: { line: THREE.Line; life: number }[] = [];
  private readonly impacts: { mesh: THREE.Mesh; life: number }[] = [];
  private flashLife = 0;
  private kickBack = 0;
  private shake = 0;

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
      this.tracers.push({ line, life: 0 });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
      );
      mesh.visible = false;
      scene.add(mesh);
      this.impacts.push({ mesh, life: 0 });
    }
  }

  /** A bullet was fired and travelled to `hit` (world space). */
  shot(hit: THREE.Vector3, hitWorld: boolean, ads: boolean): void {
    this.flashLife = 0.04;
    this.brick.shoot();
    this.kickBack = ads ? 0.015 : 0.035;
    this.shake = Math.min(1, this.shake + (ads ? 0.15 : 0.3));

    this.camera.updateMatrixWorld();
    const from = this.camera.localToWorld(MUZZLE_LOCAL.clone().add(this.gun.position));
    const t = this.tracers.find((x) => x.life <= 0);
    if (t) {
      const pos = t.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, hit.x, hit.y, hit.z);
      pos.needsUpdate = true;
      t.line.visible = true;
      t.life = TRACER_SECONDS;
    }
    if (hitWorld) {
      const i = this.impacts.find((x) => x.life <= 0);
      if (i) {
        i.mesh.position.copy(hit);
        i.mesh.visible = true;
        i.life = IMPACT_SECONDS;
      }
    }
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
    this.brick.mag.position.y = BRICK_MAG_HOME.y + r.mag;
    this.leftHand.position.copy(this.leftHandHome).lerp(MAG_GRIP, r.hand);
    this.leftHand.position.y += r.mag * r.hand;
    this.brick.update(frameDt, ammoFraction, clockSeconds());
    this.flashLife = Math.max(0, this.flashLife - frameDt);
    this.flashMesh.visible = this.flashLife > 0;

    for (const t of this.tracers) {
      t.life = Math.max(0, t.life - frameDt);
      t.line.visible = t.life > 0;
    }
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
