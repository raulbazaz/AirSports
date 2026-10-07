import { aimShot, Ball, predictContact, shotSpin, type Vec3 } from "./ball";
import { COURT } from "./court";
import { awardPoint, callout, newTally, type Tally } from "./scoring";
import { facingHeading, type PhoneAxes, phoneAxes, racquetMotion, toCourt, type V3 } from "./orientation";

// The rules of a rally, with no rendering: the view reads this state every frame and listens to
// MatchEvents for one-off effects. Player 1 plays the near end with a phone. The far end is either
// the computer or Player 2 with a second phone.
//
// Each side reasons in its own frame (see `mirror`): x to its right, z toward the opponent. The
// near side's frame is the court's; the far side's is the court turned half a turn about its
// center. So both phones play by exactly the same rules.
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

/** Where each kind of player waits between points, in its own frame. */
const HOME = {
  human: { x: 0.9, z: -0.6 },
  cpu: { x: -0.6, z: -0.8 },
};
/** Where they drift back to after hitting (own frame x). */
const RECOVER_X = { human: 0.3, cpu: 0 };

/** p1 plays the near end, p2 the far end. */
export type Side = "p1" | "p2";
export const other = (s: Side): Side => (s === "p1" ? "p2" : "p1");
/** Who plays the far end. */
export type Opponent = "cpu" | "human";
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

/** Where (court space) and when (match clock, ms) someone expects to strike the ball, and with which stroke. */
export interface Plan {
  at: Vec3;
  time: number;
  stroke: Stroke;
}

export interface MatchEvents {
  /** Whether `side`'s phone should enable its Bounce button. */
  serveReady(side: Side, ready: boolean): void;
  /** Someone struck the ball. */
  hit(shot: Shot): void;
  /** The ball hit the ground (speed in m/s) or the net (`cord`: clipped the tape and went on). */
  bounce(speed: number): void;
  net(cord: boolean): void;
  ballVisible(visible: boolean): void;
  banner(title: string, subtitle?: string): void;
  /** A short message for one player ("Perfect!"). */
  pop(side: Side, text: string): void;
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
  /** Court space. */
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  speed: number;
  /** Velocity (m/s, court space). */
  vx: number;
  vz: number;
}

/** The ball and the player a moment ago (court space), so late-arriving swings can be judged when they happened. */
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

/** A phone: its racquet and its swings. */
interface Racquet {
  /** Racquet axes in court space; mirrors the phone exactly once calibrated. Starts upright. */
  axes: { shaft: V3; strings: V3 };
  /** Latest phone orientation (earth frame) and the calibrated heading of the TV. */
  phone: PhoneAxes | null;
  tvHeading: number | null;
  pending: (SwingInput & { at: number }) | null;
  history: Snapshot[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A court-space point in `side`'s own frame, or back (it's its own inverse). */
export const mirror = (side: Side, p: Vec3): Vec3 => (side === "p1" ? { ...p } : { x: -p.x, y: p.y, z: COURT.length - p.z });
/** Same for directions, velocities and spin (the turn is a rotation, so spin turns with it). */
const mirrorDir = (side: Side, v: Vec3): Vec3 => (side === "p1" ? { ...v } : { x: -v.x, y: v.y, z: -v.z });

const athlete = (home: { x: number; z: number }, speed: number): Athlete => ({
  x: home.x,
  z: home.z,
  targetX: home.x,
  targetZ: home.z,
  speed,
  vx: 0,
  vz: 0,
});

const newRacquet = (): Racquet => ({
  axes: { shaft: { x: 0, y: 1, z: 0 }, strings: { x: 1, y: 0, z: 0 } },
  phone: null,
  tvHeading: null,
  pending: null,
  history: [],
});

export class Match {
  readonly athletes: Record<Side, Athlete>;
  readonly ball = new Ball();
  phase: Phase = "intro";
  lastHitter: Side | null = null;
  bouncesSinceHit = 0;
  /** Total points won. */
  score: Record<Side, number> = { p1: 0, p2: 0 };
  /** Games and the points in the current game. */
  readonly tally = newTally();
  /** Shots in the current rally. */
  rally = 0;
  paused = false;
  /** Who expects to hit the ball next, where and when (drives the animation's preparation). */
  readonly plan: Record<Side, Plan | null> = { p1: null, p2: null };
  /** Who drops the ball to start the next point. Player 1 always against the computer; alternates by game otherwise. */
  server: Side = "p1";

  /** The phones; p2 has none against the computer. */
  private readonly racquets: Partial<Record<Side, Racquet>>;
  private cpuTriedHit = false;
  /** Match clock (ms). Stops while paused, so timers do too. */
  private clock = 0;
  private timers: { at: number; fn: () => void }[] = [];

  constructor(
    private readonly events: MatchEvents,
    readonly opponent: Opponent = "cpu",
  ) {
    this.racquets = opponent === "human" ? { p1: newRacquet(), p2: newRacquet() } : { p1: newRacquet() };
    this.athletes = {
      p1: athlete(mirror("p1", { ...HOME.human, y: 0 }), PLAYER_SPEED),
      p2: athlete(mirror("p2", { ...this.home("p2"), y: 0 }), this.isCpu("p2") ? CPU_SPEED : PLAYER_SPEED),
    };
    this.events.banner("Get Ready!");
    this.after(1700, () => this.toReady());
  }

  get now() {
    return this.clock;
  }

  isCpu(side: Side) {
    return !this.racquets[side];
  }

  /** What to call a side on screen. */
  name(side: Side) {
    return side === "p1" ? "Player 1" : this.isCpu(side) ? "Computer" : "Player 2";
  }

  /** A human side's racquet axes (court space), or null for the computer. */
  racquetAxes(side: Side) {
    return this.racquets[side]?.axes ?? null;
  }

  // ---------- input ----------

  setOrientation(side: Side, alpha: number, beta: number, gamma: number) {
    const r = this.racquets[side];
    if (!r) return;
    r.phone = phoneAxes(alpha, beta, gamma);
    if (r.tvHeading === null) this.calibrate(r);
    // The phone's axes in its player's own frame, then turned into court space.
    r.axes = {
      shaft: mirrorDir(side, toCourt(r.phone.top, r.tvHeading!)),
      strings: mirrorDir(side, toCourt(r.phone.right, r.tvHeading!)),
    };
  }

  /** Treat the phone's current heading as "facing the TV" (for the far player: facing the near end). */
  private calibrate(r: Racquet) {
    if (r.phone) r.tvHeading = facingHeading(r.phone);
  }

  bounce(side: Side) {
    const r = this.racquets[side];
    if (this.phase !== "ready" || this.paused || side !== this.server || !r) return;
    this.calibrate(r); // they just tapped the screen, so they're holding it in front, facing the TV
    this.phase = "feed";
    this.events.serveReady(side, false);

    // Drop the ball beside the racquet hand; it bounces up to about waist height.
    const p = this.local(side);
    this.ball.pos = mirror(side, { x: p.x + SIDE_OFFSET, y: 1.0, z: p.z + CONTACT_AHEAD });
    this.ball.vel = { x: 0, y: 3, z: 0 };
    this.ball.spin = { x: 0, y: 0, z: 0 };
    this.ball.restitution = 0.8;
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.rally = 0;
    for (const q of Object.values(this.racquets)) {
      q.pending = null;
      q.history = [];
    }
    this.setPlan(side);
    this.events.ballVisible(true);
  }

  swing(side: Side, input: SwingInput) {
    const r = this.racquets[side];
    if (!r || this.paused || (this.phase !== "feed" && this.phase !== "rally")) return;
    if (this.lastHitter === side) return; // already on its way
    r.pending = { ...input, at: this.clock - clamp(input.ageMs, 0, MAX_REWIND_MS) };
    this.resolveSwing(side);
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
        for (const side of this.humans()) this.remember(side);
        for (const side of this.humans()) this.resolveSwing(side);
        this.checkCpuReach();
        this.checkBallLost();
      }
    }
    this.move(this.athletes.p1, dt);
    this.move(this.athletes.p2, dt);
  }

  private humans() {
    return (Object.keys(this.racquets) as Side[]);
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

  private home(side: Side) {
    return this.isCpu(side) ? HOME.cpu : HOME.human;
  }

  /** `side`'s position in its own frame. */
  private local(side: Side) {
    const a = this.athletes[side];
    return mirror(side, { x: a.x, y: 0, z: a.z });
  }

  private toReady() {
    this.phase = "ready";
    this.plan.p1 = this.plan.p2 = null;
    this.events.ballVisible(false);
    for (const side of ["p1", "p2"] as const) this.goTo(side, this.home(side).x, this.home(side).z);
    for (const side of this.humans()) this.events.serveReady(side, side === this.server);
  }

  private canReach(side: Side, ball: Vec3, bounces: number, px: number, pz: number) {
    if (this.lastHitter === side) return false;
    // A dropped ball must bounce first; a rally ball may be volleyed or taken after one bounce.
    if (this.lastHitter === null ? bounces !== 1 : bounces > 1) return false;
    const b = mirror(side, ball);
    const p = mirror(side, { x: px, y: 0, z: pz });
    return (
      b.z < COURT.netZ &&
      Math.abs(b.x - p.x) < REACH.x &&
      Math.abs(b.z - (p.z + CONTACT_AHEAD)) < REACH.z &&
      b.y > REACH.yMin &&
      b.y < REACH.yMax
    );
  }

  /** Keep a few hundred ms of history for judging `side`'s swings when they happened. */
  private remember(side: Side) {
    const b = this.ball;
    const a = this.athletes[side];
    const history = this.racquets[side]!.history;
    history.push({
      at: this.clock,
      pos: { ...b.pos },
      vel: { ...b.vel },
      spin: { ...b.spin },
      bounces: this.bouncesSinceHit,
      px: a.x,
      pz: a.z,
      hittable: this.canReach(side, b.pos, this.bouncesSinceHit, a.x, a.z),
    });
    while (history.length && history[0].at < this.clock - MAX_REWIND_MS - HIT_WINDOW_MS) history.shift();
  }

  /**
   * Hit with `side`'s pending swing at the hittable moment nearest to when it happened, once that
   * is known: the ball has been hittable at or after the swing, or the window has passed (a miss).
   */
  private resolveSwing(side: Side) {
    const r = this.racquets[side]!;
    const s = r.pending;
    if (!s) return;
    if (this.lastHitter === side) {
      r.pending = null;
      return;
    }
    const near = r.history.filter((h) => h.hittable && Math.abs(h.at - s.at) <= HIT_WINDOW_MS);
    if (this.clock < s.at + HIT_WINDOW_MS && !near.some((h) => h.at >= s.at)) return;
    r.pending = null;
    if (!near.length) return; // whiffed
    const best = near.reduce((a, b) => (Math.abs(b.at - s.at) < Math.abs(a.at - s.at) ? b : a));
    this.humanHit(side, s, best);
  }

  private humanHit(side: Side, swing: SwingInput, snap: Snapshot) {
    const r = this.racquets[side]!;
    // Rewind the ball to the moment of contact.
    this.ball.pos = { ...snap.pos };
    this.ball.vel = { ...snap.vel };
    this.ball.spin = { ...snap.spin };
    // Everything below is in the hitter's own frame.
    const b = mirror(side, snap.pos);
    const p = mirror(side, { x: snap.px, y: 0, z: snap.pz });
    const ballSide: Stroke = b.x >= p.x ? "forehand" : "backhand";

    // ---- Contact quality: timing, and distance from the sweet spot ----
    const timingMs = ((b.z - (p.z + CONTACT_AHEAD)) / Math.max(4, Math.abs(snap.vel.z))) * 1000; // + = early
    const timing = Math.max(0, Math.abs(timingMs) - TIMING_PERFECT_MS) / (TIMING_SPAN_MS - TIMING_PERFECT_MS);
    const lateral = Math.max(0, Math.abs(Math.abs(b.x - p.x) - SIDE_OFFSET) - 0.15) / 0.9;
    const height = Math.max(0, Math.abs(b.y - CONTACT_HEIGHT) - 0.25) / 1.4;
    const quality = clamp(1 - Math.hypot(timing, lateral, height), 0, 1);

    // ---- What the racquet did ----
    const power = clamp(swing.power, 0, 1);
    let stroke = ballSide;
    let spin = 110; // keyboard / no gyro: a safe topspin drive
    let intent: { angle: number; lift: number } | null = null;
    if (swing.rate && swing.orient && r.tvHeading !== null) {
      const { head, omega, face } = racquetMotion(swing.orient, swing.rate, r.tvHeading);
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
    const vel = aimShot(b, tx, tz, clamp(time, 0.6, 2.4), spinVec, spin > 150 ? 0.5 : 0.3);
    if (intent && intent.lift < -0.35 && quality < 0.5) vel.y -= 1.6; // rolled over it: into the net
    this.ball.restitution = 0.74;
    this.ball.vel = mirrorDir(side, vel);
    this.ball.spin = mirrorDir(side, spinVec);

    if (quality >= 0.8) this.events.pop(side, "Perfect!");
    else if (timingMs > TIMING_SPAN_MS * 0.45) this.events.pop(side, "Early!");
    else if (timingMs < -TIMING_SPAN_MS * 0.45) this.events.pop(side, "Late!");
    else if (shank) this.events.pop(side, "Shanked!");

    this.strike(side, power, stroke, quality, spin, snap.pos);
    this.phase = "rally";
    // Catch up from the moment of contact to now.
    this.stepBall((this.clock - snap.at) / 1000);
    this.afterStrike(side);
  }

  /** The computer swings once, when the ball reaches it after bouncing. */
  private checkCpuReach() {
    if (!this.isCpu("p2") || this.lastHitter !== "p1" || this.bouncesSinceHit !== 1 || this.cpuTriedHit) return;
    const b = mirror("p2", this.ball.pos);
    const c = this.local("p2");
    if (b.z > c.z + CONTACT_AHEAD) return; // not there yet
    this.cpuTriedHit = true;
    if (Math.abs(b.x - c.x) > REACH.x || b.y > REACH.yMax + 0.3) {
      this.plan.p2 = null; // couldn't get there
      return;
    }

    const miss = Math.random() < CPU_ERROR_RATE;
    const wide = Math.random() < 0.5;
    const tx = miss && wide ? Math.sign(rand(-1, 1)) * rand(4.5, 5.5) : rand(-3.3, 3.3);
    const tz = miss && !wide ? COURT.netZ + 0.3 : COURT.length - rand(2.5, 7.5);
    const time = rand(1.15, 1.45);
    const kind = Math.random();
    const spin = kind < 0.7 ? rand(80, 260) : kind < 0.88 ? 30 : -rand(80, 170);
    const spinVec = shotSpin({ x: tx - b.x, y: 0, z: tz - b.z }, spin);
    const stroke: Stroke = b.x >= c.x ? "forehand" : "backhand";

    const vel = aimShot(b, tx, tz, time, spinVec, miss && !wide ? -0.1 : 0.3);
    if (miss && !wide) vel.y -= 0.8; // into the net
    this.ball.vel = mirrorDir("p2", vel);
    this.ball.spin = mirrorDir("p2", spinVec);
    this.strike("p2", clamp((1.45 - time) / 0.5 + 0.3, 0, 1), stroke, 1, spin, this.ball.pos);
    this.afterStrike("p2");
  }

  private strike(by: Side, power: number, stroke: Stroke, quality: number, spin: number, at: Vec3) {
    this.lastHitter = by;
    this.bouncesSinceHit = 0;
    this.rally++;
    this.plan[by] = null;
    this.cpuTriedHit = false;
    const v = this.ball.vel;
    const kmh = Math.round(Math.hypot(v.x, v.y, v.z) * 3.6);
    this.events.hit({ by, kmh, power, stroke, quality, spin, at: { ...at } });
  }

  /** The hitter drifts back to the middle; the other side runs for the ball. */
  private afterStrike(by: Side) {
    const recover = this.isCpu(by) ? RECOVER_X.cpu : RECOVER_X.human;
    this.goTo(by, recover, this.home(by).z);
    for (const r of Object.values(this.racquets)) r.pending = null;
    this.chaseBall(other(by));
  }

  /** Auto-move: run to where the ball will be after it bounces, racquet side toward it. */
  private chaseBall(side: Side) {
    const plan = this.setPlan(side);
    if (!plan) return; // going into the net or out: no need to run
    const at = mirror(side, plan.at);
    const offset = plan.stroke === "forehand" ? SIDE_OFFSET : -SIDE_OFFSET;
    this.goTo(side, at.x - offset, at.z - CONTACT_AHEAD);
  }

  /** Predict where `side` will meet the ball and with which stroke. */
  private setPlan(side: Side): Plan | null {
    const near = side === "p1";
    const contact = predictContact(this.ball, near ? "near" : "far", near ? -2.2 : COURT.length + 3);
    if (!contact) return (this.plan[side] = null);
    const { t, ...at } = contact;
    const stroke: Stroke = mirror(side, at).x >= this.local(side).x - 0.3 ? "forehand" : "backhand";
    return (this.plan[side] = { at, time: this.clock + t * 1000, stroke });
  }

  private onBounce(x: number, z: number) {
    this.bouncesSinceHit++;

    if (this.lastHitter === null) {
      // Dropped ball: if it bounces twice nobody swung in time; just drop another one.
      if (this.bouncesSinceHit >= 2) {
        this.phase = "pointOver";
        this.plan.p1 = this.plan.p2 = null;
        this.events.pop(this.server, "Swing when it bounces!");
        this.after(1100, () => this.toReady());
      }
      return;
    }

    const hitter = this.lastHitter;
    const receiver = other(hitter);
    if (this.bouncesSinceHit === 1) {
      const landedOn: Side = z < COURT.netZ ? "p1" : "p2";
      if (landedOn !== receiver) return this.pointTo(receiver, "Net!");
      const inside = Math.abs(x) <= SINGLES_HALF + LINE_SLACK && z >= -LINE_SLACK && z <= COURT.length + LINE_SLACK;
      if (!inside) return this.pointTo(receiver, "Out!");
      this.chaseBall(receiver); // refine now that it has landed
    } else {
      this.pointTo(hitter, this.isCpu(hitter) ? "Missed!" : "Winner!");
    }
  }

  /** Safety net: a ball that leaves the arena without bouncing counts as out. */
  private checkBallLost() {
    const { x, z } = this.ball.pos;
    if (Math.abs(x) < 16 && z > -14 && z < COURT.length + 14) return;
    if (this.lastHitter) this.pointTo(other(this.lastHitter), "Out!");
    else this.toReady();
  }

  private pointTo(winner: Side, reason: string) {
    this.phase = "pointOver";
    this.plan.p1 = this.plan.p2 = null;
    this.score[winner]++;
    const game = awardPoint(this.tally, winner);
    this.events.score(this.tally);
    this.events.point(winner);
    // Against the computer the screen talks to Player 1 ("Your game"); with two players, by name.
    const solo = this.isCpu("p2");
    const who = solo ? (winner === "p1" ? "Your" : "Computer's") : `${this.name(winner)}'s`;
    const call = callout(this.tally);
    const sub = game
      ? `${who} game`
      : call === "Advantage"
        ? `Advantage ${solo ? (winner === "p1" ? "you" : "computer") : this.name(winner)}`
        : (call ?? `${who} point`);
    this.events.banner(reason, sub);
    // Two players take turns serving, a game each.
    if (game && !solo) this.server = other(this.server);
    this.after(2000, () => this.toReady());
  }

  // ---------- movement ----------

  /** Send `side` toward a point in its own frame, kept on its half. */
  private goTo(side: Side, x: number, z: number) {
    const a = this.athletes[side];
    const deepest = this.isCpu(side) ? -3 : -2.2;
    const p = mirror(side, { x: clamp(x, -6, 6), y: 0, z: clamp(z, deepest, COURT.netZ - 1.5) });
    a.targetX = p.x;
    a.targetZ = p.z;
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
