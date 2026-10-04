// Bakes the athlete model into a light, seated spectator for the stands
// (client/public/models/spectator.bin):
// - poses it sitting, twice: hands on the knees, and hands up clapping (the game blends the two
//   on the GPU when the crowd cheers);
// - bakes the skinning into plain positions, drops the eyes, and simplifies it with meshoptimizer
//   to two detail levels (big screens / weak devices);
// - keeps per vertex which part it is (skin, hair, shirt...) so each spectator can be recoloured,
//   and how much it belongs to the head, so heads can turn to follow the ball.
//
//   node scripts/make-spectator.mjs
//
// Re-run it after changing client/public/models/athlete.glb.
//
// File layout (little endian): Uint32 [version, vertices, hiIndices, loIndices], Float32 [head
// pivot x, y, z, 0], then Float32 sit positions (3n), clap positions (3n), part (n), head weight
// (n), then Uint16 hi indices, lo indices.

import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptSimplifier } from "meshoptimizer";

const INPUT = "client/public/models/athlete.glb";
const OUTPUT = "client/public/models/spectator.bin";
const HEIGHT = 1.83;
/** Triangles kept from the full model (~7.9k) at each detail level. */
const LOD = { hi: 0.13, lo: 0.055 };
/** Material name → part id (the game's colour slots); missing ones are dropped. */
const PARTS = { Skin: 0, Hair: 1, Shirt: 2, Pants: 3, Socks: 4, Shoes: 5 };

// Directions in the model's frame (+z forward, its left on +x). `aim` points a bone toward its
// child joint. L/R mirror x.
const SIT = {
  UpperLeg: [0.08, -0.05, 1],
  LowerLeg: [0.02, -1, 0.12],
};
const POSES = {
  lap: { UpperArm: [0.15, -0.9, 0.35], LowerArm: [-0.3, -0.75, 0.6] },
  clap: { UpperArm: [0.5, 0.75, 0.45], LowerArm: [-0.45, 0.85, 0.3] },
};
const CHILD = { UpperArm: "LowerArm", LowerArm: "Palm", UpperLeg: "LowerLeg", LowerLeg: "Foot" };

const buf = readFileSync(INPUT);
const gltf = await new Promise((ok, fail) =>
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", ok, fail),
);
const scene = gltf.scene;
scene.updateMatrixWorld(true);
const bones = {};
const meshes = [];
scene.traverse((o) => {
  if (o.isBone) bones[o.name] = o;
  if (o.isSkinnedMesh) meshes.push(o);
});
const box = new THREE.Box3().setFromObject(scene);
const scale = HEIGHT / (box.max.y - box.min.y);

const pos = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
const rot = (b) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(b.matrixWorld));
const rest = {};
for (const [name, b] of Object.entries(bones)) rest[name] = { pos: b.position.clone(), quat: b.quaternion.clone() };
const restWorld = {};
for (const [name, b] of Object.entries(bones)) restWorld[name] = { pos: pos(b), quat: rot(b) };
const shin = (s) => restWorld["Foot" + s].pos.distanceTo(restWorld["LowerLeg" + s].pos);

/** Point a bone at a world direction (rotating from its rest pose), keeping its children's local poses. */
function aim(name, dir) {
  const b = bones[name];
  const r = restWorld[name];
  const childName = CHILD[name.replace(/[LR]$/, "")] + name.slice(-1);
  const restDir = restWorld[childName].pos.clone().sub(r.pos).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(restDir, new THREE.Vector3(...dir).normalize());
  const world = delta.multiply(r.quat);
  b.parent.updateMatrixWorld(true);
  b.quaternion.copy(rot(b.parent).invert().multiply(world));
  b.updateMatrixWorld(true);
}

function pose(arms) {
  for (const [name, r] of Object.entries(rest)) {
    bones[name].position.copy(r.pos);
    bones[name].quaternion.copy(r.quat);
  }
  scene.updateMatrixWorld(true);
  for (const [s, mx] of [["L", 1], ["R", -1]]) {
    const m = ([x, y, z]) => [x * mx, y, z];
    // Parents before children.
    aim("UpperLeg" + s, m(SIT.UpperLeg));
    aim("LowerLeg" + s, m(SIT.LowerLeg));
    aim("UpperArm" + s, m(arms.UpperArm));
    aim("LowerArm" + s, m(arms.LowerArm));
    // The feet are IK bones, not attached to the legs: put them at the end of the shins.
    const foot = bones["Foot" + s];
    const knee = pos(bones["LowerLeg" + s]);
    const at = knee.addScaledVector(new THREE.Vector3(...m(SIT.LowerLeg)).normalize(), shin(s));
    foot.position.copy(foot.parent.worldToLocal(at));
    foot.updateMatrixWorld(true);
  }
}

/** Skinned positions (meters, model frame) of every vertex of every kept part. */
function bake() {
  const out = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const part = PARTS[mesh.material.name];
    if (part === undefined) continue;
    const n = mesh.geometry.attributes.position.count;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).multiplyScalar(scale);
      v.toArray(p, i * 3);
    }
    out.push(p);
  }
  return out;
}

pose(POSES.lap);
const sit = bake();
// Seat the model: the back of the thighs on y = 0, the hips over z = 0.
const hip = pos(bones.UpperLegL).add(pos(bones.UpperLegR)).multiplyScalar(0.5 * scale);
const shift = new THREE.Vector3(-hip.x, -hip.y + 0.1, -hip.z + 0.05);
const pivot = pos(bones.Head).multiplyScalar(scale).add(shift);
pose(POSES.clap);
const clap = bake();

// Merge each part's vertices (the model splits them along seams) and gather triangles.
const verts = { sit: [], clap: [], part: [], head: [] };
const tris = [];
let k = 0;
for (const mesh of meshes) {
  const part = PARTS[mesh.material.name];
  if (part === undefined) continue;
  const g = mesh.geometry;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  const boneIndex = (name) => mesh.skeleton.bones.indexOf(bones[name]);
  const head = boneIndex("Head");
  const neck = boneIndex("Neck");
  const map = new Map();
  const remap = new Uint32Array(g.attributes.position.count);
  const [s, c] = [sit[k], clap[k]];
  k++;
  for (let i = 0; i < remap.length; i++) {
    const key = [0, 1, 2].map((a) => Math.round(s[i * 3 + a] * 2000)).join() + "|" + [0, 1, 2].map((a) => Math.round(c[i * 3 + a] * 2000)).join();
    let id = map.get(key);
    if (id === undefined) {
      id = verts.part.length;
      map.set(key, id);
      verts.sit.push(s[i * 3] + shift.x, s[i * 3 + 1] + shift.y, s[i * 3 + 2] + shift.z);
      verts.clap.push(c[i * 3] + shift.x, c[i * 3 + 1] + shift.y, c[i * 3 + 2] + shift.z);
      verts.part.push(part);
      let hw = 0;
      for (let j = 0; j < 4; j++) {
        const b = si.getComponent(i, j);
        if (b === head) hw += sw.getComponent(i, j);
        if (b === neck) hw += sw.getComponent(i, j) * 0.4;
      }
      verts.head.push(Math.min(1, hw));
    }
    remap[i] = id;
  }
  const idx = g.index.array;
  const own = [];
  for (let i = 0; i < idx.length; i++) own.push(remap[idx[i]]);
  tris.push(own);
}

await MeshoptSimplifier.ready;
const positions = new Float32Array(verts.sit);
function simplify(ratio) {
  const all = [];
  for (const t of tris) {
    const target = Math.max(36, Math.floor((t.length * ratio) / 3) * 3);
    // Permissive: the parts are split along UV seams, which would otherwise lock their borders.
    const [res] = MeshoptSimplifier.simplify(new Uint32Array(t), positions, 3, target, 1, ["Permissive"]);
    all.push(...res);
  }
  return all;
}
const hi = simplify(LOD.hi);
const lo = simplify(LOD.lo);

// Keep only the vertices the hi level uses (lo is a subset of the same vertices).
const used = new Map();
for (const i of [...hi, ...lo]) if (!used.has(i)) used.set(i, used.size);
const n = used.size;
const pick = (arr, w) => {
  const o = new Float32Array(n * w);
  for (const [old, i] of used) for (let a = 0; a < w; a++) o[i * w + a] = arr[old * w + a];
  return o;
};
const parts = [pick(verts.sit, 3), pick(verts.clap, 3), pick(verts.part, 1), pick(verts.head, 1)];
const hiIdx = Uint16Array.from(hi, (i) => used.get(i));
const loIdx = Uint16Array.from(lo, (i) => used.get(i));

const header = new ArrayBuffer(32);
new Uint32Array(header, 0, 4).set([1, n, hiIdx.length, loIdx.length]);
new Float32Array(header, 16, 4).set([pivot.x, pivot.y, pivot.z, 0]);
const chunks = [new Uint8Array(header), ...parts.map((p) => new Uint8Array(p.buffer)), new Uint8Array(hiIdx.buffer), new Uint8Array(loIdx.buffer)];
writeFileSync(OUTPUT, Buffer.concat(chunks));
console.log(`${OUTPUT}: ${n} vertices, ${hiIdx.length / 3} / ${loIdx.length / 3} triangles, ${Buffer.concat(chunks).length} bytes`);
