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

/** Warning stripes for climbable surfaces: diagonal ACID and INK bands (traversal). */
function climbStripes(ctx: CanvasRenderingContext2D): void {
  const { ACID, INK } = PALETTE_HEX;
  const band = 16; // pixels (0.5 m); 64 / band must be even for the stripes to tile
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      rect(ctx, Math.floor((x + y) / band) % 2 === 0 ? ACID : INK, x, y, 1, 1);
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

/** Shared textures, created once on first use. */
let cache: { wall: THREE.Texture; floor: THREE.Texture; climb: THREE.Texture } | null = null;
export function surfaceTextures() {
  cache ??= {
    wall: canvasTexture(wallPanel),
    floor: canvasTexture(floorPlate),
    climb: canvasTexture(climbStripes),
  };
  return cache;
}

export function numberTexture(n: number): THREE.Texture {
  return canvasTexture(paintedNumber(n), false);
}

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
