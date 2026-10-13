import { formatClock, playerName, rankScores, resultHeadline, statusLine } from "./matchui";
import { type MatchInfo, MatchPhases, type Score } from "./net/protocol.gen";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

function tableHtml(scores: readonly Score[], myId: number): string {
  const rows = rankScores(scores)
    .map(
      (s, i) =>
        `<tr class="${s.id === myId ? "me" : ""}"><td>${i + 1}</td><td>${escapeHtml(playerName(s.id, myId))}</td>` +
        `<td>${s.kills}</td><td>${s.deaths}</td></tr>`,
    )
    .join("");
  return `<table><tr><th>#</th><th>Player</th><th>Kills</th><th>Deaths</th></tr>${rows}</table>`;
}

/** The match UI: status bar, countdown, scoreboard (hold Tab) and the results screen. */
export class MatchHud {
  private readonly bar = document.getElementById("matchbar") as HTMLDivElement;
  private readonly countdown = document.getElementById("countdown") as HTMLDivElement;
  private readonly board = document.getElementById("scoreboard") as HTMLDivElement;
  private readonly results = document.getElementById("results") as HTMLDivElement;

  /** Per frame. Pass null before the first snapshot. */
  update(
    match: MatchInfo | null,
    scores: readonly Score[],
    myId: number,
    showBoard: boolean,
    link: string,
  ): void {
    if (!match) {
      for (const el of [this.bar, this.countdown, this.board, this.results]) {
        el.classList.remove("on");
      }
      this.bar.textContent = "";
      return;
    }

    const waiting = match.phase === MatchPhases.waiting;
    this.bar.innerHTML =
      escapeHtml(statusLine(match, scores, myId)) +
      (waiting ? `<small>invite a friend: ${escapeHtml(link)}  (press L to copy)</small>` : "");

    const counting = match.phase === MatchPhases.countdown;
    this.countdown.classList.toggle("on", counting);
    if (counting) this.countdown.textContent = String(Math.max(1, Math.ceil(match.timeLeft)));

    const ended = match.phase === MatchPhases.ended;
    this.board.classList.toggle("on", showBoard && !ended);
    if (showBoard && !ended) this.board.innerHTML = tableHtml(scores, myId);

    this.results.classList.toggle("on", ended);
    if (ended) {
      const next =
        match.players < match.minPlayers
          ? "waiting for more players"
          : `next match in ${formatClock(match.timeLeft)}`;
      this.results.innerHTML =
        `<h1>${escapeHtml(resultHeadline(match, myId))}</h1>${tableHtml(scores, myId)}` +
        `<div class="foot">ENTER: play again (${match.rematchVotes}/${match.players})  ·  ${next}</div>`;
    }
  }
}
