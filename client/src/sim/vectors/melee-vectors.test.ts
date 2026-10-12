import { describe, expect, it } from "vitest";

import { replayMelee } from "./melee-format";
import { meleeScenarios, recordMelee } from "./melee-scenarios";
import { loadMeleeVectors, loadWorld } from "./node";

describe("melee test vectors (shared with the Go server)", () => {
  const vectors = loadMeleeVectors();

  it("has a vector recorded for every scenario (run `pnpm vectors` if this fails)", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(meleeScenarios.map((s) => s.name).sort());
  });

  for (const v of vectors) {
    it(`replays ${v.name} (${v.cases.length} swings)`, () => {
      expect(replayMelee(v, loadWorld(v.world)).slice(0, 5)).toEqual([]);
    });
  }

  for (const sc of meleeScenarios) {
    it(`${sc.name} still demonstrates what it claims`, () => {
      expect(() => recordMelee(sc)).not.toThrow();
    });
  }
});
