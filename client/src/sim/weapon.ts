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
import { PARAMS, SNIPER, WEAPON as W } from "./params";

export type { WeaponState };

const DEG = Math.PI / 180;

/** What differs between guns. Slot 0 is the rifle (a projectile weapon), slot 1 the sniper (hitscan). */
export interface WeaponDef {
  name: string;
  /** Hits instantly along the aim line instead of firing a bullet. */
  hitscan: boolean;
  rpm: number;
  magSize: number;
  reloadTime: number;
  damage: number;
  headshotMult: number;
  range: number;
  hipSpread: number;
  adsSpread: number;
  moveBloom: number;
  airBloom: number;
  adsBloomScale: number;
  crouchHipMult: number;
  slideHipMult: number;
  slideBloomScale: number;
  shotBloom: number;
  shotBloomMax: number;
  recoilResetTime: number;
  recoilPitch: readonly number[];
  recoilYaw: readonly number[];
  adsFovScale: number;
  adsSensitivity: number;
  /** Ground speed multiplier while aiming down sights with this gun. */
  adsSpeedMult: number;
}

export const WEAPON_DEFS: readonly [WeaponDef, WeaponDef] = [
  { name: "Brick", hitscan: false, ...W },
  { name: "Needle", hitscan: true, ...SNIPER },
];

/** The slot value of empty hands (no gun). */
export const EMPTY_HANDS = 2;

/** The gun definition for a weapon state's active gun, or null when the hands are empty. */
export function activeDef(w: Pick<WeaponState, "slot" | "gun">): WeaponDef | null {
  return w.slot === EMPTY_HANDS ? null : (WEAPON_DEFS[w.gun] ?? null);
}

/**
 * How the weapon in hand changes movement: empty hands run faster, and each gun has its own
 * slowdown while aiming down sights (the sniper's is much bigger). Both sides compute this from
 * the weapon state before each step and put it on the input, so prediction matches the server.
 */
export function movementMods(w: Pick<WeaponState, "slot" | "gun">): {
  runSpeedMult: number;
  adsSpeedMult: number;
} {
  const d = activeDef(w);
  return {
    runSpeedMult: d ? 1 : W.emptyRunMult,
    adsSpeedMult: d ? d.adsSpeedMult : PARAMS.adsSpeedMult,
  };
}

/** Seconds between shots of a gun. */
const shotInterval = (d: WeaponDef) => 60 / d.rpm;

export interface WeaponInput {
  /** Fire button held. */
  fire: boolean;
  /** Reload pressed this tick. */
  reload: boolean;
  /** Melee pressed this tick. */
  melee: boolean;
  /** Weapon slot pressed this tick: 0 none, 1 rifle, 2 sniper, 3 empty hands. */
  slot: number;
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
  /** The weapon in hand changed this tick (a new draw begins). */
  switched: boolean;
  /** A melee swing began this tick. */
  meleeStarted: boolean;
  /** A melee swing landed this tick: the caller finds who it hit (see melee.ts). */
  meleeStrike: boolean;
}

export function spawnWeapon(seed = 1): WeaponState {
  return {
    slot: 0,
    gun: 0,
    ammo: W.magSize,
    stash: SNIPER.magSize,
    switchT: 0,
    reloadT: 0,
    cooldown: 0,
    burst: 0,
    sinceShot: 1e9,
    meleeT: 0,
    meleeCooldown: 0,
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
export function spreadDegrees(
  burst: number,
  ads: boolean,
  ctx: WeaponContext,
  d: WeaponDef = WEAPON_DEFS[0],
): number {
  let spread = ads ? d.adsSpread : d.hipSpread;
  let bloom = d.moveBloom * Math.min(1, ctx.hSpeed / PARAMS.runSpeed);
  if (!ctx.onGround) bloom += d.airBloom;
  if (ctx.sliding) bloom *= d.slideBloomScale;
  if (ads) bloom *= d.adsBloomScale;
  spread += bloom + Math.min(d.shotBloomMax, burst * d.shotBloom);
  // Crouching steadies hipfire a lot, sliding a little; aiming down sights is already tight.
  if (!ads) {
    if (ctx.crouching) spread *= d.crouchHipMult;
    else if (ctx.sliding) spread *= d.slideHipMult;
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
  switched: false,
  meleeStarted: false,
  meleeStrike: false,
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
  if (w.sinceShot > (activeDef(w)?.recoilResetTime ?? W.recoilResetTime)) w.burst = 0;
  w.cooldown -= dt;
  w.meleeCooldown = Math.max(0, w.meleeCooldown - dt);
  w.switchT = Math.max(0, w.switchT - dt);

  // Switch weapon: 1 rifle, 2 sniper, 3 empty hands. The old gun is put away (a reload is lost)
  // and the new one is ready after the draw. Each gun keeps its own rounds.
  const want = input.slot - 1;
  if (want >= 0 && want <= EMPTY_HANDS && want !== w.slot) {
    if (want !== EMPTY_HANDS && want !== w.gun) {
      const held = w.ammo;
      w.ammo = w.stash;
      w.stash = held;
      w.gun = want;
    }
    const quick = want === EMPTY_HANDS || w.slot === EMPTY_HANDS;
    w.slot = want;
    w.switchT = quick ? W.switchQuickTime : W.switchTime;
    w.reloadT = 0;
    w.burst = 0;
    shot.switched = true;
  }
  const def = activeDef(w);

  // Melee: press to swing; the blow lands after the wind-up, and firing is locked meanwhile.
  if (w.meleeT > 0) {
    w.meleeT -= dt;
    if (w.meleeT <= 0) {
      w.meleeT = 0;
      shot.meleeStrike = true;
    }
  } else if (input.melee && w.meleeCooldown <= 0) {
    w.meleeT = W.meleeWindup;
    w.meleeCooldown = W.meleeCooldown;
    shot.meleeStarted = true;
  }
  const swinging = w.meleeCooldown > W.meleeCooldown - W.meleeLock;
  const ready = def !== null && w.switchT <= 0;

  // Reload
  if (w.reloadT > 0) {
    w.reloadT -= dt;
    if (w.reloadT <= 0) {
      w.reloadT = 0;
      w.ammo = def?.magSize ?? w.ammo;
      shot.reloadFinished = true;
    }
  } else if (input.reload && ready && w.ammo < def.magSize) {
    w.reloadT = def.reloadTime;
    shot.reloadStarted = true;
  }

  // Fire
  if (input.fire && ready && w.reloadT <= 0 && w.cooldown <= 0 && !swinging) {
    if (w.ammo > 0) {
      const spread = spreadDegrees(w.burst, input.ads, ctx, def) * DEG;
      const [u, r1] = nextRandom(w.rng);
      const [v, r2] = nextRandom(r1);
      w.rng = r2;
      const radius = spread * Math.sqrt(u); // uniform over the disc
      shot.fired = true;
      shot.spreadYaw = radius * Math.cos(v * 2 * Math.PI);
      shot.spreadPitch = radius * Math.sin(v * 2 * Math.PI);
      const i = Math.min(w.burst, def.recoilPitch.length - 1);
      shot.kickPitch = (def.recoilPitch[i] ?? 0) * DEG;
      shot.kickYaw = (def.recoilYaw[i] ?? 0) * DEG;
      w.ammo -= 1;
      w.burst += 1;
      w.sinceShot = 0;
      w.cooldown += shotInterval(def);
    } else if (w.reloadT <= 0) {
      // Empty: start reloading automatically.
      shot.dryFire = true;
      w.reloadT = def.reloadTime;
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

export function damageFor(headshot: boolean, d: WeaponDef = WEAPON_DEFS[0]): number {
  return d.damage * (headshot ? d.headshotMult : 1);
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
