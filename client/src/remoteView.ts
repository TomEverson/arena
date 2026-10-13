import type * as THREE from "three";

import { type BodyState, CharacterBody, type CharacterLook, HERO_LOOKS } from "./character";
import type { Pose } from "./net/interpolation";
import { EntityFlags, EntityKinds } from "./net/protocol.gen";

interface View {
  look: CharacterLook;
  body: CharacterBody;
  state: BodyState;
  lastY: number;
}

/**
 * Bodies for everyone else, drawn with the shared character body (character.ts): other players
 * as the hero they chose, practice-range targets as the dummy with empty hands. Visual only: hitboxes live in the sim. They flash when hit.
 */
export class RemoteViews {
  private readonly views = new Map<number, View>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Flash a body for a moment (a confirmed hit). */
  flash(id: number): void {
    this.views.get(id)?.body.hit();
  }

  /** Per frame. `viewer` is the camera position: standing bodies turn to face it. */
  update(poses: Pose[], frameDt: number, viewer: THREE.Vector3): void {
    const seen = new Set<number>();
    for (const pose of poses) {
      seen.add(pose.id);
      const target = pose.kind === EntityKinds.target;
      // Practice-range targets are the plain dummy; a player is whichever hero they chose.
      const look = target ? "dummy" : (HERO_LOOKS[pose.hero] ?? "trooper");
      let v = this.views.get(pose.id);
      if (v && v.look !== look) {
        this.scene.remove(v.body.root); // they changed hero: a new body
        v = undefined;
      }
      if (!v) {
        v = {
          look,
          body: new CharacterBody(this.scene, pose.id, look),
          state: { x: 0, y: 0, z: 0, onGround: true, sliding: false, alive: true, armed: true },
          lastY: pose.y,
        };
        this.views.set(pose.id, v);
      }
      const s = v.state;
      s.x = pose.x;
      s.y = pose.y;
      s.z = pose.z;
      s.sliding = (pose.flags & EntityFlags.sliding) !== 0;
      s.wallRunning = (pose.flags & EntityFlags.wallRunning) !== 0;
      s.meleeing = (pose.flags & EntityFlags.meleeing) !== 0;
      s.slashing = (pose.flags & EntityFlags.slashing) !== 0;
      s.rolling = (pose.flags & EntityFlags.rolling) !== 0;
      s.armed = !target && (pose.flags & EntityFlags.emptyHanded) === 0; // a target holds nothing
      s.weapon =
        (pose.flags & EntityFlags.holdingSpear) !== 0
          ? 2
          : (pose.flags & EntityFlags.holdingSniper) !== 0
            ? 1
            : 0;
      s.crouching = (pose.flags & EntityFlags.crouching) !== 0;
      s.dashing = (pose.flags & EntityFlags.dashing) !== 0;
      s.alive = (pose.flags & EntityFlags.dead) === 0;
      // Poses carry no on-ground flag: a body whose height is not changing is on the ground.
      s.onGround = Math.abs(pose.y - v.lastY) < 0.005;
      v.lastY = pose.y;
      v.body.update(s, frameDt, viewer);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        this.scene.remove(v.body.root);
        this.views.delete(id);
      }
    }
  }
}
