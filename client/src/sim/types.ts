/** Shared types for the movement simulation. Units are metres and seconds, Y is up. */

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Hold jump while facing this surface to climb it. */
  climbable?: boolean;
}

/** Direction the ramp surface rises toward. */
export type RiseDir = "+x" | "-x" | "+z" | "-z";

/** A solid wedge filling `box` below a sloped surface. */
export interface Ramp {
  box: Aabb;
  rises: RiseDir;
}

export interface CollisionWorld {
  boxes: Aabb[];
  ramps: Ramp[];
}

/** One tick of player intent. Edge-triggered buttons are "pressed this tick". */
export interface PlayerInput {
  /** Strafe, -1 (left) .. +1 (right). */
  moveX: number;
  /** Forward, -1 (back) .. +1 (forward). */
  moveZ: number;
  /** Look direction in radians. Yaw 0 faces -Z; positive yaw turns left. */
  yaw: number;
  jump: boolean;
  /** Jump button held (climbing). */
  jumpHeld: boolean;
  dash: boolean;
  /** Held. */
  slide: boolean;
  /** Aiming down sights (held): slows ground movement. */
  ads: boolean;
}

/**
 * Complete movement state. Flat numeric fields only, so it ports 1:1 to Go
 * and is trivially cloneable. (x, y, z) is the centre of the player's feet.
 */
export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;

  climbing: boolean;

  sliding: boolean;
  slideTime: number;
  slideCooldown: number;

  /** Fractional: regenerates continuously up to PARAMS.dashCharges. */
  dashCharges: number;
  /** Seconds of dash remaining; 0 when not dashing. */
  dashTime: number;
  dashDirX: number;
  dashDirZ: number;

  /** Air jumps left; refilled whenever grounded. */
  airJumps: number;
  coyote: number;
  jumpBuffer: number;

  mantling: boolean;
  mantleT: number;
  mantleFromX: number;
  mantleFromY: number;
  mantleFromZ: number;
  mantleToX: number;
  mantleToY: number;
  mantleToZ: number;
}

export const emptyInput = (): PlayerInput => ({
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  jump: false,
  jumpHeld: false,
  dash: false,
  slide: false,
  ads: false,
});
