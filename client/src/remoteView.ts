import * as THREE from "three";

import type { Pose } from "./net/interpolation";
import { EntityFlags, EntityKinds } from "./net/protocol.gen";
import { COMBAT, PARAMS } from "./sim/params";

const FLASH_SECONDS = 0.09;
const TARGET_BODY = 0xd08030;
const TARGET_HEAD = 0xc03030;

interface View {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  materials: THREE.MeshLambertMaterial[];
  /** The colours to restore after a hit flash. */
  base: number[];
  isTarget: boolean;
  flash: number;
}

/**
 * Bodies for everyone else: a coloured box figure per player (crouching and sliding like the
 * real thing), and orange-and-red dummies for practice-range targets, which flash when hit.
 */
export class RemoteViews {
  private readonly views = new Map<number, View>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Flash a body white for a moment (a confirmed hit). */
  flash(id: number): void {
    const v = this.views.get(id);
    if (v) v.flash = FLASH_SECONDS;
  }

  update(poses: Pose[], frameDt: number): void {
    const seen = new Set<number>();
    for (const pose of poses) {
      seen.add(pose.id);
      const v = this.views.get(pose.id) ?? this.create(pose.id, pose.kind === EntityKinds.target);

      // The dead disappear until they respawn; spawn protection makes a player see-through.
      v.group.visible = (pose.flags & EntityFlags.dead) === 0;
      const ghost = (pose.flags & EntityFlags.protected) !== 0;
      v.flash = Math.max(0, v.flash - frameDt);
      v.materials.forEach((m, i) => {
        m.transparent = ghost;
        m.opacity = ghost ? 0.4 : 1;
        m.color.setHex(v.flash > 0 ? 0xffffff : (v.base[i] ?? 0xffffff));
        m.emissive.setHex(v.flash > 0 ? 0x888888 : 0x000000);
      });

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

  private create(id: number, isTarget: boolean): View {
    const bodyColor = isTarget
      ? TARGET_BODY
      : new THREE.Color().setHSL((id * 0.37) % 1, 0.65, 0.5).getHex();
    const headColor = isTarget ? TARGET_HEAD : 0xf0d0b0;
    const group = new THREE.Group();
    const w = PARAMS.halfWidth * 2;
    const bodyMaterial = new THREE.MeshLambertMaterial({ color: bodyColor });
    const headMaterial = new THREE.MeshLambertMaterial({ color: headColor });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 1.5, w), bodyMaterial);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), headMaterial);
    if (!isTarget) {
      // A visor on the front (-Z) so you can tell which way a player faces.
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.08, 0.06),
        new THREE.MeshBasicMaterial({ color: 0x101010 }),
      );
      visor.position.set(0, 0.02, -0.15);
      head.add(visor);
    }
    group.add(body, head);
    this.scene.add(group);
    const view: View = {
      group,
      body,
      head,
      materials: [bodyMaterial, headMaterial],
      base: [bodyColor, headColor],
      isTarget,
      flash: 0,
    };
    this.views.set(id, view);
    return view;
  }
}
