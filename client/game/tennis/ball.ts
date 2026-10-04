import { COURT } from "./court";

// Ball physics in court meters (see court.ts for axes), in small fixed steps so the same code
// predicts landings exactly:
// - Gravity, air drag (∝ v²) and the Magnus force from spin: topspin dips, slice floats.
// - Bounces with friction at the contact point: topspin grips and kicks forward, slice skids and
//   checks up, and the bounce changes the spin (it tends toward rolling).
// - The net: a ball that clips the tape dribbles on with little speed; below it, it drops back.

export const GRAVITY = 9.81;
const RESTITUTION = 0.74; // vertical speed kept on a bounce
/** Court friction at the contact point (grass is slick). */
const FRICTION = 0.5;
/** Physical radius for the spin/bounce maths (the rendered ball is bigger, for readability). */
const RADIUS = 0.0335;
/** Drag: a = -DRAG·|v|·v. Real balls are ~0.02; a bit less keeps rallies brisk. */
const DRAG = 0.013;
/** Magnus: a = MAGNUS·(ω × v), ω in rad/s. */
const MAGNUS = 0.0009;
/** Fraction of spin lost per second in the air. */
const SPIN_DECAY = 0.05;
/** A ball this close above or below the tape clips it. */
const CORD = 0.07;
const STEP = 1 / 240;
export const NET_POST_X = COURT.doublesWidth / 2 + 0.914;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type BallEvent =
  | { type: "bounce"; x: number; z: number; speed: number }
  /** `cord`: clipped the tape and carried on; otherwise it hit the net and dropped back. */
  | { type: "net"; cord: boolean };

/** Height of the net tape at x (it sags toward the center). */
export function netTop(x: number) {
  const t = Math.min(1, Math.abs(x) / NET_POST_X);
  return COURT.netHeightCenter + (COURT.netHeightPost - COURT.netHeightCenter) * t;
}

/**
 * Spin vector for a shot travelling along `vel`: positive `amount` is topspin, negative is slice
 * (rad/s). Topspin turns about the horizontal axis across the flight, top of the ball forward.
 */
export function shotSpin(vel: Vec3, amount: number): Vec3 {
  const h = Math.hypot(vel.x, vel.z) || 1;
  // up × v̂
  return { x: (vel.z / h) * amount, y: 0, z: (-vel.x / h) * amount };
}

export class Ball {
  pos: Vec3 = { x: 0, y: 0, z: 0 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  /** Angular velocity (rad/s). */
  spin: Vec3 = { x: 0, y: 0, z: 0 };
  restitution = RESTITUTION;

  clone() {
    const b = new Ball();
    b.pos = { ...this.pos };
    b.vel = { ...this.vel };
    b.spin = { ...this.spin };
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
    const { pos, vel, spin: w } = this;
    const prevZ = pos.z;

    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const ax = -DRAG * speed * vel.x + MAGNUS * (w.y * vel.z - w.z * vel.y);
    const ay = -DRAG * speed * vel.y + MAGNUS * (w.z * vel.x - w.x * vel.z) - GRAVITY;
    const az = -DRAG * speed * vel.z + MAGNUS * (w.x * vel.y - w.y * vel.x);
    vel.x += ax * h;
    vel.y += ay * h;
    vel.z += az * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
    const decay = 1 - SPIN_DECAY * h;
    w.x *= decay;
    w.y *= decay;
    w.z *= decay;

    const netZ = COURT.netZ;
    if ((prevZ - netZ) * (pos.z - netZ) < 0 && Math.abs(pos.x) < NET_POST_X) {
      const top = netTop(pos.x);
      if (pos.y < top + CORD) {
        if (pos.y > top - CORD) {
          // Clipped the tape: it pops up and trickles on, to fall on either side.
          vel.y = Math.abs(vel.y) * 0.25 + 1.4;
          vel.z *= 0.22;
          vel.x *= 0.5;
          pos.y = top + CORD;
          w.x = w.y = w.z = 0;
          events.push({ type: "net", cord: true });
        } else {
          pos.z = netZ - Math.sign(vel.z) * 0.05;
          vel.z *= -0.15;
          vel.x *= 0.3;
          w.x = w.y = w.z = 0;
          events.push({ type: "net", cord: false });
        }
      }
    }

    if (pos.y <= 0 && vel.y < 0) {
      const vy = -vel.y;
      pos.y = -pos.y * this.restitution;
      vel.y = vy * this.restitution;
      this.bounceFriction(vy);
      events.push({ type: "bounce", x: pos.x, z: pos.z, speed: Math.hypot(vel.x, vy, vel.z) });
    }
  }

  /**
   * Friction impulse at the contact point, opposing its slip and capped at what makes the ball
   * roll (thin-shelled ball: I = 2/3·m·R²).
   */
  private bounceFriction(impactVy: number) {
    const { vel, spin: w } = this;
    // Contact point velocity: v + ω × (0, -R, 0).
    const ux = vel.x + RADIUS * w.z;
    const uz = vel.z - RADIUS * w.x;
    const slip = Math.hypot(ux, uz);
    if (slip < 1e-6) return;
    const dv = Math.min(FRICTION * (1 + this.restitution) * impactVy, slip / 2.5);
    const dvx = (-ux / slip) * dv;
    const dvz = (-uz / slip) * dv;
    vel.x += dvx;
    vel.z += dvz;
    w.x += (-1.5 / RADIUS) * dvz;
    w.z += (1.5 / RADIUS) * dvx;
  }
}

/** Velocity that takes a ball from `from` to land on (tx, tz) after `time` seconds, in a vacuum. */
function launch(from: Vec3, tx: number, tz: number, time: number): Vec3 {
  return {
    x: (tx - from.x) / time,
    z: (tz - from.z) / time,
    y: (-from.y + 0.5 * GRAVITY * time * time) / time,
  };
}

interface Flight {
  x: number;
  z: number;
  t: number;
  /** Height over the tape where it crosses the net (negative: into the net). */
  clearance: number;
}

/** Fly a shot until its first bounce (or the net, or 4 s). */
function fly(from: Vec3, vel: Vec3, spin: Vec3): Flight | null {
  const b = new Ball();
  b.pos = { ...from };
  b.vel = { ...vel };
  b.spin = { ...spin };
  let clearance = Infinity;
  for (let t = 0; t < 4; t += STEP) {
    const prevZ = b.pos.z;
    for (const e of b.update(STEP)) {
      if (e.type === "net") clearance = -1;
      if (e.type === "bounce") return { x: e.x, z: e.z, t: t + STEP, clearance };
    }
    if ((prevZ - COURT.netZ) * (b.pos.z - COURT.netZ) <= 0 && clearance > 0) {
      clearance = Math.min(clearance, b.pos.y - netTop(b.pos.x));
    }
  }
  return null;
}

/**
 * Velocity that lands a shot with this spin on (tx, tz) after about `time` seconds, clearing the
 * net by `margin` (adding air time until it does: a loftier shot). Solved by flying the real
 * physics and correcting, so drag and spin are accounted for. A negative margin lets it find the
 * tape: that's how a mishit goes into the net.
 */
export function aimShot(from: Vec3, tx: number, tz: number, time: number, spin: Vec3, margin = 0.3): Vec3 {
  let best = launch(from, tx, tz, time);
  for (let tries = 0; tries < 24; tries++, time += 0.06) {
    const v = launch(from, tx, tz, time);
    for (let i = 0; i < 8; i++) {
      const f = fly(from, v, spin);
      if (!f) break;
      const ex = tx - f.x;
      const ez = tz - f.z;
      const et = time - f.t;
      if (Math.abs(ex) < 0.03 && Math.abs(ez) < 0.03 && Math.abs(et) < 0.02) break;
      // Landing moves roughly with velocity × flight time; flight time with 2·vy/g.
      v.x += ex / f.t;
      v.z += ez / f.t;
      v.y += (et * GRAVITY) / 2;
    }
    best = v;
    const f = fly(from, v, spin);
    if (f && f.clearance >= margin) return v;
  }
  return best;
}

/**
 * Where a receiver should meet the ball: the top of its arc after the first bounce on their half,
 * or where it passes `deepest` if it is still rising by then; `t` is seconds from now. Null if it
 * never lands on their half.
 */
export function predictContact(ball: Ball, receiver: "near" | "far", deepest: number): (Vec3 & { t: number }) | null {
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
    if (bounced && (sim.vel.y <= 0 || pastDeepest(sim.pos.z))) return { ...sim.pos, t: t + 1 / 120 };
  }
  return null;
}
