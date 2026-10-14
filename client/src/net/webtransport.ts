import type { Transport, TransportFactory } from "./transport";

/**
 * The WebTransport connection (QUIC over UDP), matching server/internal/gameserver/webtransport.go:
 *
 *   - One bidirectional stream, opened by the client, carries the messages that must arrive
 *     (the welcome; hero, respawn, rematch and practice requests). Each is a 4-byte big-endian
 *     length followed by the message. The client's first frame is empty: it only opens the stream.
 *   - Datagrams carry the messages that may be lost (inputs and pings up; snapshots and pongs
 *     down), one message per datagram.
 *   - A message too big for a datagram travels on a one-way stream of its own, closed after it.
 *     It still arrives without waiting for anything else, just not in a single packet.
 */

/** Messages up to this size go as a datagram (a QUIC packet carries about 1200 bytes). */
export const MAX_DATAGRAM = 1100;
/** A reliable frame or a one-message stream bigger than this is a broken peer. */
const MAX_MESSAGE = 1 << 20;

/** A 4-byte big-endian length, then the bytes. */
export function frame(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** Collects stream chunks and hands back each complete frame's bytes (empty frames are skipped). */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const size = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0);
      if (size > MAX_MESSAGE) throw new Error(`frame of ${size} bytes`);
      if (this.buf.length < 4 + size) break;
      if (size > 0) out.push(this.buf.slice(4, 4 + size));
      this.buf = this.buf.slice(4 + size);
    }
    return out;
  }
}

/** base64 (as the server's /api/transport gives a certificate hash) to bytes. */
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Can this browser do it at all? */
export const hasWebTransport = (): boolean => typeof WebTransport !== "undefined";

/**
 * `certHash` is for development only: the server's self-signed certificate, which the browser
 * accepts by its SHA-256 hash (base64). In production the server has a real certificate and
 * this is empty.
 */
export function webTransportTransport(url: string, certHash = ""): TransportFactory {
  return (handlers) => {
    let closed = false;
    let reliable: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let datagrams: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const done = (code: number) => {
      if (closed) return;
      closed = true;
      handlers.onClose(code);
    };
    const wt = new WebTransport(url, {
      congestionControl: "low-latency",
      ...(certHash
        ? { serverCertificateHashes: [{ algorithm: "sha-256", value: base64Bytes(certHash) }] }
        : {}),
    });
    wt.closed.then(
      (info) => done(info.closeCode ?? 0),
      () => done(0),
    );

    const readAll = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = stream.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        size += value.length;
        if (size > MAX_MESSAGE) return;
        chunks.push(value);
      }
      const whole = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        whole.set(c, at);
        at += c.length;
      }
      if (size > 0 && !closed) handlers.onMessage(whole);
    };
    const pump = async <T>(stream: ReadableStream<T>, each: (value: T) => void) => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end || closed) return;
        each(value);
      }
    };

    void (async () => {
      await wt.ready;
      const control = await wt.createBidirectionalStream();
      reliable = control.writable.getWriter();
      void reliable.write(frame(new Uint8Array(0))); // opens the stream: the server answers with the welcome
      datagrams = wt.datagrams.writable.getWriter();
      const frames = new FrameReader();
      void pump(control.readable as ReadableStream<Uint8Array>, (chunk) => {
        for (const msg of frames.push(chunk)) handlers.onMessage(msg);
      }).catch(() => undefined);
      void pump(wt.datagrams.readable as ReadableStream<Uint8Array>, (d) =>
        handlers.onMessage(d),
      ).catch(() => undefined);
      void pump(
        wt.incomingUnidirectionalStreams as ReadableStream<ReadableStream<Uint8Array>>,
        (s) => {
          void readAll(s).catch(() => undefined);
        },
      ).catch(() => undefined);
      handlers.onOpen();
    })().catch(() => done(0));

    const transport: Transport = {
      sendReliable(bytes) {
        void reliable?.write(frame(bytes)).catch(() => undefined);
      },
      sendUnreliable(bytes) {
        if (!datagrams) return;
        if (bytes.length <= Math.min(MAX_DATAGRAM, wt.datagrams.maxDatagramSize)) {
          void datagrams.write(bytes).catch(() => undefined);
          return;
        }
        void wt
          .createUnidirectionalStream()
          .then(async (stream) => {
            const w = (stream as WritableStream<Uint8Array>).getWriter();
            await w.write(bytes);
            await w.close();
          })
          .catch(() => undefined);
      },
      close() {
        try {
          wt.close();
        } catch {
          // already closed
        }
      },
    };
    return transport;
  };
}
