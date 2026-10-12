import type { HitKind } from "./fx";
import { playerName } from "./matchui";
import { EventKinds, type GameEvent, GameEventFlags, type PlayerHealth } from "./net/protocol.gen";
import { WEAPON } from "./sim/params";

const KILLFEED_SECONDS = 6;
const MAX_FEED = 5;

/** Combat UI: health and shield, spawn protection, the death screen, the hurt flash and the kill feed. */
export class CombatHud {
  private readonly vitals = document.getElementById("vitals") as HTMLDivElement;
  private readonly hurt = document.getElementById("hurt") as HTMLDivElement;
  private readonly death = document.getElementById("death") as HTMLDivElement;
  private readonly feed = document.getElementById("killfeed") as HTMLDivElement;
  private myId = -1;

  constructor(
    private readonly onHitMarker: (kind: HitKind) => void,
    private readonly onHitDetail: (e: GameEvent) => void,
  ) {}

  setPlayerId(id: number): void {
    this.myId = id;
  }

  /** React to one server event: hit markers, the hurt flash, kill feed lines. */
  onEvent(e: GameEvent): void {
    switch (e.kind) {
      case EventKinds.hit: {
        const killed = (e.flags & GameEventFlags.killed) !== 0;
        const head = (e.flags & GameEventFlags.headshot) !== 0;
        this.onHitMarker(killed ? "kill" : head ? "head" : "body");
        this.onHitDetail(e);
        break;
      }
      case EventKinds.hurt:
        this.hurt.classList.remove("on");
        void this.hurt.offsetWidth; // restart the CSS animation
        this.hurt.classList.add("on");
        break;
      case EventKinds.kill:
        this.addKill(e);
        break;
    }
  }

  private addKill(e: GameEvent): void {
    const line = document.createElement("div");
    line.textContent = `${playerName(e.actor, this.myId)}  ▸  ${playerName(e.other, this.myId)}`;
    if ((e.flags & GameEventFlags.headshot) !== 0) line.classList.add("head");
    if (e.actor === this.myId || e.other === this.myId) line.classList.add("me");
    this.feed.prepend(line);
    while (this.feed.children.length > MAX_FEED) this.feed.lastElementChild?.remove();
    setTimeout(() => line.remove(), KILLFEED_SECONDS * 1000);
  }

  /** Per frame: health bars and the death screen. Pass null before the first snapshot. */
  update(h: PlayerHealth | null, showDeath = true): void {
    if (!h) {
      this.vitals.textContent = "";
      this.death.classList.remove("on");
      return;
    }
    const low = h.health <= 30 ? " low" : "";
    const pct = (v: number, max: number) =>
      `${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(0)}%`;
    this.vitals.innerHTML =
      `HP ${Math.ceil(h.health)}  SHIELD ${Math.ceil(h.shield)}` +
      `<div class="bar shield"><i style="width:${pct(h.shield, WEAPON.maxShield)}"></i></div>` +
      `<div class="bar health${low}"><i style="width:${pct(h.health, WEAPON.maxHealth)}"></i></div>` +
      `<div class="note">${h.protectedFor > 0 ? `SPAWN PROTECTION ${h.protectedFor.toFixed(1)}s (ends when you fire)` : ""}</div>`;

    if (h.alive || !showDeath) {
      this.death.classList.remove("on");
    } else {
      this.death.classList.add("on");
      this.death.innerHTML = `ELIMINATED<small>respawning in ${Math.max(0, h.respawnIn).toFixed(1)}s</small>`;
    }
  }
}
