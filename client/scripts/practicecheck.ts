/**
 * End-to-end practice-range check. Starts the real server (80 ms each way, 3% loss) and:
 *  1. a bot shoots the range's targets, strafing ones first, once with lag compensation and once
 *     without; a second player in the same range shoots at the first, who must never be hurt;
 *  2. the helper commands (refill, course start, reset targets) are tried over the wire.
 *
 *   pnpm practicecheck [seconds] [latency] [loss]
 */
import { type ChildProcess } from "node:child_process";

import { EntityFlags, EntityKinds } from "../src/net/protocol.gen";
import { eyeHeight } from "../src/sim/movement";
import { loadWorld } from "../src/sim/vectors/node";
import { makeTargetShooter } from "./brains";
import { BotClient, type Brain, createRoom, sleep, startServer } from "./headless";

const seconds = Number(process.argv[2] ?? 20);
const latency = process.argv[3] ?? "80ms";
const loss = process.argv[4] ?? "3%";
const port = 8094;
const world = loadWorld({ level: "range" }); // an open arena where every target is in view of the spawn
const STRAFERS = [1003, 1004]; // range.json: the two strafing targets are the last two

/** A second player: walk off the spawn, turn round and fire at the first player (who must be unharmed). */
const troublemaker: Brain = (bot, tick) => {
  const p = bot.predictor;
  if (!p || !p.alive) return {};
  if (tick < 90) return { moveZ: 1, yaw: 0 }; // 1.5 s forward from the spawn
  const other = bot.remotes
    .ids()
    .map((id) => bot.remotes.sample(id, bot.renderTick))
    .find((pose) => pose && pose.kind === EntityKinds.player);
  if (!other) return {};
  const eye = [p.state.x, p.state.y + eyeHeight(p.state), p.state.z] as const;
  const dx = other.x - eye[0];
  const dy = other.y + 1.0 - eye[1];
  const dz = other.z - eye[2];
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
    ads: true,
    fire: true,
  };
};

const measurable = (s: { shots: number; wasted: number }) => s.shots - s.wasted;
/** Shot accounting around kills is approximate, so never report more than 100%. */
const rate = (hits: number, shots: number) => (shots <= 0 ? 0 : Math.min(1, hits / shots));

async function shootingRun(compensate: boolean, withTroublemaker: boolean) {
  const room = await createRoom(port, "practice");
  const a = new BotClient("A", port, room, world, makeTargetShooter(world, STRAFERS), compensate);
  const b = withTroublemaker ? new BotClient("B", port, room, world, troublemaker) : null;
  await sleep(seconds * 1000);
  a.stop();
  b?.stop();
  await sleep(1500);
  const result = {
    stats: { ...a.stats },
    healthAfter: a.health ? { ...a.health } : null,
    bHurt: b?.stats.hurt ?? 0,
    corrections: a.predictor?.corrections ?? 0,
    rtt: a.net.stats.rttMs,
    mode: a.net.playerId,
  };
  a.close();
  b?.close();
  await sleep(300);
  return result;
}

/** The three helper commands, one at a time, in a fresh range. */
async function commandChecks(): Promise<string[]> {
  const problems: string[] = [];
  const room = await createRoom(port, "practice");
  let phase: "walk" | "idle" | "shoot" | "hunt" = "walk";
  const hunter = makeTargetShooter(world);
  const bot = new BotClient("C", port, room, world, (b, tick) => {
    if (phase === "walk") return { moveZ: 1, yaw: 0, slide: false };
    if (phase === "shoot") return { fire: true, yaw: 0, pitch: 0.4 }; // into the sky: spends ammo
    if (phase === "hunt") return hunter(b, tick);
    return {};
  });
  const waitFor = async (test: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!test() && Date.now() - t0 < ms) await sleep(50);
    return test();
  };

  await waitFor(() => bot.predictor !== null, 5000);
  const startZ = bot.predictor?.state.z ?? 0;

  // start: run away from the course start, then ask to go back.
  await sleep(2000);
  phase = "idle";
  await sleep(500);
  const farZ = bot.predictor?.state.z ?? 0;
  if (Math.abs(farZ - startZ) < 5)
    problems.push(`the bot did not leave the start (z ${startZ.toFixed(1)} -> ${farZ.toFixed(1)})`);
  bot.practice("start");
  const back = await waitFor(() => Math.abs((bot.predictor?.state.z ?? 99) - startZ) < 0.5, 3000);
  if (!back)
    problems.push(
      `"start" did not bring the player back (z = ${bot.predictor?.state.z.toFixed(1)}, start ${startZ.toFixed(1)})`,
    );

  // refill: spend some ammo, then refill.
  phase = "shoot";
  await sleep(1500);
  phase = "idle";
  await sleep(400);
  const spent = bot.predictor?.weapon.ammo ?? 30;
  if (spent >= 30) problems.push("the bot did not spend any ammo");
  bot.practice("refill");
  const refilled = await waitFor(() => (bot.predictor?.weapon.ammo ?? 0) === 30, 3000);
  if (!refilled) problems.push(`"refill" left ${bot.predictor?.weapon.ammo} rounds (had ${spent})`);

  // reset: kill a target, then bring it back at once instead of waiting for its respawn.
  phase = "hunt";
  const dead = () =>
    bot.remotes.ids().some((id) => {
      const pose = bot.remotes.sample(id, bot.renderTick);
      return (
        pose !== null && pose.kind === EntityKinds.target && (pose.flags & EntityFlags.dead) !== 0
      );
    });
  const sawDeath = await waitFor(dead, 20000);
  phase = "idle";
  if (!sawDeath) {
    problems.push("never killed a target to test reset");
  } else {
    bot.practice("reset");
    const alive = await waitFor(() => !dead(), 1200); // a normal respawn takes 2 s
    if (!alive) problems.push(`"reset" did not bring the targets back within 1.2 s`);
  }
  bot.close();
  await sleep(300);
  return problems;
}

let server: ChildProcess | undefined;
let failed = false;
try {
  server = await startServer(port, latency, loss, "greybox", [
    "--practice-level=../levels/range.json",
  ]);
  console.log(
    `a bot shoots the targets for ${seconds}s through ${latency} each way and ${loss} loss...`,
  );
  const on = await shootingRun(true, true);
  console.log("...and again without lag compensation");
  const off = await shootingRun(false, false);
  console.log("...then the helper commands");
  const commandProblems = await commandChecks();

  const rateOn = rate(on.stats.hits, measurable(on.stats));
  const rateOff = rate(off.stats.hits, measurable(off.stats));
  console.table([
    {
      run: "lag compensation",
      shots: on.stats.shots,
      hits: on.stats.hits,
      kills: on.stats.kills,
      wasted: on.stats.wasted,
      hitRate: rateOn.toFixed(2),
    },
    {
      run: "no compensation",
      shots: off.stats.shots,
      hits: off.stats.hits,
      kills: off.stats.kills,
      wasted: off.stats.wasted,
      hitRate: rateOff.toFixed(2),
    },
  ]);
  console.log(
    `hit rate on targets: ${(rateOn * 100).toFixed(0)}% with lag compensation, ${(rateOff * 100).toFixed(0)}% without; ` +
      `the other player's shots hurt A ${on.stats.hurt} times (health ${on.healthAfter?.health}/${on.healthAfter?.shield}), ` +
      `round trip ${on.rtt.toFixed(0)} ms, ${on.corrections} prediction corrections`,
  );

  const problems: string[] = [...commandProblems];
  if (on.stats.shots < 60) problems.push(`only ${on.stats.shots} shots were fired`);
  if (rateOn < 0.8)
    problems.push(
      `with lag compensation only ${(rateOn * 100).toFixed(0)}% of shots hit (want 80%+)`,
    );
  if (rateOff > rateOn - 0.2)
    problems.push("lag compensation made no clear difference on the strafing targets");
  if (on.stats.kills < 3) problems.push(`only ${on.stats.kills} targets were killed`);
  if (on.stats.hurt > 0 || on.healthAfter?.health !== 100 || on.healthAfter?.shield !== 50)
    problems.push("a player was hurt by another player in the range");
  if (on.corrections > 4) problems.push(`${on.corrections} prediction corrections is too many`);

  if (problems.length > 0) {
    failed = true;
    console.error(`\nFAILED:\n - ${problems.join("\n - ")}`);
  } else {
    console.log(
      "\nPASS: targets register hits fairly under lag, players cannot hurt each other, and the helpers work.",
    );
  }
} finally {
  server?.kill();
}
process.exit(failed ? 1 : 0);
