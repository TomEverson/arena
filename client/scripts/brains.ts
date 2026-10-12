/** Bot "brains": what a headless player decides to do each tick. */
import { EntityFlags, EntityKinds } from "../src/net/protocol.gen";
import { castRay, type Hitbox } from "../src/sim/hitscan";
import { eyeHeight } from "../src/sim/movement";
import { COMBAT, PARAMS, WEAPON } from "../src/sim/params";
import type { CollisionWorld } from "../src/sim/types";
import type { BotClient, Brain } from "./headless";

/**
 * Where to aim to hit a moving target with a slow, dropping bullet: the target's drawn position
 * pushed forward by how far it runs while the bullet flies there, and raised by the drop over
 * that flight. A bot that does this is as good as a player who leads their shots perfectly.
 */
function leadPoint(
  bot: BotClient,
  id: number,
  eye: readonly [number, number, number],
  height: number,
  heightFrac: number,
): { x: number; y: number; z: number } | null {
  const now = bot.remotes.sample(id, bot.renderTick);
  const before = bot.remotes.sample(id, bot.renderTick - 3);
  if (!now) return null;
  const span = before ? 3 / 60 : 1;
  const vx = before ? (now.x - before.x) / span : 0;
  const vy = before ? (now.y - before.y) / span : 0;
  const vz = before ? (now.z - before.z) / span : 0;
  let px = now.x;
  let py = now.y + height * heightFrac;
  let pz = now.z;
  let flight = 0;
  for (let i = 0; i < 4; i++) {
    flight = Math.hypot(px - eye[0], py - eye[1], pz - eye[2]) / WEAPON.bulletSpeed;
    px = now.x + vx * flight;
    py = now.y + height * heightFrac + vy * flight;
    pz = now.z + vz * flight;
  }
  return { x: px, y: py + 0.5 * WEAPON.bulletGravity * flight * flight, z: pz };
}

/**
 * Aim at the other player as drawn on our own screen, strafe, close in when far, and shoot
 * when we can see them. A perfect-aim player who reacts to exactly what the screen shows.
 */
export function makeFighter(world: CollisionWorld): Brain {
  return (bot, tick) => {
    const p = bot.predictor;
    if (!p || !bot.health?.alive || !bot.clock.ready) return {};
    const id = bot.remotes.ids()[0];
    if (id === undefined) return {};
    const pose = bot.remotes.sample(id, bot.renderTick);
    if (!pose || pose.flags & EntityFlags.dead) return {};

    const height = pose.flags & EntityFlags.crouching ? PARAMS.crouchHeight : PARAMS.standHeight;
    const eye = [p.state.x, p.state.y + eyeHeight(p.state), p.state.z] as const;
    const aim = leadPoint(bot, id, eye, height, 0.55) ?? {
      x: pose.x,
      y: pose.y + height * 0.55,
      z: pose.z,
    };
    const dx = aim.x - eye[0];
    const dy = aim.y - eye[1];
    const dz = aim.z - eye[2];
    const flat = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, flat);

    const box: Hitbox = {
      id,
      headMinY: pose.y + height - COMBAT.headSize,
      minX: pose.x - PARAMS.halfWidth,
      maxX: pose.x + PARAMS.halfWidth,
      minY: pose.y,
      maxY: pose.y + height,
      minZ: pose.z - PARAMS.halfWidth,
      maxZ: pose.z + PARAMS.halfWidth,
    };
    // Line of sight to where they are now (the bullet's lead and drop only bend the aim a little).
    const tx = pose.x - eye[0];
    const ty = pose.y + height * 0.55 - eye[1];
    const tz = pose.z - eye[2];
    const tl = Math.hypot(tx, ty, tz);
    const sees = castRay(world, [box], [...eye], [tx / tl, ty / tl, tz / tl]).kind === "target";
    const ghost = (pose.flags & EntityFlags.protected) !== 0; // no point shooting at the invulnerable

    return {
      yaw,
      pitch,
      moveZ: flat > 14 ? 1 : 0,
      moveX: flat > 14 ? 0 : Math.floor(tick / 45) % 2 === 0 ? 1 : -1, // strafe: left, right, left...
      ads: true,
      fire: sees && !ghost,
    };
  };
}

/**
 * Practice-range shooter: stand at the course start, aim at the nearest target we can see (the
 * strafing ones first, since those are what lag compensation is for) and fire.
 */
export function makeTargetShooter(world: CollisionWorld, preferred: readonly number[] = []): Brain {
  return (bot) => {
    const p = bot.predictor;
    if (!p || !p.alive || !bot.clock.ready) return {};
    const eye = [p.state.x, p.state.y + eyeHeight(p.state), p.state.z] as const;
    let best: { dist: number; yaw: number; pitch: number; sees: boolean; rank: number } | null =
      null;
    for (const id of bot.remotes.ids()) {
      const pose = bot.remotes.sample(id, bot.renderTick);
      if (!pose || pose.kind !== EntityKinds.target || pose.flags & EntityFlags.dead) continue;
      const aim = leadPoint(bot, id, eye, PARAMS.standHeight, 0.55) ?? {
        x: pose.x,
        y: pose.y + PARAMS.standHeight * 0.55,
        z: pose.z,
      };
      const dx = aim.x - eye[0];
      const dy = aim.y - eye[1];
      const dz = aim.z - eye[2];
      const len = Math.hypot(dx, dy, dz);
      // Line of sight to where the target is now.
      const sx = pose.x - eye[0];
      const sy = pose.y + PARAMS.standHeight * 0.55 - eye[1];
      const sz = pose.z - eye[2];
      const sl = Math.hypot(sx, sy, sz);
      const box: Hitbox = {
        id,
        headMinY: pose.y + PARAMS.standHeight - COMBAT.headSize,
        minX: pose.x - PARAMS.halfWidth,
        maxX: pose.x + PARAMS.halfWidth,
        minY: pose.y,
        maxY: pose.y + PARAMS.standHeight,
        minZ: pose.z - PARAMS.halfWidth,
        maxZ: pose.z + PARAMS.halfWidth,
      };
      const sees = castRay(world, [box], [...eye], [sx / sl, sy / sl, sz / sl]).kind === "target";
      const rank = preferred.includes(id) ? 0 : 1;
      const cand = {
        dist: len,
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.hypot(dx, dz)),
        sees,
        rank,
      };
      if (
        sees &&
        (!best || cand.rank < best.rank || (cand.rank === best.rank && cand.dist < best.dist))
      )
        best = cand;
    }
    if (!best) return {};
    return { yaw: best.yaw, pitch: best.pitch, ads: true, fire: true };
  };
}
