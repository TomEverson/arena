import type { Entity } from "./protocol.gen";

/** Remote players are drawn this many server ticks in the past (6 = 100 ms, three snapshots). */
export const INTERP_TICKS = 6;
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

  push(tick: number, entities: readonly Entity[]): void {
    this.latestTick = Math.max(this.latestTick, tick);
    for (const e of entities) {
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
      if (last && this.latestTick - last.tick > FORGET_TICKS) this.tracks.delete(id);
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
    };
  }
}
