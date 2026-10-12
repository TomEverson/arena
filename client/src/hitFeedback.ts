import { DamageTally } from "./damageTally";
import { WEAPON } from "./sim/params";

/** How long a target's marker stays after the last hit on them. */
const SHOW_MS = 2000;
const FADE_MS = 400;

export interface HitInfo {
  /** Who was hit (each target has its own marker and running total). */
  targetId: number;
  /** The target's health and shield AFTER this hit. */
  health: number;
  shield: number;
  damage: number;
  headshot: boolean;
  killed: boolean;
}

/** Where to draw a target's marker: the point on screen above their head (CSS pixels), or null if off screen. */
export type Anchor = (targetId: number) => { x: number; y: number } | null;

interface Marker {
  el: HTMLDivElement;
  number: HTMLDivElement;
  shield: HTMLElement;
  health: HTMLElement;
  expiresAt: number;
}

/**
 * What you see when you hit someone: a small health bar floating above their head, and one damage
 * number that counts up as you keep hitting (9, 18, 27...), popping on every hit. It follows the
 * target and fades a moment after you stop.
 */
export class HitFeedback {
  private readonly layer = document.getElementById("hitlayer") as HTMLDivElement;
  private readonly tally = new DamageTally();
  private readonly markers = new Map<number, Marker>();

  onHit(h: HitInfo, nowMs: number): void {
    const total = this.tally.add(h.targetId, h.damage, nowMs);
    const m = this.markers.get(h.targetId) ?? this.create(h.targetId);
    m.expiresAt = nowMs + SHOW_MS;
    m.el.style.opacity = "1";

    m.number.textContent = String(Math.round(total));
    m.number.className = `num${h.killed ? " kill" : h.headshot ? " head" : ""}`;
    void m.number.offsetWidth; // restart the pop animation on every hit
    m.number.classList.add("pop");

    const pct = (v: number, max: number) =>
      `${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(0)}%`;
    m.shield.style.width = pct(h.shield, WEAPON.maxShield);
    m.health.style.width = pct(h.health, WEAPON.maxHealth);
  }

  /** Per frame: move each marker to follow its target, and fade out the ones that have timed out. */
  update(nowMs: number, anchor: Anchor): void {
    for (const [id, m] of this.markers) {
      const left = m.expiresAt - nowMs;
      if (left <= 0) {
        m.el.remove();
        this.markers.delete(id);
        this.tally.forget(id);
        continue;
      }
      const at = anchor(id);
      m.el.style.display = at ? "block" : "none";
      if (at) {
        m.el.style.left = `${at.x}px`;
        m.el.style.top = `${at.y}px`;
      }
      if (left < FADE_MS) m.el.style.opacity = String(left / FADE_MS);
    }
  }

  private create(id: number): Marker {
    const el = document.createElement("div");
    el.className = "tmark";
    el.innerHTML =
      `<div class="num"></div>` +
      `<div class="bar shield"><i></i></div>` +
      `<div class="bar health"><i></i></div>`;
    this.layer.append(el);
    const m: Marker = {
      el,
      number: el.querySelector(".num") as HTMLDivElement,
      shield: el.querySelector(".shield i") as HTMLElement,
      health: el.querySelector(".health i") as HTMLElement,
      expiresAt: 0,
    };
    this.markers.set(id, m);
    return m;
  }
}
