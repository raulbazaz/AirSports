/**
 * Racquet angle from the phone's orientation, for a phone held upright like a racquet handle
 * with the screen facing the player: 0° = racquet up, positive = top tilted right (clockwise).
 *
 * Uses the world "up" vector in device coordinates, (-cos β sin γ, sin β, cos β cos γ), so it stays
 * stable at β ≈ 90° where γ alone would flip. Returns `prev` when the phone lies flat and the
 * in-screen direction is meaningless.
 */
export function racquetAngle(beta: number, gamma: number, prev = 0): number {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  const right = Math.cos(b) * Math.sin(g);
  const up = Math.sin(b);
  if (Math.hypot(right, up) < 0.35) return prev;
  return (Math.atan2(right, up) * 180) / Math.PI;
}
