import * as THREE from "three";

import type { Pose } from "./net/interpolation";
import { EntityFlags } from "./net/protocol.gen";
import { COMBAT, PARAMS } from "./sim/params";

interface View {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  materials: THREE.MeshLambertMaterial[];
}

/** Placeholder bodies for other players: a coloured box figure that crouches and slides. */
export class RemoteViews {
  private readonly views = new Map<number, View>();

  constructor(private readonly scene: THREE.Scene) {}

  update(poses: Pose[]): void {
    const seen = new Set<number>();
    for (const pose of poses) {
      seen.add(pose.id);
      const v = this.views.get(pose.id) ?? this.create(pose.id);

      // The dead disappear until they respawn; spawn protection makes a player see-through.
      v.group.visible = (pose.flags & EntityFlags.dead) === 0;
      const ghost = (pose.flags & EntityFlags.protected) !== 0;
      for (const m of v.materials) {
        m.transparent = ghost;
        m.opacity = ghost ? 0.4 : 1;
      }

      const height =
        pose.flags & EntityFlags.sliding
          ? PARAMS.slideHeight
          : pose.flags & EntityFlags.crouching
            ? PARAMS.crouchHeight
            : PARAMS.standHeight;
      const headSize = COMBAT.headSize;
      v.body.scale.y = (height - headSize) / 1.5;
      v.body.position.y = (height - headSize) / 2;
      v.head.position.y = height - headSize / 2;
      v.group.position.set(pose.x, pose.y, pose.z);
      v.group.rotation.y = pose.yaw;
      v.head.rotation.x = pose.pitch;
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        this.scene.remove(v.group);
        this.views.delete(id);
      }
    }
  }

  private create(id: number): View {
    const color = new THREE.Color().setHSL((id * 0.37) % 1, 0.65, 0.5);
    const group = new THREE.Group();
    const w = PARAMS.halfWidth * 2;
    const bodyMaterial = new THREE.MeshLambertMaterial({ color });
    const headMaterial = new THREE.MeshLambertMaterial({ color: 0xf0d0b0 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 1.5, w), bodyMaterial);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), headMaterial);
    // A visor on the front (-Z) so you can tell which way they face.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.08, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x101010 }),
    );
    visor.position.set(0, 0.02, -0.15);
    head.add(visor);
    group.add(body, head);
    this.scene.add(group);
    const view = { group, body, head, materials: [bodyMaterial, headMaterial] };
    this.views.set(id, view);
    return view;
  }
}
