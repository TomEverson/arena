import { describe, expect, it } from "vitest";

import { ServerClock, TICK_MS } from "./clock";
import { EventTracker } from "./events";
import { INTERP_TICKS, interpolationTicks, lerpAngle, RemoteTracks } from "./interpolation";
import type { Entity, GameEvent } from "./protocol.gen";
import { CorrectionSmoother, SMOOTH_TIME, SNAP_DISTANCE } from "./smoothing";

const ent = (id: number, x: number, extra: Partial<Entity> = {}): Entity => ({
  id,
  teamId: id,
  x,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  flags: 0,
  kind: 0,
  hero: 0,
  ...extra,
});

describe("RemoteTracks", () => {
  it("adds interpolation buffer only when jitter is elevated", () => {
    expect(interpolationTicks(0)).toBe(INTERP_TICKS);
    expect(interpolationTicks(8)).toBe(INTERP_TICKS);
    expect(interpolationTicks(20)).toBe(INTERP_TICKS + 1);
    expect(interpolationTicks(200)).toBe(10);
  });

  it("interpolates between two snapshots", () => {
    const t = new RemoteTracks();
    t.push(10, [ent(2, 0)]);
    t.push(12, [ent(2, 10)]);
    expect(t.sample(2, 11)?.x).toBeCloseTo(5, 9);
    expect(t.sample(2, 10.5)?.x).toBeCloseTo(2.5, 9);
  });

  it("holds the nearest sample outside the known range", () => {
    const t = new RemoteTracks();
    t.push(10, [ent(2, 1)]);
    t.push(12, [ent(2, 3)]);
    expect(t.sample(2, 5)?.x).toBe(1);
    expect(t.sample(2, 99)?.x).toBe(3);
  });

  it("turns yaw the short way round", () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI - 0.1415926535 + 0.1415926535 - 0.0, 1);
    const mid = lerpAngle(3.0, -3.0, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.01); // near +-pi, not near 0
  });

  it("ignores duplicate and out-of-order snapshots", () => {
    const t = new RemoteTracks();
    t.push(10, [ent(2, 1)]);
    t.push(12, [ent(2, 3)]);
    t.push(11, [ent(2, 99)]);
    t.push(12, [ent(2, 99)]);
    expect(t.sample(2, 11)?.x).toBeCloseTo(2, 9);
  });

  it("forgets players that stopped appearing, keeps ones that are still there", () => {
    const t = new RemoteTracks();
    t.push(10, [ent(2, 1), ent(3, 1)]);
    for (let tick = 12; tick <= 80; tick += 2) t.push(tick, [ent(3, 1)]);
    expect(t.ids()).toEqual([3]);
  });

  it("uses the earlier sample's posture flags", () => {
    const t = new RemoteTracks();
    t.push(10, [ent(2, 0, { flags: 1 })]);
    t.push(12, [ent(2, 4, { flags: 2 })]);
    expect(t.sample(2, 11)?.flags).toBe(1);
  });

  it("renders remote players about 100 ms behind", () => {
    expect(INTERP_TICKS * TICK_MS).toBeCloseTo(100, 5);
  });
});

describe("ServerClock", () => {
  it("tracks the server tick from snapshot arrivals", () => {
    const c = new ServerClock();
    expect(c.ready).toBe(false);
    for (let tick = 2; tick <= 100; tick += 2) c.onSnapshot(tick, 1000 + tick * TICK_MS + 80);
    expect(c.tickAt(1000 + 100 * TICK_MS + 80)).toBeCloseTo(100, 3);
    expect(c.tickAt(1000 + 130 * TICK_MS + 80)).toBeCloseTo(130, 3);
  });

  it("is not thrown off by one badly delayed snapshot", () => {
    const c = new ServerClock();
    for (let tick = 2; tick <= 60; tick += 2) c.onSnapshot(tick, tick * TICK_MS + 80);
    const before = c.tickAt(5000);
    c.onSnapshot(62, 62 * TICK_MS + 80 + 300); // 300 ms late
    expect(Math.abs(c.tickAt(5000) - before)).toBeLessThan(0.5);
  });

  it("follows quickly when snapshots start arriving earlier", () => {
    const c = new ServerClock();
    for (let tick = 2; tick <= 40; tick += 2) c.onSnapshot(tick, tick * TICK_MS + 200);
    for (let tick = 42; tick <= 60; tick += 2) c.onSnapshot(tick, tick * TICK_MS + 40);
    expect(c.tickAt(60 * TICK_MS + 40)).toBeGreaterThan(59);
  });
});

describe("CorrectionSmoother", () => {
  const correction = (dx: number) => ({
    ackSeq: 1,
    error: Math.abs(dx),
    before: { x: dx, y: 0, z: 0 },
    after: { x: 0, y: 0, z: 0 },
  });

  it("keeps the view where it was, then fades", () => {
    const s = new CorrectionSmoother();
    s.onCorrection(correction(0.5)); // predicted position jumped back by 0.5 m
    expect(s.x).toBeCloseTo(0.5, 9); // offset cancels the jump: view continuous
    for (let i = 0; i < 30; i++) s.update(1 / 60);
    expect(Math.abs(s.x)).toBeLessThan(0.5 * Math.exp(-0.5 / SMOOTH_TIME) + 1e-6);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.x).toBe(0);
  });

  it("snaps instead of blending a teleport", () => {
    const s = new CorrectionSmoother();
    s.onCorrection(correction(SNAP_DISTANCE + 5));
    expect(s.x).toBe(0);
  });

  it("can be told to blend a big shove (a melee knockback) more gently instead of snapping", () => {
    const s = new CorrectionSmoother();
    s.snapDistance = 6;
    s.smoothTime = 0.2;
    s.onCorrection(correction(SNAP_DISTANCE + 1)); // would have snapped by default
    expect(s.x).toBeCloseTo(SNAP_DISTANCE + 1, 9);
    for (let i = 0; i < 12; i++) s.update(1 / 60); // 0.2 s: down to about 1/e, slower than the default
    expect(s.x).toBeGreaterThan((SNAP_DISTANCE + 1) * Math.exp(-0.2 / SMOOTH_TIME));
  });
});

describe("EventTracker", () => {
  const ev = (seq: number): GameEvent => ({
    seq,
    tick: seq,
    kind: 1,
    actor: 1,
    other: 2,
    amount: 9,
    flags: 0,
    health: 100,
    shield: 41,
  });

  it("hands back each event once, even when snapshots resend it", () => {
    const t = new EventTracker();
    expect(t.fresh([ev(1), ev(2)]).map((e) => e.seq)).toEqual([1, 2]);
    expect(t.fresh([ev(1), ev(2), ev(3)]).map((e) => e.seq)).toEqual([3]);
    expect(t.fresh([ev(2), ev(3)])).toEqual([]);
  });

  it("sorts oldest first and tolerates a snapshot that arrives late", () => {
    const t = new EventTracker();
    expect(t.fresh([ev(5), ev(4)]).map((e) => e.seq)).toEqual([4, 5]);
    expect(t.fresh([ev(3)])).toEqual([]); // older than what we already handled
  });
});
