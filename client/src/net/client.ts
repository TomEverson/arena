import {
  type ClientMessage,
  type Input,
  parseServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "./protocol.gen";

export interface NetStats {
  /** Smoothed round-trip time and its jitter (ms). */
  rttMs: number;
  jitterMs: number;
  snapshotsPerSecond: number;
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

/** Thin WebSocket wrapper: parsing, ping/RTT, snapshot rate. No game logic. */
export class NetClient {
  state: "connecting" | "open" | "closed" = "connecting";
  playerId: number | null = null;
  readonly stats: NetStats = { rttMs: 0, jitterMs: 0, snapshotsPerSecond: 0, queued: 0 };

  private readonly ws: WebSocket;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private snapshotTimes: number[] = [];
  private gotRtt = false;

  constructor(
    url: string,
    private readonly handlers: NetHandlers,
  ) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.state = "open";
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    };
    this.ws.onclose = (ev) => {
      const wasConnected = this.playerId !== null;
      this.state = "closed";
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.handlers.onClose(wasConnected, ev.code);
    };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      switch (msg.type) {
        case "welcome":
          this.playerId = msg.playerId;
          this.handlers.onWelcome(msg);
          break;
        case "snapshot": {
          const now = performance.now();
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
    };
  }

  private send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.send({ type: "ping", t: performance.now() });
  }

  sendInputs(inputs: Input[]): void {
    this.send({ type: "input", inputs });
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
    this.ws.close();
  }
}
