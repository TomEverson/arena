import type { GameEvent, Shot } from "./protocol.gen";

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

/**
 * Shots (bullets to draw) are resent like events, but numbered across the whole room. This hands
 * back only the new ones, oldest first.
 */
export class ShotTracker {
  private last = 0;

  fresh(shots: readonly Shot[]): Shot[] {
    const out = shots.filter((s) => s.seq > this.last).sort((a, b) => a.seq - b.seq);
    for (const s of out) this.last = Math.max(this.last, s.seq);
    return out;
  }
}
