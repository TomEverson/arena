import type { Correction } from "./prediction";

/** Corrections bigger than this teleport instead of blending (respawn, big desync). */
export const SNAP_DISTANCE = 2;
/** How quickly a blended correction fades (seconds for it to fall to 1/e). */
export const SMOOTH_TIME = 0.1;

/**
 * Hides small prediction corrections from the camera. The simulation state is
 * corrected instantly; this offset starts at "old position minus new position"
 * so the view does not jump, then decays to zero.
 */
export class CorrectionSmoother {
  x = 0;
  y = 0;
  z = 0;

  onCorrection(c: Correction): void {
    if (c.error > SNAP_DISTANCE) {
      this.x = this.y = this.z = 0;
      return;
    }
    this.x += c.before.x - c.after.x;
    this.y += c.before.y - c.after.y;
    this.z += c.before.z - c.after.z;
  }

  update(frameDt: number): void {
    const k = Math.exp(-frameDt / SMOOTH_TIME);
    this.x *= k;
    this.y *= k;
    this.z *= k;
    if (Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z) < 1e-5) this.x = this.y = this.z = 0;
  }
}
