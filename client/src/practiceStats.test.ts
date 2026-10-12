import { describe, expect, it } from "vitest";

import { PracticeStats } from "./practiceStats";

const hit = (
  targetId: number,
  tick: number,
  over: Partial<Parameters<PracticeStats["onHit"]>[0]> = {},
) => ({
  targetId,
  damage: 9,
  headshot: false,
  killed: false,
  tick,
  ...over,
});

describe("PracticeStats", () => {
  it("starts empty", () => {
    const s = new PracticeStats();
    expect(s.accuracy).toBe(0);
    expect(s.headshotShare).toBe(0);
    expect(s.lastTtk).toBeNull();
    expect(s.averageTtk).toBeNull();
    expect(s.bestTtk).toBeNull();
  });

  it("counts shots, hits, accuracy and damage", () => {
    const s = new PracticeStats();
    for (let i = 0; i < 10; i++) s.onShot();
    for (let i = 0; i < 8; i++) s.onHit(hit(1000, i));
    s.onHit(hit(1000, 9, { damage: 13.5, headshot: true }));
    expect(s.hits).toBe(9);
    expect(s.accuracy).toBeCloseTo(0.9);
    expect(s.damage).toBeCloseTo(8 * 9 + 13.5);
    expect(s.headshots).toBe(1);
    expect(s.headshotShare).toBeCloseTo(1 / 9);
  });

  it("times a kill from the first hit on that target to its death", () => {
    const s = new PracticeStats();
    s.onHit(hit(1000, 100));
    s.onHit(hit(1000, 130));
    s.onHit(hit(1000, 196, { killed: true }));
    expect(s.kills).toBe(1);
    expect(s.lastTtk).toBeCloseTo(1.6, 6); // 96 ticks at 60 Hz
  });

  it("keeps separate clocks per target and starts afresh after a kill", () => {
    const s = new PracticeStats();
    s.onHit(hit(1000, 0));
    s.onHit(hit(1001, 60));
    s.onHit(hit(1000, 120, { killed: true })); // 2.0 s
    s.onHit(hit(1001, 150, { killed: true })); // 1.5 s since its first hit
    s.onHit(hit(1000, 300)); // the target is back: a new life
    s.onHit(hit(1000, 330, { killed: true })); // 0.5 s
    expect(s.ttks.map((t) => Number(t.toFixed(2)))).toEqual([2, 1.5, 0.5]);
    expect(s.bestTtk).toBeCloseTo(0.5);
    expect(s.averageTtk).toBeCloseTo(4 / 3);
    expect(s.lastTtk).toBeCloseTo(0.5);
  });

  it("a one-hit kill takes no time", () => {
    const s = new PracticeStats();
    s.onHit(hit(1000, 50, { killed: true }));
    expect(s.lastTtk).toBe(0);
  });

  it("resets everything, including half-finished kills", () => {
    const s = new PracticeStats();
    s.onShot();
    s.onHit(hit(1000, 0));
    s.reset();
    s.onHit(hit(1000, 600, { killed: true }));
    expect(s.shots).toBe(0);
    expect(s.ttks).toEqual([0]); // the old first hit must not leak into the new run
    expect(s.hits).toBe(1);
  });

  it("never reports more than 100% accuracy", () => {
    const s = new PracticeStats();
    s.onHit(hit(1, 0)); // a hit with no shot recorded (events can outrun the shot count)
    expect(s.accuracy).toBe(0);
    s.onShot();
    s.onHit(hit(1, 1));
    expect(s.accuracy).toBe(1);
  });
});
