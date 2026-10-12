/**
 * End-to-end match-flow check. Two bots fight through the real server over the fake network
 * with a short match (a few seconds of countdown, 15 s of play, a few seconds of results),
 * and a third player joins and leaves mid-match.
 *
 *   pnpm matchcheck [latency] [loss]
 *
 * Passing means: waiting -> countdown -> live -> ended -> countdown again with no manual steps,
 * the winner is the player with the most kills, scores reset for the next match, and a late
 * joiner appears (and disappears) on the scoreboard.
 */
import { type ChildProcess } from "node:child_process";

import { MatchPhases } from "../src/net/protocol.gen";
import { loadWorld } from "../src/sim/vectors/node";
import { makeFighter } from "./brains";
import { BotClient, createRoom, sleep, startServer } from "./headless";

const latency = process.argv[2] ?? "80ms";
const loss = process.argv[3] ?? "3%";
const port = 8095;
const world = loadWorld({ level: "duel" });
const fighter = makeFighter(world);
const PHASE = ["waiting", "countdown", "live", "ended"];

async function until(what: string, test: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

let server: ChildProcess | undefined;
let failed = false;
const log: string[] = [];
const note = (msg: string) => {
  log.push(msg);
  console.log(`  ${msg}`);
};

try {
  server = await startServer(port, latency, loss, "duel", [
    "--countdown=2s",
    "--match-length=15s",
    "--results=5s",
  ]);
  const room = await createRoom(port);
  console.log("two bots, a short match, and a late joiner:");

  const a = new BotClient("A", port, room, world, fighter);
  await until("A to see the waiting room", () => a.match?.phase === MatchPhases.waiting, 5000);
  note(
    `A alone: ${PHASE[a.match?.phase ?? 0]} (${a.match?.players}/${a.match?.minPlayers} players)`,
  );
  await sleep(1000);
  if (a.match?.phase !== MatchPhases.waiting)
    throw new Error("the match started with only one player");

  const b = new BotClient("B", port, room, world, fighter);
  await until("the countdown", () => a.match?.phase === MatchPhases.countdown, 5000);
  note("B joined: countdown started");
  await until("the match to go live", () => a.match?.phase === MatchPhases.live, 6000);
  note("match live");

  // A third player walks in mid-match.
  await sleep(4000);
  const c = new BotClient("C", port, room, world, () => ({}));
  await until("C on the scoreboard", () => a.scores.length === 3, 5000);
  const late = a.scores.find((s) => s.id === c.id);
  note(`C joined mid-match: on the scoreboard with ${late?.kills} kills`);
  if (!late || late.kills !== 0) throw new Error("a late joiner should start with 0 kills");
  await sleep(1500);
  c.close();
  await until("C to leave the scoreboard", () => a.scores.length === 2, 5000);
  note("C left: scoreboard back to 2 players");

  await until("the match to end", () => a.match?.phase === MatchPhases.ended, 40000);
  const finalScores = [...a.scores];
  const winner = a.match?.winner ?? -1;
  note(
    `match over: winner ${winner || "none (draw)"}, scores ${JSON.stringify(finalScores.map((s) => [s.id, s.kills, s.deaths]))}`,
  );

  // The winner must be the player with strictly the most kills.
  const best = Math.max(...finalScores.map((s) => s.kills));
  const leaders = finalScores.filter((s) => s.kills === best);
  const expected = leaders.length === 1 ? (leaders[0]?.id ?? 0) : 0;
  if (winner !== expected) throw new Error(`winner ${winner} but the scoreboard says ${expected}`);

  // Rematch: both vote, the next match starts right away instead of after the full results time.
  const resultsStart = Date.now();
  a.rematch();
  b.rematch();
  await until("the next countdown", () => a.match?.phase === MatchPhases.countdown, 7000);
  note(
    `both voted: next match counting down after ${((Date.now() - resultsStart) / 1000).toFixed(1)}s`,
  );
  await until("the second match to go live", () => a.match?.phase === MatchPhases.live, 6000);
  const fresh = a.scores.every((s) => s.kills === 0 && s.deaths === 0);
  note(`second match live, scores reset: ${fresh}`);
  if (!fresh) throw new Error("scores were not reset for the new match");

  const order = a.phases.map((p) => PHASE[p.phase]).join(" > ");
  console.log(`\nphases seen by A: ${order}`);
  console.table([a, b].map((bot) => ({ bot: bot.name, ...bot.stats })));
  a.close();
  b.close();
  console.log(
    "\nPASS: the match cycle runs by itself, joins and leaves are handled, and rematch works.",
  );
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${(e as Error).message}`);
  console.error(log.join("\n"));
} finally {
  server?.kill();
}
process.exit(failed ? 1 : 0);
