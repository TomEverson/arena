export const TICK_MS = 1000 / 60;

/**
 * Estimates the server's tick number from snapshot arrivals. Each snapshot says
 * "this is tick T"; it arrived after the network delay, so (arrival - T * TICK_MS)
 * is the local time of server tick 0 plus latency. Jitter only ever makes a
 * snapshot LATE, so the estimate follows early arrivals quickly and late ones slowly.
 */
export class ServerClock {
  private offset: number | null = null;

  onSnapshot(tick: number, nowMs: number): void {
    const sample = nowMs - tick * TICK_MS;
    if (this.offset === null) this.offset = sample;
    else if (sample < this.offset)
      this.offset += (sample - this.offset) * 0.5; // earlier than expected: believe it
    else this.offset += (sample - this.offset) * 0.02; // later: probably jitter, or the clocks drifting apart
  }

  get ready(): boolean {
    return this.offset !== null;
  }

  /** The server tick we believe is current at local time `nowMs` (fractional). */
  tickAt(nowMs: number): number {
    return this.offset === null ? 0 : (nowMs - this.offset) / TICK_MS;
  }
}
