/**
 * Fixed-timestep accumulator. Simulation runs at a constant rate regardless of
 * frame rate; rendering happens once per frame with an interpolation alpha.
 * Pure (no timers, no DOM) so it can be unit tested.
 */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** Clamp for huge frame gaps (tab in background) to avoid a spiral of death. */
const MAX_FRAME_MS = 250;

export class FixedTimestep {
  private accumulator = 0;
  private last: number | null = null;

  constructor(
    private readonly step: () => void,
    private readonly tickMs = TICK_MS,
  ) {}

  /** Feed the current time in ms. Runs zero or more sim steps and returns alpha in [0, 1). */
  advance(nowMs: number): number {
    if (this.last !== null) {
      this.accumulator += Math.min(nowMs - this.last, MAX_FRAME_MS);
    }
    this.last = nowMs;
    while (this.accumulator >= this.tickMs) {
      this.step();
      this.accumulator -= this.tickMs;
    }
    return this.accumulator / this.tickMs;
  }
}
