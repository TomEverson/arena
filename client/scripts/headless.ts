/**
 * Headless players for end-to-end checks. A BotClient is the browser client minus the
 * renderer: the same NetClient, Predictor, ServerClock and RemoteTracks, driven by a
 * "brain" function instead of a keyboard and mouse.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FixedTimestep } from "../src/loop";
import { canAct } from "../src/matchui";
import { NetClient } from "../src/net/client";
import { ServerClock } from "../src/net/clock";
import { EventTracker } from "../src/net/events";
import { INTERP_TICKS, RemoteTracks } from "../src/net/interpolation";
import { Predictor } from "../src/net/prediction";
import {
  EventKinds,
  GameEventFlags,
  type MatchInfo,
  type PlayerHealth,
  type Score,
} from "../src/net/protocol.gen";
import { type CollisionWorld, emptyInput, type PlayerInput } from "../src/sim/types";

const serverDir = fileURLToPath(new URL("../../server/", import.meta.url));
const bin = "/tmp/arena-check-server";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startServer(
  port: number,
  latency: string,
  loss: string,
  level = "greybox",
  extraArgs: string[] = [],
): Promise<ChildProcess> {
  console.log("building server...");
  execFileSync("go", ["build", "-o", bin, "./cmd/server"], { cwd: serverDir, stdio: "inherit" });
  const child = spawn(
    bin,
    [
      `--addr=:${port}`,
      `--level=../levels/${level}.json`,
      `--fake-latency=${latency}`,
      `--loss=${loss}`,
      ...extraArgs,
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

/** Ask the server for a new room and return its code (the same call the browser makes). */
export async function createRoom(port: number, mode: "ffa" | "practice" = "ffa"): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`could not create a room: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}

/** What a brain decides each tick: movement and look direction, plus buttons. */
export type BrainOutput = Partial<PlayerInput> & { pitch?: number };
export type Brain = (bot: BotClient, tick: number) => BrainOutput;

export interface BotStats {
  /** Shots the bot's own weapon fired. */
  shots: number;
  /** Times we were hit by someone (hurt events). */
  hurt: number;
  /** Server-confirmed hits, headshots among them, and kills and deaths. */
  hits: number;
  headshots: number;
  kills: number;
  deaths: number;
  /** Times the server brought us back to life. */
  respawns: number;
  /** Kill-feed events (kills by anyone) received. */
  killFeed: number;
  /** Shots the server consumed after the kill that ended an engagement: they cannot register. */
  wasted: number;
  reconciled: number;
  inputsSent: number;
}

export class BotClient {
  readonly remotes = new RemoteTracks();
  readonly clock = new ServerClock();
  readonly events = new EventTracker();
  readonly net: NetClient;
  predictor: Predictor | null = null;
  health: PlayerHealth | null = null;
  match: MatchInfo | null = null;
  scores: Score[] = [];
  /** Every distinct match phase seen, in order, with the time it first appeared. */
  readonly phases: { phase: number; at: number }[] = [];
  readonly stats: BotStats = {
    shots: 0,
    hurt: 0,
    hits: 0,
    headshots: 0,
    kills: 0,
    deaths: 0,
    respawns: 0,
    killFeed: 0,
    wasted: 0,
    reconciled: 0,
    inputsSent: 0,
  };

  private tick = 0;
  private running = true;
  private readonly acks: { tick: number; ack: number }[] = [];
  private readonly shotSeqs: number[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    readonly name: string,
    port: number,
    room: string,
    private readonly world: CollisionWorld,
    private readonly brain: Brain,
    /** False sends no view tick, so the server does no lag compensation for our shots. */
    private readonly compensate = true,
  ) {
    this.net = new NetClient(`ws://localhost:${port}/ws?room=${room}`, {
      onWelcome: () => {},
      onSnapshot: (s) => {
        const wasAlive = this.health?.alive ?? true;
        this.clock.onSnapshot(s.tick, performance.now());
        this.remotes.push(s.tick, s.entities, s.removed, s.full);
        this.health = s.health;
        this.match = s.match;
        this.scores = s.scores;
        if (this.phases[this.phases.length - 1]?.phase !== s.match.phase) {
          this.phases.push({ phase: s.match.phase, at: performance.now() });
        }
        this.acks.push({ tick: s.tick, ack: s.ackSeq });
        if (this.acks.length > 300) this.acks.shift();
        if (!wasAlive && s.health.alive) this.stats.respawns++;
        for (const e of this.events.fresh(s.events)) {
          this.onEvent(e.kind, e.flags, e.actor, e.other, e.tick);
        }
        if (!this.predictor) {
          this.predictor = new Predictor(this.world, s.you, s.ackSeq, 1 / 60, s.weapon);
          this.predictor.alive = s.health.alive && canAct(s.match.phase);
        } else {
          this.predictor.reconcile(
            s.ackSeq,
            s.you,
            s.weapon,
            s.health.alive && canAct(s.match.phase),
          );
          this.stats.reconciled++;
        }
      },
      onClose: () => {},
    });
    const loop = new FixedTimestep(() => this.step());
    this.timer = setInterval(() => loop.advance(performance.now()), 4);
  }

  get id(): number {
    return this.net.playerId ?? -1;
  }

  /** The server tick our screen is currently showing other players at. */
  get renderTick(): number {
    return this.clock.tickAt(performance.now()) - INTERP_TICKS;
  }

  private onEvent(kind: number, flags: number, actor: number, other: number, tick: number): void {
    if (kind === EventKinds.hurt) {
      this.stats.hurt++;
    } else if (kind === EventKinds.hit) {
      this.stats.hits++;
      if (flags & GameEventFlags.headshot) this.stats.headshots++;
    } else if (kind === EventKinds.kill) {
      this.stats.killFeed++;
      if (actor === this.id) this.stats.kills++;
      if (other === this.id) this.stats.deaths++;
      if (actor === this.id || other === this.id) this.countWastedShots(tick);
    }
  }

  /**
   * A kill ended an engagement at server tick `killTick`. Any shot of ours that the server
   * consumed after that went to a dead target (or came from a dead player): it cannot register.
   */
  private countWastedShots(killTick: number): void {
    const at = this.acks.find((a) => a.tick >= killTick);
    if (!at) return;
    this.stats.wasted += this.shotSeqs.filter((seq) => seq > at.ack).length;
    this.shotSeqs.length = 0;
  }

  private step(): void {
    if (!this.predictor || !this.running) return;
    const out = this.brain(this, this.tick++);
    const { pitch = 0, ...rest } = out;
    const viewTick = this.compensate && this.clock.ready ? this.renderTick : 0;
    const sent = this.predictor.step({ ...emptyInput(), ...rest }, pitch, viewTick);
    this.net.sendInputs(this.predictor.recent());
    this.stats.inputsSent++;
    if (this.predictor.lastShot?.fired) {
      this.stats.shots++;
      this.shotSeqs.push(sent.seq);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** A practice-range helper (ignored outside a practice room). */
  practice(action: "refill" | "start" | "reset"): void {
    this.net.sendPractice(action);
  }

  /** Vote for a rematch (only counts while the results are showing). */
  rematch(): void {
    this.net.sendRematch();
  }

  close(): void {
    clearInterval(this.timer);
    this.net.close();
  }
}
