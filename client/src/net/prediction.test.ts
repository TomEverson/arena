import { describe, expect, it } from "vitest";

import { spawnState, stepPlayer } from "../sim/movement";
import { flatWorld } from "../sim/testutil";
import { emptyInput, type PlayerInput, type PlayerState } from "../sim/types";
import { loadWorld } from "../sim/vectors/node";
import { scenarios } from "../sim/vectors/scenarios";
import { MAX_HISTORY, Predictor, REDUNDANCY, statesMatch } from "./prediction";
import type { Input } from "./protocol.gen";

const DT = 1 / 60;

/** Same rules as the Go server: input-driven, dedupes by seq, one input per tick (two when backed up). */
class SimServer {
  state: PlayerState;
  ack = 0;
  private queue: Input[] = [];
  private lastSeq = 0;
  constructor(
    private readonly world: ReturnType<typeof loadWorld>,
    initial: PlayerState,
  ) {
    this.state = initial;
  }
  receive(inputs: Input[]): void {
    for (const i of inputs) {
      if (i.seq > this.lastSeq) {
        this.lastSeq = i.seq;
        this.queue.push(i);
      }
    }
  }
  tick(): void {
    const n = this.queue.length > 2 ? 2 : 1;
    for (let k = 0; k < n && this.queue.length > 0; k++) {
      const i = this.queue.shift() as Input;
      this.state = stepPlayer(this.state, i, this.world, DT);
      this.ack = i.seq;
    }
  }
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunOptions {
  /** One-way delay in ticks (a little jitter is added). */
  latency: number;
  jitter?: number;
  loss: number;
  ticks: number;
  seed: number;
  /** Server-side event at a tick, e.g. a respawn. */
  serverEvent?: { tick: number; apply: (s: SimServer) => void };
}

function simulate(opts: RunOptions) {
  const sc = scenarios.find((s) => s.name === "fuzz-greybox");
  if (!sc) throw new Error("scenario missing");
  const world = loadWorld(sc.world);
  const inputFor = sc.input();
  const rand = rng(opts.seed);
  const start = spawnState(...sc.start);

  const server = new SimServer(world, start);
  const client = new Predictor(world, start);
  const toServer: { at: number; inputs: Input[] }[] = [];
  const toClient: { at: number; ack: number; state: PlayerState }[] = [];
  // One WebSocket is one TCP stream: delay can pile up, but messages never overtake each other.
  const lastArrival = { up: 0, down: 0 };
  const arrival = (dir: "up" | "down", now: number) => {
    const at = Math.max(
      lastArrival[dir],
      now + opts.latency + Math.floor(rand() * ((opts.jitter ?? 0) + 1)),
    );
    lastArrival[dir] = at;
    return at;
  };
  let lossy = true;
  const lost = () => lossy && rand() < opts.loss;
  const bigCorrections: number[] = [];

  const total = opts.ticks + 4 * (opts.latency + (opts.jitter ?? 0)) + 12; // then settle without new inputs
  for (let t = 0; t < total; t++) {
    for (const m of toClient.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
      const c = client.reconcile(m.ack, m.state);
      if (c && c.error > 2) bigCorrections.push(c.error);
    }
    toClient.splice(0, toClient.length, ...toClient.filter((x) => x.at > t));

    if (t < opts.ticks) {
      const input: PlayerInput = { ...emptyInput(), ...inputFor(t, client.state) };
      client.step(input, 0);
      if (!lost()) toServer.push({ at: arrival("up", t), inputs: client.recent(REDUNDANCY) });
    } else {
      // Settle: the client keeps resending its last inputs over a clean link, so the
      // server ends up having simulated everything it can.
      lossy = false;
      toServer.push({ at: arrival("up", t), inputs: client.recent(REDUNDANCY) });
    }

    for (const m of toServer.filter((x) => x.at <= t)) server.receive(m.inputs);
    toServer.splice(0, toServer.length, ...toServer.filter((x) => x.at > t));

    if (opts.serverEvent && t === opts.serverEvent.tick) opts.serverEvent.apply(server);
    server.tick();
    if (t % 2 === 1 && !lost())
      toClient.push({ at: arrival("down", t), ack: server.ack, state: server.state });
  }
  // One last lossless snapshot so the comparison is not hostage to the final random loss.
  client.reconcile(server.ack, server.state);
  return { client, server };
}

describe("Predictor.reconcile", () => {
  const world = flatWorld();
  const start = spawnState(0, 0, 0);
  const run = (p: Predictor, n: number, input: Partial<PlayerInput> = { moveZ: 1 }) => {
    for (let i = 0; i < n; i++) p.step({ ...emptyInput(), ...input });
  };

  it("does nothing when the server agrees", () => {
    const p = new Predictor(world, start);
    run(p, 10);
    const predictedAt5 = p.state;
    const mirror = new Predictor(world, start);
    run(mirror, 5);
    expect(p.reconcile(5, mirror.state)).toBeNull();
    expect(p.state).toBe(predictedAt5);
    expect(p.pending).toBe(5); // inputs 6..10 still unacknowledged
    expect(p.corrections).toBe(0);
  });

  it("adopts the server state and replays unacknowledged inputs on a mismatch", () => {
    const p = new Predictor(world, start);
    run(p, 10);
    // The server says that after input 5 we were somewhere else entirely.
    const elsewhere = { ...p.state, x: 3, z: -1, vx: 0, vz: 0 };
    const c = p.reconcile(5, elsewhere);
    expect(c).not.toBeNull();
    expect(p.corrections).toBe(1);
    // Expected: server state + inputs 6..10 replayed.
    let want = elsewhere;
    for (let i = 0; i < 5; i++) want = stepPlayer(want, { ...emptyInput(), moveZ: 1 }, world, DT);
    expect(statesMatch(p.state, want, 1e-12)).toBe(true);
    expect(c?.error).toBeGreaterThan(1);
    expect(p.pending).toBe(5);
  });

  it("ignores a stale (older) snapshot", () => {
    const p = new Predictor(world, start);
    run(p, 10);
    const mirror = new Predictor(world, start);
    run(mirror, 6);
    expect(p.reconcile(6, mirror.state)).toBeNull(); // a fresh, correct ack
    expect(p.reconcile(3, { ...start, x: 99 })).toBeNull(); // an older one arriving late is ignored
    expect(p.corrections).toBe(0);
  });

  it("treats ack 0 as the starting state", () => {
    const p = new Predictor(world, start);
    run(p, 3);
    expect(p.reconcile(0, start)).toBeNull();
    expect(p.pending).toBe(3);
  });

  it("returns the latest inputs oldest first for redundant sends", () => {
    const p = new Predictor(world, start);
    run(p, 5);
    expect(p.recent().map((i) => i.seq)).toEqual([3, 4, 5]);
    expect(p.recent(1).map((i) => i.seq)).toEqual([5]);
  });

  it("caps its history", () => {
    const p = new Predictor(world, start);
    run(p, MAX_HISTORY + 50);
    expect(p.pending).toBe(MAX_HISTORY);
  });

  it("statesMatch compares numbers with a tolerance and flags exactly", () => {
    expect(statesMatch(start, { ...start, x: 1e-6 })).toBe(true);
    expect(statesMatch(start, { ...start, x: 0.01 })).toBe(false);
    expect(statesMatch(start, { ...start, onGround: true })).toBe(false);
  });
});

describe("prediction against a simulated network", () => {
  it("never corrects on a perfect network", () => {
    const { client, server } = simulate({ latency: 5, loss: 0, ticks: 900, seed: 1 });
    expect(client.corrections).toBe(0);
    expect(statesMatch(client.state, server.state, 1e-9)).toBe(true);
  });

  it("never corrects at 160 ms round trip with jitter and 3% loss in both directions", () => {
    // 80 ms each way = 5 ticks; the flags in this repo mean one-way.
    const { client, server } = simulate({ latency: 5, jitter: 2, loss: 0.03, ticks: 900, seed: 2 });
    expect(client.corrections).toBe(0);
    expect(statesMatch(client.state, server.state, 1e-9)).toBe(true);
  });

  it("survives a long lag spike without diverging", () => {
    const { client, server } = simulate({
      latency: 30,
      jitter: 12,
      loss: 0.03,
      ticks: 900,
      seed: 3,
    });
    expect(client.corrections).toBe(0);
    expect(statesMatch(client.state, server.state, 1e-9)).toBe(true);
  });

  it("converges to the server even when most packets are lost", () => {
    const { client, server } = simulate({ latency: 5, jitter: 3, loss: 0.4, ticks: 900, seed: 4 });
    expect(client.corrections).toBeGreaterThan(0); // some inputs never arrived
    expect(statesMatch(client.state, server.state, 1e-9)).toBe(true);
  });

  it("recovers from a server-side teleport (respawn) with one big correction", () => {
    const { client, server } = simulate({
      latency: 5,
      loss: 0.03,
      ticks: 600,
      seed: 5,
      serverEvent: {
        tick: 300,
        apply: (s) => {
          s.state = { ...spawnState(30, 0, -30), airJumps: s.state.airJumps };
        },
      },
    });
    expect(client.corrections).toBeGreaterThanOrEqual(1);
    expect(client.maxError).toBeGreaterThan(2);
    expect(statesMatch(client.state, server.state, 1e-9)).toBe(true);
  });
});
