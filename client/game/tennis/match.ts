import { aimOverNet, Ball, predictContact } from "./ball";
import { COURT } from "./court";
import { facingHeading, type PhoneAxes, phoneAxes, toCourt, type V3 } from "./orientation";

// The rules of a 1-player rally against the computer, with no rendering: the view reads this
// state every frame and listens to MatchEvents for one-off effects.

/** A swing counts if the ball was or becomes hittable within this many ms of it arriving. */
const HIT_WINDOW_MS = 150;
/** The ball is hittable this close to the player (meters): sideways, front/back, height. */
const REACH = { x: 1.6, z: 1.1, yMin: 0.1, yMax: 2.6 };
/** Ideal contact: the ball this far in front of the player's feet. Earlier/later pulls the shot. */
const CONTACT_AHEAD = 0.3;
/** Players stand this far to the side of the ball so it meets the racquet, not the body. */
export const SIDE_OFFSET = 0.75;
const PLAYER_SPEED = 6.5; // m/s
const CPU_SPEED = 5.5;
const CPU_ERROR_RATE = 0.15;
const SINGLES_HALF = COURT.singlesWidth / 2;
const LINE_SLACK = 0.06; // a ball touching the line is in

const HOME = {
  player: { x: 0.9, z: -0.6 },
  cpu: { x: 0.6, z: COURT.length + 0.8 },
};

export type Side = "player" | "cpu";
/** intro → ready (wait for Bounce) → feed (ball dropped) → rally → pointOver → ready … */
export type Phase = "intro" | "ready" | "feed" | "rally" | "pointOver";

export interface MatchEvents {
  /** Whether the phone's Bounce button should be enabled. */
  serveReady(ready: boolean): void;
  /** Someone struck the ball; `power` is 0..1. */
  hit(by: Side, speedKmh: number, power: number): void;
  ballVisible(visible: boolean): void;
  banner(title: string, subtitle?: string): void;
  /** A short message over the player's head. */
  pop(text: string): void;
  score(score: Record<Side, number>): void;
}

export interface Athlete {
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  speed: number;
  /** Velocity this frame (m/s), for the running animation. */
  vx: number;
  vz: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

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
  score: Record<Side, number> = { player: 0, cpu: 0 };
  /** Shots in the current rally. */
  rally = 0;
  paused = false;

  /** Racquet axes in court space; mirrors the phone exactly once calibrated. Starts upright. */
  racquetAxes: { shaft: V3; strings: V3 } = { shaft: { x: 0, y: 1, z: 0 }, strings: { x: 1, y: 0, z: 0 } };
  /** Latest phone orientation (earth frame) and the calibrated heading of the TV. */
  private phone: PhoneAxes | null = null;
  private tvHeading: number | null = null;

  private cpuTriedHit = false;
  private lastHittableAt = -Infinity;
  private pendingSwing: { at: number; power: number; tilt: number } | null = null;
  /** Match clock (ms). Stops while paused, so timers do too. */
  private now = 0;
  private timers: { at: number; fn: () => void }[] = [];

  constructor(private readonly events: MatchEvents) {
    this.events.banner("Get Ready!");
    this.after(1700, () => this.toReady());
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
    this.ball.restitution = 0.8;
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.rally = 0;
    this.lastHittableAt = -Infinity;
    this.pendingSwing = null;
    this.events.ballVisible(true);
  }

  swing(power: number, tilt: number) {
    if (this.paused || (this.phase !== "feed" && this.phase !== "rally")) return;
    if (this.lastHitter === "player") return; // already on its way

    const swing = { at: this.now, power, tilt };
    if (this.now - this.lastHittableAt <= HIT_WINDOW_MS) this.playerHit(swing);
    else this.pendingSwing = swing; // a little early: hit if the ball arrives in time
  }

  // ---------- frame loop ----------

  update(dt: number) {
    if (this.paused) return;
    this.now += dt * 1000;
    const due = this.timers.filter((t) => t.at <= this.now);
    this.timers = this.timers.filter((t) => t.at > this.now);
    for (const t of due) t.fn();

    if (this.phase === "feed" || this.phase === "rally" || this.phase === "pointOver") {
      for (const e of this.ball.update(dt)) {
        if (e.type === "bounce" && this.phase !== "pointOver") this.onBounce(e.x, e.z);
      }
      if (this.phase !== "pointOver") {
        this.checkPlayerReach();
        this.checkCpuReach();
        this.checkBallLost();
      }
    }
    this.move(this.player, dt);
    this.move(this.cpu, dt);
  }

  private after(ms: number, fn: () => void) {
    this.timers.push({ at: this.now + ms, fn });
  }

  // ---------- rally logic ----------

  private toReady() {
    this.phase = "ready";
    this.events.ballVisible(false);
    this.goTo(this.player, HOME.player.x, HOME.player.z);
    this.goTo(this.cpu, HOME.cpu.x, HOME.cpu.z);
    this.events.serveReady(true);
  }

  playerHittable() {
    if (this.lastHitter === "player") return false;
    // A dropped ball must bounce first; a rally ball may be volleyed or taken after one bounce.
    if (this.lastHitter === null ? this.bouncesSinceHit !== 1 : this.bouncesSinceHit > 1) return false;
    const { x, y, z } = this.ball.pos;
    const p = this.player;
    return (
      z < COURT.netZ &&
      Math.abs(x - p.x) < REACH.x &&
      Math.abs(z - (p.z + CONTACT_AHEAD)) < REACH.z &&
      y > REACH.yMin &&
      y < REACH.yMax
    );
  }

  private checkPlayerReach() {
    if (!this.playerHittable()) return;
    this.lastHittableAt = this.now;
    if (this.pendingSwing && this.now - this.pendingSwing.at <= HIT_WINDOW_MS) this.playerHit(this.pendingSwing);
  }

  private playerHit(swing: { power: number; tilt: number }) {
    this.pendingSwing = null;
    const b = this.ball.pos;
    const p = this.player;
    const forehand = b.x >= p.x;

    // Early (ball still in front) pulls the shot cross-court, late pushes it the other way;
    // the racquet tilt adds a little extra aim.
    const early = clamp((b.z - (p.z + CONTACT_AHEAD)) / REACH.z, -1, 1);
    const tx = clamp((forehand ? -early : early) * 3.2 + (swing.tilt / 90) * 1.2 + rand(-0.6, 0.6), -4.6, 4.6);
    const tz = COURT.length - rand(1.8, 5.3);
    const power = clamp(swing.power, 0, 1);

    this.ball.restitution = 0.74;
    this.ball.vel = aimOverNet(b, tx, tz, 1.35 - 0.5 * power);
    this.strike("player", power);
    this.cpuTriedHit = false;
    this.phase = "rally";

    this.goTo(this.player, 0.3, HOME.player.z);
    this.chaseBall(this.cpu);
  }

  private checkCpuReach() {
    if (this.lastHitter !== "player" || this.bouncesSinceHit !== 1 || this.cpuTriedHit) return;
    const b = this.ball.pos;
    const c = this.cpu;
    if (b.z < c.z - CONTACT_AHEAD) return; // not there yet
    this.cpuTriedHit = true;
    if (Math.abs(b.x - c.x) > REACH.x || b.y > REACH.yMax + 0.3) return; // couldn't get there

    const miss = Math.random() < CPU_ERROR_RATE;
    const wide = Math.random() < 0.5;
    const tx = miss && wide ? Math.sign(rand(-1, 1)) * rand(4.5, 5.5) : rand(-3.3, 3.3);
    const tz = miss && !wide ? -rand(0.4, 1.6) : rand(2.5, 7.5);
    const time = rand(1.15, 1.45);

    this.ball.vel = aimOverNet(b, tx, tz, time);
    this.strike("cpu", clamp((1.45 - time) / 0.5 + 0.3, 0, 1));
    this.lastHittableAt = -Infinity;
    this.pendingSwing = null;

    this.goTo(this.cpu, 0, HOME.cpu.z);
    this.chaseBall(this.player);
  }

  private strike(by: Side, power: number) {
    this.lastHitter = by;
    this.bouncesSinceHit = 0;
    this.rally++;
    const v = this.ball.vel;
    this.events.hit(by, Math.round(Math.hypot(v.x, v.y, v.z) * 3.6), power);
  }

  /** Auto-move: run to where the ball will be after it bounces, racquet side toward it. */
  private chaseBall(a: Athlete) {
    const near = a === this.player;
    const contact = predictContact(this.ball, near ? "near" : "far", near ? -2.2 : COURT.length + 3);
    if (!contact) return; // going into the net or out: no need to run
    if (near) {
      const forehand = contact.x >= a.x - 0.3;
      this.goTo(a, contact.x - (forehand ? SIDE_OFFSET : -SIDE_OFFSET), contact.z - CONTACT_AHEAD);
    } else {
      // Facing the camera, the computer's forehand side is screen-left.
      const forehand = contact.x <= a.x + 0.3;
      this.goTo(a, contact.x + (forehand ? SIDE_OFFSET : -SIDE_OFFSET), contact.z + CONTACT_AHEAD);
    }
  }

  private onBounce(x: number, z: number) {
    this.bouncesSinceHit++;

    if (this.lastHitter === null) {
      // Dropped ball: if it bounces twice nobody swung in time; just drop another one.
      if (this.bouncesSinceHit >= 2) {
        this.phase = "pointOver";
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
    this.score[winner]++;
    this.events.score(this.score);
    this.events.banner(reason, winner === "player" ? "Your point" : "Computer's point");
    this.after(2000, () => this.toReady());
  }

  // ---------- movement ----------

  private goTo(a: Athlete, x: number, z: number) {
    const near = a === this.player;
    a.targetX = clamp(x, -6, 6);
    a.targetZ = near ? clamp(z, -2.2, COURT.netZ - 1.5) : clamp(z, COURT.netZ + 1.5, COURT.length + 3);
  }

  private move(a: Athlete, dt: number) {
    const dx = a.targetX - a.x;
    const dz = a.targetZ - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) {
      a.vx = a.vz = 0;
      return;
    }
    const step = Math.min(dist, a.speed * dt);
    a.vx = ((dx / dist) * step) / dt;
    a.vz = ((dz / dist) * step) / dt;
    a.x += (dx / dist) * step;
    a.z += (dz / dist) * step;
  }
}
