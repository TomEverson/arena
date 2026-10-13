import type { Entity } from "./protocol.gen";

/** Remote players are drawn this many server ticks in the past (6 = 100 ms, three snapshots). */
export const INTERP_TICKS = 6;
/** Increase the remote buffer when jitter threatens to outrun the normal 100 ms cushion. */
export function interpolationTicks(jitterMs: number): number {
  return Math.min(10, INTERP_TICKS + Math.max(0, Math.ceil((jitterMs - 8) / 12)));
}
/** An entity missing from snapshots for this long is gone. */
const FORGET_TICKS = 30;
const MAX_SAMPLES = 32;

export interface Pose {
  id: number;
  teamId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  /** An EntityKinds value: a player or a practice-range target. */
  kind: number;
  /** A HeroKinds value: which character a player is. */
  hero: number;
}

interface Sample {
  tick: number;
  e: Entity;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-arc interpolation of an angle in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Remembers recent snapshots of every remote entity and answers "where were they at tick T?". */
export class RemoteTracks {
  private readonly tracks = new Map<number, Sample[]>();
  private latestTick = 0;

  push(
    tick: number,
    entities: readonly Entity[],
    removed: readonly number[] = [],
    full = true,
  ): void {
    this.latestTick = Math.max(this.latestTick, tick);
    const changed = new Set<number>();
    if (full) {
      const present = new Set(entities.map((e) => e.id));
      for (const id of this.tracks.keys()) if (!present.has(id)) this.tracks.delete(id);
    } else {
      for (const id of removed) this.tracks.delete(id);
    }
    for (const e of entities) {
      changed.add(e.id);
      let samples = this.tracks.get(e.id);
      if (!samples) {
        samples = [];
        this.tracks.set(e.id, samples);
      }
      const last = samples[samples.length - 1];
      if (last && tick <= last.tick) continue; // duplicate or out of order
      samples.push({ tick, e });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
    for (const [id, samples] of this.tracks) {
      const last = samples[samples.length - 1];
      // Delta snapshots omit unchanged entities. Repeating the last state at the new tick keeps
      // interpolation moving smoothly until the next changed sample arrives.
      if (!changed.has(id) && last && last.tick < tick) {
        samples.push({ tick, e: last.e });
        if (samples.length > MAX_SAMPLES) samples.shift();
      }
      const current = samples[samples.length - 1];
      if (current && this.latestTick - current.tick > FORGET_TICKS) this.tracks.delete(id);
    }
  }

  /** Ids currently worth drawing. */
  ids(): number[] {
    return [...this.tracks.keys()];
  }

  /** Interpolated pose at `renderTick` (fractional). Holds the nearest sample outside the known range. */
  sample(id: number, renderTick: number): Pose | null {
    const samples = this.tracks.get(id);
    const first = samples?.[0];
    if (!samples || !first) return null;
    const lastSample = samples[samples.length - 1] as Sample;

    if (renderTick <= first.tick) return { ...first.e };
    if (renderTick >= lastSample.tick) return { ...lastSample.e };

    let i = samples.length - 2;
    while (i > 0 && (samples[i] as Sample).tick > renderTick) i--;
    const a = samples[i] as Sample;
    const b = samples[i + 1] as Sample;
    const t = (renderTick - a.tick) / (b.tick - a.tick);
    return {
      id,
      teamId: a.e.teamId,
      x: lerp(a.e.x, b.e.x, t),
      y: lerp(a.e.y, b.e.y, t),
      z: lerp(a.e.z, b.e.z, t),
      yaw: lerpAngle(a.e.yaw, b.e.yaw, t),
      pitch: lerp(a.e.pitch, b.e.pitch, t),
      flags: a.e.flags,
      kind: a.e.kind,
      hero: a.e.hero,
    };
  }
}
