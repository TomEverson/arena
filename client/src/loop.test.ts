import { describe, expect, it } from "vitest";

import { FixedTimestep, TICK_MS } from "./loop";

describe("FixedTimestep", () => {
  it("runs one step per tick interval regardless of frame pacing", () => {
    let steps = 0;
    const loop = new FixedTimestep(() => steps++);
    loop.advance(0);
    // 10 frames at ~144 Hz = ~69.4 ms => 4 ticks at 60 Hz (16.67 ms)
    for (let i = 1; i <= 10; i++) loop.advance(i * (1000 / 144));
    expect(steps).toBe(4);
  });

  it("returns an interpolation alpha in [0, 1)", () => {
    const loop = new FixedTimestep(() => {});
    loop.advance(0);
    const alpha = loop.advance(TICK_MS * 1.5);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it("clamps huge gaps instead of spiraling", () => {
    let steps = 0;
    const loop = new FixedTimestep(() => steps++);
    loop.advance(0);
    loop.advance(60_000);
    expect(steps).toBeLessThanOrEqual(15);
  });
});
