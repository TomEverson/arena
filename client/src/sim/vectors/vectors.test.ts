import { describe, expect, it } from "vitest";

import { replayVector } from "./format";
import { loadVectors, loadWorld } from "./node";
import { recordScenario } from "./record";
import { scenarios } from "./scenarios";

describe("movement test vectors (shared with the Go server)", () => {
  const vectors = loadVectors();

  it("has a vector recorded for every scenario (run `pnpm vectors` if this fails)", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(scenarios.map((s) => s.name).sort());
  });

  it("covers every movement feature", () => {
    const states = vectors.flatMap((v) => v.checkpoints.map((c) => c.state));
    for (const key of ["sliding", "crouching", "mantling"] as const) {
      expect(
        states.some((s) => s[key]),
        key,
      ).toBe(true);
    }
    expect(states.some((s) => s.dashTime > 0)).toBe(true);
    expect(states.some((s) => !s.onGround)).toBe(true);
  });

  for (const v of vectors) {
    it(`replays ${v.name}`, () => {
      const mismatches = replayVector(v, loadWorld(v.world));
      expect(mismatches.slice(0, 5)).toEqual([]);
    });
  }
});

describe("scenarios still demonstrate what they claim", () => {
  for (const sc of scenarios) {
    it(sc.name, () => {
      const { trace } = recordScenario(sc, loadWorld(sc.world));
      expect(() => sc.verify(trace)).not.toThrow();
    });
  }
});
