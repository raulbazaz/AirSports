import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NET_POST_X, netTop } from "../ball";
import { COURT } from "../court";
import { w } from "./space";
import { GROUND, groundTexture, netTexture, outerGrassTexture, wallTextTexture } from "./textures";

// The venue: a mowed grass court boxed in by padded green walls, small stands with spectators
// down both sides, hedges and trees beyond. Built for weak GPUs: everything static is merged
// into a handful of meshes (one per material) with cheap Lambert shading.

const L = COURT.length;
const WALL = { h: 1.15, t: 0.35, green: 0x2c6a37, pad: 0x3b8645 };
const SKINS = [0xf6d3b3, 0xe8b996, 0xc98e66, 0xa8694a, 0x6b4430];
const HAIRS = [0x2b1d16, 0x5a3820, 0x7a4a26, 0x1a1a1a, 0xc8a060, 0x8a8a8a];
const SHIRTS = [0xe5532d, 0x2f7de1, 0xffd23f, 0xffffff, 0x8c5bd6, 0x3cb371, 0xff8fb0, 0x43c6d8, 0x2b2f36];

/** Collects coloured geometry and merges it into one vertex-coloured mesh. */
class Batch {
  private parts: THREE.BufferGeometry[] = [];
  private readonly color = new THREE.Color();

  add(geo: THREE.BufferGeometry, color: number, at?: THREE.Vector3) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (at) g.translate(at.x, at.y, at.z);
    this.color.setHex(color);
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.color.toArray(cols, i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    g.deleteAttribute("uv");
    this.parts.push(g);
  }

  build() {
    const mesh = new THREE.Mesh(mergeGeometries(this.parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return mesh;
  }
}

const box = (wx: number, h: number, dz: number) => new THREE.BoxGeometry(wx, h, dz);

function ground(scene: THREE.Scene) {
  const { x0, x1, z0, z1 } = GROUND;
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, -(z0 + z1) / 2);
  const court = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: groundTexture() }));

  const outer = new THREE.PlaneGeometry(160, 160);
  outer.rotateX(-Math.PI / 2);
  outer.translate(0, -0.02, -L / 2 - 40);
  const grass = new THREE.Mesh(outer, new THREE.MeshLambertMaterial({ map: outerGrassTexture() }));
  scene.add(grass, court);
}

/** Padded walls all round, with a rounded cushion along the top. */
function walls(batch: Batch, scene: THREE.Scene) {
  const { x0, x1, z0, z1 } = GROUND;
  const { h, t } = WALL;
  // Centre lines of the four runs: [x0, z0, x1, z1].
  const runs: [number, number, number, number][] = [
    [x0 - t, z1 + t / 2, x1 + t, z1 + t / 2],
    [x0 - t, z0 - t / 2, x1 + t, z0 - t / 2],
    [x0 - t / 2, z0, x0 - t / 2, z1],
    [x1 + t / 2, z0, x1 + t / 2, z1],
  ];
  for (const [ax, az, bx, bz] of runs) {
    const alongX = az === bz;
    const len = alongX ? bx - ax : bz - az;
    batch.add(alongX ? box(len, h, t) : box(t, h, len), WALL.green, w((ax + bx) / 2, h / 2, (az + bz) / 2));
    const pad = new THREE.CylinderGeometry(t / 2 + 0.03, t / 2 + 0.03, len, 8, 1);
    if (alongX) pad.rotateZ(Math.PI / 2);
    else pad.rotateX(Math.PI / 2);
    batch.add(pad, WALL.pad, w((ax + bx) / 2, h, (az + bz) / 2));
  }

  // Name painted on the far wall, facing the camera.
  const text = new THREE.MeshBasicMaterial({ map: wallTextTexture("AirSports"), transparent: true, depthWrite: false });
  const plate = new THREE.PlaneGeometry(4.4, 0.82);
  for (const x of [-6, 0, 6]) {
    const m = new THREE.Mesh(plate, text);
    m.position.copy(w(x, h * 0.46, GROUND.z1 - 0.01));
    scene.add(m);
  }
}

/** Three tiers of seats down each side, filled with round-headed spectators. */
function stands(batch: Batch, crowd: Batch) {
  const rand = rng(5);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const tiers = 3;
  const depth = 1.1;
  const rise = 0.5;
  const zA = -3.5;
  const zB = L + 3.5;
  const len = zB - zA + 3;
  const zMid = (zA + zB) / 2;
  for (const side of [-1, 1]) {
    const inner = side * (GROUND.x1 + WALL.t);
    batch.add(box(0.6, 0.3, len), 0xcfcfc4, w(inner + side * 0.3, 0.15, zMid));
    for (let r = 0; r < tiers; r++) {
      const x = inner + side * (0.6 + depth * (r + 0.5));
      const top = 0.55 + rise * (r + 1);
      batch.add(box(depth, top, len), r % 2 ? 0xe6e6dc : 0xd6d6cb, w(x, top / 2, zMid));
      // Seat backs along the back of each tier.
      batch.add(box(0.1, 0.32, len), 0x2f7de1, w(x + side * (depth / 2 - 0.05), top + 0.16, zMid));
      for (let z = zA; z <= zB; z += 0.62) {
        if (rand() > 0.8) continue;
        spectator(crowd, x + side * 0.12 + (rand() - 0.5) * 0.08, top, z + (rand() - 0.5) * 0.12, pick);
      }
    }
    // Green end walls closing off each stand.
    const outer = depth * tiers + 0.6;
    const hEnd = 0.55 + rise * tiers + 0.4;
    for (const z of [zA - 1.5, zB + 1.5]) batch.add(box(outer, hEnd, 0.25), WALL.green, w(inner + (side * outer) / 2, hEnd / 2, z));
  }
}

function spectator(crowd: Batch, x: number, seatY: number, z: number, pick: <T>(a: T[]) => T) {
  crowd.add(new THREE.CylinderGeometry(0.14, 0.19, 0.42, 7), pick(SHIRTS), w(x, seatY + 0.21, z));
  crowd.add(new THREE.SphereGeometry(0.17, 8, 6), pick(SKINS), w(x, seatY + 0.6, z));
  const hair = new THREE.SphereGeometry(0.18, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.45);
  crowd.add(hair, pick(HAIRS), w(x, seatY + 0.63, z));
}

/** Hedge and round trees behind the far wall and around the outside. */
function greenery(batch: Batch) {
  const rand = rng(17);
  const hedgeZ = GROUND.z1 + WALL.t + 1.2;
  batch.add(box(GROUND.x1 * 2 + 14, 1.5, 1.3), 0x2f7a33, w(0, 0.75, hedgeZ));
  for (let x = -GROUND.x1 - 7; x <= GROUND.x1 + 7; x += 1.1) {
    const s = 0.75 + rand() * 0.25;
    batch.add(new THREE.IcosahedronGeometry(s, 1), rand() < 0.5 ? 0x34843a : 0x2c7533, w(x, 1.45, hedgeZ + (rand() - 0.5) * 0.3));
  }
  const tree = (x: number, z: number, s: number) => {
    batch.add(new THREE.CylinderGeometry(0.18 * s, 0.25 * s, 2.4 * s, 6), 0x7a5634, w(x, 1.2 * s, z));
    batch.add(new THREE.IcosahedronGeometry(1.5 * s, 1), rand() < 0.5 ? 0x3e9440 : 0x358a3a, w(x, 3.1 * s, z));
    batch.add(new THREE.IcosahedronGeometry(1.1 * s, 1), 0x4aa24a, w(x + 0.6 * s, 3.8 * s, z - 0.3 * s));
  };
  for (let x = -28; x <= 28; x += 4.5 + rand() * 2) tree(x, hedgeZ + 4 + rand() * 6, 1.3 + rand() * 0.7);
  for (const side of [-1, 1]) {
    for (let z = -4; z < L + 8; z += 5 + rand() * 3) tree(side * (18 + rand() * 4), z, 1.2 + rand() * 0.6);
  }
}

function net(scene: THREE.Scene, batch: Batch) {
  const width = NET_POST_X * 2;
  const g = new THREE.PlaneGeometry(width, 1, 16, 1);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) > 0 ? netTop(x) - 0.03 : 0;
    pos.setY(i, y);
    uv.setXY(i, (x + NET_POST_X) * 5, y * 5); // 10 cm mesh
  }
  g.translate(0, 0, -COURT.netZ);
  const tex = netTexture();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  mesh.renderOrder = 1;
  scene.add(mesh);

  // White tape over the top (two straight runs meeting at the centre strap), posts.
  for (const side of [-1, 1]) {
    const a = w(0, netTop(0), COURT.netZ);
    const b = w(side * NET_POST_X, netTop(NET_POST_X), COURT.netZ);
    const tape = box(a.distanceTo(b), 0.07, 0.04);
    tape.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
    batch.add(tape, 0xffffff, a.clone().add(b).multiplyScalar(0.5));
    batch.add(new THREE.CylinderGeometry(0.06, 0.06, 1.15, 8), WALL.green, w(side * NET_POST_X, 0.575, COURT.netZ));
    batch.add(new THREE.SphereGeometry(0.075, 8, 6), WALL.green, w(side * NET_POST_X, 1.15, COURT.netZ));
  }
  batch.add(box(0.05, COURT.netHeightCenter, 0.02), 0xffffff, w(0, COURT.netHeightCenter / 2, COURT.netZ));
}

function umpireChair(batch: Batch) {
  const x = -(NET_POST_X + 1.2);
  const z = COURT.netZ;
  for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
    batch.add(new THREE.CylinderGeometry(0.035, 0.035, 1.8, 6), 0xffffff, w(x + dx, 0.9, z + dz));
  }
  batch.add(box(0.8, 0.1, 0.8), WALL.green, w(x, 1.8, z));
  batch.add(box(0.08, 0.6, 0.8), WALL.green, w(x - 0.36, 2.15, z));
}

export function buildArena(scene: THREE.Scene) {
  ground(scene);
  const solid = new Batch();
  const crowd = new Batch();
  walls(solid, scene);
  stands(solid, crowd);
  greenery(solid);
  net(scene, solid);
  umpireChair(solid);
  scene.add(solid.build(), crowd.build());
}

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}
