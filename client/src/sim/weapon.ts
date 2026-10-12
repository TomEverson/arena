/**
 * Weapon and damage logic: pure and deterministic, shared in logic with the Go
 * server (server/internal/game/weapon*.go, M5). Randomness comes from the
 * weapon's own seeded generator, never from Math.random.
 *
 * Recoil model: each consecutive shot kicks the player's VIEW by a fixed
 * pattern entry (the caller adds the kick to its look angles). The player pulls
 * the mouse the other way to counter it. Spread is random within a cone around
 * the view direction and does not move the view.
 */
import type { WeaponState } from "../net/protocol.gen";
import { PARAMS, WEAPON as W } from "./params";

export type { WeaponState };

const DEG = Math.PI / 180;
const SHOT_INTERVAL = 60 / W.rpm;

export interface WeaponInput {
  /** Fire button held. */
  fire: boolean;
  /** Reload pressed this tick. */
  reload: boolean;
  ads: boolean;
}

export interface WeaponContext {
  /** Horizontal speed of the player. */
  hSpeed: number;
  onGround: boolean;
  crouching: boolean;
  sliding: boolean;
}

export interface ShotResult {
  fired: boolean;
  /** Random offset of this bullet from the view direction (radians). */
  spreadYaw: number;
  spreadPitch: number;
  /** View kick to apply after the shot (radians). Positive pitch looks up, positive yaw turns left. */
  kickYaw: number;
  kickPitch: number;
  reloadStarted: boolean;
  reloadFinished: boolean;
  /** Tried to fire with an empty magazine. */
  dryFire: boolean;
}

export function spawnWeapon(seed = 1): WeaponState {
  return {
    ammo: W.magSize,
    reloadT: 0,
    cooldown: 0,
    burst: 0,
    sinceShot: 1e9,
    rng: seed >>> 0 || 1,
  };
}

/** mulberry32: returns [value in [0,1), next state]. */
function nextRandom(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Half-angle of the shot cone in degrees, for the shot about to be fired. */
export function spreadDegrees(burst: number, ads: boolean, ctx: WeaponContext): number {
  let spread = ads ? W.adsSpread : W.hipSpread;
  let bloom = W.moveBloom * Math.min(1, ctx.hSpeed / PARAMS.runSpeed);
  if (!ctx.onGround) bloom += W.airBloom;
  if (ctx.sliding) bloom *= W.slideBloomScale;
  if (ads) bloom *= W.adsBloomScale;
  spread += bloom + Math.min(W.shotBloomMax, burst * W.shotBloom);
  // Crouching steadies hipfire a lot, sliding a little; aiming down sights is already tight.
  if (!ads) {
    if (ctx.crouching) spread *= W.crouchHipMult;
    else if (ctx.sliding) spread *= W.slideHipMult;
  }
  return spread;
}

const NO_SHOT: ShotResult = {
  fired: false,
  spreadYaw: 0,
  spreadPitch: 0,
  kickYaw: 0,
  kickPitch: 0,
  reloadStarted: false,
  reloadFinished: false,
  dryFire: false,
};

export function stepWeapon(
  prev: WeaponState,
  input: WeaponInput,
  ctx: WeaponContext,
  dt: number,
): { state: WeaponState; shot: ShotResult } {
  const w: WeaponState = { ...prev };
  const shot: ShotResult = { ...NO_SHOT };

  w.sinceShot += dt;
  if (w.sinceShot > W.recoilResetTime) w.burst = 0;
  w.cooldown -= dt;

  // Reload
  if (w.reloadT > 0) {
    w.reloadT -= dt;
    if (w.reloadT <= 0) {
      w.reloadT = 0;
      w.ammo = W.magSize;
      shot.reloadFinished = true;
    }
  } else if (input.reload && w.ammo < W.magSize) {
    w.reloadT = W.reloadTime;
    shot.reloadStarted = true;
  }

  // Fire
  if (input.fire && w.reloadT <= 0 && w.cooldown <= 0) {
    if (w.ammo > 0) {
      const spread = spreadDegrees(w.burst, input.ads, ctx) * DEG;
      const [u, r1] = nextRandom(w.rng);
      const [v, r2] = nextRandom(r1);
      w.rng = r2;
      const radius = spread * Math.sqrt(u); // uniform over the disc
      shot.fired = true;
      shot.spreadYaw = radius * Math.cos(v * 2 * Math.PI);
      shot.spreadPitch = radius * Math.sin(v * 2 * Math.PI);
      const i = Math.min(w.burst, W.recoilPitch.length - 1);
      shot.kickPitch = (W.recoilPitch[i] ?? 0) * DEG;
      shot.kickYaw = (W.recoilYaw[i] ?? 0) * DEG;
      w.ammo -= 1;
      w.burst += 1;
      w.sinceShot = 0;
      w.cooldown += SHOT_INTERVAL;
    } else if (w.reloadT <= 0) {
      // Empty: start reloading automatically.
      shot.dryFire = true;
      w.reloadT = W.reloadTime;
      shot.reloadStarted = true;
    }
  }
  if (w.cooldown < 0 && !shot.fired) w.cooldown = 0;

  return { state: w, shot };
}

// --- Damage ----------------------------------------------------------------

export interface Health {
  health: number;
  shield: number;
}

export interface DamageResult {
  shieldDamage: number;
  healthDamage: number;
  killed: boolean;
}

export const fullHealth = (): Health => ({ health: W.maxHealth, shield: W.maxShield });

export function damageFor(headshot: boolean): number {
  return W.damage * (headshot ? W.headshotMult : 1);
}

/** Shield absorbs first; the remainder spills into health. Mutates `h`. */
export function applyDamage(h: Health, amount: number): DamageResult {
  const shieldDamage = Math.min(h.shield, amount);
  h.shield -= shieldDamage;
  const healthDamage = Math.min(h.health, amount - shieldDamage);
  h.health -= healthDamage;
  return { shieldDamage, healthDamage, killed: h.health <= 0 };
}

/** Unit view direction. Yaw 0 / pitch 0 faces -Z; positive pitch looks up. */
export function viewDirection(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
