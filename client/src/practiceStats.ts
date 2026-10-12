/**
 * What the practice panel shows: accuracy, damage and time-to-kill. Fed from the events the
 * server sends (hits with a server tick) and from your own shots. Pure, so it is easy to test.
 */
const TICK_SECONDS = 1 / 60;

export interface PracticeHit {
  targetId: number;
  damage: number;
  headshot: boolean;
  killed: boolean;
  /** The server tick of the hit. */
  tick: number;
}

export class PracticeStats {
  shots = 0;
  hits = 0;
  headshots = 0;
  damage = 0;
  kills = 0;
  /** Seconds from the first hit on a target to its death, one per kill. */
  readonly ttks: number[] = [];

  private readonly firstHitTick = new Map<number, number>();

  onShot(): void {
    this.shots++;
  }

  onHit(h: PracticeHit): void {
    this.hits++;
    this.damage += h.damage;
    if (h.headshot) this.headshots++;
    if (!this.firstHitTick.has(h.targetId)) this.firstHitTick.set(h.targetId, h.tick);
    if (h.killed) {
      const first = this.firstHitTick.get(h.targetId) ?? h.tick;
      this.ttks.push((h.tick - first) * TICK_SECONDS);
      this.firstHitTick.delete(h.targetId);
      this.kills++;
    }
  }

  /** Hits as a share of shots fired, 0..1. */
  get accuracy(): number {
    return this.shots === 0 ? 0 : Math.min(1, this.hits / this.shots);
  }

  /** Headshots as a share of hits, 0..1. */
  get headshotShare(): number {
    return this.hits === 0 ? 0 : this.headshots / this.hits;
  }

  get lastTtk(): number | null {
    return this.ttks[this.ttks.length - 1] ?? null;
  }

  get bestTtk(): number | null {
    return this.ttks.length === 0 ? null : Math.min(...this.ttks);
  }

  get averageTtk(): number | null {
    return this.ttks.length === 0 ? null : this.ttks.reduce((a, b) => a + b, 0) / this.ttks.length;
  }

  reset(): void {
    this.shots = this.hits = this.headshots = this.damage = this.kills = 0;
    this.ttks.length = 0;
    this.firstHitTick.clear();
  }
}
