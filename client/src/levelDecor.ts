import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { hasLevelKit, KitPlacer, placeProp, TOWER_CORE_INSET } from "./levelKit";
import { PALETTE } from "./palette";
import type { Level, LevelProp, LevelSign } from "./sim/level";
import { SIGN_TILE, signTexture } from "./surfaces";

/**
 * A level's looks-only extras (spec/art/style-guide.md): painted signs, props built from boxes,
 * and at night the stars. Nothing here is in the collision world: props are thin, high up, flat
 * on a surface or outside the perimeter wall, so nobody can walk into one that is not there.
 *
 * Everything of one material is merged into one mesh, so a hundred props cost a few draw calls.
 */

/** A unit vector for a `face` name ("+x", "-z"...). */
function faceNormal(face: string | undefined): THREE.Vector3 {
  const sign = face?.[0] === "-" ? -1 : 1;
  return face?.[1] === "x" ? new THREE.Vector3(sign, 0, 0) : new THREE.Vector3(0, 0, sign);
}

function signMesh(s: LevelSign): THREE.Mesh {
  const side = s.size * SIGN_TILE;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(side, side),
    new THREE.MeshLambertMaterial({ map: signTexture(s.text), alphaTest: 0.5 }),
  );
  mesh.position.set(...s.pos);
  if (s.face === "up") {
    // Flat on the ground, then turned so the letters' tops point the way `yaw` says.
    mesh.rotation.set(-Math.PI / 2, s.yaw, 0, "YXZ");
  } else {
    const n = faceNormal(s.face);
    mesh.rotation.y = Math.atan2(n.x, n.z);
  }
  return mesh;
}

/** Collects boxes per material, to merge at the end. */
class Parts {
  readonly dark: THREE.BufferGeometry[] = [];
  readonly mid: THREE.BufferGeometry[] = [];
  readonly glow: THREE.BufferGeometry[] = [];
  readonly pale: THREE.BufferGeometry[] = [];
  readonly pool: THREE.BufferGeometry[] = [];

  box(into: THREE.BufferGeometry[], size: [number, number, number], at: THREE.Vector3): void {
    into.push(new THREE.BoxGeometry(...size).translate(at.x, at.y, at.z));
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** A lamp post: a thin pole, an arm out over the road, a SIGNAL lamp, and its pool of light on the ground. */
function lamp(p: LevelProp, parts: Parts): void {
  const base = new THREE.Vector3(...p.pos);
  const out = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  const H = 6;
  const REACH = 1.6;
  parts.box(parts.dark, [0.14, H, 0.14], base.clone().addScaledVector(UP, H / 2));
  parts.box(parts.dark, [0.3, 0.5, 0.3], base.clone().addScaledVector(UP, 0.25)); // foot
  const arm = new THREE.BoxGeometry(0.1, 0.1, REACH)
    .rotateY(p.yaw)
    .translate(base.x + (out.x * REACH) / 2, H - 0.05, base.z + (out.z * REACH) / 2);
  parts.dark.push(arm);
  const head = base
    .clone()
    .addScaledVector(out, REACH)
    .setY(H - 0.16);
  parts.box(parts.dark, [0.34, 0.08, 0.34], head.clone().setY(H - 0.06));
  parts.box(parts.glow, [0.26, 0.1, 0.26], head);
  lampPool(p, parts);
}

/** The pool of lamp light on the ground under a lamp's head. */
function lampPool(p: LevelProp, parts: Parts): void {
  const out = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  const head = new THREE.Vector3(...p.pos).addScaledVector(out, 1.6);
  const pool = new THREE.CircleGeometry(3.4, 20)
    .rotateX(-Math.PI / 2)
    .translate(head.x, p.pos[1] + 0.035, head.z);
  parts.pool.push(pool);
}

/** A mast: a thin pole on a small base, a crossbar, and a SIGNAL light at the tip. */
function mast(p: LevelProp, parts: Parts): void {
  const [w, h] = p.size ?? [0.2, 6, 0.2];
  const base = new THREE.Vector3(...p.pos);
  parts.box(parts.dark, [w * 3, 0.3, w * 3], base.clone().addScaledVector(UP, 0.15));
  parts.box(parts.dark, [w, h, w], base.clone().addScaledVector(UP, h / 2));
  parts.box(parts.dark, [w * 6, w * 0.6, w * 0.6], base.clone().addScaledVector(UP, h * 0.7));
  parts.box(parts.glow, [w * 1.6, w * 1.6, w * 1.6], base.clone().addScaledVector(UP, h + w * 0.8));
}

/** A pipe run along a wall: `size` is [length, thickness, thickness], standing just off the face. */
function pipe(p: LevelProp, parts: Parts): void {
  const [len, t] = p.size ?? [10, 0.2, 0.2];
  const n = faceNormal(p.face);
  const at = new THREE.Vector3(...p.pos).addScaledVector(n, t * 0.8);
  const alongX = n.x === 0;
  parts.box(parts.mid, alongX ? [len, t, t] : [t, t, len], at);
  // A bracket every 10 m.
  for (let c = -len / 2 + 5; c < len / 2; c += 10) {
    const b = at.clone();
    if (alongX) b.x += c;
    else b.z += c;
    parts.box(parts.dark, alongX ? [0.12, t * 1.8, t * 1.8] : [t * 1.8, t * 1.8, 0.12], b);
  }
}

/** A wall unit: a ventilation box on the wall with a grille and a small light. */
function unit(p: LevelProp, parts: Parts): void {
  const n = faceNormal(p.face);
  const at = new THREE.Vector3(...p.pos).addScaledVector(n, 0.3);
  const alongX = n.x === 0;
  parts.box(parts.mid, alongX ? [1.6, 1.2, 0.6] : [0.6, 1.2, 1.6], at);
  const front = at.clone().addScaledVector(n, 0.31);
  for (const dy of [-0.3, 0, 0.3])
    parts.box(
      parts.dark,
      alongX ? [1.2, 0.1, 0.04] : [0.04, 0.1, 1.2],
      front.clone().setY(at.y + dy),
    );
  parts.box(
    parts.glow,
    alongX ? [0.16, 0.08, 0.04] : [0.04, 0.08, 0.16],
    front.clone().setY(at.y + 0.5),
  );
}

/** A crane hook: a cable down from `pos`, a block and a hook plate. `size` is [width, drop, width]. */
function hook(p: LevelProp, parts: Parts): void {
  const [w, drop] = p.size ?? [0.6, 3, 0.6];
  const top = new THREE.Vector3(...p.pos);
  parts.box(parts.dark, [0.06, drop, 0.06], top.clone().addScaledVector(UP, -drop / 2));
  parts.box(parts.mid, [w, w * 0.9, w * 0.7], top.clone().addScaledVector(UP, -drop));
  parts.box(
    parts.dark,
    [w * 0.25, w * 0.9, w * 0.25],
    top.clone().addScaledVector(UP, -drop - w * 0.8),
  );
  parts.box(
    parts.glow,
    [w * 0.5, 0.06, w * 0.72],
    top.clone().addScaledVector(UP, -drop + w * 0.2),
  );
}

/** A tower of the city beyond the wall: a dark block with a few lit windows on every side. */
function tower(p: LevelProp, parts: Parts, index: number): void {
  const [w, h, d] = p.size ?? [16, 50, 16];
  const base = new THREE.Vector3(...p.pos);
  parts.box(parts.dark, [w, h, d], base.clone().addScaledVector(UP, h / 2));
  let seed = (index + 1) * 2654435761;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Windows only above the perimeter wall's height: nothing lower is ever seen.
  for (let i = 0; i < 14; i++) {
    const y = 28 + rnd() * Math.max(1, h - 32);
    const onX = rnd() < 0.5;
    const side = rnd() < 0.5 ? -1 : 1;
    const along = (rnd() - 0.5) * ((onX ? d : w) - 3);
    const at = base.clone().setY(y);
    if (onX) at.add(new THREE.Vector3((side * w) / 2 + side * 0.05, 0, along));
    else at.add(new THREE.Vector3(along, 0, (side * d) / 2 + side * 0.05));
    const lit = rnd() < 0.3 ? parts.glow : parts.pale;
    parts.box(lit, onX ? [0.1, 1.4, 2.2] : [2.2, 1.4, 0.1], at);
  }
}

/** Stars: small pale squares scattered over the upper sky, far away and untouched by the fog. */
function stars(): THREE.Points {
  const N = 260;
  const pos = new Float32Array(N * 3);
  let seed = 99;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const up = 0.12 + rnd() * 0.88; // none down at the horizon
    const r = 900;
    const flat = Math.sqrt(1 - up * up);
    pos.set([Math.cos(a) * flat * r, up * r, Math.sin(a) * flat * r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: PALETTE.BONE,
      size: 2.2,
      sizeAttenuation: false,
      fog: false,
    }),
  );
  points.frustumCulled = false;
  return points;
}

export function buildLevelDecor(level: Level): THREE.Group {
  const group = new THREE.Group();
  for (const s of level.signs) group.add(signMesh(s));

  const parts = new Parts();
  const kit = new KitPlacer();
  let towers = 0;
  for (const p of level.props) {
    // The level kit's models where there is one (levelKit.ts); the boxes below otherwise.
    if (hasLevelKit() && placeProp(kit, p, p.kind === "tower" ? towers : 0)) {
      if (p.kind === "lamp") lampPool(p, parts);
      if (p.kind === "tower") {
        // The dark block the facades hang on, pulled in behind their windows.
        const [w, h, d] = p.size ?? [16, 50, 16];
        const inset = 2 * TOWER_CORE_INSET;
        parts.box(
          parts.dark,
          [w - inset, h, d - inset],
          new THREE.Vector3(...p.pos).setY(p.pos[1] + h / 2),
        );
        towers++;
      }
      continue;
    }
    if (p.kind === "lamp") lamp(p, parts);
    else if (p.kind === "mast") mast(p, parts);
    else if (p.kind === "pipe") pipe(p, parts);
    else if (p.kind === "unit") unit(p, parts);
    else if (p.kind === "hook") hook(p, parts);
    else if (p.kind === "tower") tower(p, parts, towers++);
  }
  const lit = (color: THREE.Color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const glow = (color: THREE.Color) => new THREE.MeshBasicMaterial({ color });
  for (const [geos, material] of [
    [parts.dark, lit(PALETTE.GRAPHITE)],
    [parts.mid, lit(PALETTE.CONCRETE)],
    [parts.glow, glow(PALETTE.SIGNAL)],
    // (The far windows are unlit paint, and ignore the fog so the city shows through the night.)
    [parts.pale, new THREE.MeshBasicMaterial({ color: PALETTE.BONE, fog: false })],
    [
      parts.pool,
      new THREE.MeshBasicMaterial({
        color: PALETTE.BONE,
        transparent: true,
        opacity: level.sky === "night" ? 0.16 : 0.05,
        depthWrite: false,
      }),
    ],
  ] as const) {
    if (geos.length === 0) continue;
    group.add(new THREE.Mesh(mergeGeometries([...geos]), material));
    for (const g of geos) g.dispose();
  }
  group.add(kit.build());
  if (level.sky === "night") group.add(stars());
  return group;
}
