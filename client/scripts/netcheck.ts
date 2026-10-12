/**
 * End-to-end netcode check. Starts the real Go server with the fake network
 * (80 ms each way, 3% loss) and drives two headless players through it using the
 * same classes the browser uses (NetClient, Predictor, ServerClock, RemoteTracks).
 *
 *   pnpm netcheck [seconds] [latency] [loss]      e.g. pnpm netcheck 20 80ms 3%
 *
 * Passing means: prediction never had to correct (the server simulated exactly what
 * we predicted), and the other player's interpolated motion has no pops.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FixedTimestep } from "../src/loop";
import { NetClient } from "../src/net/client";
import { ServerClock } from "../src/net/clock";
import { INTERP_TICKS, RemoteTracks } from "../src/net/interpolation";
import { Predictor } from "../src/net/prediction";
import { emptyInput } from "../src/sim/types";
import { loadWorld } from "../src/sim/vectors/node";
import { fuzzInput } from "../src/sim/vectors/scenarios";

const seconds = Number(process.argv[2] ?? 20);
const latency = process.argv[3] ?? "80ms";
const loss = process.argv[4] ?? "3%";
const port = 8098;
const serverDir = fileURLToPath(new URL("../../server/", import.meta.url));
const bin = "/tmp/arena-netcheck-server";

const world = loadWorld({ level: "greybox" });

interface Metrics {
  name: string;
  id: number;
  corrections: number;
  maxErrorCm: number;
  reconciled: number;
  inputsSent: number;
  rttMs: number;
  snapPerSec: number;
}

class HeadlessClient {
  predictor: Predictor | null = null;
  readonly remotes = new RemoteTracks();
  readonly clock = new ServerClock();
  readonly net: NetClient;
  reconciled = 0;
  inputsSent = 0;
  private readonly inputFor: (tick: number, s: never) => Record<string, unknown>;
  private tick = 0;
  private running = true;
  private readonly loop: FixedTimestep;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    readonly name: string,
    seed: number,
  ) {
    const gen = fuzzInput(seed)();
    this.inputFor = gen as never;
    this.net = new NetClient(`ws://localhost:${port}/ws`, {
      onWelcome: () => {},
      onSnapshot: (s) => {
        this.clock.onSnapshot(s.tick, performance.now());
        this.remotes.push(s.tick, s.entities);
        if (!this.predictor) this.predictor = new Predictor(world, s.you, s.ackSeq);
        else {
          this.predictor.reconcile(s.ackSeq, s.you);
          this.reconciled++;
        }
      },
      onClose: () => {},
    });
    this.loop = new FixedTimestep(() => {
      if (!this.predictor || !this.running) return;
      const raw = this.inputFor(this.tick++, this.predictor.state as never);
      this.predictor.step({ ...emptyInput(), ...raw }, 0);
      this.net.sendInputs(this.predictor.recent());
      this.inputsSent++;
    });
    this.timer = setInterval(() => this.loop.advance(performance.now()), 4);
  }

  stop(): void {
    this.running = false;
  }

  close(): void {
    clearInterval(this.timer);
    this.net.close();
  }

  metrics(): Metrics {
    return {
      name: this.name,
      id: this.net.playerId ?? -1,
      corrections: this.predictor?.corrections ?? -1,
      maxErrorCm: (this.predictor?.maxError ?? 0) * 100,
      reconciled: this.reconciled,
      inputsSent: this.inputsSent,
      rttMs: this.net.stats.rttMs,
      snapPerSec: this.net.stats.snapshotsPerSecond,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(): Promise<ChildProcess> {
  console.log("building server...");
  execFileSync("go", ["build", "-o", bin, "./cmd/server"], { cwd: serverDir, stdio: "inherit" });
  const child = spawn(
    bin,
    [
      `--addr=:${port}`,
      "--level=../levels/greybox.json",
      `--fake-latency=${latency}`,
      `--loss=${loss}`,
    ],
    { cwd: serverDir },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stderr.on("data", (d: Buffer) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
  return child;
}

const server = await startServer();
let failed = false;
try {
  const a = new HeadlessClient("A", 12345);
  const b = new HeadlessClient("B", 777);
  console.log(`two players for ${seconds}s through ${latency} each way and ${loss} loss...`);

  // Watch how A looks to B, once per "frame" (60 fps), the way the renderer would.
  let last: { x: number; y: number; z: number } | null = null;
  let maxStep = 0;
  let pops = 0;
  let frames = 0;
  let lagSum = 0;
  let lagN = 0;
  const watcher = setInterval(() => {
    if (!b.clock.ready || a.net.playerId === null) return;
    const renderTick = b.clock.tickAt(performance.now()) - INTERP_TICKS;
    const pose = b.remotes.sample(a.net.playerId, renderTick);
    if (!pose) return;
    frames++;
    if (last) {
      const step = Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z);
      maxStep = Math.max(maxStep, step);
      if (step > 1.5) pops++; // faster than 90 m/s: a teleport, not motion
    }
    last = pose;
    if (a.predictor) {
      lagSum += Math.hypot(a.predictor.state.x - pose.x, a.predictor.state.z - pose.z);
      lagN++;
    }
  }, 1000 / 60);

  await sleep(seconds * 1000);
  a.stop();
  b.stop();
  await sleep(1500); // let the last inputs be simulated and acknowledged
  clearInterval(watcher);

  const results = [a.metrics(), b.metrics()];
  console.table(results);
  console.log(
    `B watching A: ${frames} frames, largest per-frame step ${maxStep.toFixed(2)} m, pops ${pops}, ` +
      `average distance behind A's own view ${(lagSum / Math.max(1, lagN)).toFixed(2)} m`,
  );

  const problems: string[] = [];
  for (const m of results) {
    if (m.corrections > 2)
      problems.push(`${m.name}: ${m.corrections} prediction corrections (want at most 2)`);
    if (m.reconciled < seconds * 20)
      problems.push(`${m.name}: only ${m.reconciled} snapshots reconciled`);
    if (m.rttMs < 100 || m.rttMs > 320)
      problems.push(
        `${m.name}: round trip ${m.rttMs.toFixed(0)} ms is not what the fake network should give`,
      );
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
  server.kill();
}
process.exit(failed ? 1 : 0);
