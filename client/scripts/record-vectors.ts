/**
 * Records every scenario into /testvectors/movement/<name>.json from the live TypeScript sim.
 * Run with `pnpm vectors`. A scenario whose `verify` fails aborts the recording.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { loadWorld, VECTOR_DIR } from "../src/sim/vectors/node";
import { recordScenario } from "../src/sim/vectors/record";
import { scenarios } from "../src/sim/vectors/scenarios";

mkdirSync(VECTOR_DIR, { recursive: true });
for (const f of readdirSync(VECTOR_DIR)) if (f.endsWith(".json")) rmSync(`${VECTOR_DIR}/${f}`);

const coverage = { sliding: 0, crouching: 0, climbing: 0, mantling: 0, dashing: 0, airborne: 0 };
let totalTicks = 0;

for (const sc of scenarios) {
  const { vector, trace } = recordScenario(sc, loadWorld(sc.world));
  try {
    sc.verify(trace);
  } catch (e) {
    throw new Error(`scenario "${sc.name}": ${(e as Error).message}`, { cause: e });
  }
  writeFileSync(`${VECTOR_DIR}/${sc.name}.json`, `${JSON.stringify(vector)}\n`);
  for (const s of trace) {
    if (s.sliding) coverage.sliding++;
    if (s.crouching) coverage.crouching++;
    if (s.climbing) coverage.climbing++;
    if (s.mantling) coverage.mantling++;
    if (s.dashTime > 0) coverage.dashing++;
    if (!s.onGround) coverage.airborne++;
  }
  totalTicks += trace.length - 1;
}

console.log(`recorded ${scenarios.length} vectors, ${totalTicks} ticks into ${VECTOR_DIR}`);
console.log("ticks exercised:", coverage);
