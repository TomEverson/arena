import { describe, expect, it } from "vitest";

import { canAct, formatClock, playerName, rankScores, resultHeadline, statusLine } from "./matchui";
import { type MatchInfo, MatchPhases, type Score } from "./net/protocol.gen";

const info = (over: Partial<MatchInfo> = {}): MatchInfo => ({
  phase: MatchPhases.live,
  timeLeft: 100,
  suddenDeath: false,
  winner: 0,
  players: 2,
  minPlayers: 2,
  rematchVotes: 0,
  ...over,
});
const score = (id: number, kills: number, deaths = 0): Score => ({ id, kills, deaths });

describe("formatClock", () => {
  it("rounds up like a countdown and pads seconds", () => {
    expect(formatClock(360)).toBe("6:00");
    expect(formatClock(342.2)).toBe("5:43");
    expect(formatClock(59.01)).toBe("1:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-3)).toBe("0:00");
  });
});

describe("rankScores", () => {
  it("sorts by kills, then fewer deaths, then id, without changing the input", () => {
    const input = [score(3, 2, 5), score(1, 2, 1), score(2, 5, 9), score(4, 2, 1)];
    const copy = [...input];
    expect(rankScores(input).map((s) => s.id)).toEqual([2, 1, 4, 3]);
    expect(input).toEqual(copy);
  });
});

describe("canAct", () => {
  it("is false only during the countdown and the results", () => {
    expect(canAct(MatchPhases.waiting)).toBe(true);
    expect(canAct(MatchPhases.live)).toBe(true);
    expect(canAct(MatchPhases.countdown)).toBe(false);
    expect(canAct(MatchPhases.ended)).toBe(false);
  });
});

describe("statusLine", () => {
  it("says what the room is waiting for", () => {
    expect(statusLine(info({ phase: MatchPhases.waiting, players: 1 }), [], 1)).toContain("1/2");
    expect(statusLine(info({ phase: MatchPhases.countdown, timeLeft: 2.4 }), [], 1)).toContain("3");
    expect(statusLine(info({ phase: MatchPhases.ended }), [], 1)).toBe("MATCH OVER");
  });

  it("shows the clock and how far you are from the lead", () => {
    const line = statusLine(info({ timeLeft: 125 }), [score(1, 3), score(2, 5)], 1);
    expect(line).toContain("2:05");
    expect(line).toContain("YOU 3");
    expect(line).toContain("5 LEADER");
  });

  it("compares with second place when you are the leader", () => {
    const line = statusLine(info(), [score(1, 5), score(2, 2), score(3, 4)], 1);
    expect(line).toContain("YOU 5");
    expect(line).toContain("4 SECOND");
  });

  it("calls out sudden death", () => {
    expect(
      statusLine(info({ suddenDeath: true, timeLeft: 0 }), [score(1, 1), score(2, 1)], 1),
    ).toContain("SUDDEN DEATH");
  });
});

describe("resultHeadline", () => {
  it("names the winner, you, or a draw", () => {
    expect(resultHeadline(info({ phase: MatchPhases.ended, winner: 1 }), 1)).toBe("YOU WIN");
    expect(resultHeadline(info({ phase: MatchPhases.ended, winner: 2 }), 1)).toBe("PLAYER 2 WINS");
    expect(resultHeadline(info({ phase: MatchPhases.ended, winner: 0 }), 1)).toBe("DRAW");
  });
});

describe("playerName", () => {
  it("names you, other players and practice targets", () => {
    expect(playerName(1, 1)).toBe("YOU");
    expect(playerName(3, 1)).toBe("Player 3");
    expect(playerName(1000, 1)).toBe("Target 1");
    expect(playerName(1004, 1)).toBe("Target 5");
  });
});
