import * as THREE from "three";

import { buildGrenade } from "./grenade";
import type { Pose } from "./net/interpolation";
import { EntityKinds } from "./net/protocol.gen";
import { PALETTE } from "./palette";
import { SKILL } from "./sim/params";
import { buildSpearShaft } from "./spear";

/**
 * Skill objects, drawn from the entities the server sends for them (visual only; the server
 * decides everything they do, see server/internal/game/skills.go):
 *
 *   grenade      a frag grenade that tumbles, or (flags 1) the beacon that calls a bombardment:
 *                two colour schemes of one model (grenade.ts); when it stops being sent it has
 *                gone off, so a blast is drawn where it last was.
 *   barrier      a SIGNAL pane (technology) with a brighter frame.
 *   bombardment  a HAZARD ring on the ground the size of the danger zone: it blinks during the
 *                warning, then streaks fall inside it while the shells land.
 *   spear        a thunder spear in flight, then blinking once its fuse is lit (stuck in a wall or
 *                bounced off a body), with a HAZARD ring on the
 *                ground showing how far its blast will reach; a blast when it goes off.
 *   grapple      an INK cable from a grappling player's hip gear to the point they are hooked to.
 *   pickup       the practice range's recharge: a SIGNAL box turning over a pad, bobbing. It is
 *                only sent while it can be taken, so it vanishes when someone takes it.
 *
 * HAZARD is danger for everyone here, your own included: your own grenade and shells hurt you.
 */

const BLAST_SECONDS = 0.35;
const STREAKS = 10;
const STREAK_HEIGHT = 30;

interface View {
  kind: number;
  root: THREE.Object3D;
  /** Where it was last frame (a grenade's blast is drawn here). */
  last: THREE.Vector3;
  streaks?: THREE.Mesh[];
  /** Seconds a spear's fuse has been lit (it blinks until it goes off). */
  stuckFor?: number;
  /** A stuck spear's danger zone on the ground (its own object in the scene: it does not blink or tilt with the spear). */
  zone?: THREE.Group;
  age: number;
}

/** What happened this frame that deserves a sound. */
export interface SkillSounds {
  blasts: THREE.Vector3[];
  /** Bombardments with shells landing right now. */
  shelling: THREE.Vector3[];
  /** Recharge pickups taken this frame. */
  taken: THREE.Vector3[];
}

/** A grapple line to draw this frame: from a tank of the player's hip gear to the point they are hooked to. */
export interface GrappleLine {
  from: [number, number, number];
  to: [number, number, number];
}

/** Is this pose a skill object (and not a player or a practice target)? */
export const isSkillPose = (p: Pose): boolean =>
  p.kind === EntityKinds.grenade ||
  p.kind === EntityKinds.barrier ||
  p.kind === EntityKinds.strike ||
  p.kind === EntityKinds.pickup ||
  p.kind === EntityKinds.hook ||
  p.kind === EntityKinds.spear;

export class SkillViews {
  private readonly views = new Map<number, View>();
  private readonly blasts: { mesh: THREE.Mesh; life: number }[] = [];
  private readonly sounds: SkillSounds = { blasts: [], shelling: [], taken: [] };

  private readonly hazard = new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD });
  private readonly pane = new THREE.MeshBasicMaterial({
    color: PALETTE.SIGNAL,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly frame = new THREE.MeshBasicMaterial({ color: PALETTE.SIGNAL });
  /** Grapple cables and their hooks: black, like the rig's wall-run cable (character.ts). */
  private readonly cable = new THREE.MeshBasicMaterial({ color: PALETTE.INK });
  private readonly blastGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly lines: { rope: THREE.Mesh; hook: THREE.Mesh }[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  private readonly zoneGeo = new THREE.RingGeometry(0.96, 1, 48);
  private readonly zoneFillGeo = new THREE.CircleGeometry(0.96, 48);
  private readonly zoneFill = new THREE.MeshBasicMaterial({
    color: PALETTE.HAZARD,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly zoneEdge = new THREE.MeshBasicMaterial({
    color: PALETTE.HAZARD,
    side: THREE.DoubleSide,
  });

  /**
   * `groundBelow` gives the height of the floor under a point (for a stuck spear's danger zone);
   * without it the zone is drawn at the spear's own height.
   */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly groundBelow?: (x: number, y: number, z: number) => number,
  ) {}

  /**
   * A stuck spear's danger zone: a ring on the ground below it, as wide as the blast reaches
   * there. The blast is a ball round the spear, so a spear high on a wall marks a smaller circle,
   * and none at all from higher than the blast reaches.
   */
  private placeZone(v: View, x: number, y: number, z: number): void {
    if (!v.zone) {
      v.zone = new THREE.Group();
      for (const m of [
        new THREE.Mesh(this.zoneGeo, this.zoneEdge),
        new THREE.Mesh(this.zoneFillGeo, this.zoneFill),
      ]) {
        m.rotation.x = -Math.PI / 2;
        v.zone.add(m);
      }
      this.scene.add(v.zone);
    }
    const floor = this.groundBelow ? this.groundBelow(x, y, z) : y;
    const up = Math.max(0, y - floor);
    const reach = SKILL.spearRadius * SKILL.spearRadius - up * up;
    v.zone.visible = reach > 0;
    if (reach <= 0) return;
    v.zone.position.set(x, floor + 0.04, z);
    v.zone.scale.setScalar(Math.sqrt(reach));
  }

  private build(kind: number, flags: number): View {
    const root = new THREE.Group();
    const view: View = { kind, root, last: new THREE.Vector3(), age: 0 };
    if (kind === EntityKinds.grenade) {
      root.add(buildGrenade((flags & 1) !== 0 ? "beacon" : "grenade"));
    } else if (kind === EntityKinds.barrier) {
      const [w, h, t] = [SKILL.barrierWidth, SKILL.barrierHeight, SKILL.barrierThickness];
      const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), this.pane);
      pane.position.y = h / 2;
      root.add(pane);
      // A frame round the edge, so it reads as an object and not as a patch of tinted air.
      const bar = 0.05;
      for (const [bw, bh, x, y] of [
        [w, bar, 0, bar / 2],
        [w, bar, 0, h - bar / 2],
        [bar, h, -w / 2 + bar / 2, h / 2],
        [bar, h, w / 2 - bar / 2, h / 2],
      ] as const) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, t + 0.02), this.frame);
        edge.position.set(x, y, 0);
        root.add(edge);
      }
    } else if (kind === EntityKinds.spear) {
      root.add(buildSpearShaft());
    } else if (kind === EntityKinds.pickup) {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 12), this.frame);
      pad.position.y = 0.02;
      root.add(pad);
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), this.frame);
      core.name = "core";
      root.add(core);
    } else {
      const r = SKILL.bombardRadius;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.25, r, 32),
        new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      root.add(ring);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12), this.hazard);
      dot.rotation.x = -Math.PI / 2;
      dot.position.y = 0.05;
      root.add(dot);
      view.streaks = [];
      for (let i = 0; i < STREAKS; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3, 0.08), this.hazard);
        s.visible = false;
        root.add(s);
        view.streaks.push(s);
      }
    }
    this.scene.add(root);
    return view;
  }

  /** One thin INK box stretched between the two ends of each grapple line, with a hook at the far end. */
  private drawLines(lines: readonly GrappleLine[]): void {
    while (this.lines.length < lines.length) {
      const rope = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 1), this.cable);
      const hook = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), this.cable);
      this.scene.add(rope, hook);
      this.lines.push({ rope, hook });
    }
    this.lines.forEach(({ rope, hook }, i) => {
      const line = lines[i];
      rope.visible = hook.visible = line !== undefined;
      if (!line) return;
      const from = this.a.set(...line.from);
      const to = this.b.set(...line.to);
      rope.position.copy(from).add(to).multiplyScalar(0.5);
      rope.scale.z = Math.max(0.01, from.distanceTo(to));
      rope.lookAt(to);
      hook.position.copy(to);
    });
  }

  private blastAt(at: THREE.Vector3): void {
    const mesh = new THREE.Mesh(
      this.blastGeo,
      new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD, transparent: true, depthWrite: false }),
    );
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.blasts.push({ mesh, life: BLAST_SECONDS });
    this.sounds.blasts.push(at.clone());
  }

  /** Per frame, with the interpolated poses of every skill object. Returns the sounds to play. */
  update(poses: Pose[], frameDt: number, lines: readonly GrappleLine[] = []): SkillSounds {
    this.drawLines(lines);
    this.sounds.blasts.length = 0;
    this.sounds.shelling.length = 0;
    this.sounds.taken.length = 0;
    const seen = new Set<number>();
    for (const pose of poses) {
      seen.add(pose.id);
      let v = this.views.get(pose.id);
      if (!v) {
        v = this.build(pose.kind, pose.flags);
        this.views.set(pose.id, v);
      }
      v.age += frameDt;
      v.root.position.set(pose.x, pose.y, pose.z);
      v.last.copy(v.root.position);
      if (v.kind === EntityKinds.grenade) {
        v.root.rotation.x += frameDt * 9;
        v.root.rotation.z += frameDt * 6;
      } else if (v.kind === EntityKinds.spear) {
        // Pointing the way it flies (the shaft is built along -Z); once stuck it blinks faster and faster.
        v.root.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
        if ((pose.flags & 1) !== 0) {
          v.stuckFor = (v.stuckFor ?? 0) + frameDt;
          v.root.visible = Math.floor(v.stuckFor * (6 + v.stuckFor * 14)) % 2 === 0;
          this.placeZone(v, pose.x, pose.y, pose.z);
        }
      } else if (v.kind === EntityKinds.barrier) {
        v.root.rotation.y = pose.yaw;
      } else if (v.kind === EntityKinds.pickup) {
        const core = v.root.getObjectByName("core");
        if (core) {
          core.position.y = 0.9 + Math.sin(v.age * 2.5) * 0.12;
          core.rotation.set(v.age * 1.3, v.age * 2, 0);
        }
      } else if (v.streaks) {
        const falling = (pose.flags & 1) !== 0;
        // Warning: the ring blinks, faster than a heartbeat. Shelling: it stays lit.
        v.root.visible = falling || Math.floor(v.age * 6) % 2 === 0;
        v.streaks.forEach((s, i) => {
          s.visible = falling;
          if (!falling) return;
          // Each streak falls on its own repeating schedule, to a spot fixed by its index.
          const t = (v.age * 2.2 + i / STREAKS) % 1;
          const a = i * 2.399; // the golden angle: spreads the spots over the circle
          const r = SKILL.bombardRadius * Math.sqrt(((i * 7) % STREAKS) / STREAKS);
          s.position.set(Math.cos(a) * r, (1 - t) * STREAK_HEIGHT, Math.sin(a) * r);
        });
        if (falling) this.sounds.shelling.push(v.last);
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      if (v.kind === EntityKinds.grenade || v.kind === EntityKinds.spear) this.blastAt(v.last);
      if (v.kind === EntityKinds.pickup) this.sounds.taken.push(v.last.clone());
      if (v.zone) this.scene.remove(v.zone);
      this.scene.remove(v.root);
      this.views.delete(id);
    }
    // Blasts: a ball that swells to the blast radius and fades.
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      if (!b) continue;
      b.life -= frameDt;
      const u = 1 - Math.max(0, b.life) / BLAST_SECONDS;
      b.mesh.scale.setScalar(0.5 + u * (SKILL.grenadeRadius * 0.6));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - u);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.blasts.splice(i, 1);
      }
    }
    return this.sounds;
  }
}
