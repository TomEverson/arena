/**
 * Client-side prediction and server reconciliation. Pure: no sockets, no clock, no DOM.
 *
 * Every sim tick the client runs `step`, which simulates the player immediately
 * (the same stepPlayer and weapon code as the server) and records the input and
 * resulting state under a sequence number. The server is input-driven, so its snapshot
 * says "your state right after input N". `reconcile` compares that with our
 * prediction for N; on a mismatch it adopts the server state and replays the
 * inputs the server has not simulated yet.
 */
import { hSpeed, slashLunge, startRoll, stepPlayer } from "../sim/movement";
import type { CollisionWorld, PlayerInput, PlayerState } from "../sim/types";
import {
  movementMods,
  type ShotResult,
  spawnWeapon,
  stepWeapon,
  type WeaponContext,
} from "../sim/weapon";
import type { Input, WeaponState } from "./protocol.gen";

/** Numbers closer than this count as equal. Go and JS agree to about 1e-12, so this is generous. */
export const MATCH_EPSILON = 1e-4;
/** Inputs kept while waiting for acks (about 4 s at 60 Hz). */
export const MAX_HISTORY = 256;
/** Inputs resent in every message so a lost message loses nothing. */
export const REDUNDANCY = 3;

export interface Correction {
  /** The ack the correction was made at. */
  ackSeq: number;
  /** How far the predicted position moved (metres). */
  error: number;
  /** Predicted position before and after, so the view can blend. */
  before: { x: number; y: number; z: number };
  after: { x: number; y: number; z: number };
}

interface Entry {
  seq: number;
  input: Input;
  after: PlayerState;
  weaponAfter: WeaponState;
}

function weaponContext(s: PlayerState): WeaponContext {
  return {
    hSpeed: hSpeed(s),
    onGround: s.onGround,
    crouching: s.crouching,
    sliding: s.sliding,
    grappling: s.grappling,
  };
}

export function statesMatch(a: PlayerState, b: PlayerState, epsilon = MATCH_EPSILON): boolean {
  const x = a as unknown as Record<string, number | boolean>;
  const y = b as unknown as Record<string, number | boolean>;
  for (const key of Object.keys(x)) {
    const av = x[key];
    const bv = y[key];
    if (typeof av === "number" && typeof bv === "number") {
      if (!(Math.abs(av - bv) <= epsilon)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

export class Predictor {
  /** The predicted current state (after the latest input). */
  state: PlayerState;
  /** The predicted weapon (ammo, reload, recoil pattern, spread generator). */
  weapon: WeaponState;
  /** False while dead: inputs are still numbered and sent, but nothing is simulated. */
  alive = true;
  /** What the weapon did on the latest `step` (a shot, a reload, a switch), or null. For effects only. */
  lastShot: ShotResult | null = null;
  /** Corrections applied so far, and the largest one. */
  corrections = 0;
  maxError = 0;

  private nextSeq: number;
  private base: { seq: number; state: PlayerState; weapon: WeaponState };
  private history: Entry[] = [];

  /**
   * @param initial the server's state at `initialAck` (from the first snapshot)
   * @param weapon the server's weapon state at `initialAck`
   */
  constructor(
    private readonly world: CollisionWorld,
    initial: PlayerState,
    initialAck = 0,
    private readonly dt = 1 / 60,
    weapon: WeaponState = spawnWeapon(1),
  ) {
    this.state = initial;
    this.weapon = weapon;
    this.base = { seq: initialAck, state: initial, weapon };
    this.nextSeq = initialAck + 1;
  }

  /** Inputs simulated but not yet acknowledged. */
  get pending(): number {
    return this.history.length;
  }

  /** Simulate one tick now. Returns the sequenced input to send. */
  step(input: PlayerInput, pitch = 0, viewTick = 0): Input {
    // The weapon in hand sets run speed and aim-down-sights slowdown: put them on the input.
    const moving: PlayerInput = { ...input, pitch, ...movementMods(this.weapon) };
    const full: Input = { ...moving, seq: this.nextSeq++, viewTick };
    this.lastShot = null;
    if (this.alive) {
      this.state = stepPlayer(this.state, moving, this.world, this.dt);
      const r = stepWeapon(this.weapon, moving, weaponContext(this.state), this.dt);
      this.weapon = r.state;
      if (r.shot.slash) slashLunge(this.state, moving.yaw);
      if (r.shot.roll) startRoll(this.state, moving.yaw, moving.pitch);
      const s = r.shot;
      if (
        s.fired ||
        s.reloadStarted ||
        s.reloadFinished ||
        s.dryFire ||
        s.meleeStarted ||
        s.meleeStrike ||
        s.switched ||
        s.grenade ||
        s.barrier ||
        s.slash ||
        s.roll
      )
        this.lastShot = s;
    }
    this.history.push({ seq: full.seq, input: full, after: this.state, weaponAfter: this.weapon });
    if (this.history.length > MAX_HISTORY) {
      const dropped = this.history.shift() as Entry;
      this.base = { seq: dropped.seq, state: dropped.after, weapon: dropped.weaponAfter };
    }
    return full;
  }

  /** The newest `n` inputs, oldest first, for a redundant send. */
  recent(n = REDUNDANCY): Input[] {
    return this.history.slice(-n).map((e) => e.input);
  }

  /**
   * Apply an authoritative snapshot: the server's state right after input `ackSeq`.
   * Returns the correction if our prediction was wrong, otherwise null.
   * `serverWeapon` and `alive` are optional so movement-only callers keep working.
   */
  reconcile(
    ackSeq: number,
    server: PlayerState,
    serverWeapon?: WeaponState,
    alive: boolean = this.alive,
  ): Correction | null {
    if (ackSeq < this.base.seq) return null; // out of order / stale

    let predicted: PlayerState | undefined;
    let predictedWeapon: WeaponState | undefined;
    if (ackSeq === this.base.seq) {
      predicted = this.base.state;
      predictedWeapon = this.base.weapon;
    } else {
      const e = this.history.find((h) => h.seq === ackSeq);
      predicted = e?.after;
      predictedWeapon = e?.weaponAfter;
    }

    // Forget everything the server has now simulated.
    this.history = this.history.filter((e) => e.seq > ackSeq);
    const weaponAtAck = serverWeapon ?? predictedWeapon ?? this.weapon;
    this.base = { seq: ackSeq, state: server, weapon: weaponAtAck };

    const lifeChanged = alive !== this.alive;
    const weaponMatches =
      !serverWeapon ||
      (predictedWeapon !== undefined && weaponsMatch(predictedWeapon, serverWeapon));
    if (!lifeChanged && predicted && weaponMatches && statesMatch(predicted, server)) return null;

    // Mismatch (or an ack we cannot compare): trust the server, replay what it has not seen.
    this.alive = alive;
    const before = { x: this.state.x, y: this.state.y, z: this.state.z };
    let s = server;
    let w = weaponAtAck;
    for (const e of this.history) {
      if (alive) {
        const inp = { ...e.input, ...movementMods(w) }; // from the weapon as replayed, like the server
        s = stepPlayer(s, inp, this.world, this.dt);
        const r = stepWeapon(w, inp, weaponContext(s), this.dt);
        w = r.state;
        if (r.shot.slash) slashLunge(s, inp.yaw);
        if (r.shot.roll) startRoll(s, inp.yaw, inp.pitch);
      }
      e.after = s;
      e.weaponAfter = w;
    }
    this.state = s;
    this.weapon = w;
    const after = { x: s.x, y: s.y, z: s.z };
    const error = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    this.corrections++;
    this.maxError = Math.max(this.maxError, error);
    return { ackSeq, error, before, after };
  }
}

/** Weapon states match when every field agrees (the generator state is an exact integer). */
export function weaponsMatch(a: WeaponState, b: WeaponState, epsilon = MATCH_EPSILON): boolean {
  return (
    a.ammo === b.ammo &&
    a.burst === b.burst &&
    a.rng === b.rng &&
    Math.abs(a.reloadT - b.reloadT) <= epsilon &&
    Math.abs(a.cooldown - b.cooldown) <= epsilon &&
    Math.abs(a.sinceShot - b.sinceShot) <= epsilon
  );
}
