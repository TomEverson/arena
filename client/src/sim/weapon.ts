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
import { PARAMS, SKILL, SNIPER, SPEAR, WEAPON as W } from "./params";

export type { WeaponState };

const DEG = Math.PI / 180;

/** What differs between guns. Slot 0 is the rifle, slot 1 the sniper: both fire bullets that fly. */
export interface WeaponDef {
  name: string;
  /** Fires a thunder spear: it flies, sticks, and explodes (the server flies it, see skills.go). */
  spear: boolean;
  rpm: number;
  magSize: number;
  reloadTime: number;
  damage: number;
  headshotMult: number;
  range: number;
  /** The bullet: muzzle speed (m/s) and how fast it falls (m/s²). Unused by the spears. */
  bulletSpeed: number;
  bulletGravity: number;
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

export const WEAPON_DEFS: readonly [WeaponDef, WeaponDef, WeaponDef] = [
  { name: "Brick", spear: false, ...W },
  { name: "Needle", spear: false, ...SNIPER },
  { name: "Spears", spear: true, bulletSpeed: 0, bulletGravity: 0, ...SPEAR },
];

/**
 * Each hero's two guns (indices into WEAPON_DEFS), for slots 1 and 2. Slot 3 is the hands: the
 * Trooper's fists, the Assassin's blades.
 */
export const LOADOUTS: readonly (readonly [number, number])[] = [
  [0, 1], // Trooper: rifle, sniper
  [1, 2], // Assassin: sniper, thunder spears
];
const loadout = (hero: number): readonly [number, number] => LOADOUTS[hero] ?? [0, 1];

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
  /** Skills pressed this tick (see SKILL in params.ts). Left out means not pressed. */
  skillQ?: boolean;
  skillE?: boolean;
  /** Dash pressed this tick: for the Assassin that is the dash cut (the Trooper's dash is movement). */
  dash?: boolean;
  /** One of HeroKinds (left out means the Trooper): decides what the skill buttons do. */
  hero?: number;
  /** The Assassin's overdrive is running: blade skills back to back, the sniper put away, and the spears reloading faster. */
  overdrive?: boolean;
  ads: boolean;
}

export interface WeaponContext {
  /** Horizontal speed of the player. */
  hSpeed: number;
  onGround: boolean;
  crouching: boolean;
  sliding: boolean;
  /** Being pulled by a grapple: shooting is allowed but very loose. */
  grappling?: boolean;
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
  /** A skill was used this tick (it was off cooldown): the server throws the grenade or places the barrier. */
  grenade: boolean;
  barrier: boolean;
  /** The Assassin's dash cut dashes this tick, its wind-up over: the server finds who it cuts, and the caller applies the dash. */
  slash: boolean;
  /** The dash cut's wind-up started this tick (the blades are drawn and cut the X; the dash follows). */
  slashStarted: boolean;
  /** The Assassin's rolling dive began this tick: the caller starts it (movement), the server finds who it hits. */
  roll: boolean;
  /** The rolling dive's wind-up started this tick (the blades are drawn; the dive follows). */
  rollStarted: boolean;
}

/** HeroKinds (protocol). */
const HERO_TROOPER = 0;
const HERO_ASSASSIN = 1;

export function spawnWeapon(seed = 1, hero = HERO_TROOPER): WeaponState {
  const [first, second] = loadout(hero);
  return {
    slot: 0,
    gun: first,
    ammo: WEAPON_DEFS[first]?.magSize ?? 0,
    stash: WEAPON_DEFS[second]?.magSize ?? 0,
    switchT: 0,
    reloadT: 0,
    cooldown: 0,
    burst: 0,
    sinceShot: 1e9,
    meleeT: 0,
    meleeCooldown: 0,
    skillQT: 0,
    skillET: 0,
    slashT: 0,
    diveT: 0,
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
  if (ctx.grappling) spread += SKILL.grappleBloom;
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
  grenade: false,
  barrier: false,
  slash: false,
  slashStarted: false,
  roll: false,
  rollStarted: false,
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
  w.skillQT = Math.max(0, w.skillQT - dt);
  w.skillET = Math.max(0, w.skillET - dt);

  // Skills: a press when the skill is off cooldown uses it, whatever the hands are doing.
  const hero = input.hero ?? HERO_TROOPER;
  if (hero === HERO_TROOPER) {
    if (input.skillQ && w.skillQT <= 0) {
      w.skillQT = SKILL.grenadeCooldown;
      shot.grenade = true;
    }
    if (input.skillE && w.skillET <= 0) {
      w.skillET = SKILL.barrierCooldown;
      shot.barrier = true;
    }
  } else if (hero === HERO_ASSASSIN) {
    // The dash button is the dash cut, on the ground or in the air; E is the rolling dive,
    // in the air only. (Q is the grapple, which is movement: see movement.ts.) Their cooldowns
    // are skillQT and skillET. In overdrive the only wait is for the move itself to finish.
    if (input.overdrive) {
      w.skillQT = Math.min(w.skillQT, SKILL.slashSpin);
      w.skillET = Math.min(w.skillET, SKILL.rollTime);
    }
    // The dash cut has a wind-up: the press draws the blades and cuts the X, then it dashes.
    if (w.slashT > 0) {
      w.slashT -= dt;
      if (w.slashT <= 0) {
        w.slashT = 0;
        shot.slash = true;
      }
    } else if (input.dash && w.skillQT <= 0) {
      w.skillQT = input.overdrive ? SKILL.slashSpin : SKILL.slashCooldown;
      w.slashT = SKILL.slashWindup;
      shot.slashStarted = true;
    }
    // The rolling dive has a wind-up too: the press (in the air) draws the blades, then it dives.
    // Landing before the wind-up is over calls it off, and the skill is ready again.
    if (w.diveT > 0) {
      w.diveT -= dt;
      if (ctx.onGround) {
        w.diveT = 0;
        w.skillET = 0;
      } else if (w.diveT <= 0) {
        w.diveT = 0;
        shot.roll = true;
      }
    } else if (input.skillE && w.skillET <= 0 && !ctx.onGround) {
      w.skillET = input.overdrive ? SKILL.rollTime : SKILL.rollCooldown;
      w.diveT = SKILL.rollWindup;
      shot.rollStarted = true;
    }
  }

  // Switch weapon: 1 and 2 are the hero's two guns, 3 the hands. The old gun is put away (a
  // reload is lost) and the new one is ready after the draw. Each gun keeps its own rounds.
  // In overdrive the Assassin has the blades and the spears, not the sniper: a sniper in hand is
  // put away for the blades, and its slot does nothing.
  const od = hero === HERO_ASSASSIN && input.overdrive === true;
  const barred = (slot: number) =>
    od && slot !== EMPTY_HANDS && WEAPON_DEFS[loadout(hero)[slot] ?? 0]?.spear !== true;
  let want = input.slot - 1;
  if (barred(w.slot)) want = EMPTY_HANDS;
  else if (want >= 0 && want < EMPTY_HANDS && barred(want)) want = -1;
  if (want >= 0 && want <= EMPTY_HANDS && want !== w.slot) {
    const gun = want === EMPTY_HANDS ? w.gun : (loadout(hero)[want] ?? w.gun);
    if (gun !== w.gun) {
      const held = w.ammo;
      w.ammo = w.stash;
      w.stash = held;
      w.gun = gun;
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
  // (In overdrive only the spears fire, and they reload faster.)
  const ready = def !== null && w.switchT <= 0 && !(od && !def.spear);
  const reloadTime = (def?.reloadTime ?? 0) * (od ? SKILL.overdriveReload : 1);

  // Reload
  if (w.reloadT > 0) {
    w.reloadT -= dt;
    if (w.reloadT <= 0) {
      w.reloadT = 0;
      w.ammo = def?.magSize ?? w.ammo;
      shot.reloadFinished = true;
    }
  } else if (input.reload && ready && w.ammo < def.magSize) {
    w.reloadT = reloadTime;
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
      w.reloadT = reloadTime;
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
