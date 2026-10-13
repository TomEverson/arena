import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildKatana, KATANA_REACH } from "./katana";

describe("katana", () => {
  it("falls back to a plain bar pointing -Z when the model is not loaded", () => {
    const blade = buildKatana();
    blade.geometry.computeBoundingBox();
    expect(blade.geometry.boundingBox?.min.z).toBeCloseTo(-KATANA_REACH);
    expect(blade.geometry.boundingBox?.max.z).toBeCloseTo(0);
  });

  /** If this fails after an edit in Blockbench, the sword's group or its grip locator was renamed. */
  it("has the group and the locator the game needs in its Blockbench model", () => {
    interface GltfNode {
      name?: string;
      children?: number[];
      mesh?: number;
    }
    const buf = readFileSync(new URL("./models/katana.glb", import.meta.url));
    const json = buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8");
    const nodes = (JSON.parse(json) as { nodes: GltfNode[] }).nodes;
    const sword = nodes.find((n) => n.name === "katana");
    expect(sword?.children?.some((c) => nodes[c]?.mesh !== undefined)).toBe(true);
    expect(sword?.children?.some((c) => nodes[c]?.name === "grip")).toBe(true);
  });
});
