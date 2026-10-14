import { decode, encode } from "@msgpack/msgpack";

import {
  type ClientMessage,
  type Input,
  packClientMessage,
  parseServerMessage,
  type SnapshotMessage,
  unpackServerMessage,
  type WelcomeMessage,
} from "./protocol.gen";
import { type Transport, type TransportFactory, webSocketTransport } from "./transport";

export interface NetStats {
  /** Smoothed round-trip time and its jitter (ms). */
  rttMs: number;
  jitterMs: number;
  snapshotsPerSecond: number;
  /** Size of the most recently received snapshot, useful for tuning replication. */
  snapshotBytes: number;
  /** Inputs of ours the server still has queued (from the latest snapshot). */
  queued: number;
}

export interface NetHandlers {
  onWelcome(w: WelcomeMessage): void;
  onSnapshot(s: SnapshotMessage): void;
  /**
   * The socket closed or never opened. `wasConnected` tells whether we ever got a welcome;
   * `code` is the WebSocket close code (4001 room not found, 4002 room full).
   */
  onClose(wasConnected: boolean, code: number): void;
}

const PING_EVERY_MS = 500;

/**
 * The connection to the game server: parsing, ping/RTT, snapshot rate, and which messages may be
 * lost. No game logic. It runs over any Transport (transport.ts); a plain URL means a WebSocket.
 *
 * Snapshots can arrive late or twice or not at all, so an old one is dropped here (the game only
 * ever sees them in order), and every input message says which snapshot we have got: the server
 * repeats what we have not acknowledged.
 */
export class NetClient {
  state: "connecting" | "open" | "closed" = "connecting";
  playerId: number | null = null;
  readonly stats: NetStats = {
    rttMs: 0,
    jitterMs: 0,
    snapshotsPerSecond: 0,
    snapshotBytes: 0,
    queued: 0,
  };

  private readonly transport: Transport;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private snapshotTimes: number[] = [];
  private gotRtt = false;
  /** The tick of the newest snapshot handed to the game (0: none yet). */
  private snapshotTick = 0;

  constructor(
    connect: string | TransportFactory,
    private readonly handlers: NetHandlers,
  ) {
    const factory = typeof connect === "string" ? webSocketTransport(connect) : connect;
    this.transport = factory({
      onOpen: () => {
        this.state = "open";
        this.ping();
        this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
      },
      onClose: (code) => {
        const wasConnected = this.playerId !== null;
        this.state = "closed";
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.handlers.onClose(wasConnected, code);
      },
      onMessage: (data) => this.receive(data),
    });
  }

  private receive(data: Uint8Array | string): void {
    const msg =
      typeof data === "string" ? parseServerMessage(data) : unpackServerMessage(decode(data));
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        this.playerId = msg.playerId;
        this.handlers.onWelcome(msg);
        break;
      case "snapshot": {
        if (msg.tick <= this.snapshotTick) return; // late or repeated: a newer one has been used
        this.snapshotTick = msg.tick;
        const now = performance.now();
        this.stats.snapshotBytes = data.length;
        this.snapshotTimes.push(now);
        while (this.snapshotTimes.length > 0 && now - (this.snapshotTimes[0] as number) > 1000)
          this.snapshotTimes.shift();
        this.stats.snapshotsPerSecond = this.snapshotTimes.length;
        this.stats.queued = msg.queued;
        this.handlers.onSnapshot(msg);
        break;
      }
      case "pong": {
        const rtt = performance.now() - msg.t;
        if (!this.gotRtt) {
          this.stats.rttMs = rtt;
          this.gotRtt = true;
        } else {
          this.stats.jitterMs += (Math.abs(rtt - this.stats.rttMs) - this.stats.jitterMs) * 0.2;
          this.stats.rttMs += (rtt - this.stats.rttMs) * 0.2;
        }
        break;
      }
    }
  }

  /** `lossy`: this message may be lost (it will be sent again, or does not matter by then). */
  private send(msg: ClientMessage, lossy = false): void {
    if (this.state !== "open") return;
    const bytes = encode(packClientMessage(msg));
    if (lossy) this.transport.sendUnreliable(bytes);
    else this.transport.sendReliable(bytes);
  }

  private ping(): void {
    this.send({ type: "ping", t: performance.now() }, true);
  }

  sendInputs(inputs: Input[]): void {
    this.send({ type: "input", inputs, ack: this.snapshotTick }, true);
  }

  sendRespawn(): void {
    this.send({ type: "respawn" });
  }

  /** A practice-range helper: refill health and ammo, back to the course start, or reset the targets. */
  sendPractice(action: "refill" | "start" | "reset"): void {
    this.send({ type: "practice", action });
  }

  /** Choose a hero (one of HeroKinds). The server decides when it takes effect. */
  sendHero(hero: number): void {
    this.send({ type: "hero", hero });
  }

  /** Vote for another match while the results are showing. */
  sendRematch(): void {
    this.send({ type: "rematch" });
  }

  close(): void {
    this.transport.close();
  }
}
