import { describe, expect, it } from "vitest";

import { replayBullet } from "./bullet-format";
import { bulletScenarios, recordBullet } from "./bullet-scenarios";
import { loadBulletVectors, loadWorld } from "./node";

describe("bullet test vectors (shared with the Go server)", () => {
  const vectors = loadBulletVectors();

  it("has a vector recorded for every scenario (run `pnpm vectors` if this fails)", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(bulletScenarios.map((s) => s.name).sort());
  });

  for (const v of vectors) {
    it(`replays ${v.name} (${v.steps.length} steps)`, () => {
      expect(replayBullet(v, loadWorld(v.world)).slice(0, 5)).toEqual([]);
    });
  }

  for (const sc of bulletScenarios) {
    it(`${sc.name} still demonstrates what it claims`, () => {
      expect(() => recordBullet(sc)).not.toThrow();
    });
  }
});
