import { describe, expect, it } from "vitest";

import { replayHitscan, replayWeapon } from "./combat-format";
import { hitscanScenarios, recordHitscan, recordWeapon, weaponScenarios } from "./combat-scenarios";
import { loadHitscanVectors, loadWeaponVectors, loadWorld } from "./node";

describe("weapon test vectors (shared with the Go server)", () => {
  const vectors = loadWeaponVectors();

  it("has a vector recorded for every scenario (run `pnpm vectors` if this fails)", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(weaponScenarios.map((s) => s.name).sort());
  });

  for (const v of vectors) {
    it(`replays ${v.name}`, () => {
      expect(replayWeapon(v).slice(0, 5)).toEqual([]);
    });
  }

  for (const sc of weaponScenarios) {
    it(`${sc.name} still demonstrates what it claims`, () => {
      const { vector, trace } = recordWeapon(sc);
      expect(() => sc.verify(trace, vector.events)).not.toThrow();
    });
  }
});

describe("hitscan test vectors (shared with the Go server)", () => {
  const vectors = loadHitscanVectors();

  it("has a vector recorded for every scenario (run `pnpm vectors` if this fails)", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(hitscanScenarios.map((s) => s.name).sort());
  });

  for (const v of vectors) {
    it(`replays ${v.name} (${v.cases.length} rays)`, () => {
      expect(replayHitscan(v, loadWorld(v.world)).slice(0, 5)).toEqual([]);
    });
  }

  for (const sc of hitscanScenarios) {
    it(`${sc.name} still demonstrates what it claims`, () => {
      expect(() => recordHitscan(sc)).not.toThrow();
    });
  }
});
