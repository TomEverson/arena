import type * as THREE from "three";

import { type BodyState, CharacterBody } from "./character";
import type { Pose } from "./net/interpolation";
import { EntityFlags } from "./net/protocol.gen";

interface View {
  body: CharacterBody;
  state: BodyState;
  lastY: number;
}

/**
 * Bodies for everyone else (other players and practice-range targets), drawn with the shared
 * character body (character.ts). Visual only: hitboxes live in the sim. They flash when hit.
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
      let v = this.views.get(pose.id);
      if (!v) {
        v = {
          body: new CharacterBody(this.scene, pose.id),
          state: { x: 0, y: 0, z: 0, onGround: true, sliding: false, alive: true },
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
