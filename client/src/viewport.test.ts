import { describe, expect, it } from "vitest";

import { letterbox, ndcToScreen } from "./viewport";

describe("letterbox", () => {
  it("fills a canvas of the same shape", () => {
    expect(letterbox(1280, 720, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(letterbox(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("adds bars top and bottom for a taller window, keeping the 16:9 picture centred", () => {
    const b = letterbox(1000, 1000, 1280, 720);
    expect(b.w).toBe(1000);
    expect(b.h).toBe(562);
    expect(b.x).toBe(0);
    expect(b.y).toBe(219);
  });

  it("adds bars at the sides for a very wide window", () => {
    const b = letterbox(2000, 720, 1280, 720);
    expect(b.h).toBe(720);
    expect(b.w).toBe(1280);
    expect(b.x).toBe(360);
    expect(b.y).toBe(0);
  });
});

describe("ndcToScreen", () => {
  const box = { x: 100, y: 50, w: 800, h: 400 };

  it("maps the centre, corners and axes (y flips: up on screen is smaller y)", () => {
    expect(ndcToScreen(0, 0, 0.5, box)).toEqual({ x: 500, y: 250 });
    expect(ndcToScreen(-1, 1, 0.5, box)).toEqual({ x: 100, y: 50 });
    expect(ndcToScreen(1, -1, 0.5, box)).toEqual({ x: 900, y: 450 });
    expect(ndcToScreen(0, 0.5, 0.5, box)?.y).toBeLessThan(250);
  });

  it("rejects points behind the camera or off screen", () => {
    expect(ndcToScreen(0, 0, 1.2, box)).toBeNull();
    expect(ndcToScreen(1.5, 0, 0.5, box)).toBeNull();
    expect(ndcToScreen(0, -1.01, 0.5, box)).toBeNull();
  });
});
