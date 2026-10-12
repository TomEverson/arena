import * as THREE from "three";
import { rampSurface } from "./sim/collision";
import { type Level, toAabb } from "./sim/level";

/** Cheap stable hash so each piece of greybox gets a slightly different shade. */
function shade(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 0.45 + (h % 100) / 400;
}

function greyMaterial(id: string, climbable = false): THREE.MeshLambertMaterial {
  const g = shade(id);
  if (climbable)
    return new THREE.MeshLambertMaterial({
      color: new THREE.Color(g * 0.6, g * 1.5, g * 0.8),
      flatShading: true,
    });
  return new THREE.MeshLambertMaterial({
    color: new THREE.Color(g, g * 0.98, g * 0.92),
    flatShading: true,
  });
}

/** Build wedge geometry from the same height function the collision uses. */
function rampGeometry(
  box: ReturnType<typeof toAabb>,
  rises: Parameters<typeof rampSurface>[0]["rises"],
) {
  const corners: [number, number][] = [
    [box.minX, box.minZ],
    [box.maxX, box.minZ],
    [box.maxX, box.maxZ],
    [box.minX, box.maxZ],
  ];
  const ramp = { box, rises };
  const topY = ([x, z]: [number, number]) => {
    // A zero-width footprint at the corner samples the surface exactly there.
    const h = rampSurface(ramp, {
      minX: x - 1e-4,
      maxX: x + 1e-4,
      minZ: z - 1e-4,
      maxZ: z + 1e-4,
      minY: 0,
      maxY: 0,
    });
    return h ?? box.minY;
  };
  const bottom = corners.map(([x, z]) => new THREE.Vector3(x, box.minY, z));
  const top = corners.map((c) => new THREE.Vector3(c[0], topY(c), c[1]));
  const pts: THREE.Vector3[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    pts.push(a, b, c, a, c, d);
  };
  quad(
    top[0] as THREE.Vector3,
    top[1] as THREE.Vector3,
    top[2] as THREE.Vector3,
    top[3] as THREE.Vector3,
  );
  quad(
    bottom[3] as THREE.Vector3,
    bottom[2] as THREE.Vector3,
    bottom[1] as THREE.Vector3,
    bottom[0] as THREE.Vector3,
  );
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(
      bottom[i] as THREE.Vector3,
      bottom[j] as THREE.Vector3,
      top[j] as THREE.Vector3,
      top[i] as THREE.Vector3,
    );
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export function buildLevelMeshes(level: Level): THREE.Group {
  const group = new THREE.Group();
  for (const b of level.boxes) {
    const [w, h, d] = b.size;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), greyMaterial(b.id, b.climbable));
    mesh.position.set(...b.pos);
    group.add(mesh);
  }
  for (const r of level.ramps) {
    const geo = rampGeometry(toAabb(r), r.rises);
    geo.computeVertexNormals();
    const mat = greyMaterial(r.id);
    mat.side = THREE.DoubleSide;
    group.add(new THREE.Mesh(geo, mat));
  }
  return group;
}
