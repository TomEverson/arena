import { describe, expect, it } from "vitest";

import { DamageTally, TALLY_GAP_MS } from "./damageTally";

describe("DamageTally", () => {
  it("counts up while you keep hitting one target", () => {
    const t = new DamageTally();
    expect(t.add(2, 9, 1000)).toBe(9);
    expect(t.add(2, 9, 1100)).toBe(18);
    expect(t.add(2, 13.5, 1200)).toBe(31.5);
  });

  it("starts over after a pause", () => {
    const t = new DamageTally();
    t.add(2, 9, 0);
    expect(t.add(2, 9, TALLY_GAP_MS + 1)).toBe(9);
  });

  it("keeps counting while hits keep coming just inside the gap", () => {
    const t = new DamageTally();
    t.add(2, 9, 0);
    t.add(2, 9, TALLY_GAP_MS - 10);
    expect(t.add(2, 9, 2 * TALLY_GAP_MS - 20)).toBe(27);
  });

  it("keeps a separate total per target", () => {
    const t = new DamageTally();
    t.add(2, 9, 0);
    expect(t.add(3, 9, 100)).toBe(9);
    expect(t.add(2, 9, 200)).toBe(18); // switching away and back does not lose the first count
    expect(t.add(3, 9, 300)).toBe(18);
  });

  it("forgets a target", () => {
    const t = new DamageTally();
    t.add(2, 9, 0);
    t.forget(2);
    expect(t.add(2, 9, 100)).toBe(9);
  });
});
