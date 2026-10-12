/**
 * End-to-end movement netcode check. Starts the real Go server with the fake network
 * (80 ms each way, 3% loss) with the match cycle off (always live) and drives two headless players
 * through it using the same classes the browser uses (NetClient, Predictor, ServerClock, RemoteTracks).
 *
 *   pnpm netcheck [seconds] [latency] [loss]      e.g. pnpm netcheck 20 80ms 3%
 *
 * Passing means: prediction never had to correct (the server simulated exactly what we
 * predicted), and the other player's interpolated motion has no pops.
 */
import { type ChildProcess } from "node:child_process";

import { INTERP_TICKS } from "../src/net/interpolation";
import { loadWorld } from "../src/sim/vectors/node";
import { fuzzInput } from "../src/sim/vectors/scenarios";
import { BotClient, type Brain, createRoom, sleep, startServer } from "./headless";

const seconds = Number(process.argv[2] ?? 20);
const latency = process.argv[3] ?? "80ms";
const loss = process.argv[4] ?? "3%";
const port = 8098;
const world = loadWorld({ level: "greybox" });

/** Random but seeded movement, the same generator the test vectors use. */
function wanderer(seed: number): Brain {
  const gen = fuzzInput(seed)();
  return (bot, tick) => (bot.predictor ? gen(tick, bot.predictor.state) : {});
}

let server: ChildProcess | undefined;
let failed = false;
try {
  server = await startServer(port, latency, loss, "greybox", ["--no-match"]);
  const room = await createRoom(port);
  const a = new BotClient("A", port, room, world, wanderer(12345));
  const b = new BotClient("B", port, room, world, wanderer(777));
  console.log(`two players for ${seconds}s through ${latency} each way and ${loss} loss...`);

  // Watch how A looks to B, once per "frame" (60 fps), the way the renderer would.
  let last: { x: number; y: number; z: number } | null = null;
  let maxStep = 0;
  let pops = 0;
  let frames = 0;
  const watcher = setInterval(() => {
    if (!b.clock.ready || a.id < 0) return;
    const pose = b.remotes.sample(a.id, b.clock.tickAt(performance.now()) - INTERP_TICKS);
    if (!pose) return;
    frames++;
    if (last) {
      const step = Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z);
      maxStep = Math.max(maxStep, step);
      if (step > 1.5) pops++; // faster than 90 m/s: a teleport, not motion
    }
    last = pose;
  }, 1000 / 60);

  await sleep(seconds * 1000);
  a.stop();
  b.stop();
  await sleep(1500); // let the last inputs be simulated and acknowledged
  clearInterval(watcher);

  const rows = [a, b].map((bot) => ({
    name: bot.name,
    id: bot.id,
    corrections: bot.predictor?.corrections ?? -1,
    maxErrorCm: (bot.predictor?.maxError ?? 0) * 100,
    reconciled: bot.stats.reconciled,
    inputsSent: bot.stats.inputsSent,
    rttMs: Math.round(bot.net.stats.rttMs),
    snapPerSec: bot.net.stats.snapshotsPerSecond,
  }));
  console.table(rows);
  console.log(
    `B watching A: ${frames} frames, largest per-frame step ${maxStep.toFixed(2)} m, pops ${pops}`,
  );

  const problems: string[] = [];
  for (const m of rows) {
    if (m.corrections > 2)
      problems.push(`${m.name}: ${m.corrections} prediction corrections (want at most 2)`);
    if (m.reconciled < seconds * 20)
      problems.push(`${m.name}: only ${m.reconciled} snapshots reconciled`);
    if (m.rttMs < 100 || m.rttMs > 320)
      problems.push(`${m.name}: round trip ${m.rttMs} ms is not what the fake network should give`);
  }
  if (pops > 0) problems.push(`remote motion popped ${pops} times`);
  if (frames < seconds * 40) problems.push(`only ${frames} frames of remote motion observed`);

  a.close();
  b.close();
  if (problems.length > 0) {
    failed = true;
    console.error(`\nFAILED:\n - ${problems.join("\n - ")}`);
  } else {
    console.log("\nPASS: prediction stayed exact and remote motion was smooth.");
  }
} finally {
  server?.kill();
}
process.exit(failed ? 1 : 0);
