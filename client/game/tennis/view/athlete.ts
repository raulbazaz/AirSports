import * as THREE from "three";

// A procedurally built human tennis player with real proportions (~1.83 m) and physically driven
// motion, no canned animation:
// - Feet are planted in the world and step when the body moves away from them (no foot sliding);
//   legs reach them by two-bone IK, and the pelvis height follows from how far the legs can reach.
// - The torso is spring-damped: it leans into acceleration and twists with the racquet arm.
// - The free arm swings against the legs and points forward on the backswing, with momentum.
// - The head tracks a look target (the ball).
// The model faces +z with its right (racquet) hand on -x.

export interface Look {
  skin: number;
  hair: number;
  shirt: number;
  trim: number;
  shorts: number;
  shoes: number;
  socks: number;
  hairStyle: "short" | "buzz";
}

// Same colours as the lobby characters (client/characters.ts).
export const PLAYER_LOOK: Look = {
  skin: 0xf2c9a5,
  hair: 0x6b3f22,
  shirt: 0x2f7de1,
  trim: 0xffffff,
  shorts: 0xf4f4f4,
  shoes: 0xf7f7f7,
  socks: 0xffffff,
  hairStyle: "short",
};

export const CPU_LOOK: Look = {
  skin: 0xa8694a,
  hair: 0x221812,
  shirt: 0xf08a24,
  trim: 0xffffff,
  shorts: 0xf4f4f4,
  shoes: 0x3a3f47,
  socks: 0xffffff,
  hairStyle: "buzz",
};

const SEG = { thigh: 0.45, shin: 0.44, upper: 0.29, fore: 0.26 };
const ANKLE_Y = 0.08;
const HIP = { x: 0.095, y: -0.06 }; // hip joints relative to the pelvis pivot
const LEG_MAX = (SEG.thigh + SEG.shin) * 0.985;
const DOWN = new THREE.Vector3(0, -1, 0);

const mat = (color: number) => new THREE.MeshLambertMaterial({ color });

function mesh(geo: THREE.BufferGeometry, material: THREE.Material, at?: [number, number, number], scale?: [number, number, number]) {
  const m = new THREE.Mesh(geo, material);
  if (at) m.position.set(...at);
  if (scale) m.scale.set(...scale);
  return m;
}

/** A lathe-turned body part from a [radius, y] profile (y down from the joint is negative). */
function lathe(profile: [number, number][], material: THREE.Material, segments = 12, depth = 1) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  if (depth !== 1) g.scale(1, 1, depth);
  return new THREE.Mesh(g, material);
}

/** Critically-ish damped spring on a scalar. */
class Spring {
  v = 0;
  constructor(public x = 0, private readonly w = 12, private readonly z = 0.75) {}
  step(target: number, dt: number) {
    this.v += (this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

interface Foot {
  pos: THREE.Vector3; // ground point under the ankle (world)
  from: THREE.Vector3;
  t: number; // step progress 0..1, or -1 when planted
  dur: number;
  lift: number;
  yaw: number;
  fromYaw: number;
}

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  end: THREE.Group;
}

const tmp = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
};

/** Rotate `upper`/`lower` (bones hanging along -y at rest) so their end reaches `target`. */
function solveTwoBone(limb: Limb, a: number, b: number, target: THREE.Vector3, pole: THREE.Vector3) {
  const { upper, lower } = limb;
  const S = upper.getWorldPosition(new THREE.Vector3());
  const toT = target.clone().sub(S);
  const len = toT.length() || 1e-6;
  const u = toT.divideScalar(len);
  const d = THREE.MathUtils.clamp(len, Math.abs(a - b) + 0.02, a + b - 1e-3);
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const p = pole.clone().addScaledVector(u, -pole.dot(u));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(u, u.y).normalize();
  else p.normalize();
  const E = S.clone()
    .addScaledVector(u, a * cosA)
    .addScaledVector(p, a * Math.sqrt(1 - cosA * cosA));
  const T = S.clone().addScaledVector(u, d);

  const parentQ = upper.parent!.getWorldQuaternion(new THREE.Quaternion());
  const qU = new THREE.Quaternion().setFromUnitVectors(DOWN, E.clone().sub(S).normalize());
  upper.quaternion.copy(parentQ.invert().multiply(qU));
  const qF = new THREE.Quaternion().setFromUnitVectors(DOWN, T.sub(E).normalize());
  lower.quaternion.copy(qU.invert().multiply(qF));
}

export class AthleteModel {
  readonly root = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legs: [Limb, Limb]; // right, left
  private readonly racquetArm: Limb;
  private readonly freeArm: Limb;

  private readonly feet: [Foot, Foot];
  private feetReady = false;
  private readonly lastRoot = new THREE.Vector3();
  private yaw: number;
  private pvx = 0;
  private pvz = 0;
  private readonly acc = new THREE.Vector2();
  private pelvisY = 1;
  private readonly pitch = new Spring(0.1, 9, 0.6);
  private readonly roll = new Spring(0, 9, 0.6);
  private readonly twist = new Spring(0, 10, 0.7);
  private twistTarget = 0;
  private readonly headYaw = new Spring(0, 12, 0.9);
  private readonly headPitch = new Spring(0, 12, 0.9);
  private lookTarget: THREE.Vector3 | null = null;
  /** Racquet hand in model space, last frame (drives torso twist and the balancing arm). */
  private readonly handLocal = new THREE.Vector3(-0.3, 1.0, 0.25);
  private readonly freeHand = { x: new Spring(0.3, 13, 0.7), y: new Spring(1.0, 13, 0.7), z: new Spring(0.25, 13, 0.7) };

  constructor(look: Look, private readonly facing: number) {
    this.yaw = facing;
    const skin = mat(look.skin);
    const shirt = mat(look.shirt);
    const trim = mat(look.trim);
    const shorts = mat(look.shorts);
    const shoes = mat(look.shoes);
    const socks = mat(look.socks);
    const hair = mat(look.hair);
    const sole = mat(0xd8d8d8);
    const dark = new THREE.MeshBasicMaterial({ color: 0x241a14 });
    const white = new THREE.MeshBasicMaterial({ color: 0xf6f6f6 });
    const lips = mat(0xb5655a);

    this.root.add(this.pelvis);
    this.root.rotation.y = facing;

    // ---- Hips and legs ----
    this.pelvis.add(mesh(new THREE.SphereGeometry(0.17, 16, 10), shorts, [0, -0.03, 0], [1, 0.75, 0.72]));
    this.legs = [-1, 1].map((side) => {
      const upper = new THREE.Group();
      upper.position.set(side * HIP.x, HIP.y, 0);
      upper.add(
        lathe([[0.001, 0.05], [0.08, 0.035], [0.088, -0.06], [0.08, -0.22], [0.064, -0.38], [0.055, -0.45], [0.001, -0.47]], skin),
      );
      const leg = lathe([[0.096, 0.05], [0.1, -0.06], [0.094, -0.22], [0.09, -0.23]], shorts);
      (leg.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
      upper.add(leg);
      const lower = new THREE.Group();
      lower.position.y = -SEG.thigh;
      lower.add(mesh(new THREE.SphereGeometry(0.056, 10, 8), skin));
      lower.add(lathe([[0.001, 0.02], [0.05, 0.01], [0.06, -0.11], [0.048, -0.27], [0.036, -0.4], [0.001, -0.44]], skin));
      const sock = lathe([[0.042, -0.3], [0.04, -0.36], [0.04, -0.44]], socks);
      lower.add(sock);
      const end = new THREE.Group();
      end.position.y = -SEG.shin;
      end.add(mesh(new THREE.SphereGeometry(1, 14, 10), shoes, [0, -0.035, 0.05], [0.055, 0.048, 0.13]));
      end.add(mesh(new THREE.BoxGeometry(0.1, 0.022, 0.26), sole, [0, -0.07, 0.05]));
      lower.add(end);
      upper.add(lower);
      this.pelvis.add(upper);
      return { upper, lower, end };
    }) as [Limb, Limb];

    // ---- Torso ----
    this.spine.position.y = 0.04;
    this.pelvis.add(this.spine);
    this.spine.add(lathe([[0.001, -0.06], [0.145, -0.05], [0.142, 0.08], [0.15, 0.24], [0.001, 0.25]], shirt, 16, 0.68));
    this.chest.position.y = 0.22;
    this.spine.add(this.chest);
    this.chest.add(
      lathe(
        [[0.001, -0.04], [0.15, -0.03], [0.168, 0.08], [0.188, 0.19], [0.195, 0.24], [0.15, 0.29], [0.07, 0.31], [0.001, 0.312]],
        shirt,
        16,
        0.62,
      ),
    );
    const collar = mesh(new THREE.TorusGeometry(0.058, 0.012, 6, 16), trim, [0, 0.3, 0.004]);
    collar.rotation.x = Math.PI / 2;
    this.chest.add(collar);

    // ---- Neck and head ----
    this.neck.position.y = 0.28;
    this.chest.add(this.neck);
    this.neck.add(mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.14, 10), skin, [0, 0.05, 0]));
    this.head.position.y = 0.1;
    this.head.rotation.order = "YXZ";
    this.neck.add(this.head);
    this.head.add(mesh(new THREE.SphereGeometry(0.105, 18, 14), skin, [0, 0.115, -0.005], [0.9, 1.06, 1]));
    this.head.add(mesh(new THREE.SphereGeometry(0.085, 14, 10), skin, [0, 0.055, 0.018], [0.86, 0.85, 0.98]));
    this.head.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), skin, [0, 0.09, 0.1], [0.9, 1.3, 1.2]));
    this.head.add(mesh(new THREE.BoxGeometry(0.036, 0.009, 0.01), lips, [0, 0.042, 0.092]));
    for (const side of [-1, 1]) {
      this.head.add(mesh(new THREE.SphereGeometry(0.022, 8, 6), skin, [side * 0.094, 0.1, -0.005], [0.45, 1, 0.75]));
      this.head.add(mesh(new THREE.SphereGeometry(0.015, 8, 6), white, [side * 0.036, 0.118, 0.086], [1.15, 0.75, 0.5]));
      this.head.add(mesh(new THREE.SphereGeometry(0.0085, 8, 6), dark, [side * 0.036, 0.118, 0.093]));
      const brow = mesh(new THREE.BoxGeometry(0.036, 0.008, 0.01), hair, [side * 0.037, 0.142, 0.092]);
      brow.rotation.z = side * -0.12;
      this.head.add(brow);
    }
    const buzz = look.hairStyle === "buzz";
    const cap = mesh(
      new THREE.SphereGeometry(0.11, 18, 10, 0, Math.PI * 2, 0, Math.PI * (buzz ? 0.5 : 0.56)),
      hair,
      [0, buzz ? 0.122 : 0.128, -0.008],
      buzz ? [0.93, 1.04, 1.04] : [0.97, 1.12, 1.08],
    );
    cap.rotation.x = -0.4;
    this.head.add(cap);
    if (!buzz) {
      const fringe = mesh(new THREE.SphereGeometry(0.06, 10, 6), hair, [0.02, 0.2, 0.06], [1.5, 0.45, 0.8]);
      fringe.rotation.z = -0.2;
      this.head.add(fringe);
    }

    // ---- Arms ----
    const makeArm = (side: number): Limb => {
      const upper = new THREE.Group();
      upper.position.set(side * 0.19, 0.235, 0);
      upper.add(mesh(new THREE.SphereGeometry(0.068, 12, 8), shirt));
      upper.add(lathe([[0.001, 0.03], [0.05, 0.02], [0.054, -0.08], [0.045, -0.22], [0.04, -0.29], [0.001, -0.31]], skin));
      const sleeve = lathe([[0.07, 0.04], [0.066, -0.06], [0.062, -0.13]], shirt);
      (sleeve.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
      upper.add(sleeve);
      const lower = new THREE.Group();
      lower.position.y = -SEG.upper;
      lower.add(mesh(new THREE.SphereGeometry(0.042, 8, 6), skin));
      lower.add(lathe([[0.001, 0.02], [0.042, 0.01], [0.045, -0.06], [0.032, -0.24], [0.001, -0.27]], skin));
      const end = new THREE.Group();
      end.position.y = -SEG.fore;
      end.add(mesh(new THREE.SphereGeometry(1, 10, 8), skin, [0, -0.045, 0.005], [0.04, 0.055, 0.03]));
      end.add(mesh(new THREE.SphereGeometry(0.016, 6, 5), skin, [side * -0.03, -0.03, 0.02], [1, 1.6, 1]));
      lower.add(end);
      upper.add(lower);
      this.chest.add(upper);
      return { upper, lower, end };
    };
    this.racquetArm = makeArm(-1);
    this.freeArm = makeArm(1);
    this.racquetArm.lower.add(lathe([[0.041, -0.18], [0.04, -0.23]], trim));

    const foot = (): Foot => ({ pos: new THREE.Vector3(), from: new THREE.Vector3(), t: -1, dur: 0.25, lift: 0.08, yaw: facing, fromYaw: facing });
    this.feet = [foot(), foot()];
  }

  /** Where the head should look (world), or null to look straight ahead. */
  setLookTarget(p: THREE.Vector3 | null) {
    this.lookTarget = p ? (this.lookTarget ?? new THREE.Vector3()).copy(p) : null;
  }

  /** Simulate the body for this frame. `vx`/`vz` is the velocity in scene space (m/s). */
  update(dt: number, time: number, vx: number, vz: number) {
    const root = this.root.position;
    const speed = Math.hypot(vx, vz);
    const run = THREE.MathUtils.smoothstep(speed, 0.6, 5);

    // Facing: turn toward the run direction for long runs, shuffle sideways for short ones.
    let target = this.facing;
    if (speed > 2.5) {
      const diff = angleDiff(Math.atan2(vx, vz), this.facing);
      if (Math.abs(diff) < 2) target = this.facing + diff * 0.8 * THREE.MathUtils.smoothstep(speed, 2.5, 5.5);
    }
    this.yaw += angleDiff(target, this.yaw) * Math.min(1, dt * 8);
    this.root.rotation.y = this.yaw;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const rx = Math.cos(this.yaw); // model +x (the left side) in scene space
    const rz = -Math.sin(this.yaw);

    // Acceleration in the body frame, smoothed.
    if (dt > 0) {
      const k = Math.min(1, dt * 12);
      this.acc.x += (((vx - this.pvx) / dt) - this.acc.x) * k;
      this.acc.y += (((vz - this.pvz) / dt) - this.acc.y) * k;
    }
    this.pvx = vx;
    this.pvz = vz;
    const accFwd = this.acc.x * fx + this.acc.y * fz;
    const accSide = this.acc.x * rx + this.acc.y * rz;
    const velFwd = vx * fx + vz * fz;

    // ---- Feet ----
    const width = 0.19 * (1 - run) + 0.1 * run;
    const desired = (i: number, lead: number, out: THREE.Vector3) => {
      const side = i === 0 ? -1 : 1;
      return out.set(root.x + rx * side * width + vx * lead, 0, root.z + rz * side * width + vz * lead);
    };
    if (!this.feetReady || root.distanceTo(this.lastRoot) > 1.2) {
      this.feet.forEach((f, i) => {
        desired(i, 0, f.pos);
        f.t = -1;
        f.yaw = this.yaw;
      });
      this.feetReady = true;
    }
    this.lastRoot.copy(root);

    const dur = THREE.MathUtils.clamp(0.3 - speed * 0.025, 0.15, 0.3);
    const want = [desired(0, 0.1, new THREE.Vector3()), desired(1, 0.1, new THREE.Vector3())];
    // Land steps in progress (retargeting toward where the body is going).
    this.feet.forEach((f, i) => {
      if (f.t < 0) return;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = smooth(f.t);
      const to = tmp.a.copy(want[i]).addScaledVector(tmp.b.set(vx, 0, vz), f.dur * (1 - f.t) * 0.6);
      f.pos.lerpVectors(f.from, to, e);
      f.yaw = f.fromYaw + angleDiff(this.yaw, f.fromYaw) * e;
      if (f.t >= 1) f.t = -1;
    });
    // Start the next step with whichever planted foot is furthest from where it should be.
    const threshold = 0.1 + speed * 0.06;
    let pick = -1;
    let worst = threshold;
    this.feet.forEach((f, i) => {
      if (f.t >= 0) return;
      const other = this.feet[1 - i];
      const err = Math.max(f.pos.distanceTo(want[i]), Math.abs(angleDiff(this.yaw, f.yaw)) * 0.3);
      const free = other.t < 0 || other.t > 0.65 || err > 0.8;
      if (free && err > worst) {
        worst = err;
        pick = i;
      }
    });
    if (pick >= 0) {
      const f = this.feet[pick];
      f.from.copy(f.pos);
      f.fromYaw = f.yaw;
      f.t = 0;
      f.dur = dur;
      f.lift = 0.05 + Math.min(speed, 6) * 0.02;
    }

    // ---- Pelvis: as high as the stance allows, lower in the ready crouch ----
    const bounce = Math.sin(time * 0.009) * (1 - run);
    const crouch = 0.11 * (1 - run) + 0.05 * run + bounce * 0.012;
    let top = ANKLE_Y + SEG.thigh + SEG.shin - crouch - HIP.y;
    this.feet.forEach((f, i) => {
      const side = i === 0 ? -1 : 1;
      const hx = root.x + rx * side * HIP.x;
      const hz = root.z + rz * side * HIP.x;
      const horiz = Math.hypot(f.pos.x - hx, f.pos.z - hz);
      const ankleY = ANKLE_Y + (f.t >= 0 ? Math.sin(Math.PI * f.t) * f.lift : 0);
      top = Math.min(top, ankleY + Math.sqrt(Math.max(0, LEG_MAX * LEG_MAX - horiz * horiz)) - HIP.y);
    });
    this.pelvisY += (top - this.pelvisY) * Math.min(1, dt * 25);
    this.pelvis.position.y = this.pelvisY;

    // ---- Torso: lean into acceleration, twist with the racquet ----
    const pitch = this.pitch.step(0.1 * (1 - run) + 0.2 * run + THREE.MathUtils.clamp(accFwd * 0.025, -0.2, 0.25) + velFwd * 0.01, dt);
    const roll = this.roll.step(THREE.MathUtils.clamp(-accSide * 0.025, -0.25, 0.25), dt);
    const twist = this.twist.step(this.twistTarget, dt);
    // Hips counter-rotate with the stride.
    const stride = this.footLocalZ(0) - this.footLocalZ(1);
    const hipTwist = THREE.MathUtils.clamp(stride * 0.35, -0.3, 0.3) + twist * 0.25;
    this.pelvis.rotation.set(pitch * 0.25, hipTwist, roll * 0.3);
    this.spine.rotation.set(pitch * 0.45, twist * 0.35 - hipTwist * 0.6, roll * 0.4);
    this.chest.rotation.set(pitch * 0.3, twist * 0.4 - hipTwist * 0.4, roll * 0.3);

    // ---- Legs reach the feet ----
    this.root.updateMatrixWorld(true);
    const knee = tmp.c.set(fx, 0, fz);
    this.feet.forEach((f, i) => {
      const lift = f.t >= 0 ? Math.sin(Math.PI * f.t) * f.lift : 0;
      const ankle = new THREE.Vector3(f.pos.x, ANKLE_Y + lift, f.pos.z);
      const leg = this.legs[i];
      solveTwoBone(leg, SEG.thigh, SEG.shin, ankle, knee);
      // Shoe flat on the ground (toes turned out a touch), rolling off the toes mid-step.
      const toe = f.t >= 0 ? -Math.sin(Math.PI * f.t) * 0.35 : 0;
      const footQ = tmp.q.setFromEuler(new THREE.Euler(toe, f.yaw + (i === 0 ? -0.12 : 0.12), 0, "YXZ"));
      const shinQ = leg.lower.getWorldQuaternion(tmp.q2);
      leg.end.quaternion.copy(shinQ.invert().multiply(footQ));
    });

    // ---- Free arm: counter-swings the legs, points forward on the backswing ----
    const h = this.handLocal;
    const prep = THREE.MathUtils.clamp((0.1 - h.z) * 2.2, 0, 1);
    const fh = this.freeHand;
    const hipBase = this.pelvisY;
    const fhx = fh.x.step(0.26 - prep * 0.15, dt);
    const fhy = fh.y.step(hipBase + 0.02 + prep * 0.35 + run * 0.08, dt);
    const fhz = fh.z.step(0.18 + prep * 0.25 - stride * 0.6 * run, dt);
    const freeTarget = this.root.localToWorld(new THREE.Vector3(fhx, fhy, fhz));
    solveTwoBone(this.freeArm, SEG.upper, SEG.fore, freeTarget, this.toWorldDir(0.8, -1, -0.7));

    // ---- Head tracks the look target ----
    let yawT = 0;
    let pitchT = -(pitch * 1.0);
    if (this.lookTarget) {
      const local = this.neck.worldToLocal(tmp.a.copy(this.lookTarget));
      local.y -= this.head.position.y + 0.1;
      yawT = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1.1, 1.1);
      pitchT = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.6, 0.6);
    }
    this.head.rotation.set(this.headPitch.step(pitchT, dt), this.headYaw.step(yawT, dt), 0);
  }

  private footLocalZ(i: number) {
    const f = this.feet[i].pos;
    const r = this.root.position;
    return (f.x - r.x) * Math.sin(this.yaw) + (f.z - r.z) * Math.cos(this.yaw);
  }

  /** World position of the racquet shoulder (after `update`). */
  shoulderWorld(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.racquetArm.upper.getWorldPosition(out);
  }

  /** Put the racquet hand at `target` (world), bending the elbow toward `pole`. */
  reach(target: THREE.Vector3, pole: THREE.Vector3) {
    solveTwoBone(this.racquetArm, SEG.upper, SEG.fore, target, pole);
    // Shoulders follow the hand: back on the backswing, through on the follow-through.
    this.handLocal.copy(this.root.worldToLocal(this.handWorld()));
    this.twistTarget = THREE.MathUtils.clamp(0.9 * (this.handLocal.z - 0.2) + 0.6 * (this.handLocal.x + 0.3), -0.9, 0.8);
  }

  /** Where the racquet hand actually ended up (after `reach`). */
  handWorld(out = new THREE.Vector3()) {
    this.racquetArm.end.updateWorldMatrix(true, false);
    return this.racquetArm.end.localToWorld(out.set(0, -0.05, 0));
  }

  headWorld(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.set(0, 0.32, 0));
  }

  /** Model-space direction → world, for poles and swing paths. */
  toWorldDir(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z).applyQuaternion(this.root.quaternion);
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
