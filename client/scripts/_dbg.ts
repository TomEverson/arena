import { spawnState, stepPlayer } from "../src/sim/movement";
import { emptyInput } from "../src/sim/types";
import { loadWorld } from "../src/sim/vectors/node";
const world = loadWorld({ level: "ffa" });
const DT = 1 / 60;
const EAST = -Math.PI / 2;
let s = spawnState(-4.5, 0, -18);
for (let i = 0; i < 120; i++) {
  s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw: EAST }, world, DT);
  if (i % 10 === 0) console.log(i, s.x.toFixed(2), s.y.toFixed(2), s.z.toFixed(2), s.onGround, s.vx.toFixed(1));
}
console.log(world.ramps.filter((r) => r.box.minX === -3.75 && r.box.minZ < -10 && r.box.maxZ > -22).map((r) => JSON.stringify(r)).slice(0, 3).join("\n"));
s = spawnState(-8, 0, -15);
for (let i = 0; i < 150; i++) {
  s = stepPlayer(s, { ...emptyInput(), moveZ: 1, yaw: EAST }, world, DT);
  if (i % 15 === 0) console.log("thru", i, s.x.toFixed(2), s.y.toFixed(2), s.vx.toFixed(1));
}
