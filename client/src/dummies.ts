/**
 * Practice dummies for gunplay tuning. Client-only: in the real game, targets
 * are other players simulated by the server.
 */
import type { Hitbox } from "./sim/hitscan";
import type { LevelTarget } from "./sim/level";
import { COMBAT, WEAPON as W } from "./sim/params";
import { fullHealth, type Health } from "./sim/weapon";

const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
const STRAFE_SPEED = 3.5;
const RESPAWN_SECONDS = 2;

export interface Dummy extends Health {
  id: number;
  name: string;
  kind: LevelTarget["kind"];
  axis: "x" | "z";
  range: number;
  homeX: number;
  homeZ: number;
  x: number;
  y: number;
  z: number;
  dir: 1 | -1;
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
  return targets.map((t, i) => ({
    id: i,
    name: t.id,
    kind: t.kind,
    axis: t.axis,
    range: t.range,
    homeX: t.pos[0],
    homeZ: t.pos[2],
    x: t.pos[0],
    y: t.pos[1],
    z: t.pos[2],
    dir: 1,
    alive: true,
    respawnIn: 0,
    firstHitAt: null,
    shotsAtFirstHit: 0,
    hits: 0,
    headshots: 0,
    ...fullHealth(),
  }));
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

export function killDummy(d: Dummy): void {
  d.alive = false;
  d.respawnIn = RESPAWN_SECONDS;
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
      }
      continue;
    }
    if (d.kind !== "strafe") continue;
    const home = d.axis === "x" ? d.homeX : d.homeZ;
    let p = (d.axis === "x" ? d.x : d.z) + d.dir * STRAFE_SPEED * dt;
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
