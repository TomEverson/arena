import * as THREE from "three";

import { type Dummy, DUMMY_HALF_WIDTH, DUMMY_HEIGHT } from "./dummies";
import { WEAPON as W } from "./sim/params";

const FLASH_SECONDS = 0.09;

interface View {
  group: THREE.Group;
  materials: THREE.MeshLambertMaterial[];
  flash: number;
}

/** Meshes for the practice dummies: orange body, red head, white flash when hit. */
export class DummyViews {
  private readonly views: View[] = [];

  constructor(scene: THREE.Scene, dummies: readonly Dummy[]) {
    const headSize = DUMMY_HEIGHT - W.headMinHeight;
    for (const _ of dummies) {
      const body = new THREE.MeshLambertMaterial({ color: 0xd08030 });
      const head = new THREE.MeshLambertMaterial({ color: 0xc03030 });
      const group = new THREE.Group();
      const bodyMesh = new THREE.Mesh(
        new THREE.BoxGeometry(DUMMY_HALF_WIDTH * 2, W.headMinHeight, DUMMY_HALF_WIDTH * 2),
        body,
      );
      bodyMesh.position.y = W.headMinHeight / 2;
      const headMesh = new THREE.Mesh(
        new THREE.BoxGeometry(DUMMY_HALF_WIDTH * 2, headSize, DUMMY_HALF_WIDTH * 2),
        head,
      );
      headMesh.position.y = W.headMinHeight + headSize / 2;
      group.add(bodyMesh, headMesh);
      scene.add(group);
      this.views.push({ group, materials: [body, head], flash: 0 });
    }
  }

  flash(id: number): void {
    const v = this.views[id];
    if (v) v.flash = FLASH_SECONDS;
  }

  update(dummies: readonly Dummy[], frameDt: number): void {
    dummies.forEach((d, i) => {
      const v = this.views[i];
      if (!v) return;
      v.group.visible = d.alive;
      v.group.position.set(d.x, d.y, d.z);
      v.flash = Math.max(0, v.flash - frameDt);
      const base = [0xd08030, 0xc03030];
      v.materials.forEach((m, k) => {
        m.color.setHex(v.flash > 0 ? 0xffffff : (base[k] ?? 0xffffff));
        m.emissive.setHex(v.flash > 0 ? 0x888888 : 0x000000);
      });
    });
  }
}
