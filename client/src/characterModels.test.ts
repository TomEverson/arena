import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ARM_UPPER, HEAD_Y, HIP_X, HIP_Y, SHOULDER_X, SHOULDER_Y } from "./character";

/**
 * Checks each Blockbench model (.glb) against the rules in characterModels.ts: bones named after
 * the joints, pivots exactly on the code joints, and every part inside the hitbox. If this fails
 * after an edit in Blockbench, a bone's pivot was moved or a part sticks out.
 */

interface GltfNode {
  name?: string;
  translation?: [number, number, number];
  rotation?: number[];
  children?: number[];
  mesh?: number;
}
interface Gltf {
  nodes: GltfNode[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

/** The JSON part of a .glb file. */
function readGlb(path: string): Gltf {
  const buf = readFileSync(new URL(path, import.meta.url));
  const length = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + length).toString("utf8")) as Gltf;
}

/** Each bone: its parent bone and its pivot relative to that parent (metres). */
const JOINTS: Record<string, { parent: string; at: [number, number, number] }> = {
  hip_l: { parent: "body", at: [-HIP_X, HIP_Y, 0] },
  hip_r: { parent: "body", at: [HIP_X, HIP_Y, 0] },
  upper: { parent: "body", at: [0, HIP_Y, 0] },
  head: { parent: "upper", at: [0, HEAD_Y, 0] },
  shoulder_l: { parent: "upper", at: [-SHOULDER_X, SHOULDER_Y, 0] },
  shoulder_r: { parent: "upper", at: [SHOULDER_X, SHOULDER_Y, 0] },
  elbow_l: { parent: "shoulder_l", at: [0, -ARM_UPPER, 0] },
  elbow_r: { parent: "shoulder_r", at: [0, -ARM_UPPER, 0] },
};

/** The standing hitbox (sim/): 0.6 m wide, 1.8 m tall; the head zone is its top 0.3 m. */
const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
const HEAD_ZONE = 1.5;
/**
 * The one exception (Luke, 2026-10-13): a hat may be bigger than the hitbox, wider and taller.
 * Parts named hat... only; shots through the brim miss, it is decoration.
 */
const HAT_HALF_WIDTH = 0.42;
const HAT_TOP = 1.95;

describe.each(["trooper", "assassin"])("Blockbench model %s", (look) => {
  const gltf = readGlb(`./models/${look}.glb`);
  const byName = new Map(gltf.nodes.map((n, i) => [n.name, i]));
  const parentOf = new Map<number, number>();
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));

  it.each(Object.entries(JOINTS))("bone %s sits on its joint", (bone, { parent, at }) => {
    const i = byName.get(bone);
    expect(i, `no bone named ${bone}`).toBeDefined();
    const node = gltf.nodes[i ?? 0];
    expect(gltf.nodes[parentOf.get(i ?? 0) ?? -1]?.name).toBe(parent);
    const t = node?.translation ?? [0, 0, 0];
    for (let k = 0; k < 3; k++) expect(t[k]).toBeCloseTo(at[k] ?? 0, 4);
    expect(node?.rotation, "bones must not be rotated in the rest pose").toBeUndefined();
  });

  it("keeps every part inside the hitbox, and the head inside the head zone", () => {
    const worldOffset = (i: number): [number, number, number] => {
      const o: [number, number, number] = [0, 0, 0];
      for (let n: number | undefined = i; n !== undefined; n = parentOf.get(n)) {
        const t = gltf.nodes[n]?.translation ?? [0, 0, 0];
        for (let k = 0; k < 3; k++) o[k] = (o[k] ?? 0) + (t[k] ?? 0);
      }
      return o;
    };
    const headBone = byName.get("head");
    gltf.nodes.forEach((node, i) => {
      if (node.mesh === undefined) return;
      const o = worldOffset(i);
      for (const prim of gltf.meshes[node.mesh]?.primitives ?? []) {
        const acc = gltf.accessors[prim.attributes.POSITION];
        const at = (v: number[] | undefined, k: number) => (v?.[k] ?? NaN) + (o[k] ?? 0);
        const [x0, y0, z0] = [0, 1, 2].map((k) => at(acc?.min, k)) as [number, number, number];
        const [x1, y1, z1] = [0, 1, 2].map((k) => at(acc?.max, k)) as [number, number, number];
        const where = `${node.name ?? "?"}: x ${x0.toFixed(3)}..${x1.toFixed(3)}, y ${y0.toFixed(3)}..${y1.toFixed(3)}, z ${z0.toFixed(3)}..${z1.toFixed(3)}`;
        const hat = node.name?.startsWith("hat") ?? false;
        const half = hat ? HAT_HALF_WIDTH : HALF_WIDTH;
        for (const v of [x0, z0]) expect(v, where).toBeGreaterThanOrEqual(-half - 1e-6);
        for (const v of [x1, z1]) expect(v, where).toBeLessThanOrEqual(half + 1e-6);
        expect(y0, where).toBeGreaterThanOrEqual(-1e-6);
        expect(y1, where).toBeLessThanOrEqual((hat ? HAT_TOP : HEIGHT) + 1e-6);
        // Helmet parts (everything in the head bone above the collar) must be in the head zone.
        if (parentOf.get(i) === headBone && y1 > HEAD_ZONE + 0.05 && !hat)
          expect(y0, where).toBeGreaterThanOrEqual(HEAD_ZONE - 1e-6);
      }
    });
  });
});
