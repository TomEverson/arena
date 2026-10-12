import type { PlayerState } from "./net/protocol.gen";

/**
 * Sound, all synthesised with the Web Audio API (no sound files): short bursts of noise and
 * oscillators shaped by filters and volume envelopes. Tune the numbers in the `sound` functions.
 *
 * Browsers keep audio silent until the player interacts with the page, so the context is made
 * on the first click or key press (`unlock`). Press M to mute.
 */

/** Metres of walking per footstep. */
export const STRIDE = 2.3;
/** Metres at which a spatial sound is half as loud as at 1 m (see PannerNode.refDistance). */
const REF_DISTANCE = 4;
const MAX_DISTANCE = 60;

/** Something a body did that makes a sound. */
export type MoveSound =
  "step" | "jump" | "airJump" | "land" | "dash" | "slide" | "wallRun" | "wallJump";

/** Seconds between scrape sounds while running along a wall. */
const WALL_SCRAPE_EVERY = 0.4;

/**
 * Turns a stream of player states (one per frame) into movement sounds: footsteps every STRIDE
 * metres on the ground, jump, double jump, landing, dash and slide start. Pure, so it is tested.
 */
export class MoveSoundTracker {
  private prev: PlayerState | null = null;
  private walked = 0;
  private airTime = 0;
  private fallSpeed = 0;
  private scrapeIn = 0;
  /** How hard the last landing was (0..1), for the volume of the thump. */
  landStrength = 0;

  update(s: PlayerState, dt: number, out: MoveSound[]): void {
    const p = this.prev;
    this.prev = s;
    if (!p) return;
    const grounded = s.onGround && !s.sliding && !s.climbing && !s.mantling;

    if (p.onGround && !s.onGround && s.vy > 0 && !s.climbing && !s.mantling) out.push("jump");
    else if (s.airJumps < p.airJumps && !s.onGround) out.push("airJump");
    if (p.dashTime <= 0 && s.dashTime > 0) out.push("dash");
    if (!p.sliding && s.sliding) out.push("slide");
    if (s.wallJumps > p.wallJumps) out.push("wallJump");
    if (s.wallRunning) {
      this.scrapeIn -= dt;
      if (!p.wallRunning || this.scrapeIn <= 0) {
        out.push("wallRun");
        this.scrapeIn = WALL_SCRAPE_EVERY;
      }
    }

    if (s.onGround) {
      if (this.airTime > 0.2) {
        this.landStrength = Math.min(1, Math.max(0.25, -this.fallSpeed / 14));
        out.push("land");
      }
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.airTime += dt;
      this.fallSpeed = Math.min(this.fallSpeed, s.vy);
    }

    // Footsteps follow distance walked, so they speed up with the player.
    if (grounded && dt > 0) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < 3) this.walked += d; // a bigger jump is a teleport (respawn), not walking
      if (this.walked >= STRIDE) {
        this.walked -= STRIDE;
        out.push("step");
      }
    } else {
      this.walked = Math.min(this.walked, STRIDE / 2);
    }
  }
}

/** Footsteps for someone else, from their position alone (poses carry no on-ground flag). */
export class StepCounter {
  private last: { x: number; y: number; z: number } | null = null;
  private walked = 0;

  /** True when this move completes a footstep. */
  update(x: number, y: number, z: number): boolean {
    const l = this.last;
    this.last = { x, y, z };
    if (!l) return false;
    const d = Math.hypot(x - l.x, z - l.z);
    const grounded = Math.abs(y - l.y) < 0.02;
    if (!grounded || d > 3) return false;
    this.walked += d;
    if (this.walked < STRIDE) return false;
    this.walked -= STRIDE;
    return true;
  }
}

type Out = AudioNode;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  private readonly spatialVoices: number[] = [];

  /** Create (or resume) the audio context. Call from a click or key press. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.5;
      const limiter = ctx.createDynamicsCompressor(); // a pile of shots must not clip
      master.connect(limiter).connect(ctx.destination);
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Where the listener (the camera) is and which way it faces. Call once per frame. */
  setListener(x: number, y: number, z: number, yaw: number, pitch: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    // Forward is -Z rotated by yaw (the camera looks down -Z at yaw 0).
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(x, t);
      l.positionY.setValueAtTime(y, t);
      l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    }
  }

  // --- Building blocks ------------------------------------------------------

  /** A place to play a sound: straight to the speakers, or positioned in the world. */
  private dest(at?: { x: number; y: number; z: number }): Out | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    if (!at) return this.master;
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = REF_DISTANCE;
    panner.maxDistance = MAX_DISTANCE;
    panner.rolloffFactor = 1.4;
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
    panner.connect(this.master);
    return panner;
  }

  /** An oscillator that glides from `f0` to `f1`, fading out over `dur` seconds. */
  private tone(
    out: Out,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of noise through a filter that sweeps from `f0` to `f1`. */
  private hiss(
    out: Out,
    filter: BiquadFilterType,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
    delay = 0,
    q = 1,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4; // never the exact same noise twice
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** Too many positioned sounds at once get muddy and cost CPU: drop the extras. */
  private room(): boolean {
    const now = this.ctx?.currentTime ?? 0;
    while (this.spatialVoices.length > 0 && (this.spatialVoices[0] ?? 0) < now) {
      this.spatialVoices.shift();
    }
    if (this.spatialVoices.length >= 12) return false;
    this.spatialVoices.push(now + 0.3);
    return true;
  }

  // --- The sounds -----------------------------------------------------------

  /** Your own rifle shot. */
  shot(): void {
    const o = this.dest();
    if (!o) return;
    this.hiss(o, "bandpass", 3200, 500, 0.09, 0.55, 0, 0.8); // the crack
    this.tone(o, "sine", 170, 45, 0.12, 0.6); // the thump
    this.hiss(o, "lowpass", 900, 150, 0.2, 0.22, 0.01); // the tail
  }

  /** Someone else's rifle shot, placed where it was fired (quieter and duller with distance). */
  shotAt(at: { x: number; y: number; z: number }): void {
    if (!this.room()) return;
    const o = this.dest(at);
    if (!o) return;
    this.hiss(o, "bandpass", 2800, 450, 0.09, 0.9, 0, 0.8);
    this.tone(o, "sine", 160, 45, 0.12, 1.0);
    this.hiss(o, "lowpass", 800, 140, 0.2, 0.35, 0.01);
  }

  /** The swing of a melee strike: a short rush of air. */
  swing(): void {
    const o = this.dest();
    if (!o) return;
    this.hiss(o, "bandpass", 500, 2600, 0.18, 0.4, 0, 1.4);
    this.tone(o, "sawtooth", 140, 70, 0.14, 0.08);
  }

  /** A melee blow landing: a thud, and a higher crack when it kills. */
  meleeHit(killed: boolean): void {
    const o = this.dest();
    if (!o) return;
    this.tone(o, "sine", 150, 45, 0.16, 0.8);
    this.hiss(o, "lowpass", 1800, 200, 0.12, 0.5);
    if (killed) this.tone(o, "triangle", 880, 880, 0.2, 0.3, 0.05);
  }

  dryFire(): void {
    const o = this.dest();
    if (!o) return;
    this.tone(o, "square", 1400, 900, 0.025, 0.18);
  }

  reloadStart(): void {
    const o = this.dest();
    if (!o) return;
    this.hiss(o, "bandpass", 2400, 1800, 0.03, 0.4, 0, 3);
    this.tone(o, "square", 500, 300, 0.05, 0.12, 0.01);
  }

  reloadDone(): void {
    const o = this.dest();
    if (!o) return;
    this.hiss(o, "bandpass", 1800, 900, 0.04, 0.5, 0, 3);
    this.tone(o, "square", 260, 140, 0.07, 0.2);
    this.hiss(o, "bandpass", 2600, 2000, 0.025, 0.4, 0.09, 3);
  }

  /** You hit someone: a tick (higher for a headshot), and a two-note ding for a kill. */
  hit(headshot: boolean, killed: boolean): void {
    const o = this.dest();
    if (!o) return;
    if (killed) {
      this.tone(o, "triangle", 880, 880, 0.12, 0.4);
      this.tone(o, "triangle", 1320, 1320, 0.22, 0.4, 0.07);
    } else if (headshot) {
      this.tone(o, "triangle", 1900, 1500, 0.1, 0.45);
      this.tone(o, "sine", 2800, 2400, 0.07, 0.2);
    } else {
      this.tone(o, "triangle", 1100, 800, 0.06, 0.35);
    }
  }

  /** You were shot. */
  hurt(damage: number): void {
    const o = this.dest();
    if (!o) return;
    const size = Math.min(1, 0.4 + damage / 60);
    this.tone(o, "sine", 130, 60, 0.18, 0.7 * size);
    this.hiss(o, "lowpass", 1400, 300, 0.12, 0.35 * size);
  }

  /** You died. */
  death(): void {
    const o = this.dest();
    if (!o) return;
    this.tone(o, "sawtooth", 330, 60, 0.7, 0.3);
    this.tone(o, "sine", 110, 30, 0.8, 0.6);
    this.hiss(o, "lowpass", 1200, 100, 0.6, 0.3);
  }

  /** Movement sounds. `at` places someone else's; leave it out for your own. */
  move(sound: MoveSound, strength = 1, at?: { x: number; y: number; z: number }): void {
    if (at && !this.room()) return;
    const o = this.dest(at);
    if (!o) return;
    const v = at ? 1.3 : 1; // other people are further away: lift them a little
    switch (sound) {
      case "step":
        this.hiss(o, "lowpass", 700 + Math.random() * 300, 160, 0.07, 0.3 * v);
        this.tone(o, "sine", 90, 55, 0.06, 0.18 * v);
        break;
      case "jump":
        this.hiss(o, "bandpass", 500, 1400, 0.12, 0.22 * v, 0, 1.5);
        this.tone(o, "sine", 150, 260, 0.08, 0.15 * v);
        break;
      case "airJump":
        this.hiss(o, "bandpass", 900, 2400, 0.14, 0.28 * v, 0, 2);
        this.tone(o, "sine", 300, 620, 0.1, 0.18 * v);
        break;
      case "land":
        this.tone(o, "sine", 120, 40, 0.14, 0.6 * strength * v);
        this.hiss(o, "lowpass", 900, 120, 0.12, 0.4 * strength * v);
        break;
      case "dash":
        this.hiss(o, "highpass", 600, 4500, 0.22, 0.4 * v, 0, 0.7);
        this.tone(o, "sawtooth", 220, 110, 0.18, 0.1 * v);
        break;
      case "wallRun":
        this.hiss(o, "bandpass", 1500, 900, 0.5, 0.22 * v, 0, 1.2);
        this.hiss(o, "lowpass", 500, 250, 0.3, 0.12 * v);
        break;
      case "wallJump":
        this.hiss(o, "highpass", 800, 3500, 0.15, 0.35 * v, 0, 0.8);
        this.tone(o, "sine", 210, 80, 0.12, 0.45 * v);
        this.tone(o, "triangle", 300, 520, 0.1, 0.12 * v);
        break;
      case "slide":
        this.hiss(o, "bandpass", 1800, 700, 0.45, 0.25 * v, 0, 0.9);
        break;
    }
  }
}
