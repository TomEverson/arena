/**
 * Client-side prediction and server reconciliation. Pure: no sockets, no clock, no DOM.
 *
 * Every sim tick the client runs `step`, which simulates the player immediately
 * (using the same stepPlayer as the server) and records the input and resulting
 * state under a sequence number. The server is input-driven, so its snapshot
 * says "your state right after input N". `reconcile` compares that with our
 * prediction for N; on a mismatch it adopts the server state and replays the
 * inputs the server has not simulated yet.
 */
import { stepPlayer } from "../sim/movement";
import type { CollisionWorld, PlayerInput, PlayerState } from "../sim/types";
import type { Input } from "./protocol.gen";

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
  /** Corrections applied so far, and the largest one. */
  corrections = 0;
  maxError = 0;

  private nextSeq: number;
  private base: { seq: number; state: PlayerState };
  private history: Entry[] = [];

  /**
   * @param initial the server's state at `initialAck` (from the first snapshot)
   */
  constructor(
    private readonly world: CollisionWorld,
    initial: PlayerState,
    initialAck = 0,
    private readonly dt = 1 / 60,
  ) {
    this.state = initial;
    this.base = { seq: initialAck, state: initial };
    this.nextSeq = initialAck + 1;
  }

  /** Inputs simulated but not yet acknowledged. */
  get pending(): number {
    return this.history.length;
  }

  /** Simulate one tick now. Returns the sequenced input to send. */
  step(input: PlayerInput, pitch = 0): Input {
    const full: Input = { ...input, seq: this.nextSeq++, pitch };
    this.state = stepPlayer(this.state, input, this.world, this.dt);
    this.history.push({ seq: full.seq, input: full, after: this.state });
    if (this.history.length > MAX_HISTORY) {
      const dropped = this.history.shift() as Entry;
      this.base = { seq: dropped.seq, state: dropped.after };
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
   */
  reconcile(ackSeq: number, server: PlayerState): Correction | null {
    if (ackSeq < this.base.seq) return null; // out of order / stale

    let predicted: PlayerState | undefined;
    if (ackSeq === this.base.seq) predicted = this.base.state;
    else predicted = this.history.find((e) => e.seq === ackSeq)?.after;

    // Forget everything the server has now simulated.
    this.history = this.history.filter((e) => e.seq > ackSeq);
    this.base = { seq: ackSeq, state: server };
    if (predicted && statesMatch(predicted, server)) return null;

    // Mismatch (or an ack we cannot compare): trust the server, replay what it has not seen.
    const before = { x: this.state.x, y: this.state.y, z: this.state.z };
    let s = server;
    for (const e of this.history) {
      s = stepPlayer(s, e.input, this.world, this.dt);
      e.after = s;
    }
    this.state = s;
    const after = { x: s.x, y: s.y, z: s.z };
    const error = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    this.corrections++;
    this.maxError = Math.max(this.maxError, error);
    return { ackSeq, error, before, after };
  }
}
