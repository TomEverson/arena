import * as THREE from "three";
import type { Pose } from "./net/interpolation";
import { EntityFlags } from "./net/protocol.gen";
import { PARAMS } from "./sim/params";

interface View {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
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
      const height =
        pose.flags & EntityFlags.sliding
          ? PARAMS.slideHeight
          : pose.flags & EntityFlags.crouching
            ? PARAMS.crouchHeight
            : PARAMS.standHeight;
      const headSize = 0.3;
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
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1.5, w),
      new THREE.MeshLambertMaterial({ color }),
    );
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshLambertMaterial({ color: 0xf0d0b0 }),
    );
    // A visor on the front (-Z) so you can tell which way they face.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.08, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x101010 }),
    );
    visor.position.set(0, 0.02, -0.15);
    head.add(visor);
    group.add(body, head);
    this.scene.add(group);
    const view = { group, body, head };
    this.views.set(id, view);
    return view;
  }
}
