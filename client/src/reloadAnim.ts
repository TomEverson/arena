/**
 * First-person reload animation as keyframe timelines (visual only).
 * Time is reload progress: 0 = reload just started, 1 = finished (WEAPON.reloadTime seconds).
 * Each track is a list of [time, value] keys; between keys the value glides smoothly.
 * Tweak the numbers to change the feel; keep the times of each track in increasing order.
 *
 * The story: tilt the gun, left hand grabs the magazine and pulls it down off screen,
 * brings a new one up, slots it in with a jolt, gun returns to the ready position.
 */

type Track = readonly (readonly [time: number, value: number])[];

const TRACKS = {
  /** Gun roll in radians (positive tips the top of the gun toward the screen centre). */
  roll: [
    [0, 0],
    [0.15, 0.45],
    [0.72, 0.45],
    [0.9, 0],
  ],
  /** Gun pitch in radians (positive raises the muzzle). The bump at 0.76 is the "slap" jolt. */
  pitch: [
    [0, 0],
    [0.15, 0.18],
    [0.72, 0.18],
    [0.76, 0.3],
    [0.9, 0],
  ],
  /** Gun drop in metres (negative lowers it). */
  drop: [
    [0, 0],
    [0.15, -0.03],
    [0.72, -0.03],
    [0.9, 0],
  ],
  /** Magazine offset below its slot in metres: pulled out, off screen, back up, seated. */
  mag: [
    [0, 0],
    [0.15, 0],
    [0.3, -0.35],
    [0.5, -0.35],
    [0.68, -0.06],
    [0.74, 0],
  ],
  /** Left hand: 0 = on the handguard, 1 = holding the magazine (follows it down and up). */
  hand: [
    [0, 0],
    [0.15, 1],
    [0.78, 1],
    [0.95, 0],
  ],
} as const satisfies Record<string, Track>;

function sample(track: Track, t: number): number {
  const first = track[0];
  if (!first || t <= first[0]) return first ? first[1] : 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1] as readonly [number, number];
    const b = track[i] as readonly [number, number];
    if (t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0]);
      const smooth = k * k * (3 - 2 * k); // ease in and out
      return a[1] + (b[1] - a[1]) * smooth;
    }
  }
  return (track[track.length - 1] as readonly [number, number])[1];
}

export interface ReloadPose {
  roll: number;
  pitch: number;
  drop: number;
  mag: number;
  hand: number;
}

/** Fill `out` with the pose at reload progress `t` (0..1). Not reloading = all zeros. */
export function reloadPose(t: number, out: ReloadPose): ReloadPose {
  out.roll = sample(TRACKS.roll, t);
  out.pitch = sample(TRACKS.pitch, t);
  out.drop = sample(TRACKS.drop, t);
  out.mag = sample(TRACKS.mag, t);
  out.hand = sample(TRACKS.hand, t);
  return out;
}
