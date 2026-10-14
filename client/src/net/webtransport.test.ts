import { describe, expect, it } from "vitest";

import { base64Bytes, frame, FrameReader } from "./webtransport";

describe("reliable frames", () => {
  it("prefix a message with its length, big-endian", () => {
    expect([...frame(new Uint8Array([7, 8, 9]))]).toEqual([0, 0, 0, 3, 7, 8, 9]);
  });

  it("come back whole however the stream cuts them up", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array(300).fill(5);
    const stream = new Uint8Array([...frame(a), ...frame(new Uint8Array(0)), ...frame(b)]);
    const reader = new FrameReader();
    const out: Uint8Array[] = [];
    for (let at = 0; at < stream.length; at += 7)
      out.push(...reader.push(stream.slice(at, at + 7)));
    expect(out).toHaveLength(2); // the empty frame is skipped
    expect([...(out[0] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(out[1]).toHaveLength(300);
  });

  it("refuse an absurd length", () => {
    expect(() => new FrameReader().push(new Uint8Array([255, 255, 255, 255, 0]))).toThrow();
  });
});

describe("base64Bytes", () => {
  it("decodes a certificate hash", () => {
    expect([...base64Bytes("AQID/w==")]).toEqual([1, 2, 3, 255]);
  });
});
