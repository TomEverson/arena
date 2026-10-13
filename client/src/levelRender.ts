import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { PALETTE } from "./palette";
import { rampSurface } from "./sim/collision";
import { type Level, type LevelBox, toAabb } from "./sim/level";
import { applyWorldUvs, numberTexture, surfaceKind, surfaceTextures } from "./surfaces";

/** Cheap stable hash (0..1) so each piece of greybox gets a slightly different shade. */
function shade(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 100) / 100;
}

/**
 * Surface material: the texture carries the palette colors and says what the piece is (its
 * `surface` in the level data: concrete, container steel, a walkway, a crate...). The material
 * color only varies brightness per box (0.7..1.1) so boxes stay distinguishable.
 */
function surfaceMaterial(b: LevelBox, face: "wall" | "floor"): THREE.MeshLambertMaterial {
  const tex = surfaceTextures(surfaceKind(b.surface))[face];
  const g = 0.7 + shade(b.id) * 0.4;
  return new THREE.MeshLambertMaterial({
    map: tex,
    color: new THREE.Color(g, g, g),
    flatShading: true,
  });
}

/** One material per box face, in BoxGeometry's group order: +X, -X, +Y (top), -Y, +Z, -Z. */
function boxMaterials(b: LevelBox): THREE.Material[] {
  const wall = surfaceMaterial(b, "wall");
  const floor = surfaceMaterial(b, "floor");
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
  surfaceOnly = false,
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
  if (surfaceOnly) return new THREE.BufferGeometry().setFromPoints(pts);
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

/** How tall a light strip is, and how far it stands out from the face it is on (metres). */
const STRIP_TALL = 0.07;
const STRIP_PROUD = 0.03;

/**
 * Light strips (the style guide's roadmap step 4), as two unlit meshes, one per colour:
 *
 *   SIGNAL (technology) where a piece's `glow` says: "edges" runs a strip along both long sides
 *   of a walkway just under its top, so decks, catwalks, gates and bridges read from below and
 *   from far off; "door-x" and "door-z" run one along the bottom of the faces you walk through,
 *   the head of a doorway or passage.
 *
 *   ACID (traversal: "you can go here") along both edges of every ramp's slope.
 *
 * Visual only: nothing here is in the collision world.
 */
function lightStrips(level: Level): THREE.Group {
  const signal: THREE.BufferGeometry[] = [];
  const acid: THREE.BufferGeometry[] = [];
  const bar = (into: THREE.BufferGeometry[], size: [number, number, number]) => {
    const g = new THREE.BoxGeometry(...size);
    into.push(g);
    return g;
  };
  for (const b of level.boxes) {
    if (!b.glow) continue;
    const [w, h, d] = b.size;
    const [x, y, z] = b.pos;
    if (b.glow === "edges") {
      const up = y + h / 2 - STRIP_TALL / 2 - 0.03;
      for (const s of [-1, 1]) {
        if (w >= d) bar(signal, [w, STRIP_TALL, STRIP_PROUD]).translate(x, up, z + (s * d) / 2);
        else bar(signal, [STRIP_PROUD, STRIP_TALL, d]).translate(x + (s * w) / 2, up, z);
      }
    } else if (b.glow === "door-x" || b.glow === "door-z") {
      const low = y - h / 2 + STRIP_TALL / 2 + 0.03;
      for (const s of [-1, 1]) {
        if (b.glow === "door-z")
          bar(signal, [w, STRIP_TALL, STRIP_PROUD]).translate(x, low, z + (s * d) / 2);
        else bar(signal, [STRIP_PROUD, STRIP_TALL, d]).translate(x + (s * w) / 2, low, z);
      }
    }
  }
  for (const r of level.ramps) {
    const [w, h, d] = r.size;
    const [x, y, z] = r.pos;
    const alongX = r.rises[1] === "x";
    const up = r.rises[0] === "+" ? 1 : -1;
    const run = alongX ? w : d;
    const tilt = Math.atan2(h, run) * up;
    const length = Math.hypot(run, h);
    for (const s of [-1, 1]) {
      // A flat bar the length of the slope, tilted to lie on it, a hair above, at each side edge.
      const g = alongX
        ? bar(acid, [length, 0.03, 0.12]).rotateZ(tilt)
        : bar(acid, [0.12, 0.03, length]).rotateX(-tilt);
      const side = (s * ((alongX ? d : w) - 0.3)) / 2;
      g.translate(x + (alongX ? 0 : side), y + 0.03, z + (alongX ? side : 0));
    }
  }
  const group = new THREE.Group();
  for (const [geos, color] of [
    [signal, PALETTE.SIGNAL],
    [acid, PALETTE.ACID],
  ] as const) {
    if (geos.length === 0) continue;
    group.add(new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({ color })));
    for (const g of geos) g.dispose();
  }
  return group;
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
    // Spire switchbacks are open catwalk ramps: show only the slash surface, not a solid wedge.
    const geo = rampGeometry(toAabb(r), r.rises, r.id.includes("-flight-"));
    geo.computeVertexNormals();
    applyWorldUvs(geo, new THREE.Vector3());
    const mat = surfaceMaterial(r, "floor");
    mat.side = THREE.DoubleSide;
    group.add(new THREE.Mesh(geo, mat));
  }
  group.add(paintedNumbers(level));
  group.add(lightStrips(level));
  return group;
}
