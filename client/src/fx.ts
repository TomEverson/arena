import * as THREE from "three";
import { buildHands } from "./hands";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { WEAPON } from "./sim/params";

/** Visual and audio-free feedback for shooting: crosshair, hit markers, shake, viewmodel, tracers. */

const HIP = new THREE.Vector3(0.2, -0.2, -0.45);
const ADS = new THREE.Vector3(0, -0.145, -0.36);
const MUZZLE_LOCAL = new THREE.Vector3(0, 0.0, -0.58);
const TRACER_SECONDS = 0.07;
const IMPACT_SECONDS = 0.12;
const POOL = 8;
/** Where the left hand grips the magazine during a reload (gun space). */
const MAG_GRIP = new THREE.Vector3(-0.01, -0.17, -0.28);

export type HitKind = "body" | "head" | "kill";

export class Fx {
  private readonly crosshair = document.getElementById("crosshair") as HTMLDivElement;
  private readonly marker = document.getElementById("hitmarker") as HTMLDivElement;
  private readonly gun = new THREE.Group();
  private readonly flashMesh: THREE.Mesh;
  private readonly mag: THREE.Mesh;
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
    // Placeholder rifle: a few boxes, parented to the camera.
    const dark = new THREE.MeshLambertMaterial({ color: PALETTE.GRAPHITE });
    const light = new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE });
    const part = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      m: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      this.gun.add(mesh);
      return mesh;
    };
    part(0.07, 0.09, 0.4, 0, 0, -0.3, dark); // receiver
    part(0.035, 0.035, 0.24, 0, 0.012, -0.55, light); // barrel
    this.mag = part(0.05, 0.12, 0.06, 0, -0.1, -0.28, dark); // magazine
    part(0.06, 0.1, 0.07, 0, -0.08, -0.1, dark); // grip
    part(0.015, 0.03, 0.03, 0, 0.06, -0.4, light); // sight
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
   * `reloadT` is the weapon's remaining reload time in seconds (0 when not reloading).
   */
  update(
    frameDt: number,
    adsT: number,
    spreadDeg: number,
    fovDeg: number,
    reloadT: number,
  ): { yaw: number; pitch: number } {
    this.gun.position.lerpVectors(HIP, ADS, adsT);
    this.kickBack = Math.max(0, this.kickBack - frameDt * 0.5);
    this.gun.position.z += this.kickBack;

    // Reload: follow the keyframe timeline in reloadAnim.ts.
    const r = reloadPose(reloadT > 0 ? 1 - reloadT / WEAPON.reloadTime : 0, this.reload);
    this.gun.rotation.set(r.pitch, 0, r.roll);
    this.gun.position.y += r.drop;
    this.mag.position.y = -0.1 + r.mag;
    this.leftHand.position.copy(this.leftHandHome).lerp(MAG_GRIP, r.hand);
    this.leftHand.position.y += r.mag * r.hand;
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
    this.crosshair.style.opacity = String(1 - 0.85 * adsT);

    this.shake = Math.max(0, this.shake - frameDt * 6);
    const a = this.shake * this.shake * 0.012;
    return { yaw: (Math.random() - 0.5) * a, pitch: (Math.random() - 0.5) * a };
  }
}
