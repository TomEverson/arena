/**
 * Movement and weapon tuning. The numbers live in /shared/params.json, the single
 * source of truth shared with the Go server (which gets generated constants).
 * Changing any of them changes movement: run `pnpm vectors` to re-record the
 * test vectors, and keep both test suites green.
 */
import params from "../../../shared/params.json";

export const PARAMS = params.movement;

/**
 * Assault rifle tuning. Combat math lives in weapon.ts / hitscan.ts and is ported
 * to the Go server in M5. Angles are degrees.
 */
export const WEAPON = params.weapon;

/** Health, respawn and lag-compensation numbers (server-authoritative; the client shows them). */
export const COMBAT = params.combat;
