/**
 * Debug fly camera. NOT player movement: it is exempt from the shared
 * movement rules (see AGENTS.md). Real movement lives in sim/movement.ts.
 */
export interface FlyState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface FlyKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export const FLY_SPEED = 8; // units per second

export function emptyKeys(): FlyKeys {
  return { forward: false, back: false, left: false, right: false, up: false, down: false };
}

/** Advance position by dt seconds. Yaw 0 looks down -Z; positive yaw turns left. */
export function stepFly(s: FlyState, k: FlyKeys, dt: number): void {
  const fwd = Number(k.forward) - Number(k.back);
  const strafe = Number(k.right) - Number(k.left);
  const vert = Number(k.up) - Number(k.down);

  let dx = -Math.sin(s.yaw) * fwd + Math.cos(s.yaw) * strafe;
  let dz = -Math.cos(s.yaw) * fwd - Math.sin(s.yaw) * strafe;
  const len = Math.hypot(dx, dz);
  if (len > 1) {
    dx /= len;
    dz /= len;
  }
  s.x += dx * FLY_SPEED * dt;
  s.z += dz * FLY_SPEED * dt;
  s.y += vert * FLY_SPEED * dt;
}
