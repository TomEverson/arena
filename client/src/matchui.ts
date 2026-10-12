/** Pure helpers for the match UI: clock text, ranking and the status line. No DOM here, so they are easy to test. */
import { type MatchInfo, MatchPhases, type Score } from "./net/protocol.gen";
import { COMBAT } from "./sim/params";

/** 342.2 seconds -> "5:43" (rounded up, like a countdown). */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** "YOU", "Player 3", or "Target 2" for a practice-range target (their ids start at COMBAT.targetIdBase). */
export function playerName(id: number, myId: number): string {
  if (id >= COMBAT.targetIdBase) return `Target ${id - COMBAT.targetIdBase + 1}`;
  return id === myId ? "YOU" : `Player ${id}`;
}

/** Most kills first; fewer deaths breaks a tie; then the lower id so the order never jitters. */
export function rankScores(scores: readonly Score[]): Score[] {
  return [...scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
}

/** Can players move and shoot in this phase? (Not during the countdown or the results.) */
export function canAct(phase: number): boolean {
  return phase === MatchPhases.waiting || phase === MatchPhases.live;
}

/** The line at the top of the screen. */
export function statusLine(match: MatchInfo, scores: readonly Score[], myId: number): string {
  switch (match.phase) {
    case MatchPhases.waiting:
      return `WAITING FOR PLAYERS  ${match.players}/${match.minPlayers}`;
    case MatchPhases.countdown:
      return `MATCH STARTS IN ${Math.ceil(match.timeLeft)}`;
    case MatchPhases.live: {
      const ranked = rankScores(scores);
      const me = ranked.find((s) => s.id === myId)?.kills ?? 0;
      const best = ranked[0];
      const lead = best && best.id === myId ? (ranked[1]?.kills ?? 0) : (best?.kills ?? 0);
      const clock = match.suddenDeath ? "SUDDEN DEATH" : formatClock(match.timeLeft);
      return `${clock}   YOU ${me}  –  ${lead} ${best && best.id === myId ? "SECOND" : "LEADER"}`;
    }
    default:
      return "MATCH OVER";
  }
}

/** The big banner on the results screen. */
export function resultHeadline(match: MatchInfo, myId: number): string {
  if (match.winner === 0) return "DRAW";
  return match.winner === myId ? "YOU WIN" : `${playerName(match.winner, myId).toUpperCase()} WINS`;
}
