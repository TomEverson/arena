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
  /** Where the script has it (the strafe), before any knock offset is added. */
  bx: number;
  bz: number;
  /** The knock offset and its speed: a melee blow shoves the dummy, and a spring brings it back. */
  kx: number;
  kz: number;
  ky: number;
  kvx: number;
  kvz: number;
  kvy: number;
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
    bx: t.pos[0],
    bz: t.pos[2],
    kx: 0,
    kz: 0,
    ky: 0,
    kvx: 0,
    kvz: 0,
    kvy: 0,
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
    d.x = d.bx = d.homeX;
    d.z = d.bz = d.homeZ;
    d.y = d.homeY;
    d.kx = d.kz = d.ky = d.kvx = d.kvz = d.kvy = 0;
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
/** A melee blow's shove: speed away from the attacker (a unit direction in XZ), and a hop. */
export function knockDummy(d: Dummy, dirX: number, dirZ: number): void {
  if (d.kind === "wallrun") return; // it stays on its wall
  d.kvx += dirX * W.meleeKnockback;
  d.kvz += dirZ * W.meleeKnockback;
  d.kvy = Math.max(d.kvy, W.meleeKnockUp);
}

/** The server's numbers (server/internal/game/targets.go): a slightly underdamped spring back to the script. */
const KNOCK_SPRING = 25;
const KNOCK_DAMPING = 7;

/** Move the knock offset one step and put the dummy at script plus offset. */
function stepKnock(d: Dummy, dt: number): void {
  if (d.kx === 0 && d.kz === 0 && d.ky === 0 && d.kvx === 0 && d.kvz === 0 && d.kvy === 0) {
    d.x = d.bx;
    d.z = d.bz;
    return;
  }
  d.kvx += (-KNOCK_SPRING * d.kx - KNOCK_DAMPING * d.kvx) * dt;
  d.kvz += (-KNOCK_SPRING * d.kz - KNOCK_DAMPING * d.kvz) * dt;
  d.kx += d.kvx * dt;
  d.kz += d.kvz * dt;
  if (d.ky > 0 || d.kvy > 0) {
    d.kvy -= P.gravity * dt;
    d.ky += d.kvy * dt;
    if (d.ky <= 0) d.ky = d.kvy = 0;
  }
  if (
    Math.abs(d.kx) < 1e-4 &&
    Math.abs(d.kz) < 1e-4 &&
    Math.abs(d.kvx) < 1e-3 &&
    Math.abs(d.kvz) < 1e-3 &&
    d.ky === 0
  ) {
    d.kx = d.kz = d.kvx = d.kvz = 0;
  }
  d.x = d.bx + d.kx;
  d.z = d.bz + d.kz;
  d.y = d.homeY + d.ky;
}

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
        d.x = d.bx = d.homeX;
        d.z = d.bz = d.homeZ;
        d.y = d.homeY;
        d.kx = d.kz = d.ky = d.kvx = d.kvz = d.kvy = 0;
        d.runT = 0;
        placeOnWall(d);
      }
      continue;
    }
    if (d.kind === "static") {
      stepKnock(d, dt);
      continue;
    }
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
    let p = (d.axis === "x" ? d.bx : d.bz) + d.dir * COMBAT.targetSpeed * dt;
    if (p > home + d.range) {
      p = home + d.range;
      d.dir = -1;
    } else if (p < home - d.range) {
      p = home - d.range;
      d.dir = 1;
    }
    if (d.axis === "x") d.bx = p;
    else d.bz = p;
    stepKnock(d, dt);
  }
}

export const DUMMY_HEIGHT = HEIGHT;
export const DUMMY_HALF_WIDTH = HALF_WIDTH;
