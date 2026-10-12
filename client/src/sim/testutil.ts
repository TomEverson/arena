import { hSpeed, spawnState, stepPlayer } from "./movement";
import type { CollisionWorld, PlayerInput, PlayerState } from "./types";
import { emptyInput } from "./types";

export const DT = 1 / 60;

/** A big flat floor with its top at y = 0. */
export function flatWorld(extra: Partial<CollisionWorld> = {}): CollisionWorld {
  return {
    boxes: [
      { minX: -100, maxX: 100, minY: -1, maxY: 0, minZ: -100, maxZ: 100 },
      ...(extra.boxes ?? []),
    ],
    ramps: extra.ramps ?? [],
  };
}

export function box(cx: number, cy: number, cz: number, w: number, h: number, d: number) {
  return {
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minY: cy - h / 2,
    maxY: cy + h / 2,
    minZ: cz - d / 2,
    maxZ: cz + d / 2,
  };
}

/** Run `ticks` steps; `input` may depend on the tick index. */
export function run(
  start: PlayerState,
  world: CollisionWorld,
  ticks: number,
  input: Partial<PlayerInput> | ((tick: number, s: PlayerState) => Partial<PlayerInput>),
): PlayerState {
  let s = start;
  for (let i = 0; i < ticks; i++) {
    const partial = typeof input === "function" ? input(i, s) : input;
    s = stepPlayer(s, { ...emptyInput(), ...partial }, world, DT);
  }
  return s;
}

/** Spawn on the floor and let the player settle. */
export function grounded(world: CollisionWorld, x = 0, z = 0): PlayerState {
  return run(spawnState(x, 0, z), world, 2, {});
}

export { hSpeed };
