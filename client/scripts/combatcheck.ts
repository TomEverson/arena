/**
 * End-to-end combat check. Two headless players fight through the real Go server over the
 * fake network (80 ms each way, 3% loss by default). Each aims perfectly at where the OTHER
 * player appears on its own screen (a screen that is about 260 ms behind the server) and
 * shoots. The run is repeated with lag compensation switched off for comparison.
 *
 *   pnpm combatcheck [seconds] [latency] [loss]      e.g. pnpm combatcheck 25 80ms 3%
 *
 * Passing means: with compensation nearly every shot aimed at a visible target is confirmed
 * by the server, without it far fewer are, and kills, deaths, respawns and the kill feed work.
 */
import { type ChildProcess } from "node:child_process";

import { EntityFlags } from "../src/net/protocol.gen";
import { castRay, type Hitbox } from "../src/sim/hitscan";
import { eyeHeight } from "../src/sim/movement";
import { COMBAT, PARAMS } from "../src/sim/params";
import { loadWorld } from "../src/sim/vectors/node";
import { BotClient, type BotStats, type Brain, sleep, startServer } from "./headless";

const world = loadWorld({ level: "duel" });

const seconds = Number(process.argv[2] ?? 30);
const latency = process.argv[3] ?? "80ms";
const loss = process.argv[4] ?? "3%";
const port = 8096;

/** Aim at the other player as drawn on our screen, strafe, close in when far, shoot when we can see them. */
const fighter: Brain = (bot, tick) => {
  const p = bot.predictor;
  if (!p || !bot.health?.alive || !bot.clock.ready) return {};
  const id = bot.remotes.ids()[0];
  if (id === undefined) return {};
  const pose = bot.remotes.sample(id, bot.renderTick);
  if (!pose || pose.flags & EntityFlags.dead) return {};

  const height = pose.flags & EntityFlags.crouching ? PARAMS.crouchHeight : PARAMS.standHeight;
  const eye = [p.state.x, p.state.y + eyeHeight(p.state), p.state.z] as const;
  const dx = pose.x - eye[0];
  const dy = pose.y + height * 0.55 - eye[1];
  const dz = pose.z - eye[2];
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
  const len = Math.hypot(dx, dy, dz);
  const sees = castRay(world, [box], [...eye], [dx / len, dy / len, dz / len]).kind === "target";
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

interface RunResult {
  label: string;
  a: BotStats;
  b: BotStats;
  corrections: number;
  rtt: number;
}

async function fight(label: string, compensate: boolean): Promise<RunResult> {
  const a = new BotClient("A", port, world, fighter, compensate);
  const b = new BotClient("B", port, world, fighter, compensate);
  await sleep(seconds * 1000);
  a.stop();
  b.stop();
  await sleep(1500); // let the last events arrive
  const result = {
    label,
    a: { ...a.stats },
    b: { ...b.stats },
    corrections: (a.predictor?.corrections ?? 0) + (b.predictor?.corrections ?? 0),
    rtt: (a.net.stats.rttMs + b.net.stats.rttMs) / 2,
  };
  a.close();
  b.close();
  await sleep(300);
  return result;
}

/** Hit rate over the shots that could register (not those consumed after the target had died). */
const measurable = (s: BotStats) => s.shots - s.wasted;
const rate = (hits: number, shots: number) => (shots <= 0 ? 0 : hits / shots);

let server: ChildProcess | undefined;
let failed = false;
try {
  server = await startServer(port, latency, loss, "duel");
  console.log(
    `two bots fight for ${seconds}s through ${latency} each way and ${loss} loss, with lag compensation...`,
  );
  const withComp = await fight("with lag compensation", true);
  server.kill();
  await sleep(500);
  server = await startServer(port, latency, loss, "duel");
  console.log(`...and again for ${seconds}s without it`);
  const without = await fight("no lag compensation", false);

  for (const r of [withComp, without]) {
    console.log(`\n${r.label}:`);
    console.table([
      { bot: "A", ...r.a, hitRate: rate(r.a.hits, measurable(r.a)).toFixed(2) },
      { bot: "B", ...r.b, hitRate: rate(r.b.hits, measurable(r.b)).toFixed(2) },
    ]);
    console.log(
      `prediction corrections ${r.corrections}, average round trip ${r.rtt.toFixed(0)} ms`,
    );
  }

  const shotsOn = measurable(withComp.a) + measurable(withComp.b);
  const hitRateOn = rate(withComp.a.hits + withComp.b.hits, shotsOn);
  const hitRateOff = rate(
    without.a.hits + without.b.hits,
    measurable(without.a) + measurable(without.b),
  );
  const kills = withComp.a.kills + withComp.b.kills;
  const deaths = withComp.a.deaths + withComp.b.deaths;
  const respawns = withComp.a.respawns + withComp.b.respawns;
  console.log(
    `\nhit rate: ${(hitRateOn * 100).toFixed(0)}% with lag compensation, ${(hitRateOff * 100).toFixed(0)}% without`,
  );

  const problems: string[] = [];
  if (shotsOn < 100)
    problems.push(`only ${shotsOn} shots were fired, the bots did not really fight`);
  if (hitRateOn < 0.8)
    problems.push(
      `with lag compensation only ${(hitRateOn * 100).toFixed(0)}% of shots registered (want 80%+)`,
    );
  if (hitRateOff > hitRateOn - 0.2)
    problems.push("lag compensation made no clear difference: is the test really exercising it?");
  if (kills < 2) problems.push(`only ${kills} kills happened`);
  if (kills !== deaths) problems.push(`kills (${kills}) and deaths (${deaths}) disagree`);
  if (respawns < Math.max(1, deaths - 2))
    problems.push(`${deaths} deaths but only ${respawns} respawns`);
  if (withComp.a.killFeed < kills || withComp.b.killFeed < kills)
    problems.push("a player missed kill-feed events");
  if (withComp.corrections > 6 * (deaths + respawns) + 6)
    problems.push(
      `${withComp.corrections} prediction corrections is too many for ${deaths} deaths`,
    );
  if (withComp.rtt < 100 || withComp.rtt > 320)
    problems.push(
      `round trip ${withComp.rtt.toFixed(0)} ms is not what the fake network should give`,
    );

  if (problems.length > 0) {
    failed = true;
    console.error(`\nFAILED:\n - ${problems.join("\n - ")}`);
  } else {
    console.log(
      "\nPASS: hits register fairly under lag, and the kill, death and respawn cycle works.",
    );
  }
} finally {
  server?.kill();
}
process.exit(failed ? 1 : 0);
