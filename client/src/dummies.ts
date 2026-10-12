/**
 * Practice dummies for gunplay tuning. Client-only: in the real game, targets
 * are other players simulated by the server.
 */
import type { Hitbox } from "./sim/hitscan";
import type { LevelTarget } from "./sim/level";
import { COMBAT, PARAMS as P, WEAPON as W } from "./sim/params";
import { fullHealth, type Health } from "./sim/weapon";

const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;

export interface Dummy extends Health {
  id: number;
  name: string;
  kind: LevelTarget["kind"];
  axis: "x" | "z";
  range: number;
  homeX: number;
  homeZ: number;
  homeY: number;
  x: number;
  y: number;
  z: number;
  dir: 1 | -1;
  /** Seconds into the current pass along the wall (wallrun targets). */
  runT: number;
  alive: boolean;
  respawnIn: number;
  /** Sim time of the first hit of the current life; null until hit. */
  firstHitAt: number | null;
  /** Total shots fired by the player when this life took its first hit. */
  shotsAtFirstHit: number;
  hits: number;
  headshots: number;
}

export function makeDummies(targets: readonly LevelTarget[]): Dummy[] {
  const list: Dummy[] = targets.map((t, i) => ({
    id: i,
    name: t.id,
    kind: t.kind,
    axis: t.axis,
    range: t.range,
    homeX: t.pos[0],
    homeZ: t.pos[2],
    homeY: t.pos[1],
    x: t.pos[0],
    y: t.pos[1],
    z: t.pos[2],
    dir: 1 as const,
    runT: 0,
    alive: true,
    respawnIn: 0,
    firstHitAt: null,
    shotsAtFirstHit: 0,
    hits: 0,
    headshots: 0,
    ...fullHealth(),
  }));
  for (const d of list) placeOnWall(d); // wall runners start at one end of their run
  return list;
}

export function hitboxOf(d: Dummy): Hitbox {
  return {
    id: d.id,
    headMinY: d.y + HEIGHT - COMBAT.headSize,
    minX: d.x - HALF_WIDTH,
    maxX: d.x + HALF_WIDTH,
    minY: d.y,
    maxY: d.y + HEIGHT,
    minZ: d.z - HALF_WIDTH,
    maxZ: d.z + HALF_WIDTH,
  };
}

export function aliveHitboxes(dummies: readonly Dummy[]): Hitbox[] {
  return dummies.filter((d) => d.alive).map(hitboxOf);
}

/**
 * How far above its wall-run line a wall runner is `tau` seconds into a pass: the same rise and
 * slow fall as the player's wall run, tilted so the pass ends at the height it began.
 */
export function wallRunArc(tau: number): number {
  const f = (t: number) => P.wallRunMaxRise * t - 0.5 * P.gravity * P.wallRunGravityScale * t * t;
  return f(tau) - (f(P.wallRunMaxTime) * tau) / P.wallRunMaxTime;
}

/** Put a wall-running dummy where its pass has got to (it runs end to end in wallRunMaxTime). */
function placeOnWall(d: Dummy): void {
  if (d.kind !== "wallrun") return;
  const off = d.dir * d.range * (2 * (d.runT / P.wallRunMaxTime) - 1);
  if (d.axis === "x") d.x = d.homeX + off;
  else d.z = d.homeZ + off;
  d.y = d.homeY + wallRunArc(d.runT);
}

/** Practice-range reset: every dummy back at home with full health. */
export function resetDummies(dummies: Dummy[]): void {
  for (const d of dummies) {
    d.alive = true;
    d.respawnIn = 0;
    d.health = W.maxHealth;
    d.shield = W.maxShield;
    d.x = d.homeX;
    d.z = d.homeZ;
    d.dir = 1;
    d.runT = 0;
    placeOnWall(d);
    d.firstHitAt = null;
    d.hits = 0;
    d.headshots = 0;
  }
}

export function killDummy(d: Dummy): void {
  d.alive = false;
  d.respawnIn = COMBAT.targetRespawn;
}

/** Move strafing dummies and respawn dead ones. `frozen` is true during hitstop. */
export function stepDummies(dummies: Dummy[], dt: number, frozen: boolean): void {
  if (frozen) return;
  for (const d of dummies) {
    if (!d.alive) {
      d.respawnIn -= dt;
      if (d.respawnIn <= 0) {
        d.alive = true;
        d.health = W.maxHealth;
        d.shield = W.maxShield;
        d.firstHitAt = null;
        d.hits = 0;
        d.headshots = 0;
        d.x = d.homeX;
        d.z = d.homeZ;
        d.runT = 0;
        placeOnWall(d);
      }
      continue;
    }
    if (d.kind === "static") continue;
    if (d.kind === "wallrun") {
      d.runT += dt;
      if (d.runT >= P.wallRunMaxTime) {
        d.runT -= P.wallRunMaxTime;
        d.dir = d.dir === 1 ? -1 : 1;
      }
      placeOnWall(d);
      continue;
    }
    const home = d.axis === "x" ? d.homeX : d.homeZ;
    let p = (d.axis === "x" ? d.x : d.z) + d.dir * COMBAT.targetSpeed * dt;
    if (p > home + d.range) {
      p = home + d.range;
      d.dir = -1;
    } else if (p < home - d.range) {
      p = home - d.range;
      d.dir = 1;
    }
    if (d.axis === "x") d.x = p;
    else d.z = p;
  }
}

export const DUMMY_HEIGHT = HEIGHT;
export const DUMMY_HALF_WIDTH = HALF_WIDTH;
