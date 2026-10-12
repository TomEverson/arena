/**
 * The number that counts up while you keep hitting someone: 9, then 18, then 27, as in Apex.
 * Each target has its own running total; a pause (TALLY_GAP_MS) starts it over.
 */
export const TALLY_GAP_MS = 1500;

export class DamageTally {
  private readonly totals = new Map<number, { total: number; lastAt: number }>();

  /** Record a hit and return the running total for this target. */
  add(target: number, damage: number, nowMs: number): number {
    const t = this.totals.get(target);
    const total = t && nowMs - t.lastAt <= TALLY_GAP_MS ? t.total + damage : damage;
    this.totals.set(target, { total, lastAt: nowMs });
    return total;
  }

  /** Forget a target (it left, or its marker faded). */
  forget(target: number): void {
    this.totals.delete(target);
  }
}
