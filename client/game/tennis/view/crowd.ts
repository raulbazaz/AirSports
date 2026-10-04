import * as THREE from "three";

// Spectators in the stands: the players' model, baked sitting and simplified
// (scripts/make-spectator.mjs), drawn as one instanced mesh, a single draw call for the whole
// crowd. Everything that moves is done in the vertex shader from a few uniforms, so the crowd
// costs no CPU per person:
// - each spectator has their own skin, hair, shirt and trouser colours;
// - heads turn to follow the ball (the famous tennis-crowd head turn);
// - after a point they clap with their hands up and bounce, keener ones first.
// Weak devices get the low-detail mesh and fewer people, and the crowd thins further if the frame
// rate drops (see `degrade`).

const URL = "/models/spectator.bin";

export interface SpectatorAsset {
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
  /** Where the head turns (model frame). */
  pivot: THREE.Vector3;
}

export async function loadSpectator(): Promise<SpectatorAsset> {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${URL}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const [, n, nHi, nLo] = new Uint32Array(buf, 0, 4);
  const [px, py, pz] = new Float32Array(buf, 16, 3);
  let at = 32;
  const floats = (count: number) => {
    const a = new Float32Array(buf, at, count);
    at += count * 4;
    return a;
  };
  const sit = floats(n * 3);
  const clap = floats(n * 3);
  const part = floats(n);
  const head = floats(n);
  const hiIdx = new Uint16Array(buf, at, nHi);
  const loIdx = new Uint16Array(buf, at + nHi * 2, nLo);

  // Normals for each pose (both levels share the vertices; the hi faces give smoother normals).
  const normals = (p: Float32Array) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setIndex(new THREE.BufferAttribute(hiIdx, 1));
    g.computeVertexNormals();
    return g.attributes.normal as THREE.BufferAttribute;
  };
  const sitNormal = normals(sit);
  const clapNormal = normals(clap);
  const build = (idx: Uint16Array) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(sit, 3));
    g.setAttribute("normal", sitNormal);
    g.setAttribute("aClap", new THREE.BufferAttribute(clap, 3));
    g.setAttribute("aClapNormal", clapNormal);
    g.setAttribute("aPart", new THREE.BufferAttribute(part, 1));
    g.setAttribute("aHead", new THREE.BufferAttribute(head, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  };
  return { hi: build(hiIdx), lo: build(loIdx), pivot: new THREE.Vector3(px, py, pz) };
}

/** A seat: where the spectator's hips go (scene space) and which way they face (yaw, radians). */
export interface Seat {
  pos: THREE.Vector3;
  yaw: number;
}

export interface Palette {
  skins: number[];
  hairs: number[];
  shirts: number[];
  trousers: number[];
}

/** Crowd quality steps, best first: [detail, share of seats filled]. */
const STEPS: ["hi" | "lo", number][] = [
  ["hi", 1],
  ["lo", 1],
  ["lo", 0.6],
  ["lo", 0.35],
];

/** Phones, tablets and low-core/low-memory machines start a few steps down. */
export function weakDevice() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (
    (nav.hardwareConcurrency ?? 8) <= 4 ||
    (nav.deviceMemory ?? 8) <= 4 ||
    window.matchMedia("(pointer: coarse)").matches
  );
}

const VERTEX_HEAD = /* glsl */ `
attribute vec3 aClap;
attribute vec3 aClapNormal;
attribute float aPart;
attribute float aHead;
attribute vec3 iSkin;
attribute vec3 iHair;
attribute vec3 iShirt;
attribute vec3 iTrousers;
attribute float iSeed;
uniform float uTime;
uniform float uCheer;
uniform vec3 uLook;
uniform vec3 uPivot;
varying vec3 vCrowd;
`;

// Runs first (normals come before positions in three's shaders): works out the pose for both.
const VERTEX_POSE = /* glsl */ `
  // Cheering: keener spectators (low seed) join first; hands pump as they clap.
  float joined = clamp(uCheer * 1.7 - iSeed * 0.7, 0.0, 1.0);
  float clapMix = joined * (0.78 + 0.22 * sin(uTime * 17.0 + iSeed * 40.0));
  // The head turns toward the ball, worked out in the spectator's own frame.
  vec3 rel = transpose(mat3(instanceMatrix)) * (uLook - instanceMatrix[3].xyz);
  float yaw = (clamp(atan(rel.x, rel.z), -1.2, 1.2) + (iSeed - 0.5) * 0.3) * aHead;
  mat3 turn = mat3(cos(yaw), 0.0, -sin(yaw), 0.0, 1.0, 0.0, sin(yaw), 0.0, cos(yaw));
  vec3 objectNormal = turn * normalize(mix(normal, aClapNormal, clapMix));
`;

const VERTEX_POSITION = /* glsl */ `
  vec3 transformed = uPivot + turn * (mix(position, aClap, clapMix) - uPivot);
  transformed.y += joined * 0.07 * abs(sin(uTime * 8.0 + iSeed * 20.0));
  vCrowd = aPart < 0.5 ? iSkin : aPart < 1.5 ? iHair : aPart < 2.5 ? iShirt : aPart < 3.5 ? iTrousers
    : aPart < 4.5 ? vec3(0.9) : vec3(0.12);
`;

export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  private readonly uniforms = {
    uTime: { value: 0 },
    uCheer: { value: 0 },
    uLook: { value: new THREE.Vector3() },
    uPivot: { value: new THREE.Vector3() },
  };
  private step: number;
  private cheerHold = 0;
  private readonly look = new THREE.Vector3();
  private readonly lookIdle: THREE.Vector3;

  constructor(
    private readonly asset: SpectatorAsset,
    seats: Seat[],
    palette: Palette,
    /** Where heads rest when there's no ball (scene space). */
    idleLook: THREE.Vector3,
    weak: boolean,
  ) {
    this.uniforms.uPivot.value.copy(asset.pivot);
    this.lookIdle = idleLook.clone();
    this.look.copy(idleLook);
    this.step = weak ? 2 : 0;

    const material = new THREE.MeshLambertMaterial();
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_HEAD + shader.vertexShader
        .replace("#include <beginnormal_vertex>", VERTEX_POSE)
        .replace("#include <begin_vertex>", VERTEX_POSITION);
      shader.fragmentShader = "varying vec3 vCrowd;\n" + shader.fragmentShader
        .replace("#include <color_fragment>", "diffuseColor.rgb *= vCrowd;");
    };

    const n = seats.length;
    this.mesh = new THREE.InstancedMesh(asset.hi, material, n);
    const rand = rng(11);
    const pick = (a: number[]) => a[Math.floor(rand() * a.length)];
    // Shuffled, so showing fewer instances thins the crowd evenly.
    const order = seats.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k);
    const color = new THREE.Color();
    const attr = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
    const cols = { iSkin: attr(3), iHair: attr(3), iShirt: attr(3), iTrousers: attr(3) };
    const seed = attr(1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    order.forEach(({ s }, i) => {
      q.setFromAxisAngle(up, s.yaw + (rand() - 0.5) * 0.25);
      const size = 0.92 + rand() * 0.14;
      m.compose(s.pos, q, new THREE.Vector3(size, size, size));
      this.mesh.setMatrixAt(i, m);
      color.setHex(pick(palette.skins)).toArray(cols.iSkin.array, i * 3);
      color.setHex(pick(palette.hairs)).toArray(cols.iHair.array, i * 3);
      color.setHex(pick(palette.shirts)).toArray(cols.iShirt.array, i * 3);
      color.setHex(pick(palette.trousers)).toArray(cols.iTrousers.array, i * 3);
      seed.array[i] = rand();
    });
    for (const [name, a] of Object.entries(cols)) this.mesh.geometry.setAttribute(name, a);
    this.mesh.geometry.setAttribute("iSeed", seed);
    // Instance attributes live on the geometry, so both detail levels carry them.
    for (const [name, a] of Object.entries(cols)) asset.lo.setAttribute(name, a);
    asset.lo.setAttribute("iSeed", seed);
    this.mesh.computeBoundingSphere();
    this.apply();
  }

  /** The crowd reacts to a point: `level` 0..1. */
  cheer(level: number) {
    this.uniforms.uCheer.value = Math.max(this.uniforms.uCheer.value, level);
    this.cheerHold = 1.4 + level;
  }

  /** `ball`: where it is (scene space), or null when out of play. */
  update(dt: number, time: number, ball: THREE.Vector3 | null) {
    this.uniforms.uTime.value = time;
    // Heads ease toward the ball rather than snapping (people react a beat late).
    this.look.lerp(ball ?? this.lookIdle, 1 - Math.exp(-dt * (ball ? 9 : 2)));
    this.uniforms.uLook.value.copy(this.look);
    if (this.cheerHold > 0) this.cheerHold -= dt;
    else this.uniforms.uCheer.value = Math.max(0, this.uniforms.uCheer.value - dt * 0.7);
  }

  /** One step cheaper (lower detail, then fewer people). False when already at the cheapest. */
  degrade() {
    if (this.step >= STEPS.length - 1) return false;
    this.step++;
    this.apply();
    return true;
  }

  private apply() {
    const [detail, share] = STEPS[this.step];
    this.mesh.geometry = detail === "hi" ? this.asset.hi : this.asset.lo;
    this.mesh.count = Math.round(this.mesh.instanceMatrix.count * share);
  }

  dispose() {
    this.asset.hi.dispose();
    this.asset.lo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}
