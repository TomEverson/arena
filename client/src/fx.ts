import * as THREE from "three";

import { type ArmMaterials, armMaterials, buildHands, paintArms } from "./hands";
import { buildKatana } from "./katana";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { type Brick, BRICK_MAG_HOME, BRICK_MUZZLE, BRICK_SIGHT_Y, buildBrick } from "./rifle";
import { type Bullet, spawnBullet, stepBullet } from "./sim/bullet";
import type { Hitbox } from "./sim/hitscan";
import { PARAMS, SKILL, WEAPON } from "./sim/params";
import type { CollisionWorld } from "./sim/types";
import { buildSniper, SNIPER_MUZZLE, SNIPER_SIGHT_Y } from "./sniper";
import { buildSpear, SPEAR_MUZZLE, SPEAR_PAIR_GAP, SPEAR_SIGHT_Y, SPEAR_VIEW_SCALE } from "./spear";

/** Visual and audio-free feedback for shooting: crosshair, hit markers, shake, viewmodel, tracers. */

const HIP = new THREE.Vector3(0.2, -0.2, -0.45);
/** Aiming down sights: the optic's reticle sits exactly at the middle of the screen. */
const ADS = new THREE.Vector3(0, -BRICK_SIGHT_Y, -0.36);
/** The sniper's scope axis is lined up with the middle of the screen when aiming. */
/** The spear launcher comes up so the spear points at the middle of the screen. */
const ADS_SPEAR = new THREE.Vector3(
  SPEAR_PAIR_GAP / 2, // the pair either side of the middle
  -SPEAR_SIGHT_Y * SPEAR_VIEW_SCALE - 0.02,
  -0.3,
);
/** The launchers are drawn smaller in your own view: where a spear leaves, at that size. */
const SPEAR_VIEW_MUZZLE = SPEAR_MUZZLE.clone().multiplyScalar(SPEAR_VIEW_SCALE);
/** Each gun's aimed position and muzzle, by its index in WEAPON_DEFS. */
const ADS_SNIPER = new THREE.Vector3(0, -SNIPER_SIGHT_Y, 0.1); // eye right up at the eyepiece, so the view through the scope is big
/** What a drawn bullet needs to know about its gun (a WeaponDef has these). */
export interface BulletKind {
  bulletSpeed: number;
  bulletGravity: number;
  range: number;
}
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
/**
 * How long the dash cut takes on screen, from the press: the blades come up from the hips and
 * cut an X during the wind-up, are held crossed through the dash, then go back down. A new cut
 * in overdrive starts it again.
 */
const SLASH_SECONDS = 1;
/** When the dash starts and ends, in seconds from the press. */
const SLASH_DASH_AT = SKILL.slashWindup;
const SLASH_DASH_END = SKILL.slashWindup + PARAMS.dashDuration;
/** How long the blades take to go back down after a rolling dive. */
const DIVE_SHEATHE_SECONDS = 0.45;
/** The right fist at the hip, below the view: where the blade is drawn from and put back. */
const FIST_HIP: readonly [number, number, number] = [0.26, -0.62, -0.22];
/** The right fist during the dash cut (the left mirrors it): raised to its own side, then down across. */
const CROSS_WIND: readonly [number, number, number] = [0.36, 0.0, -0.36];
const CROSS_END: readonly [number, number, number] = [-0.14, -0.38, -0.5];
/** The rolling dive's one full turn: how long it takes when nothing says when the dive will land. */
const DIVE_TURN_SECONDS = 0.6;
/** The turn is over this share of the way to the landing, so the view is level in time. */
const DIVE_TURN_BY = 0.85;
/** A dive that ends before its turn is complete finishes the turn this fast (seconds a turn). */
const DIVE_FINISH_SECONDS = 0.25;
/** The cut with both blades happens between these shares of the turn. */
const DIVE_CUT = [0.4, 0.7] as const;
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
  /** Seconds left of the dash cut (0 = none). */
  private slashLeft = 0;
  /** How far round the rolling dive's turn the view is (radians; 0 = not turning). */
  private tumbleAt = 0;
  /** About how long until the dive lands (seconds), if known. */
  private diveLeft: number | undefined;
  /** The dive around its tumble: seconds into the wind-up and into putting the blades away (-1 = not), and whether it is diving. */
  private divePrepT = -1;
  private diveSheatheT = -1;
  private diving = false;
  /** Which gun's model is showing (0 rifle, 1 sniper), and whether any gun is in hand. */
  private gunIdx = 0;
  private held = true;
  /** Seconds left of the draw (the gun rising into view after a switch). */
  private drawLeft = 0;
  private drawTotal = 0.4;
  /** The arms' materials, shared by the gun hands and the bare fists: recoloured per hero. */
  private readonly arms: ArmMaterials = armMaterials("trooper");
  private readonly leftHand: THREE.Group;
  private readonly leftHandHome = new THREE.Vector3();
  private readonly leftHandTurn = new THREE.Euler();
  private readonly reload: ReloadPose = { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 };
  /** The model of the gun in hand. */
  private get brick(): Brick {
    return this.models[this.gunIdx] as Brick;
  }

  private readonly bullets: {
    b: Bullet;
    line: THREE.Line;
    active: boolean;
    /** How far this bullet flies and how fast it falls (its gun's numbers). */
    range: number;
    gravity: number;
  }[] = [];
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
    this.models = [buildBrick(), buildSniper(), buildSpear(-SPEAR_PAIR_GAP, SPEAR_VIEW_SCALE)];
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
    this.leftHand = buildHands(this.gun, this.arms).left;
    this.leftHandHome.copy(this.leftHand.position);
    this.leftHandTurn.copy(this.leftHand.rotation);
    this.gun.position.copy(HIP);
    // The punching fist: a glove, a cuff and a sleeve reaching back to the corner, in the hero's colours.
    const { glove, sleeve, cuff } = this.arms;
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
    // The blade: a katana (katana.ts) held in the fist, pointing forward and a little up. It sits a
    // little ahead of the grip's middle, so some of the handle shows between the fist and the guard.
    this.blade = buildKatana();
    this.blade.position.set(0, 0.01, -0.05);
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
      this.bullets.push({
        b: spawnBullet([0, 0, 0], [0, 0, -1], 0),
        line,
        active: false,
        range: 0,
        gravity: 0,
      });
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
    return this.gunIdx === 1 ? SNIPER_MUZZLE : this.gunIdx === 2 ? SPEAR_VIEW_MUZZLE : BRICK_MUZZLE;
  }

  /** Whose arms these are: they take the colours of that hero's look (hands.ts). */
  setArms(look: string): void {
    paintArms(this.arms, look);
  }

  /** Whose hands these are: the Assassin's empty hands hold a blade each. */
  setBlades(on: boolean): void {
    this.blades = on;
    this.blade.visible = on;
  }

  /** The dash cut, from the press: draw the blades, cut the X, hold through the dash, put them away. */
  slash(): void {
    this.slashLeft = SLASH_SECONDS;
  }

  /** The rolling dive begins: the view starts its one full turn forward. */
  roll(): void {
    this.tumbleAt = 1e-6;
  }

  /** The dive's wind-up started: the blades come up from the hips and are held out ahead. */
  rollPrep(): void {
    this.divePrepT = 0;
    this.diveSheatheT = -1;
  }

  /**
   * Whether you are in a dive right now, and about how long until it lands (the turn is paced by
   * it). When the dive ends the blades go back down.
   */
  setDiving(on: boolean, left?: number): void {
    this.diveLeft = left;
    if (this.diving && !on) {
      this.diveSheatheT = 0;
      this.divePrepT = -1;
    }
    this.diving = on;
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
    kind: BulletKind,
  ): void {
    this.camera.updateMatrixWorld();
    const muzzle = this.camera.localToWorld(this.muzzle().clone().add(this.gun.position));
    const aim = new THREE.Vector3(eye[0] + dir[0] * 40, eye[1] + dir[1] * 40, eye[2] + dir[2] * 40);
    const d = aim.sub(muzzle).normalize();
    this.spawnVisual([muzzle.x, muzzle.y, muzzle.z], [d.x, d.y, d.z], kind);
  }

  /** Someone else's bullet, from their eye (the picture only; the server decides hits). */
  fireRemote(
    eye: readonly [number, number, number],
    dir: readonly [number, number, number],
    kind: BulletKind,
  ): void {
    this.spawnVisual(
      [eye[0] + dir[0] * 0.6, eye[1] - 0.2 + dir[1] * 0.6, eye[2] + dir[2] * 0.6],
      [dir[0], dir[1], dir[2]],
      kind,
    );
  }

  private spawnVisual(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    kind: BulletKind,
  ): void {
    const slot = this.bullets.find((x) => !x.active);
    if (!slot) return;
    slot.b = spawnBullet(origin, dir, kind.bulletSpeed);
    slot.range = kind.range;
    slot.gravity = kind.bulletGravity;
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
      const hit = stepBullet(slot.b, frameDt, world, targets, slot.range, slot.gravity);
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
   * shake, plus the full turn of a rolling dive (in the pitch). Your aim itself does not move.
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
    // Blades: the left hand mirrors the right at rest. During the dash cut both come up and out,
    // then cut down across each other, whatever was in hand (a gun dips out of the way).
    let tumble = 0;
    this.leftFist.visible = this.blades && !this.held;
    this.leftFist.position.set(-FIST_REST[0], FIST_REST[1], FIST_REST[2]);
    this.leftFist.rotation.set(0.15, 0.12, 0);
    this.fist.rotation.set(0.15, -0.12, 0);
    if (this.slashLeft > 0) {
      this.slashLeft = Math.max(0, this.slashLeft - frameDt);
      const t = SLASH_SECONDS - this.slashLeft; // seconds since the press
      const w = SLASH_DASH_AT;
      const away = smooth(t / 0.08) * (1 - smooth((t - 0.85) / 0.15)); // the gun, out of the way
      this.gun.position.y -= 0.4 * away;
      this.fist.visible = this.leftFist.visible = true;
      this.blade.visible = true;
      // To the hip to draw, up and out, down across (the X) as the wind-up ends, held through
      // the dash, back to the hip to sheathe, then to rest.
      const f =
        t < 0.4 * w
          ? mix(FIST_REST, FIST_HIP, smooth(t / (0.4 * w)))
          : t < 0.7 * w
            ? mix(FIST_HIP, CROSS_WIND, smooth((t - 0.4 * w) / (0.3 * w)))
            : t < w
              ? mix(CROSS_WIND, CROSS_END, smooth((t - 0.7 * w) / (0.3 * w)))
              : t < SLASH_DASH_END
                ? CROSS_END
                : t < SLASH_DASH_END + 0.25
                  ? mix(CROSS_END, FIST_HIP, smooth((t - SLASH_DASH_END) / 0.25))
                  : mix(
                      FIST_HIP,
                      FIST_REST,
                      smooth((t - SLASH_DASH_END - 0.25) / (SLASH_SECONDS - SLASH_DASH_END - 0.25)),
                    );
      this.fist.position.set(f[0], f[1], f[2]);
      this.leftFist.position.set(-f[0], f[1], f[2]);
      // Each blade leans in toward the middle while it is up, and tips forward as it comes down.
      const up = smooth((t - 0.4 * w) / (0.3 * w)) * (1 - smooth((t - SLASH_DASH_END) / 0.2));
      const down = smooth((t - 0.7 * w) / (0.3 * w)) * (1 - smooth((t - SLASH_DASH_END) / 0.2));
      this.fist.rotation.set(0.15 - 0.5 * up + 0.9 * down, -0.12, 0.7 * up);
      this.leftFist.rotation.set(0.15 - 0.5 * up + 0.9 * down, 0.12, -0.7 * up);
    } else if (this.tumbleAt > 0 || this.diving || this.divePrepT >= 0 || this.diveSheatheT >= 0) {
      // The rolling dive: the blades come up from the hips and are raised during the wind-up;
      // the dive is one full forward turn of the view, paced to be over just before the landing,
      // with both blades cut down across each other part way round; then they go back down.
      const TURN = Math.PI * 2;
      if (this.diving) {
        const rest = TURN - this.tumbleAt;
        if (rest > 0) {
          const rate =
            this.diveLeft !== undefined
              ? rest / Math.max(this.diveLeft * DIVE_TURN_BY, frameDt)
              : TURN / DIVE_TURN_SECONDS;
          this.tumbleAt = Math.min(TURN, this.tumbleAt + rate * frameDt);
        }
      } else if (this.tumbleAt > 0) {
        // The dive ended before the turn was complete: finish it quickly.
        this.tumbleAt += (TURN / DIVE_FINISH_SECONDS) * frameDt;
        if (this.tumbleAt >= TURN) this.tumbleAt = 0;
      }
      tumble = -this.tumbleAt;
      const w = SKILL.rollWindup;
      let f: readonly [number, number, number];
      let up: number; // the blades raised, leaning in
      let down: number; // the blades cut down, tipped forward
      let away = 1; // the gun, out of the way
      if (this.diving || this.tumbleAt > 0) {
        const u = this.tumbleAt > 0 ? this.tumbleAt / TURN : 1;
        down = smooth((u - DIVE_CUT[0]) / (DIVE_CUT[1] - DIVE_CUT[0]));
        up = 1 - down;
        f = mix(CROSS_WIND, CROSS_END, down);
      } else if (this.divePrepT >= 0) {
        const t = this.divePrepT;
        this.divePrepT += frameDt;
        up = smooth((t - 0.4 * w) / (0.6 * w));
        down = 0;
        away = smooth(t / 0.08);
        f =
          t < 0.4 * w
            ? mix(FIST_REST, FIST_HIP, smooth(t / (0.4 * w)))
            : mix(FIST_HIP, CROSS_WIND, up);
        // No dive came (it was called off by landing): put the blades away again.
        if (t > w + 0.2) {
          this.divePrepT = -1;
          this.diveSheatheT = 0;
        }
      } else {
        const t = this.diveSheatheT;
        this.diveSheatheT = t + frameDt >= DIVE_SHEATHE_SECONDS ? -1 : t + frameDt;
        up = 0;
        down = 1 - smooth(t / 0.2);
        away = 1 - smooth((t - 0.3) / 0.15);
        f =
          t < 0.25
            ? mix(CROSS_END, FIST_HIP, smooth(t / 0.25))
            : mix(FIST_HIP, FIST_REST, smooth((t - 0.25) / (DIVE_SHEATHE_SECONDS - 0.25)));
      }
      this.gun.position.y -= 0.4 * away;
      this.fist.visible = this.leftFist.visible = true;
      this.blade.visible = true;
      this.fist.position.set(f[0], f[1], f[2]);
      this.leftFist.position.set(-f[0], f[1], f[2]);
      this.fist.rotation.set(0.15 - 0.5 * up + 0.9 * down, -0.12, 0.7 * up);
      this.leftFist.rotation.set(0.15 - 0.5 * up + 0.9 * down, 0.12, -0.7 * up);
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
    return { yaw: (Math.random() - 0.5) * a, pitch: (Math.random() - 0.5) * a + tumble };
  }
}
