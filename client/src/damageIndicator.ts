/**
 * The damage direction indicator: when you are hurt, a HAZARD arc appears round the middle of the
 * screen on the side the damage came from, and fades. It marks the spot the attacker stood on
 * when they hit you, and keeps pointing at that spot as you turn. One arc per attacker; a new hit
 * from them refreshes it.
 */

/** How long an arc stays after the last hit from that attacker, and how much of that is the fade. */
const SHOW_MS = 1600;
const FADE_MS = 500;
/** Never more arcs than this at once (the oldest goes). */
const MAX_ARCS = 6;

/**
 * Where a point is, seen from a player: radians clockwise from straight ahead (0 in front,
 * +π/2 to the right, ±π behind, -π/2 to the left). Yaw 0 faces -Z and positive yaw turns left,
 * as everywhere else.
 */
export function bearing(px: number, pz: number, yaw: number, sx: number, sz: number): number {
  const dx = sx - px;
  const dz = sz - pz;
  const ahead = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
  const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  return Math.atan2(right, ahead);
}

interface Arc {
  el: HTMLElement;
  x: number;
  z: number;
  expiresAt: number;
}

export class DamageIndicators {
  private readonly layer = document.getElementById("dmgdir") as HTMLDivElement;
  private readonly arcs = new Map<number, Arc>();

  /** You were hurt by `attackerId`, who is at (x, z). */
  hit(attackerId: number, x: number, z: number, nowMs: number): void {
    let arc = this.arcs.get(attackerId);
    if (!arc) {
      if (this.arcs.size >= MAX_ARCS) {
        const [oldest] = [...this.arcs].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        if (oldest) this.drop(oldest[0]);
      }
      arc = { el: document.createElement("i"), x, z, expiresAt: 0 };
      this.layer.append(arc.el);
      this.arcs.set(attackerId, arc);
    }
    arc.x = x;
    arc.z = z;
    arc.expiresAt = nowMs + SHOW_MS;
  }

  /** Per frame, with where you are and which way you face. */
  update(nowMs: number, px: number, pz: number, yaw: number): void {
    for (const [id, arc] of this.arcs) {
      const left = arc.expiresAt - nowMs;
      if (left <= 0) {
        this.drop(id);
        continue;
      }
      arc.el.style.transform = `rotate(${bearing(px, pz, yaw, arc.x, arc.z).toFixed(3)}rad)`;
      arc.el.style.opacity = String(Math.min(1, left / FADE_MS));
    }
  }

  /** Remove every arc (you died, or left the room). */
  clear(): void {
    for (const id of [...this.arcs.keys()]) this.drop(id);
  }

  private drop(id: number): void {
    this.arcs.get(id)?.el.remove();
    this.arcs.delete(id);
  }
}
