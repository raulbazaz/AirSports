import type { Side } from "./match";

// Tennis scoring within a game (0, 15, 30, 40, deuce, advantage) and a running games count.

export interface Tally {
  games: Record<Side, number>;
  /** Points won in the current game. */
  points: Record<Side, number>;
}

export const newTally = (): Tally => ({ games: { p1: 0, p2: 0 }, points: { p1: 0, p2: 0 } });

const other = (s: Side): Side => (s === "p1" ? "p2" : "p1");

/** Award a point; returns true if it won the game (points then reset). */
export function awardPoint(t: Tally, winner: Side): boolean {
  t.points[winner]++;
  const won = t.points[winner];
  const lost = t.points[other(winner)];
  if (won >= 4 && won - lost >= 2) {
    t.games[winner]++;
    t.points = { p1: 0, p2: 0 };
    return true;
  }
  return false;
}

const CALLS = ["0", "15", "30", "40"];

/** What the board shows in the points column for each side. */
export function pointLabels(t: Tally): Record<Side, string> {
  const { p1: p, p2: c } = t.points;
  if (p >= 3 && c >= 3) {
    if (p === c) return { p1: "40", p2: "40" };
    return p > c ? { p1: "AD", p2: "" } : { p1: "", p2: "AD" };
  }
  return { p1: CALLS[p], p2: CALLS[c] };
}

/** "Deuce" or "Advantage" once both sides reach 40; null otherwise. */
export function callout(t: Tally): string | null {
  const { p1: p, p2: c } = t.points;
  if (p >= 3 && c >= 3) return p === c ? "Deuce" : "Advantage";
  return null;
}
