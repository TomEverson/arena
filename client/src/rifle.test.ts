import { readFileSync } from "node:fs";

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { BRICK_MAG_HOME, BRICK_MUZZLE, buildBrick, LOW_AMMO } from "./rifle";

describe("Brick", () => {
  it("has a strip on each side that shrinks with the ammo and hides when empty", () => {
    const brick = buildBrick();
    const s = brick.strips;
    expect(s).toHaveLength(2);
    brick.update(0.016, 1, 0);
    for (const m of s) expect(m.scale.z).toBeCloseTo(1);
    brick.update(0.016, 0.5, 0);
    for (const m of s) expect(m.scale.z).toBeCloseTo(0.5);
    brick.update(0.016, 0, 0);
    for (const m of s) expect(m.visible).toBe(false);
  });

  it("blinks the strip when the magazine is nearly empty, and not otherwise", () => {
    const brick = buildBrick();
    const colourAt = (ammo: number, t: number) => {
      brick.update(0.016, ammo, t);
      const m = brick.strips[0] as THREE.Mesh;
      return (m.material as THREE.MeshLambertMaterial).emissive.getHex();
    };
    expect(new Set([0, 0.05, 0.1, 0.15, 0.2, 0.3].map((t) => colourAt(1, t))).size).toBe(1);
    const lowColours = new Set([0, 0.07, 0.14, 0.21, 0.28, 0.35].map((t) => colourAt(LOW_AMMO, t)));
    expect(lowColours.size).toBe(2); // on and off
  });

  it("kicks the slide back on a shot, then settles", () => {
    const brick = buildBrick();
    const slide = brick.slide;
    const home = slide.position.z;
    brick.shoot();
    brick.update(0.001, 1, 0);
    expect(slide.position.z).toBeGreaterThan(home + 0.03);
    for (let i = 0; i < 30; i++) brick.update(0.016, 1, 0);
    expect(slide.position.z).toBeCloseTo(home, 6);
  });

  it("keeps the magazine at its home and the muzzle ahead of the whole gun", () => {
    const brick = buildBrick();
    expect(brick.mag.position.equals(BRICK_MAG_HOME)).toBe(true);
    const box = new THREE.Box3().setFromObject(brick.root);
    expect(box.min.z).toBeGreaterThanOrEqual(BRICK_MUZZLE.z - 0.1); // nothing sticks out past the muzzle
    expect(box.max.x - box.min.x).toBeLessThan(0.12); // slim enough to hold
  });
});

/**
 * Checks the Blockbench gun models (.glb) against the rules in rifle.ts. If this fails after an
 * edit in Blockbench, the muzzle locator or one of the moving parts' bones was renamed or emptied.
 */
describe.each(["rifle", "sniper"])("Blockbench model %s", (gun) => {
  interface GltfNode {
    name?: string;
    children?: number[];
    mesh?: number;
  }
  const buf = readFileSync(new URL(`./models/${gun}.glb`, import.meta.url));
  const json = buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8");
  const nodes = (JSON.parse(json) as { nodes: GltfNode[] }).nodes;

  it("has a muzzle locator", () => {
    expect(nodes.some((n) => n.name === "muzzle")).toBe(true);
  });

  it.each(["mag", "slide", "strip_l", "strip_r"])("has parts in the bone %s", (bone) => {
    const node = nodes.find((n) => n.name === bone);
    expect(node, `no bone named ${bone}`).toBeDefined();
    expect(node?.children?.some((c) => nodes[c]?.mesh !== undefined)).toBe(true);
  });
});
