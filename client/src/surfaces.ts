import * as THREE from "three";

import { PALETTE_HEX } from "./palette";

/**
 * Code-generated surface graphics (spec/art/style-guide.md, roadmap step 3):
 * panel lines, warning stripes and painted numbers, drawn on small canvases
 * and shown with nearest-neighbor filtering so every texel stays a crisp square.
 */

/** Texture size in pixels. One tile covers TILE_METRES of world. */
const SIZE = 64;
export const TILE_METRES = 2;

function canvasTexture(draw: (ctx: CanvasRenderingContext2D) => void, repeat = true) {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  // Mipmaps keep distant floors from shimmering; Nearest keeps them blocky.
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const rect = (
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

/** Wall panel: BONE with INK seams on the tile edge, a split line, rivets and a small vent. */
function wallPanel(ctx: CanvasRenderingContext2D): void {
  const { BONE, INK, CONCRETE, HAZE } = PALETTE_HEX;
  rect(ctx, BONE, 0, 0, SIZE, SIZE);
  rect(ctx, INK, 0, 0, SIZE, 1); // seams: tiling makes a 2 m grid
  rect(ctx, INK, 0, 0, 1, SIZE);
  rect(ctx, HAZE, 1, 44, SIZE - 1, 1); // a shallow split between upper and lower panel
  for (const [x, y] of [
    [4, 4],
    [59, 4],
    [4, 59],
    [59, 59],
  ] as const)
    rect(ctx, CONCRETE, x, y, 1, 1);
  for (let i = 0; i < 4; i++) rect(ctx, CONCRETE, 46, 50 + i * 3, 12, 1); // vent slats
}

/** Floor plate: HAZE with GRAPHITE seams and corner marks. */
function floorPlate(ctx: CanvasRenderingContext2D): void {
  const { HAZE, GRAPHITE, CONCRETE } = PALETTE_HEX;
  rect(ctx, HAZE, 0, 0, SIZE, SIZE);
  rect(ctx, GRAPHITE, 0, 0, SIZE, 1);
  rect(ctx, GRAPHITE, 0, 0, 1, SIZE);
  rect(ctx, CONCRETE, 30, 31, 5, 1); // centre cross
  rect(ctx, CONCRETE, 32, 29, 1, 5);
}

/** Deterministic specks: `n` single pixels of a colour, the same every time for a given seed. */
function specks(ctx: CanvasRenderingContext2D, color: string, n: number, seed: number): void {
  let a = seed >>> 0;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const x = a % SIZE;
    const y = (a >>> 8) % SIZE;
    ctx.fillRect(x, y, 1, 1);
  }
}

/**
 * Poured concrete (building walls): light, with pour lines, tie holes and a little grime. It is
 * HAZE speckled with CONCRETE, not solid CONCRETE: lit by the sun and snapped to the palette, a
 * mid-grey wall goes nearly black on its shadow side.
 */
function concreteWall(ctx: CanvasRenderingContext2D): void {
  const { BONE, CONCRETE, GRAPHITE, HAZE } = PALETTE_HEX;
  rect(ctx, HAZE, 0, 0, SIZE, SIZE);
  specks(ctx, CONCRETE, 200, 11);
  specks(ctx, BONE, 120, 23);
  rect(ctx, CONCRETE, 0, 21, SIZE, 1); // pour lines, 2/3 m apart
  rect(ctx, CONCRETE, 0, 42, SIZE, 1);
  rect(ctx, GRAPHITE, 0, 0, SIZE, 1);
  rect(ctx, GRAPHITE, 0, 0, 1, SIZE);
  for (const y of [10, 31, 52]) for (const x of [16, 48]) rect(ctx, GRAPHITE, x, y, 2, 2); // tie holes
}

/** A flat roof: dark, gravelled. */
function gravelRoof(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, INK } = PALETTE_HEX;
  rect(ctx, GRAPHITE, 0, 0, SIZE, SIZE);
  specks(ctx, CONCRETE, 260, 5);
  specks(ctx, INK, 120, 9);
  rect(ctx, INK, 0, 0, SIZE, 1);
  rect(ctx, INK, 0, 0, 1, SIZE);
}

/** Corrugated container steel: vertical ribs, a rail every 2 m and a stencilled mark. */
function container(base: string, rib: string, mark: string) {
  return (ctx: CanvasRenderingContext2D): void => {
    const { INK } = PALETTE_HEX;
    rect(ctx, base, 0, 0, SIZE, SIZE);
    for (let x = 0; x < SIZE; x += 8) {
      rect(ctx, rib, x + 2, 0, 2, SIZE);
      rect(ctx, INK, x + 5, 0, 1, SIZE);
    }
    rect(ctx, INK, 0, 0, SIZE, 2); // the frame rail
    rect(ctx, rib, 0, 2, SIZE, 1);
    rect(ctx, mark, 20, 22, 22, 3); // stencil: two bars and a block
    rect(ctx, mark, 20, 28, 14, 3);
    rect(ctx, mark, 46, 22, 6, 9);
  };
}

/**
 * Tread plate (walkway tops): steel with a diamond of raised dashes. Mid-grey, not dark: at night
 * a dark walkway top goes black, and whoever stands on it must still show.
 */
function treadPlate(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, HAZE } = PALETTE_HEX;
  const INK = GRAPHITE; // seams
  rect(ctx, CONCRETE, 0, 0, SIZE, SIZE);
  ctx.fillStyle = HAZE;
  for (let y = 0; y < SIZE; y += 8)
    for (let x = 0; x < SIZE; x += 8) {
      const lean = (x / 8 + y / 8) % 2 === 0;
      for (let i = 0; i < 3; i++) ctx.fillRect(x + 2 + i, y + (lean ? 2 + i : 4 - i), 1, 1);
    }
  rect(ctx, INK, 0, 0, SIZE, 1);
  rect(ctx, INK, 0, 0, 1, SIZE);
}

/** A steel girder (walkway sides): dark, a light line every half metre and a row of rivets. */
function girder(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, HAZE, INK } = PALETTE_HEX;
  rect(ctx, GRAPHITE, 0, 0, SIZE, SIZE);
  for (let y = 0; y < SIZE; y += 16) {
    rect(ctx, HAZE, 0, y, SIZE, 1);
    rect(ctx, INK, 0, y + 15, SIZE, 1);
    for (let x = 4; x < SIZE; x += 8) rect(ctx, CONCRETE, x, y + 7, 1, 2);
  }
}

/** A pillar: light concrete with a painted INK and BONE band every 2 m, low down. */
function pillar(ctx: CanvasRenderingContext2D): void {
  const { BONE, CONCRETE, HAZE, INK } = PALETTE_HEX;
  rect(ctx, HAZE, 0, 0, SIZE, SIZE);
  specks(ctx, CONCRETE, 160, 31);
  rect(ctx, INK, 0, 48, SIZE, 12);
  rect(ctx, BONE, 0, 50, SIZE, 8);
  for (let x = 0; x < SIZE; x += 16) rect(ctx, INK, x, 50, 8, 8); // a chequer round the band
}

/** A crate: planks half a metre tall, nailed. */
function crate(ctx: CanvasRenderingContext2D): void {
  const { BONE, CONCRETE, HAZE, INK } = PALETTE_HEX;
  for (let y = 0; y < SIZE; y += 16) {
    rect(ctx, (y / 16) % 2 === 0 ? BONE : HAZE, 0, y, SIZE, 16);
    rect(ctx, INK, 0, y, SIZE, 1);
    for (const x of [3, 29, 35, 60]) rect(ctx, CONCRETE, x, y + 7, 1, 2);
  }
  rect(ctx, INK, 31, 0, 2, SIZE); // the plank ends meet every 2 m
}

/** A low wall: concrete with a BONE band a metre apart, like a road barrier. */
function barrier(ctx: CanvasRenderingContext2D): void {
  const { BONE, CONCRETE, GRAPHITE, INK } = PALETTE_HEX;
  rect(ctx, CONCRETE, 0, 0, SIZE, SIZE);
  specks(ctx, GRAPHITE, 40, 47);
  for (const y of [12, 44]) {
    rect(ctx, BONE, 0, y, SIZE, 6);
    rect(ctx, INK, 0, y + 6, SIZE, 1);
  }
  rect(ctx, INK, 0, 0, 1, SIZE);
  rect(ctx, INK, 32, 0, 1, SIZE);
}

/** A kerb or pit rim: concrete with a band of INK and BONE warning stripes a metre apart. */
function warningStripes(ctx: CanvasRenderingContext2D): void {
  const { BONE, CONCRETE, INK } = PALETTE_HEX;
  rect(ctx, CONCRETE, 0, 0, SIZE, SIZE);
  for (const top of [8, 40])
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < SIZE; x++)
        rect(ctx, Math.floor((x + y) / 8) % 2 === 0 ? INK : BONE, x, top + y, 1, 1);
}

/**
 * The ground: light paving with a stud every quarter metre and a seam every 2 m. Kept light and
 * regular: the ground is most of the screen, dark characters must show against it, and random
 * specks this close to the eye read as static.
 */
function paving(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, HAZE } = PALETTE_HEX;
  rect(ctx, HAZE, 0, 0, SIZE, SIZE);
  for (let y = 4; y < SIZE; y += 8)
    for (let x = 4; x < SIZE; x += 8) rect(ctx, CONCRETE, x, y, 1, 1);
  rect(ctx, CONCRETE, 0, 32, SIZE, 1); // a lighter joint half way
  rect(ctx, CONCRETE, 32, 0, 1, SIZE);
  rect(ctx, GRAPHITE, 0, 0, SIZE, 1);
  rect(ctx, GRAPHITE, 0, 0, 1, SIZE);
}

/** The sides of the ground where it is cut away (pit and basin walls): dark, banded. */
function cutting(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, INK } = PALETTE_HEX;
  rect(ctx, GRAPHITE, 0, 0, SIZE, SIZE);
  specks(ctx, CONCRETE, 80, 41);
  for (let y = 0; y < SIZE; y += 16) rect(ctx, INK, 0, y, SIZE, 1);
  rect(ctx, INK, 0, 0, 1, SIZE);
}

/** The floor of the pit and the basins: dark and grimy. */
function pitFloor(ctx: CanvasRenderingContext2D): void {
  const { CONCRETE, GRAPHITE, INK } = PALETTE_HEX;
  rect(ctx, GRAPHITE, 0, 0, SIZE, SIZE);
  specks(ctx, INK, 200, 13);
  specks(ctx, CONCRETE, 70, 29);
  rect(ctx, INK, 0, 0, SIZE, 1);
  rect(ctx, INK, 0, 0, 1, SIZE);
}

/** A ramp: paving with an ACID mark every metre (ACID is "you can go here"). */
function rampTop(ctx: CanvasRenderingContext2D): void {
  paving(ctx);
  for (const y of [14, 46]) for (const x of [14, 46]) rect(ctx, PALETTE_HEX.ACID, x, y, 4, 4);
}

/** 3x5 pixel digits, one string per row ("#" = filled). */
const DIGITS: Record<string, readonly string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", "..#", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
};

/** 5x5 pixel letters for the district codes (three pixels is too narrow to tell N from M or W). */
const LETTERS: Record<string, readonly string[]> = {
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  S: [".####", "#....", ".###.", "....#", "####."],
  E: ["#####", "#....", "####.", "#....", "#####"],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  C: [".####", "#....", "#....", "#....", ".####"],
};
/** Texels per letter pixel on a sign: two letters and the gap between them are 11 pixels wide. */
const SIGN_SCALE = 5;

/** A large painted two-digit number (INK on transparent) with a bar underneath. */
function paintedNumber(n: number): (ctx: CanvasRenderingContext2D) => void {
  return (ctx) => {
    const text = String(n).padStart(2, "0");
    const scale = 8; // each font pixel becomes 8x8 texels
    const left = (SIZE - 7 * scale) / 2; // two 3-wide digits + 1 gap
    ctx.fillStyle = PALETTE_HEX.INK;
    [...text].forEach((ch, i) => {
      DIGITS[ch]?.forEach((row, y) => {
        [...row].forEach((cell, x) => {
          if (cell === "#") ctx.fillRect(left + (i * 4 + x) * scale, 4 + y * scale, scale, scale);
        });
      });
    });
    ctx.fillRect(left, 4 + 6 * scale, 7 * scale, scale / 2);
  };
}

/**
 * The kinds of surface a level piece can be drawn with (`surface` in the level JSON): what its
 * sides and its top look like. Every colour is from the palette's neutrals, plus ACID on ramps.
 */
const SURFACES = {
  panel: [wallPanel, floorPlate],
  concrete: [concreteWall, gravelRoof],
  container: [
    container(PALETTE_HEX.GRAPHITE, PALETTE_HEX.CONCRETE, PALETTE_HEX.BONE),
    container(PALETTE_HEX.GRAPHITE, PALETTE_HEX.CONCRETE, PALETTE_HEX.GRAPHITE),
  ],
  "container-light": [
    container(PALETTE_HEX.BONE, PALETTE_HEX.HAZE, PALETTE_HEX.GRAPHITE),
    container(PALETTE_HEX.BONE, PALETTE_HEX.HAZE, PALETTE_HEX.BONE),
  ],
  metal: [girder, treadPlate],
  pillar: [pillar, gravelRoof],
  crate: [crate, crate],
  barrier: [barrier, paving],
  stripe: [warningStripes, floorPlate],
  ground: [cutting, paving],
  pit: [cutting, pitFloor],
  ramp: [cutting, rampTop],
} as const satisfies Record<string, readonly [Draw, Draw]>;
type Draw = (ctx: CanvasRenderingContext2D) => void;
export type SurfaceKind = keyof typeof SURFACES;

/** The kind for a level piece's `surface`: an unknown or missing one is the plain wall panel. */
export const surfaceKind = (name: string | undefined): SurfaceKind =>
  name !== undefined && name in SURFACES ? (name as SurfaceKind) : "panel";

/** Shared textures for a kind of surface (its sides and its top), created once on first use. */
const cache = new Map<SurfaceKind, { wall: THREE.Texture; floor: THREE.Texture }>();
export function surfaceTextures(kind: SurfaceKind = "panel") {
  let t = cache.get(kind);
  if (!t) {
    const [wall, floor] = SURFACES[kind];
    t = { wall: canvasTexture(wall), floor: canvasTexture(floor) };
    cache.set(kind, t);
  }
  return t;
}

export function numberTexture(n: number): THREE.Texture {
  return canvasTexture(paintedNumber(n), false);
}

/**
 * Painted text of one or two letters from the 5x5 font (INK on transparent), centred on a square
 * tile: a sign is this on a square SIGN_TILE times as tall as the letters.
 */
const signCache = new Map<string, THREE.Texture>();
export function signTexture(text: string): THREE.Texture {
  let tex = signCache.get(text);
  if (!tex) {
    tex = canvasTexture((ctx) => {
      const chars = [...text.slice(0, 2)];
      const width = (chars.length * 6 - 1) * SIGN_SCALE;
      const left = Math.floor((SIZE - width) / 2);
      const top = Math.floor((SIZE - 5 * SIGN_SCALE) / 2);
      ctx.fillStyle = PALETTE_HEX.INK;
      chars.forEach((ch, i) => {
        LETTERS[ch]?.forEach((row, y) => {
          [...row].forEach((cell, x) => {
            if (cell === "#")
              ctx.fillRect(
                left + (i * 6 + x) * SIGN_SCALE,
                top + y * SIGN_SCALE,
                SIGN_SCALE,
                SIGN_SCALE,
              );
          });
        });
      });
    }, false);
    signCache.set(text, tex);
  }
  return tex;
}

/** How much taller a sign's square is than its letters (the tile has a margin round them). */
export const SIGN_TILE = SIZE / (5 * SIGN_SCALE);

/**
 * Replace a geometry's UVs with world-space ones so every texture tile covers
 * TILE_METRES, seams line up between boxes, and nothing gets stretched.
 * `offset` is the mesh position (geometry vertices are relative to it).
 * Needs normals: each face is projected onto the plane it mostly faces.
 */
export function applyWorldUvs(geo: THREE.BufferGeometry, offset: THREE.Vector3): void {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az)
      [u, v] = [x, z]; // floors, ceilings, ramp tops
    else if (ax >= az)
      [u, v] = [z, y]; // walls facing ±X
    else [u, v] = [x, y]; // walls facing ±Z
    uv[i * 2] = u / TILE_METRES;
    uv[i * 2 + 1] = v / TILE_METRES;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}
