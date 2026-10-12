import type * as THREE from "three";

import { type BodyState, CharacterBody } from "./character";
import type { Dummy } from "./dummies";

/**
 * Practice dummies drawn with the shared character body (character.ts). Visual only:
 * the hitbox in dummies.ts stays a 0.6 x 1.8 m box with the head above 1.5 m.
 */
export class DummyViews {
  private readonly bodies: CharacterBody[];
  private readonly state: BodyState = {
    x: 0,
    y: 0,
    z: 0,
    onGround: true,
    sliding: false,
    alive: true,
  };

  constructor(scene: THREE.Scene, dummies: readonly Dummy[]) {
    this.bodies = dummies.map((d) => new CharacterBody(scene, d.id));
  }

  /** Hide every dummy (online, the targets are other players). The next `update` shows them again. */
  hideAll(): void {
    for (const b of this.bodies) b.root.visible = false;
  }

  flash(id: number): void {
    this.bodies[id]?.hit();
  }

  /** Per frame. `viewer` is the camera position: standing dummies turn to face it. */
  update(dummies: readonly Dummy[], frameDt: number, viewer: THREE.Vector3): void {
    dummies.forEach((d, i) => {
      const s = this.state;
      s.x = d.x;
      s.y = d.y;
      s.z = d.z;
      s.alive = d.alive;
      this.bodies[i]?.update(s, frameDt, viewer);
    });
  }
}
