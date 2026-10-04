import { aimShot, Ball, predictContact, shotSpin, type Vec3 } from "./ball";
import { COURT } from "./court";
import { awardPoint, callout, newTally, type Tally } from "./scoring";
import { facingHeading, type PhoneAxes, phoneAxes, racquetMotion, toCourt, type V3 } from "./orientation";

// The rules of a 1-player rally against the computer, with no rendering: the view reads this
// state every frame and listens to MatchEvents for one-off effects.
//
// Hitting:
// - A swing is judged at the moment the phone felt it, not when the message arrived: the match
//   keeps the last few hundred ms of ball positions and rewinds to the swing's timestamp.
// - Contact quality comes from timing and how close the ball was to the sweet spot (beside and a
//   little in front of the body, around waist height); a good hit is faster and truer.
// - The racquet's path and face at the peak of the swing shape the shot: low→high is topspin,
//   high→low slice, an open face lifts it, the face and path angle steer it. Aim assist blends that
//   with a safe target, so wild swings still mostly land.

/** A swing counts if the ball was or becomes hittable within this many ms of it. */
const HIT_WINDOW_MS = 150;
/** Swings older than this (network delay) are judged as if this old. */
const MAX_REWIND_MS = 300;
/** The ball is hittable this close to the player (meters): sideways, front/back, height. */
const REACH = { x: 1.6, z: 1.1, yMin: 0.1, yMax: 2.6 };
/** Ideal contact: the ball this far in front of the player's feet, at this height. */
const CONTACT_AHEAD = 0.3;
const CONTACT_HEIGHT = 1.0;
/** Players stand this far to the side of the ball so it meets the racquet, not the body. */
export const SIDE_OFFSET = 0.75;
/** Share of the shot's direction taken from the safe target rather than the racquet. */
const AIM_ASSIST = 0.65;
/** Timing (ms off the ideal moment) that still counts as perfect, and where quality runs out. */
const TIMING_PERFECT_MS = 35;
const TIMING_SPAN_MS = 140;
const PLAYER_SPEED = 7; // m/s
const CPU_SPEED = 6;
/** How hard players speed up and brake (m/s²): they don't start or stop instantly. */
const ACCEL = 22;
const CPU_ERROR_RATE = 0.15;
const SINGLES_HALF = COURT.singlesWidth / 2;
const LINE_SLACK = 0.06; // a ball touching the line is in

const HOME = {
  player: { x: 0.9, z: -0.6 },
  cpu: { x: 0.6, z: COURT.length + 0.8 },
};

export type Side = "player" | "cpu";
export type Stroke = "forehand" | "backhand";
/** intro → ready (wait for Bounce) → feed (ball dropped) → rally → pointOver → ready … */
export type Phase = "intro" | "ready" | "feed" | "rally" | "pointOver";

export interface Shot {
  by: Side;
  kmh: number;
  /** 0..1 */
  power: number;
  stroke: Stroke;
  /** Contact quality 0..1 (1 = sweet spot, on time). */
  quality: number;
  /** Rad/s; positive is topspin, negative slice. */
  spin: number;
  /** Where the ball was struck (court space). */
  at: Vec3;
}

/** Where and when (match clock, ms) someone expects to strike the ball, and with which stroke. */
export interface Plan {
  at: Vec3;
  time: number;
  stroke: Stroke;
}

export interface MatchEvents {
  /** Whether the phone's Bounce button should be enabled. */
  serveReady(ready: boolean): void;
  /** Someone struck the ball. */
  hit(shot: Shot): void;
  /** The ball hit the ground (speed in m/s) or the net (`cord`: clipped the tape and went on). */
  bounce(speed: number): void;
  net(cord: boolean): void;
  ballVisible(visible: boolean): void;
  banner(title: string, subtitle?: string): void;
  /** A short message over the player's head. */
  pop(text: string): void;
  score(tally: Tally): void;
  /** A point ended; `winner` won it. */
  point(winner: Side): void;
}

/** A swing from the phone (or a keyboard stand-in, which has no racquet data). */
export interface SwingInput {
  power: number;
  /** Racquet tilt (degrees) for swings without racquet data. */
  tilt: number;
  /** How long ago the swing peaked (ms), from the phone's timestamp. */
  ageMs: number;
  rate?: { alpha: number; beta: number; gamma: number };
  orient?: { alpha: number; beta: number; gamma: number };
}

export interface Athlete {
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  speed: number;
  /** Velocity (m/s). */
  vx: number;
  vz: number;
}

/** The ball and the player a moment ago, so late-arriving swings can be judged when they happened. */
interface Snapshot {
  at: number;
  pos: Vec3;
  vel: Vec3;
  spin: Vec3;
  bounces: number;
  px: number;
  pz: number;
  hittable: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const athlete = (home: { x: number; z: number }, speed: number): Athlete => ({
  x: home.x,
  z: home.z,
  targetX: home.x,
  targetZ: home.z,
  speed,
  vx: 0,
  vz: 0,
});

export class Match {
  readonly player = athlete(HOME.player, PLAYER_SPEED);
  readonly cpu = athlete(HOME.cpu, CPU_SPEED);
  readonly ball = new Ball();
  phase: Phase = "intro";
  lastHitter: Side | null = null;
  bouncesSinceHit = 0;
  /** Total points won. */
  score: Record<Side, number> = { player: 0, cpu: 0 };
  /** Games and the points in the current game. */
  readonly tally = newTally();
  /** Shots in the current rally. */
  rally = 0;
  paused = false;
  /** Who expects to hit the ball next, where and when (drives the animation's preparation). */
  readonly plan: Record<Side, Plan | null> = { player: null, cpu: null };

  /** Racquet axes in court space; mirrors the phone exactly once calibrated. Starts upright. */
  racquetAxes: { shaft: V3; strings: V3 } = { shaft: { x: 0, y: 1, z: 0 }, strings: { x: 1, y: 0, z: 0 } };
  /** Latest phone orientation (earth frame) and the calibrated heading of the TV. */
  private phone: PhoneAxes | null = null;
  private tvHeading: number | null = null;

  private cpuTriedHit = false;
  private pendingSwing: (SwingInput & { at: number }) | null = null;
  private history: Snapshot[] = [];
  /** Match clock (ms). Stops while paused, so timers do too. */
  private clock = 0;
  private timers: { at: number; fn: () => void }[] = [];

  constructor(private readonly events: MatchEvents) {
    this.events.banner("Get Ready!");
    this.after(1700, () => this.toReady());
  }

  get now() {
    return this.clock;
  }

  // ---------- input ----------

  setOrientation(alpha: number, beta: number, gamma: number) {
    this.phone = phoneAxes(alpha, beta, gamma);
    if (this.tvHeading === null) this.calibrate();
    this.racquetAxes = {
      shaft: toCourt(this.phone.top, this.tvHeading!),
      strings: toCourt(this.phone.right, this.tvHeading!),
    };
  }

  /** Treat the phone's current heading as "facing the TV". */
  private calibrate() {
    if (this.phone) this.tvHeading = facingHeading(this.phone);
  }

  bounce() {
    if (this.phase !== "ready" || this.paused) return;
    this.calibrate(); // they just tapped the screen, so they're holding it in front, facing the TV
    this.phase = "feed";
    this.events.serveReady(false);

    // Drop the ball beside the racquet hand; it bounces up to about waist height.
    const p = this.player;
    this.ball.pos = { x: p.x + SIDE_OFFSET, y: 1.0, z: p.z + CONTACT_AHEAD };
    this.ball.vel = { x: 0, y: 3, z: 0 };
    this.ball.spin = { x: 0, y: 0, z: 0 };
    this.ball.restitution = 0.8;
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.rally = 0;
    this.pendingSwing = null;
    this.history = [];
    this.setPlan("player");
    this.events.ballVisible(true);
  }

  swing(input: SwingInput) {
    if (this.paused || (this.phase !== "feed" && this.phase !== "rally")) return;
    if (this.lastHitter === "player") return; // already on its way
    this.pendingSwing = { ...input, at: this.clock - clamp(input.ageMs, 0, MAX_REWIND_MS) };
    this.resolveSwing();
  }

  // ---------- frame loop ----------

  update(dt: number) {
    if (this.paused) return;
    this.clock += dt * 1000;
    const due = this.timers.filter((t) => t.at <= this.clock);
    this.timers = this.timers.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();

    if (this.phase === "feed" || this.phase === "rally" || this.phase === "pointOver") {
      this.stepBall(dt);
      if (this.phase !== "pointOver") {
        this.remember();
        this.resolveSwing();
        this.checkCpuReach();
        this.checkBallLost();
      }
    }
    this.move(this.player, dt);
    this.move(this.cpu, dt);
  }

  private stepBall(dt: number) {
    for (const e of this.ball.update(dt)) {
      if (e.type === "net") this.events.net(e.cord);
      if (e.type !== "bounce") continue;
      this.events.bounce(e.speed);
      if (this.phase !== "pointOver") this.onBounce(e.x, e.z);
    }
  }

  private after(ms: number, fn: () => void) {
    this.timers.push({ at: this.clock + ms, fn });
  }

  // ---------- rally logic ----------

  private toReady() {
    this.phase = "ready";
    this.plan.player = this.plan.cpu = null;
    this.events.ballVisible(false);
    this.goTo(this.player, HOME.player.x, HOME.player.z);
    this.goTo(this.cpu, HOME.cpu.x, HOME.cpu.z);
    this.events.serveReady(true);
  }

  playerHittable() {
    return this.canReach(this.ball.pos, this.bouncesSinceHit, this.player.x, this.player.z);
  }

  private canReach(b: Vec3, bounces: number, px: number, pz: number) {
    if (this.lastHitter === "player") return false;
    // A dropped ball must bounce first; a rally ball may be volleyed or taken after one bounce.
    if (this.lastHitter === null ? bounces !== 1 : bounces > 1) return false;
    return (
      b.z < COURT.netZ &&
      Math.abs(b.x - px) < REACH.x &&
      Math.abs(b.z - (pz + CONTACT_AHEAD)) < REACH.z &&
      b.y > REACH.yMin &&
      b.y < REACH.yMax
    );
  }

  /** Keep a few hundred ms of history for judging swings when they happened. */
  private remember() {
    const b = this.ball;
    this.history.push({
      at: this.clock,
      pos: { ...b.pos },
      vel: { ...b.vel },
      spin: { ...b.spin },
      bounces: this.bouncesSinceHit,
      px: this.player.x,
      pz: this.player.z,
      hittable: this.playerHittable(),
    });
    while (this.history.length && this.history[0].at < this.clock - MAX_REWIND_MS - HIT_WINDOW_MS) this.history.shift();
  }

  /**
   * Hit with the pending swing at the hittable moment nearest to when it happened, once that is
   * known: the ball has been hittable at or after the swing, or the window has passed (a miss).
   */
  private resolveSwing() {
    const s = this.pendingSwing;
    if (!s) return;
    if (this.lastHitter === "player") {
      this.pendingSwing = null;
      return;
    }
    const near = this.history.filter((h) => h.hittable && Math.abs(h.at - s.at) <= HIT_WINDOW_MS);
    if (this.clock < s.at + HIT_WINDOW_MS && !near.some((h) => h.at >= s.at)) return;
    this.pendingSwing = null;
    if (!near.length) return; // whiffed
    const best = near.reduce((a, b) => (Math.abs(b.at - s.at) < Math.abs(a.at - s.at) ? b : a));
    this.playerHit(s, best);
  }

  private playerHit(swing: SwingInput, snap: Snapshot) {
    // Rewind the ball to the moment of contact.
    this.ball.pos = { ...snap.pos };
    this.ball.vel = { ...snap.vel };
    this.ball.spin = { ...snap.spin };
    const b = snap.pos;
    const ballSide: Stroke = b.x >= snap.px ? "forehand" : "backhand";

    // ---- Contact quality: timing, and distance from the sweet spot ----
    const timingMs = ((b.z - (snap.pz + CONTACT_AHEAD)) / Math.max(4, Math.abs(snap.vel.z))) * 1000; // + = early
    const timing = Math.max(0, Math.abs(timingMs) - TIMING_PERFECT_MS) / (TIMING_SPAN_MS - TIMING_PERFECT_MS);
    const lateral = Math.max(0, Math.abs(Math.abs(b.x - snap.px) - SIDE_OFFSET) - 0.15) / 0.9;
    const height = Math.max(0, Math.abs(b.y - CONTACT_HEIGHT) - 0.25) / 1.4;
    const quality = clamp(1 - Math.hypot(timing, lateral, height), 0, 1);

    // ---- What the racquet did ----
    const power = clamp(swing.power, 0, 1);
    let stroke = ballSide;
    let spin = 110; // keyboard / no gyro: a safe topspin drive
    let intent: { angle: number; lift: number } | null = null;
    if (swing.rate && swing.orient && this.tvHeading !== null) {
      const { head, omega, face } = racquetMotion(swing.orient, swing.rate, this.tvHeading);
      const flat = Math.hypot(head.x, head.z);
      const w = Math.hypot(omega.x, omega.y, omega.z);
      if (flat + Math.abs(head.y) > 1.5) {
        // Path: rising through contact brushes topspin, falling cuts slice.
        spin = clamp(70 + (head.y / Math.max(flat, 1)) * 300, -240, 380);
        // Turning about the vertical: right-to-left is a forehand, left-to-right a backhand.
        if (Math.abs(omega.y) > 0.45 * w) stroke = omega.y < 0 ? "forehand" : "backhand";
        const faceAngle = Math.atan2(face.x, Math.max(0.2, face.z));
        const pathAngle = flat > 0.5 ? Math.atan2(head.x, Math.max(0.2, head.z)) : faceAngle;
        intent = { angle: clamp(0.6 * faceAngle + 0.4 * pathAngle, -0.7, 0.7), lift: clamp(face.y, -0.7, 0.7) };
      }
    }

    // ---- Where it goes ----
    // The safe target: deep, pulled cross-court when early and pushed the other way when late.
    const early = clamp(timingMs / TIMING_SPAN_MS, -1, 1);
    const tz = COURT.length - rand(1.8, 4.8) + power * 0.6;
    const assistX = clamp((stroke === "forehand" ? -early : early) * 2.6 + (swing.tilt / 90) * 1.2 + rand(-0.6, 0.6), -3.4, 3.4);
    let tx = assistX;
    let time = 1.35 - 0.5 * power;
    if (intent) {
      const wantX = clamp(b.x + Math.tan(intent.angle) * (tz - b.z), -6, 6);
      tx = lerp(wantX, assistX, AIM_ASSIST);
      time *= 1 + intent.lift * 0.6 * (1 - AIM_ASSIST * 0.5); // open face: loftier; closed: flatter
    }
    // Off-center hits fly slower and wander.
    time *= 1 + (1 - quality) * 0.25;
    tx += rand(-1, 1) * (1 - quality) * 1.4;
    const shank = quality < 0.15 && Math.random() < 0.5;
    if (shank) tx += Math.sign(rand(-1, 1)) * rand(1.5, 3);

    const dir = { x: tx - b.x, y: 0, z: tz - b.z };
    const spinVec = shotSpin(dir, spin);
    this.ball.restitution = 0.74;
    this.ball.vel = aimShot(b, tx, tz, clamp(time, 0.6, 2.4), spinVec, spin > 150 ? 0.5 : 0.3);
    this.ball.spin = spinVec;
    if (intent && intent.lift < -0.35 && quality < 0.5) this.ball.vel.y -= 1.6; // rolled over it: into the net

    if (quality >= 0.8) this.events.pop("Perfect!");
    else if (timingMs > TIMING_SPAN_MS * 0.45) this.events.pop("Early!");
    else if (timingMs < -TIMING_SPAN_MS * 0.45) this.events.pop("Late!");
    else if (shank) this.events.pop("Shanked!");

    this.strike("player", power, stroke, quality, spin, b);
    this.cpuTriedHit = false;
    this.phase = "rally";
    // Catch up from the moment of contact to now.
    this.stepBall((this.clock - snap.at) / 1000);

    this.goTo(this.player, 0.3, HOME.player.z);
    this.chaseBall(this.cpu);
  }

  private checkCpuReach() {
    if (this.lastHitter !== "player" || this.bouncesSinceHit !== 1 || this.cpuTriedHit) return;
    const b = this.ball.pos;
    const c = this.cpu;
    if (b.z < c.z - CONTACT_AHEAD) return; // not there yet
    this.cpuTriedHit = true;
    if (Math.abs(b.x - c.x) > REACH.x || b.y > REACH.yMax + 0.3) {
      this.plan.cpu = null; // couldn't get there
      return;
    }

    const miss = Math.random() < CPU_ERROR_RATE;
    const wide = Math.random() < 0.5;
    const tx = miss && wide ? Math.sign(rand(-1, 1)) * rand(4.5, 5.5) : rand(-3.3, 3.3);
    const tz = miss && !wide ? COURT.netZ - 0.3 : rand(2.5, 7.5);
    const time = rand(1.15, 1.45);
    const kind = Math.random();
    const spin = kind < 0.7 ? rand(80, 260) : kind < 0.88 ? 30 : -rand(80, 170);
    const spinVec = shotSpin({ x: tx - b.x, y: 0, z: tz - b.z }, spin);
    const stroke: Stroke = b.x <= c.x ? "forehand" : "backhand"; // its right hand is on screen-left

    this.ball.vel = aimShot(b, tx, tz, time, spinVec, miss && !wide ? -0.1 : 0.3);
    if (miss && !wide) this.ball.vel.y -= 0.8; // into the net
    this.ball.spin = spinVec;
    this.strike("cpu", clamp((1.45 - time) / 0.5 + 0.3, 0, 1), stroke, 1, spin, b);
    this.pendingSwing = null;

    this.goTo(this.cpu, 0, HOME.cpu.z);
    this.chaseBall(this.player);
  }

  private strike(by: Side, power: number, stroke: Stroke, quality: number, spin: number, at: Vec3) {
    this.lastHitter = by;
    this.bouncesSinceHit = 0;
    this.rally++;
    this.plan[by] = null;
    const v = this.ball.vel;
    const kmh = Math.round(Math.hypot(v.x, v.y, v.z) * 3.6);
    this.events.hit({ by, kmh, power, stroke, quality, spin, at: { ...at } });
  }

  /** Auto-move: run to where the ball will be after it bounces, racquet side toward it. */
  private chaseBall(a: Athlete) {
    const side: Side = a === this.player ? "player" : "cpu";
    const plan = this.setPlan(side);
    if (!plan) return; // going into the net or out: no need to run
    const { at, stroke } = plan;
    // The player's forehand is on +x; the computer faces the camera, so its forehand is on -x.
    const offset = (stroke === "forehand") === (side === "player") ? SIDE_OFFSET : -SIDE_OFFSET;
    if (side === "player") this.goTo(a, at.x - offset, at.z - CONTACT_AHEAD);
    else this.goTo(a, at.x - offset, at.z + CONTACT_AHEAD);
  }

  /** Predict where `side` will meet the ball and with which stroke. */
  private setPlan(side: Side): Plan | null {
    const near = side === "player";
    const a = near ? this.player : this.cpu;
    const contact = predictContact(this.ball, near ? "near" : "far", near ? -2.2 : COURT.length + 3);
    if (!contact) return (this.plan[side] = null);
    const stroke: Stroke = near ? (contact.x >= a.x - 0.3 ? "forehand" : "backhand") : contact.x <= a.x + 0.3 ? "forehand" : "backhand";
    const { t, ...at } = contact;
    return (this.plan[side] = { at, time: this.clock + t * 1000, stroke });
  }

  private onBounce(x: number, z: number) {
    this.bouncesSinceHit++;

    if (this.lastHitter === null) {
      // Dropped ball: if it bounces twice nobody swung in time; just drop another one.
      if (this.bouncesSinceHit >= 2) {
        this.phase = "pointOver";
        this.plan.player = null;
        this.events.pop("Swing when it bounces!");
        this.after(1100, () => this.toReady());
      }
      return;
    }

    const hitter = this.lastHitter;
    const receiver: Side = hitter === "player" ? "cpu" : "player";
    if (this.bouncesSinceHit === 1) {
      const landedOn: Side = z < COURT.netZ ? "player" : "cpu";
      if (landedOn !== receiver) return this.pointTo(receiver, "Net!");
      const inside = Math.abs(x) <= SINGLES_HALF + LINE_SLACK && z >= -LINE_SLACK && z <= COURT.length + LINE_SLACK;
      if (!inside) return this.pointTo(receiver, "Out!");
      this.chaseBall(receiver === "player" ? this.player : this.cpu); // refine now that it has landed
    } else {
      this.pointTo(hitter, hitter === "player" ? "Winner!" : "Missed!");
    }
  }

  /** Safety net: a ball that leaves the arena without bouncing counts as out. */
  private checkBallLost() {
    const { x, z } = this.ball.pos;
    if (Math.abs(x) < 16 && z > -14 && z < COURT.length + 14) return;
    if (this.lastHitter) this.pointTo(this.lastHitter === "player" ? "cpu" : "player", "Out!");
    else this.toReady();
  }

  private pointTo(winner: Side, reason: string) {
    this.phase = "pointOver";
    this.plan.player = this.plan.cpu = null;
    this.score[winner]++;
    const game = awardPoint(this.tally, winner);
    this.events.score(this.tally);
    this.events.point(winner);
    const who = winner === "player" ? "Your" : "Computer's";
    const call = callout(this.tally);
    const sub = game
      ? `${who} game`
      : call === "Advantage"
        ? `Advantage ${winner === "player" ? "you" : "computer"}`
        : (call ?? `${who} point`);
    this.events.banner(reason, sub);
    this.after(2000, () => this.toReady());
  }

  // ---------- movement ----------

  private goTo(a: Athlete, x: number, z: number) {
    const near = a === this.player;
    a.targetX = clamp(x, -6, 6);
    a.targetZ = near ? clamp(z, -2.2, COURT.netZ - 1.5) : clamp(z, COURT.netZ + 1.5, COURT.length + 3);
  }

  /** Run toward the target: accelerate up to speed, then brake so as to stop on it. */
  private move(a: Athlete, dt: number) {
    if (dt <= 0) return;
    const dx = a.targetX - a.x;
    const dz = a.targetZ - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.02 && Math.hypot(a.vx, a.vz) < 0.3) {
      a.vx = a.vz = 0;
      return;
    }
    const want = Math.min(a.speed, Math.sqrt(2 * ACCEL * 0.8 * dist));
    const wx = dist > 1e-6 ? (dx / dist) * want : 0;
    const wz = dist > 1e-6 ? (dz / dist) * want : 0;
    const ex = wx - a.vx;
    const ez = wz - a.vz;
    const e = Math.hypot(ex, ez);
    const k = e > ACCEL * dt ? (ACCEL * dt) / e : 1;
    a.vx += ex * k;
    a.vz += ez * k;
    a.x += a.vx * dt;
    a.z += a.vz * dt;
  }
}
