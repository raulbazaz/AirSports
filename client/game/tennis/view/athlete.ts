import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

// A rigged 3D character (client/public/models/athlete.glb) driven by physical, procedural motion
// instead of canned animation:
// - Feet are planted in the world and step when the body moves away from them (no foot sliding);
//   legs reach them by two-bone IK, and the pelvis height follows from how far the legs can reach.
// - The torso is spring-damped: it leans into acceleration and twists with the racquet arm.
// - The free arm swings against the legs and points forward on the backswing, with momentum.
// - The head tracks a look target (the ball).
// - Strokes: the shoulders coil and uncoil with the swing (hips lead), a split step when the
//   opponent strikes, the front foot steps in at contact; the racquet hand grips (curled fingers)
//   and the forearm and wrist turn with the racquet.
//
// The motion runs on an invisible "driver" skeleton of plain groups whose joints are measured from
// the model, so its feet and hands land exactly where the model's do. Each frame the driver's
// joint rotations are copied onto the model's bones (retargeting). The model faces +z with its
// right (racquet) hand on -x.

const MODEL_URL = "/models/athlete.glb";
const HEIGHT = 1.83;

export interface Look {
  skin: number;
  hair: number;
  shirt: number;
  shorts: number;
  socks: number;
  shoes: number;
}

// Same colours as the lobby characters (client/characters.ts).
export const PLAYER_LOOK: Look = {
  skin: 0xf2c9a5,
  hair: 0x6b3f22,
  shirt: 0x2f7de1,
  shorts: 0xf4f4f4,
  socks: 0xffffff,
  shoes: 0xf2f2f2,
};

export const CPU_LOOK: Look = {
  skin: 0xa8694a,
  hair: 0x221812,
  shirt: 0xf08a24,
  shorts: 0xf4f4f4,
  socks: 0xffffff,
  shoes: 0x3a3f47,
};

/** Model material name → which colour of the Look paints it. */
const PAINT: Record<string, keyof Look | null> = {
  Skin: "skin",
  Hair: "hair",
  Shirt: "shirt",
  Pants: "shorts",
  Socks: "socks",
  Shoes: "shoes",
  Eyes: null,
};

/** The loaded character, shared by both players (each gets its own clone). */
export interface AthleteAsset {
  scene: THREE.Object3D;
}

export async function loadAthlete(): Promise<AthleteAsset> {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  return { scene: gltf.scene };
}

const DOWN = new THREE.Vector3(0, -1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

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
  /** A deliberate step (the front foot at contact) lands here instead of under the hip. */
  to: THREE.Vector3 | null;
  /** Stay planted until this time (s): don't tidy a deliberate step away at once. */
  holdUntil: number;
}

/** A hand bone and its rest frame, for turning the hand with the racquet. */
interface Hand {
  palm: THREE.Object3D;
  /** World rotation of the palm at rest, and its axes then: toward the fingers, toward the thumb. */
  rest: THREE.Quaternion;
  down: THREE.Vector3;
  thumb: THREE.Vector3;
  /** Racquet grip (middle of the fist) in the palm's frame. */
  grip: THREE.Vector3;
}

/** Fingers curl toward the palm by these angles (radians): a fist on the handle, a loose free hand. */
const GRIP_CURL = { knuckle: 1.25, finger: 1.35, thumb: 0.5 };
const LOOSE_CURL = { knuckle: 0.45, finger: 0.5, thumb: 0.15 };
/** Share of the hand's roll taken by the forearm (the rest is the wrist). */
const FOREARM_ROLL = 0.7;

/** A driver limb: groups hanging along -y at rest. */
interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  end: THREE.Group;
}

/** A driver group and the model bone it moves; `rest` is the bone's world rotation at rest. */
interface Link {
  driver: THREE.Object3D;
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  /** Also copy the driver's world position (bones that aren't attached to their chain). */
  place?: boolean;
}

const tmp = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
};

/** Rotate `upper`/`lower` (hanging along -y at rest) so their end reaches `target`. */
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

/** Give `o` this world rotation (its parent's world matrix must be current). */
function setWorldQuaternion(o: THREE.Object3D, q: THREE.Quaternion) {
  const parentQ = o.parent!.getWorldQuaternion(tmp.q2);
  o.quaternion.copy(parentQ.invert().multiply(q));
  o.updateWorldMatrix(false, true);
}

/** Turn a bone (in world space) so the direction `from` → its child joint points along `to`. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, to: THREE.Vector3) {
  const dir = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
  const q = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromUnitVectors(dir, to));
  setWorldQuaternion(bone, q);
}

const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

export class AthleteModel {
  readonly root = new THREE.Group();
  /** Shoulder to grip at full stretch (m). */
  readonly armLength: number;

  // ---- Driver skeleton (invisible) ----
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legs: [Limb, Limb]; // right, left
  private readonly racquetArm: Limb;
  private readonly freeArm: Limb;
  private readonly links: Link[] = [];

  // ---- Measured from the model ----
  private readonly seg: { thigh: number; shin: number; upper: number; fore: number };
  private readonly ankleY: number;
  private readonly hips: [THREE.Vector3, THREE.Vector3]; // hip joints relative to the pelvis pivot
  private readonly legMax: number;
  private readonly grip = new THREE.Vector3(); // racquet grip in the hand's frame
  private readonly hand: Hand;
  private readonly headTop = new THREE.Vector3();

  // ---- Simulation state ----
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
  private readonly freeHand = { x: new Spring(0.3, 13, 0.7), y: new Spring(0.85, 13, 0.7), z: new Spring(0.25, 13, 0.7) };
  /** Extra shoulder turn from the stroke (radians; + turns the racquet side forward). */
  private coil = 0;
  /** Split step progress (s since it started), or -1. */
  private split = -1;
  private clock = 0;

  constructor(asset: AthleteAsset, look: Look, private readonly facing: number) {
    this.yaw = facing;

    // ---- The model: scaled to height, feet on the ground, recoloured ----
    const model = cloneSkinned(asset.scene);
    model.updateMatrixWorld(true); // the skinned bounds below are computed from the bones
    const box = new THREE.Box3().setFromObject(model);
    const scale = HEIGHT / (box.max.y - box.min.y);
    const holder = new THREE.Group();
    holder.scale.setScalar(scale);
    holder.position.y = -box.min.y * scale;
    holder.add(model);
    this.root.add(holder);
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.frustumCulled = false; // bones move it away from its bind-pose bounds
      const paint = (m: THREE.Material) => {
        const src = m as THREE.MeshStandardMaterial;
        const key = PAINT[src.name];
        const color = key ? look[key] : src.color.getHex();
        return new THREE.MeshLambertMaterial({ name: src.name, color });
      };
      o.material = Array.isArray(o.material) ? o.material.map(paint) : paint(o.material);
    });
    this.root.updateMatrixWorld(true);

    const bone = (name: string) => {
      // The "_end" tips aren't skinned, so they load as plain nodes rather than bones.
      const b = model.getObjectByName(name);
      if (!b) throw new Error(`athlete model has no bone "${name}"`);
      return b;
    };
    const B = {
      body: bone("Body"),
      abdomen: bone("Abdomen"),
      torso: bone("Torso"),
      neck: bone("Neck"),
      head: bone("Head"),
      headEnd: bone("Head_end"),
    };
    const legBones = (s: "R" | "L") => ({
      upper: bone(`UpperLeg${s}`),
      lower: bone(`LowerLeg${s}`),
      ankle: bone(`LowerLeg${s}_end`),
      foot: bone(`Foot${s}`),
      toe: bone(`Foot${s}_end`),
    });
    const armBones = (s: "R" | "L") => ({
      upper: bone(`UpperArm${s}`),
      lower: bone(`LowerArm${s}`),
      palm: bone(`Palm${s}`),
      hand: bone(`MiddleHand${s}`),
      fingers: bone(`Fingers${s}`),
    });
    const L = [legBones("R"), legBones("L")] as const;
    const A = [armBones("R"), armBones("L")] as const;

    // The shoe soles sit on the ground with the foot bones at ankle height.
    this.ankleY = (wp(L[0].foot).y + wp(L[1].foot).y) / 2;

    // ---- Put the model in the driver's rest pose: limbs straight down, feet straight ahead ----
    for (const l of L) {
      aim(l.upper, l.lower, DOWN);
      aim(l.lower, l.ankle, DOWN);
      aim(l.foot, l.toe, FORWARD);
    }
    for (const a of A) {
      aim(a.upper, a.lower, DOWN);
      aim(a.lower, a.palm, DOWN);
    }

    // ---- Measure it ----
    const pelvisAt = wp(B.body);
    const avg = (f: (i: 0 | 1) => number) => (f(0) + f(1)) / 2;
    this.seg = {
      thigh: avg((i) => wp(L[i].upper).distanceTo(wp(L[i].lower))),
      shin: avg((i) => wp(L[i].lower).distanceTo(wp(L[i].ankle))),
      upper: avg((i) => wp(A[i].upper).distanceTo(wp(A[i].lower))),
      fore: avg((i) => wp(A[i].lower).distanceTo(wp(A[i].palm))),
    };
    this.legMax = (this.seg.thigh + this.seg.shin) * 0.985;
    this.hips = [wp(L[0].upper).sub(pelvisAt), wp(L[1].upper).sub(pelvisAt)];
    this.grip.copy(wp(A[0].hand).add(wp(A[0].fingers)).multiplyScalar(0.5).sub(wp(A[0].palm)));
    this.armLength = this.seg.upper + this.seg.fore + this.grip.length();
    this.headTop.copy(wp(B.headEnd).sub(wp(B.head)));
    this.pelvisY = pelvisAt.y;

    // ---- Hands: grip the racquet, relax the other one ----
    const midline = pelvisAt.x;
    const curl = (i: 0 | 1, c: typeof GRIP_CURL) => {
      const h = A[i];
      const fingerDir = wp(bone(`Fingers${i ? "L" : "R"}_end`)).sub(wp(h.hand)).normalize();
      const towardBody = new THREE.Vector3(Math.sign(midline - wp(h.palm).x), 0, 0);
      const axis = fingerDir.clone().cross(towardBody).normalize();
      const turn = (b: THREE.Object3D, angle: number, about = axis) =>
        setWorldQuaternion(b, b.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(about, angle)));
      turn(h.hand, c.knuckle);
      turn(h.fingers, c.finger);
      turn(bone(`Thumb1${i ? "L" : "R"}`), c.thumb, fingerDir);
    };
    const palmRest = (() => {
      const h = A[0];
      const down = wp(h.hand).sub(wp(h.palm)).normalize();
      const thumb = wp(bone("Thumb1R")).sub(wp(h.hand));
      thumb.addScaledVector(down, -thumb.dot(down)).normalize();
      return { down, thumb };
    })();
    curl(0, GRIP_CURL);
    curl(1, LOOSE_CURL);
    this.root.updateMatrixWorld(true);
    const palm = A[0].palm;
    this.hand = {
      palm,
      rest: palm.getWorldQuaternion(new THREE.Quaternion()),
      ...palmRest,
      grip: palm.worldToLocal(wp(A[0].hand).add(wp(A[0].fingers)).multiplyScalar(0.5)),
    };

    // ---- Build the driver to the same measurements ----
    this.root.add(this.pelvis);
    this.pelvis.position.copy(pelvisAt);
    this.pelvis.add(this.spine);
    this.spine.position.copy(wp(B.abdomen).sub(pelvisAt));
    this.spine.add(this.chest);
    this.chest.position.copy(wp(B.torso).sub(wp(B.abdomen)));
    this.chest.add(this.neck);
    this.neck.position.copy(wp(B.neck).sub(wp(B.torso)));
    this.neck.add(this.head);
    this.head.position.copy(wp(B.head).sub(wp(B.neck)));
    this.head.rotation.order = "YXZ";

    const limb = (parent: THREE.Object3D, at: THREE.Vector3, a: number, b: number): Limb => {
      const upper = new THREE.Group();
      const lower = new THREE.Group();
      const end = new THREE.Group();
      upper.position.copy(at);
      lower.position.y = -a;
      end.position.y = -b;
      parent.add(upper);
      upper.add(lower);
      lower.add(end);
      return { upper, lower, end };
    };
    this.legs = [0, 1].map((i) => limb(this.pelvis, this.hips[i], this.seg.thigh, this.seg.shin)) as [Limb, Limb];
    const shoulder = (i: 0 | 1) => wp(A[i].upper).sub(wp(B.torso));
    this.racquetArm = limb(this.chest, shoulder(0), this.seg.upper, this.seg.fore);
    this.freeArm = limb(this.chest, shoulder(1), this.seg.upper, this.seg.fore);

    // ---- Link driver → model, in parent-before-child order ----
    const link = (driver: THREE.Object3D, b: THREE.Object3D, place = false) =>
      this.links.push({ driver, bone: b, rest: b.getWorldQuaternion(new THREE.Quaternion()), place });
    link(this.pelvis, B.body, true);
    link(this.spine, B.abdomen);
    link(this.chest, B.torso);
    link(this.neck, B.neck);
    link(this.head, B.head);
    [this.racquetArm, this.freeArm].forEach((arm, i) => {
      link(arm.upper, A[i].upper);
      link(arm.lower, A[i].lower);
    });
    this.legs.forEach((leg, i) => {
      link(leg.upper, L[i].upper);
      link(leg.lower, L[i].lower);
      link(leg.end, L[i].foot, true); // the feet are IK bones of their own, not on the leg chain
    });

    this.root.rotation.y = facing;
    const foot = (): Foot => ({
      pos: new THREE.Vector3(),
      from: new THREE.Vector3(),
      t: -1,
      dur: 0.25,
      lift: 0.08,
      yaw: facing,
      fromYaw: facing,
      to: null,
      holdUntil: 0,
    });
    this.feet = [foot(), foot()];
  }

  /** Where the head should look (world), or null to look straight ahead. */
  setLookTarget(p: THREE.Vector3 | null) {
    this.lookTarget = p ? (this.lookTarget ?? new THREE.Vector3()).copy(p) : null;
  }

  /** Extra shoulder turn for the stroke (radians; + turns the racquet side forward). */
  setCoil(c: number) {
    this.coil = c;
  }

  /** The little hop-and-land ready move as the opponent strikes. */
  splitStep() {
    this.split = 0;
  }

  /** Step the front foot in toward the ball for the stroke (left foot on a forehand). */
  plantFront(stroke: "forehand" | "backhand") {
    const i = stroke === "forehand" ? 1 : 0;
    const f = this.feet[i];
    const side = i === 0 ? -1 : 1; // model +x is the left side
    const across = stroke === "forehand" ? -0.08 : 0.08;
    f.from.copy(f.pos);
    f.fromYaw = f.yaw;
    f.to = this.root.localToWorld(new THREE.Vector3(side * 0.16 + across, 0, 0.42));
    f.to.y = 0;
    f.t = 0;
    f.dur = 0.16;
    f.lift = 0.06;
    f.holdUntil = this.clock + 0.55;
  }

  /** Simulate the body for this frame. `vx`/`vz` is the velocity in scene space (m/s). */
  update(dt: number, time: number, vx: number, vz: number) {
    this.clock += dt;
    const root = this.root.position;
    const speed = Math.hypot(vx, vz);
    const run = THREE.MathUtils.smoothstep(speed, 0.6, 5);
    const { thigh, shin, upper, fore } = this.seg;

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
    const width = 0.17 * (1 - run) + 0.09 * run;
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
      const to = f.to ?? tmp.a.copy(want[i]).addScaledVector(tmp.b.set(vx, 0, vz), f.dur * (1 - f.t) * 0.6);
      f.pos.lerpVectors(f.from, to, e);
      f.yaw = f.fromYaw + angleDiff(this.yaw, f.fromYaw) * e;
      if (f.t >= 1) {
        f.t = -1;
        f.to = null;
      }
    });
    // Start the next step with whichever planted foot is furthest from where it should be.
    const threshold = 0.1 + speed * 0.06;
    let pick = -1;
    let worst = threshold;
    this.feet.forEach((f, i) => {
      if (f.t >= 0 || (this.clock < f.holdUntil && speed < 1.5)) return;
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
    const crouch = 0.1 * (1 - run) + 0.05 * run + bounce * 0.012;
    const hipY = (this.hips[0].y + this.hips[1].y) / 2;
    let top = this.ankleY + thigh + shin - crouch - hipY;
    this.feet.forEach((f, i) => {
      const h = this.hips[i];
      const hx = root.x + rx * h.x + fx * h.z;
      const hz = root.z + rz * h.x + fz * h.z;
      const horiz = Math.hypot(f.pos.x - hx, f.pos.z - hz);
      const ankleY = this.ankleY + (f.t >= 0 ? Math.sin(Math.PI * f.t) * f.lift : 0);
      top = Math.min(top, ankleY + Math.sqrt(Math.max(0, this.legMax * this.legMax - horiz * horiz)) - h.y);
    });
    this.pelvisY += (top - this.pelvisY) * Math.min(1, dt * 25);
    // Split step: a quick dip and spring back up, ready to push off either way.
    let dip = 0;
    if (this.split >= 0) {
      this.split += dt;
      const t = this.split / 0.32;
      if (t >= 1) this.split = -1;
      else dip = Math.sin(Math.PI * t) * 0.09;
    }
    this.pelvis.position.y = this.pelvisY - dip;

    // ---- Torso: lean into acceleration, twist with the racquet ----
    const pitch = this.pitch.step(0.1 * (1 - run) + 0.2 * run + THREE.MathUtils.clamp(accFwd * 0.025, -0.2, 0.25) + velFwd * 0.01, dt);
    const roll = this.roll.step(THREE.MathUtils.clamp(-accSide * 0.025, -0.25, 0.25), dt);
    const twist = this.twist.step(this.twistTarget, dt);
    // Hips counter-rotate with the stride.
    const stride = this.footLocalZ(0) - this.footLocalZ(1);
    // The hips lead the shoulders through the stroke.
    const hipTwist = THREE.MathUtils.clamp(stride * 0.35, -0.3, 0.3) + twist * 0.4;
    this.pelvis.rotation.set(pitch * 0.25, hipTwist, roll * 0.3);
    this.spine.rotation.set(pitch * 0.45, twist * 0.35 - hipTwist * 0.6, roll * 0.4);
    this.chest.rotation.set(pitch * 0.3, twist * 0.4 - hipTwist * 0.4, roll * 0.3);

    // ---- Legs reach the feet ----
    this.root.updateMatrixWorld(true);
    const knee = tmp.c.set(fx, 0, fz);
    this.feet.forEach((f, i) => {
      const lift = f.t >= 0 ? Math.sin(Math.PI * f.t) * f.lift : 0;
      const ankle = new THREE.Vector3(f.pos.x, this.ankleY + lift, f.pos.z);
      const leg = this.legs[i];
      solveTwoBone(leg, thigh, shin, ankle, knee);
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
    solveTwoBone(this.freeArm, upper, fore, freeTarget, this.toWorldDir(0.8, -1, -0.7));

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
    this.retarget();
  }

  private footLocalZ(i: number) {
    const f = this.feet[i].pos;
    const r = this.root.position;
    return (f.x - r.x) * Math.sin(this.yaw) + (f.z - r.z) * Math.cos(this.yaw);
  }

  /** Copy the driver's pose onto the model's bones. */
  private retarget() {
    this.root.updateMatrixWorld(true);
    for (const { driver, bone, rest, place } of this.links) {
      bone.parent!.updateWorldMatrix(true, false);
      if (place) bone.position.copy(bone.parent!.worldToLocal(driver.getWorldPosition(tmp.a)));
      // The driver's rest pose has no rotation, so its world rotation is the change from rest.
      setWorldQuaternion(bone, driver.getWorldQuaternion(tmp.q).multiply(rest));
    }
  }

  /** World position of the racquet shoulder (after `update`). */
  shoulderWorld(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.racquetArm.upper.getWorldPosition(out);
  }

  /**
   * Put the racquet hand at `target` (world), bending the elbow toward `pole`. With `shaft` (the
   * racquet's direction, world), the forearm and wrist turn so the fist holds it.
   */
  reach(target: THREE.Vector3, pole: THREE.Vector3, shaft?: THREE.Vector3) {
    const arm = this.racquetArm;
    solveTwoBone(arm, this.seg.upper, this.seg.fore, target, pole);
    // Shoulders follow the hand: back on the backswing, through on the follow-through.
    arm.end.updateWorldMatrix(true, false);
    this.handLocal.copy(this.root.worldToLocal(arm.end.localToWorld(tmp.a.copy(this.grip))));
    this.twistTarget = THREE.MathUtils.clamp(0.9 * (this.handLocal.z - 0.2) + 0.6 * (this.handLocal.x + 0.3) + this.coil, -1.1, 1.0);
    if (shaft) this.rollForearm(shaft);
    this.retarget();
    if (shaft) this.turnWrist(shaft);
  }

  /** Roll the forearm about its length so the thumb side of the hand turns toward the racquet. */
  private rollForearm(shaft: THREE.Vector3) {
    const lower = this.racquetArm.lower;
    const lowerQ = lower.getWorldQuaternion(new THREE.Quaternion());
    const axis = DOWN.clone().applyQuaternion(lowerQ);
    const thumb = this.hand.thumb.clone().applyQuaternion(lowerQ);
    const want = shaft.clone().addScaledVector(axis, -shaft.dot(axis));
    if (want.lengthSq() < 1e-4) return;
    want.normalize();
    const angle = Math.atan2(axis.dot(tmp.b.crossVectors(thumb, want)), thumb.dot(want));
    lowerQ.premultiply(tmp.q.setFromAxisAngle(axis, angle * FOREARM_ROLL));
    const parentQ = lower.parent!.getWorldQuaternion(tmp.q2);
    lower.quaternion.copy(parentQ.invert().multiply(lowerQ));
  }

  /** Turn the hand so the handle runs through the fist along the racquet. */
  private turnWrist(shaft: THREE.Vector3) {
    const { palm, rest, down, thumb } = this.hand;
    const forearm = DOWN.clone().applyQuaternion(this.racquetArm.lower.getWorldQuaternion(tmp.q));
    const s = shaft.clone().normalize();
    const d = forearm.addScaledVector(s, -forearm.dot(s));
    if (d.lengthSq() < 1e-4) return;
    d.normalize();
    // Rotation taking the rest frame (down, thumb) to the wanted one (d, s).
    const from = new THREE.Matrix4().makeBasis(down, thumb, tmp.a.crossVectors(down, thumb));
    const to = new THREE.Matrix4().makeBasis(d, s, tmp.b.crossVectors(d, s));
    const q = new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
    palm.parent!.updateWorldMatrix(true, false);
    setWorldQuaternion(palm, q.multiply(rest));
  }

  /** Where the racquet grip actually ended up (after `reach`). */
  handWorld(out = new THREE.Vector3()) {
    this.hand.palm.updateWorldMatrix(true, false);
    return this.hand.palm.localToWorld(out.copy(this.hand.grip));
  }

  /** A point just above the head (world), for markers. */
  headWorld(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.copy(this.headTop).add(tmp.a.set(0, 0.12, 0)));
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
