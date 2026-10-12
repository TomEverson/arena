/** Where the low-resolution image sits inside the canvas, and how to map 3D points onto it. Pure maths. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The low-res render is scaled up to fit the canvas without stretching, centred, with black bars.
 * Returns that rectangle in canvas pixels (y measured from the top).
 */
export function letterbox(canvasW: number, canvasH: number, renderW: number, renderH: number): Box {
  const scale = Math.min(canvasW / renderW, canvasH / renderH);
  const w = Math.floor(renderW * scale);
  const h = Math.floor(renderH * scale);
  return { x: Math.floor((canvasW - w) / 2), y: Math.floor((canvasH - h) / 2), w, h };
}

/**
 * A point in normalised device coordinates (-1..1, y up, as THREE's `project` gives) to canvas pixels.
 * Returns null if the point is behind the camera or outside the picture.
 */
export function ndcToScreen(
  ndcX: number,
  ndcY: number,
  ndcZ: number,
  box: Box,
): { x: number; y: number } | null {
  if (ndcZ > 1 || Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) return null;
  return { x: box.x + (ndcX * 0.5 + 0.5) * box.w, y: box.y + (1 - (ndcY * 0.5 + 0.5)) * box.h };
}
