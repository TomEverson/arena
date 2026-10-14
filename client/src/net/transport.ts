/**
 * How bytes get to the server and back. The game talks to a `Transport` and does not care which
 * one it has:
 *
 *   WebTransport (webtransport.ts)  what browsers use: QUIC over UDP. Messages that may be lost
 *                                   (inputs, pings, snapshots) travel as datagrams, so a lost
 *                                   packet never holds up the ones after it.
 *   WebSocket (below)               one ordered TCP stream, where "may be lost" has no meaning:
 *                                   everything arrives. Used by the headless test players
 *                                   (Node has no WebTransport) and with `?transport=ws`.
 */

export interface TransportHandlers {
  /** Connected: messages can be sent. */
  onOpen(): void;
  /** One whole message from the server: binary (MessagePack), or text (the JSON test codec). */
  onMessage(data: Uint8Array | string): void;
  /** Closed, or never opened. `code` is the server's reason (see rooms.ts), or 0. */
  onClose(code: number): void;
}

export interface Transport {
  /** Send a message that must arrive, in order (choosing a hero, a rematch vote). */
  sendReliable(bytes: Uint8Array): void;
  /** Send a message that may be lost or arrive late (inputs, pings): never waits for older ones. */
  sendUnreliable(bytes: Uint8Array): void;
  close(): void;
}

/** Opens a connection and reports to `handlers`. */
export type TransportFactory = (handlers: TransportHandlers) => Transport;

export function webSocketTransport(url: string): TransportFactory {
  return (handlers) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => handlers.onOpen();
    ws.onclose = (ev) => handlers.onClose(ev.code);
    ws.onmessage = (ev) =>
      handlers.onMessage(
        typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer),
      );
    const send = (bytes: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes as Uint8Array<ArrayBuffer>);
    };
    return { sendReliable: send, sendUnreliable: send, close: () => ws.close() };
  };
}
