import * as THREE from "three";
import { rampSurface } from "./sim/collision";
import { type Level, type LevelBox, toAabb } from "./sim/level";
import { applyWorldUvs, numberTexture, surfaceTextures } from "./surfaces";

/** Cheap stable hash (0..1) so each piece of greybox gets a slightly different shade. */
function shade(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 100) / 100;
}

/**
 * Surface material: the texture carries the palette colors (wall panels, floor plates),
 * the material color only varies brightness per box (0.7..1.1) so boxes stay distinguishable.
 * Climbable surfaces use ACID/INK warning stripes instead (traversal).
 */
function surfaceMaterial(id: string, kind: "wall" | "floor" | "climb"): THREE.MeshLambertMaterial {
  const tex = surfaceTextures()[kind];
  if (kind === "climb")
    // A little glow (through the stripe texture) so shadowed sides still read as ACID.
    return new THREE.MeshLambertMaterial({
      map: tex,
      emissive: new THREE.Color(0.4, 0.4, 0.4),
      emissiveMap: tex,
      flatShading: true,
    });
  const g = 0.7 + shade(id) * 0.4;
  return new THREE.MeshLambertMaterial({
    map: tex,
    color: new THREE.Color(g, g, g),
    flatShading: true,
  });
}

/** One material per box face, in BoxGeometry's group order: +X, -X, +Y (top), -Y, +Z, -Z. */
function boxMaterials(b: LevelBox): THREE.Material[] {
  if (b.climbable) return Array(6).fill(surfaceMaterial(b.id, "climb"));
  const wall = surfaceMaterial(b.id, "wall");
  const floor = surfaceMaterial(b.id, "floor");
  return [wall, wall, floor, floor, wall, wall];
}

/**
 * Large painted sector numbers (01, 02, ...) on the inner face of tall, long walls,
 * so players can call out positions. Purely visual, derived from level data.
 */
function paintedNumbers(level: Level): THREE.Group {
  const group = new THREE.Group();
  const xs = level.boxes.map((b) => b.pos[0]);
  const zs = level.boxes.map((b) => b.pos[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  let n = 0;
  for (const b of level.boxes) {
    const [w, h, d] = b.size;
    if (h < 6 || Math.max(w, d) < 20 || Math.min(w, d) > 2) continue;
    n++;
    // Face the side of the wall that points toward the middle of the level.
    const alongX = w > d;
    const sign = alongX ? Math.sign(cz - b.pos[2]) || 1 : Math.sign(cx - b.pos[0]) || 1;
    const normal = alongX ? new THREE.Vector3(0, 0, sign) : new THREE.Vector3(sign, 0, 0);
    const halfThickness = (alongX ? d : w) / 2;
    const size = Math.min(4, h * 0.5);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({ map: numberTexture(n), alphaTest: 0.5 }),
    );
    mesh.position.set(b.pos[0], b.pos[1] - b.size[1] / 2 + h * 0.55, b.pos[2]);
    mesh.position.addScaledVector(normal, halfThickness + 0.02);
    mesh.rotation.y = Math.atan2(normal.x, normal.z);
    group.add(mesh);
  }
  return group;
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
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, boxMaterials(b));
    mesh.position.set(...b.pos);
    applyWorldUvs(geo, mesh.position);
    group.add(mesh);
  }
  for (const r of level.ramps) {
    const geo = rampGeometry(toAabb(r), r.rises);
    geo.computeVertexNormals();
    applyWorldUvs(geo, new THREE.Vector3());
    const mat = surfaceMaterial(r.id, "floor");
    mat.side = THREE.DoubleSide;
    group.add(new THREE.Mesh(geo, mat));
  }
  group.add(paintedNumbers(level));
  return group;
}
