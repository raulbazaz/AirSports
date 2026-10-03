import { COURT } from "./court";

// Ball physics in court meters (see projection.ts for axes). Plain Euler in small fixed steps:
// good enough for a cartoon game and fully deterministic, so the same code predicts landings.

export const GRAVITY = 9.81;
const RESTITUTION = 0.74; // vertical speed kept on a bounce
const SKID = 0.86; // horizontal speed kept on a bounce
const STEP = 1 / 240;
export const NET_POST_X = COURT.doublesWidth / 2 + 0.914;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type BallEvent = { type: "bounce"; x: number; z: number } | { type: "net" };

/** Height of the net tape at x (it sags toward the center). */
export function netTop(x: number) {
  const t = Math.min(1, Math.abs(x) / NET_POST_X);
  return COURT.netHeightCenter + (COURT.netHeightPost - COURT.netHeightCenter) * t;
}

export class Ball {
  pos: Vec3 = { x: 0, y: 0, z: 0 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  restitution = RESTITUTION;

  clone() {
    const b = new Ball();
    b.pos = { ...this.pos };
    b.vel = { ...this.vel };
    b.restitution = this.restitution;
    return b;
  }

  /** Advance by dt seconds, in fixed sub-steps. Returns what happened along the way. */
  update(dt: number): BallEvent[] {
    const events: BallEvent[] = [];
    for (let left = dt; left > 1e-6; left -= STEP) this.step(Math.min(STEP, left), events);
    return events;
  }

  private step(h: number, events: BallEvent[]) {
    const { pos, vel } = this;
    const prevZ = pos.z;
    vel.y -= GRAVITY * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;

    // Net: crossing the net plane below the tape knocks the ball back on the hitter's side.
    const netZ = COURT.netZ;
    if ((prevZ - netZ) * (pos.z - netZ) < 0 && Math.abs(pos.x) < NET_POST_X && pos.y < netTop(pos.x)) {
      pos.z = netZ - Math.sign(vel.z) * 0.05;
      vel.z *= -0.15;
      vel.x *= 0.3;
      events.push({ type: "net" });
    }

    if (pos.y <= 0 && vel.y < 0) {
      pos.y = -pos.y * this.restitution;
      vel.y = -vel.y * this.restitution;
      vel.x *= SKID;
      vel.z *= SKID;
      events.push({ type: "bounce", x: pos.x, z: pos.z });
    }
  }
}

/** Velocity that takes a ball from `from` to land on (tx, tz) after `time` seconds. */
function launch(from: Vec3, tx: number, tz: number, time: number): Vec3 {
  return {
    x: (tx - from.x) / time,
    z: (tz - from.z) / time,
    y: (-from.y + 0.5 * GRAVITY * time * time) / time,
  };
}

/**
 * Like `launch`, but adds air time until the ball clears the net with some margin.
 * A longer flight is a loftier shot, so this always converges.
 */
export function aimOverNet(from: Vec3, tx: number, tz: number, time: number, margin = 0.3): Vec3 {
  for (let i = 0; i < 30; i++, time += 0.05) {
    const v = launch(from, tx, tz, time);
    const tNet = (COURT.netZ - from.z) / v.z;
    if (tNet <= 0 || tNet >= time) return v;
    const y = from.y + v.y * tNet - 0.5 * GRAVITY * tNet * tNet;
    const x = from.x + v.x * tNet;
    if (y > netTop(x) + margin) return v;
  }
  return launch(from, tx, tz, time);
}

/**
 * Where a receiver should meet the ball: the top of its arc after the first bounce on their half,
 * or where it passes `deepest` if it is still rising by then. Null if it never lands on their half.
 */
export function predictContact(ball: Ball, receiver: "near" | "far", deepest: number): Vec3 | null {
  const sim = ball.clone();
  const onReceiverHalf = (z: number) => (receiver === "near" ? z < COURT.netZ : z > COURT.netZ);
  const pastDeepest = (z: number) => (receiver === "near" ? z < deepest : z > deepest);
  let bounced = false;

  for (let t = 0; t < 5; t += 1 / 120) {
    for (const e of sim.update(1 / 120)) {
      if (e.type !== "bounce") continue;
      if (bounced || !onReceiverHalf(e.z)) return null;
      bounced = true;
    }
    if (bounced && (sim.vel.y <= 0 || pastDeepest(sim.pos.z))) return { ...sim.pos };
  }
  return null;
}
