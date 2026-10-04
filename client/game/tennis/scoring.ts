import type { Side } from "./match";

// Tennis scoring within a game (0, 15, 30, 40, deuce, advantage) and a running games count.

export interface Tally {
  games: Record<Side, number>;
  /** Points won in the current game. */
  points: Record<Side, number>;
}

export const newTally = (): Tally => ({ games: { player: 0, cpu: 0 }, points: { player: 0, cpu: 0 } });

const other = (s: Side): Side => (s === "player" ? "cpu" : "player");

/** Award a point; returns true if it won the game (points then reset). */
export function awardPoint(t: Tally, winner: Side): boolean {
  t.points[winner]++;
  const won = t.points[winner];
  const lost = t.points[other(winner)];
  if (won >= 4 && won - lost >= 2) {
    t.games[winner]++;
    t.points = { player: 0, cpu: 0 };
    return true;
  }
  return false;
}

const CALLS = ["0", "15", "30", "40"];

/** What the board shows in the points column for each side. */
export function pointLabels(t: Tally): Record<Side, string> {
  const { player: p, cpu: c } = t.points;
  if (p >= 3 && c >= 3) {
    if (p === c) return { player: "40", cpu: "40" };
    return p > c ? { player: "AD", cpu: "" } : { player: "", cpu: "AD" };
  }
  return { player: CALLS[p], cpu: CALLS[c] };
}

/** "Deuce" or "Advantage" once both sides reach 40; null otherwise. */
export function callout(t: Tally): string | null {
  const { player: p, cpu: c } = t.points;
  if (p >= 3 && c >= 3) return p === c ? "Deuce" : "Advantage";
  return null;
}
