import * as THREE from "three";
import type { Stroke } from "../match";

// The racquet arm's stroke, as a path for the hand: ready → unit turn with the racquet back as
// the ball comes → drop low → swing up through contact in front → finish over the opposite
// shoulder → recover. Positions are offsets from the racquet shoulder in the player's own frame
// (right, up, forward), in meters; IK finds the arm. The shoulders coil with it.
//
// The computer also takes its racquet direction from here. The player's racquet direction is the
// phone's, layered over this path.

type P = readonly [number, number, number];

interface Path {
  back: P;
  low: P;
  contact: P;
  follow: P;
  /** Racquet shaft directions (right, up, forward) at the same points, for the computer. */
  shaft: { back: P; low: P; contact: P; follow: P };
  /** Shoulder turn: racquet side forward is positive. */
  coil: { back: number; contact: number; follow: number };
}

const READY = { hand: [0.18, -0.5, 0.42] as P, shaft: [-0.1, 0.65, 0.75] as P };

const PATHS: Record<Stroke, Path> = {
  forehand: {
    back: [0.55, -0.12, -0.42],
    low: [0.55, -0.62, -0.05],
    contact: [0.5, -0.5, 0.52],
    follow: [-0.4, 0.12, 0.32],
    shaft: { back: [0.55, 0.3, -0.8], low: [0.75, -0.35, -0.45], contact: [1, 0.1, 0.25], follow: [-0.6, 0.85, 0.25] },
    coil: { back: -0.45, contact: 0.1, follow: 0.5 },
  },
  backhand: {
    back: [-0.42, -0.18, -0.25],
    low: [-0.45, -0.62, 0.02],
    contact: [-0.32, -0.5, 0.52],
    follow: [0.5, 0.15, 0.28],
    shaft: { back: [-0.6, 0.35, -0.7], low: [-0.8, -0.3, -0.4], contact: [-1, 0.1, 0.25], follow: [0.6, 0.85, 0.2] },
    coil: { back: 0.7, contact: 0.2, follow: -0.35 },
  },
};

/** Swing progress (0..1) at each point; the racquet meets the ball at CONTACT_U. */
const U = { low: 0.24, contact: 0.44, follow: 0.8 };
export const CONTACT_U = U.contact;
/** Recovery from the finish back to ready (s). */
const RECOVER_S = 0.4;

export interface StrokePose {
  /** Hand offset from the racquet shoulder (right, up, forward). */
  hand: THREE.Vector3;
  /** Racquet shaft (right, up, forward), normalized. */
  shaft: THREE.Vector3;
  /** How much this pose should override the racquet's free position (0..1). */
  weight: number;
  coil: number;
  /** How close the racquet is to the moment of contact (1 at contact, 0 beyond ±60 ms). */
  contact: number;
}

const v = (p: P) => new THREE.Vector3(p[0], p[1], p[2]);
const ease = (t: number) => t * t * (3 - 2 * t);

export class StrokeAnim {
  stroke: Stroke = "forehand";
  /** Unit turn / racquet back, 0..1. */
  private prep = 0;
  /** Swing progress 0..1, or null between swings. */
  private u: number | null = null;
  private dur = 0.45;
  /** Recovery progress after a swing, 0..1 (1 = done). */
  private recover = 1;

  get swinging() {
    return this.u !== null;
  }

  /** Seconds the swing takes from the backswing to contact at this power. */
  static leadTime(power: number) {
    return THREE.MathUtils.lerp(0.5, 0.34, power) * CONTACT_U;
  }

  /** Start a swing (power 0..1), optionally partway in (`u`). */
  start(stroke: Stroke, power: number, u = 0) {
    this.stroke = stroke;
    this.dur = THREE.MathUtils.lerp(0.5, 0.34, THREE.MathUtils.clamp(power, 0, 1));
    this.u = Math.max(0, u);
    this.recover = 1;
  }

  /** The ball was struck now: line the swing up with contact (starting it if needed). */
  contactNow(stroke: Stroke, power: number) {
    if (this.u === null || this.u > U.follow) this.start(stroke, power, CONTACT_U);
    else this.u = Math.max(this.u, CONTACT_U);
  }

  /** `ready`: the ball is coming to this player (turn and take the racquet back). */
  update(dt: number, ready: boolean, stroke: Stroke) {
    if (!this.swinging && ready) this.stroke = stroke;
    this.prep = THREE.MathUtils.clamp(this.prep + (ready ? dt / 0.35 : -dt / 0.5), 0, 1);
    if (this.u !== null) {
      this.u += dt / this.dur;
      if (this.u >= 1) {
        this.u = null;
        this.recover = 0;
        this.prep = 0;
      }
    } else if (this.recover < 1) {
      this.recover = Math.min(1, this.recover + dt / RECOVER_S);
    }
  }

  pose(): StrokePose {
    const p = PATHS[this.stroke];
    if (this.u !== null) {
      const u = this.u;
      const keys: [number, P, P, number][] = [
        [0, p.back, p.shaft.back, p.coil.back],
        [U.low, p.low, p.shaft.low, (p.coil.back + p.coil.contact) / 2],
        [U.contact, p.contact, p.shaft.contact, p.coil.contact],
        [U.follow, p.follow, p.shaft.follow, p.coil.follow],
        [1, p.follow, p.shaft.follow, p.coil.follow],
      ];
      let i = 0;
      while (i < keys.length - 2 && u > keys[i + 1][0]) i++;
      const [u0, h0, s0, c0] = keys[i];
      const [u1, h1, s1, c1] = keys[i + 1];
      const t = THREE.MathUtils.clamp((u - u0) / (u1 - u0), 0, 1);
      // Catmull-Rom through the neighbours keeps the arc round instead of corner-to-corner.
      const prev = v(keys[Math.max(0, i - 1)][1]);
      const next = v(keys[Math.min(keys.length - 1, i + 2)][1]);
      const hand = catmull(prev, v(h0), v(h1), next, t);
      const shaft = slerpDir(v(s0).normalize(), v(s1).normalize(), ease(t));
      const fromContact = Math.abs(u - U.contact) * this.dur;
      return { hand, shaft, weight: 1, coil: c0 + (c1 - c0) * t, contact: Math.max(0, 1 - fromContact / 0.06) };
    }
    // Ready ↔ racquet back, blended from the finish while recovering.
    const k = ease(this.prep);
    const hand = v(READY.hand).lerp(v(p.back), k);
    const shaft = slerpDir(v(READY.shaft).normalize(), v(p.shaft.back).normalize(), k);
    let coil = p.coil.back * k;
    let weight = k;
    if (this.recover < 1) {
      const r = ease(this.recover);
      hand.lerpVectors(v(p.follow), hand, r);
      shaft.copy(slerpDir(v(p.shaft.follow).normalize(), shaft, r));
      coil = p.coil.follow + (coil - p.coil.follow) * r;
      weight = Math.max(weight, 1 - r);
    }
    return { hand, shaft, weight, coil, contact: 0 };
  }
}

function catmull(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return new THREE.Vector3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

export function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number) {
  const q = new THREE.Quaternion().setFromUnitVectors(a, b);
  return a.clone().applyQuaternion(new THREE.Quaternion().slerp(q, t));
}
