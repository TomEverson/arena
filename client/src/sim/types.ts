import type { Input, PlayerState } from "../net/protocol.gen";

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

/**
 * One tick of player intent: the wire Input without the sequence number, pitch
 * and view tick (those are filled in when the input is sent). Edge buttons are "pressed this tick".
 */
export type PlayerInput = Omit<Input, "seq" | "pitch" | "viewTick">;

/**
 * Complete movement state. Defined once in /protocol/messages.json and generated
 * for both sides, so the client sim and the wire cannot drift. Flat numeric
 * fields only: ports 1:1 to Go and is trivially cloneable.
 */
export type { PlayerState };

export const emptyInput = (): PlayerInput => ({
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  jump: false,
  jumpHeld: false,
  dash: false,
  slide: false,
  ads: false,
  fire: false,
  reload: false,
});
