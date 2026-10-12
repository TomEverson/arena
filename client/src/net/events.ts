import type { GameEvent } from "./protocol.gen";

/**
 * Snapshots resend recent events so a lost snapshot does not lose a kill.
 * Each event has a per-recipient sequence number; this hands back only the new ones, oldest first.
 */
export class EventTracker {
  private last = 0;

  fresh(events: readonly GameEvent[]): GameEvent[] {
    const out = events.filter((e) => e.seq > this.last).sort((a, b) => a.seq - b.seq);
    for (const e of out) this.last = Math.max(this.last, e.seq);
    return out;
  }
}
