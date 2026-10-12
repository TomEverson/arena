/** Minimal connection to the game server through the Vite /ws proxy. */
export interface NetStatus {
  state: "connecting" | "open" | "closed";
  playerId: number | null;
  serverTick: number | null;
}

export function connect(onChange: (s: NetStatus) => void): void {
  const status: NetStatus = { state: "connecting", playerId: null, serverTick: null };
  const emit = () => onChange({ ...status });
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    status.state = "open";
    emit();
  };
  ws.onclose = () => {
    status.state = "closed";
    emit();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as { type: string; playerId?: number; tick?: number };
    if (msg.type === "welcome" && msg.playerId !== undefined) status.playerId = msg.playerId;
    if (msg.type === "snapshot" && msg.tick !== undefined) status.serverTick = msg.tick;
    emit();
  };
  emit();
}
