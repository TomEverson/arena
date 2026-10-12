/** Node-only helpers (file access) for the vector recorder and tests. Never imported by the game. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildCollisionWorld, parseLevel } from "../level";
import type { CollisionWorld } from "../types";
import type { Vector, VectorWorld } from "./format";

const repo = (rel: string) => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

export const VECTOR_DIR = repo("testvectors/movement");

export function loadWorld(spec: VectorWorld): CollisionWorld {
  if ("level" in spec) {
    const json: unknown = JSON.parse(readFileSync(repo(`levels/${spec.level}.json`), "utf8"));
    return buildCollisionWorld(parseLevel(json));
  }
  return { boxes: spec.boxes, ramps: spec.ramps };
}

export function loadVectors(): Vector[] {
  return readdirSync(VECTOR_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${VECTOR_DIR}/${f}`, "utf8")) as Vector);
}
