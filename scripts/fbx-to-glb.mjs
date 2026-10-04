// Converts a rigged character from FBX to a compact binary glTF (.glb) for the game.
// Keeps the mesh, materials and skeleton; drops the bundled animations (the game animates the
// skeleton itself).
//
//   node scripts/fbx-to-glb.mjs <in.fbx> <out.glb> [--shoes-from=<material>]
//
// --shoes-from: some packs (Quaternius) paint the shoes with the eye material; this moves that
// material's triangles near the ground into their own "Shoes" material so they can be recoloured.

import { readFileSync, writeFileSync } from "node:fs";

// FBXLoader and GLTFExporter expect a few browser globals; none of them are used for an FBX
// without textures.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.document ??= { createElementNS: () => ({ style: {} }) };
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

const args = process.argv.slice(2);
const [input, output] = args.filter((a) => !a.startsWith("--"));
const shoesFrom = args.find((a) => a.startsWith("--shoes-from="))?.split("=")[1];
if (!input || !output) {
  console.error("usage: node scripts/fbx-to-glb.mjs <in.fbx> <out.glb> [--shoes-from=<material>]");
  process.exit(1);
}

const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
const { mergeVertices } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
const THREE = await import("three");

const buf = readFileSync(input);
const scene = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
scene.animations = [];
// glTF stores PBR materials; keep each material's name and colour (the game recolours by name).
scene.traverse((o) => {
  if (!o.isMesh) return;
  // FBX imports give every triangle its own three vertices; share them (a fraction of the size).
  const merged = mergeVertices(o.geometry, 1e-4);
  o.geometry.dispose();
  o.geometry = merged;
  const swap = (m) => new THREE.MeshStandardMaterial({ name: m.name, color: m.color, roughness: 0.8 });
  o.material = Array.isArray(o.material) ? o.material.map(swap) : [swap(o.material)];
  if (!merged.groups.length) merged.addGroup(0, merged.index.count, 0);
  const shoes = shoesFrom ? splitShoes(o, shoesFrom) : null;
  regroup(merged, shoes);
});

/**
 * Triangles of material `from` in the lowest 8% of the mesh height, as a set of triangle starts;
 * adds the "Shoes" material they move to.
 */
function splitShoes(mesh, from) {
  const geo = mesh.geometry;
  const src = mesh.material.findIndex((m) => m.name === from);
  if (src < 0) throw new Error(`no material named ${from}`);
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox;
  // FBX geometry is Y-up or Z-up; up is whichever of the two is taller (x holds the arm span).
  const up = max.z - min.z > max.y - min.y ? "z" : "y";
  const floor = min[up] + (max[up] - min[up]) * 0.08;
  const pos = geo.attributes.position;
  const index = geo.index.array;
  const at = (i) => (up === "z" ? pos.getZ(index[i]) : pos.getY(index[i]));
  const moved = new Set();
  for (const g of geo.groups) {
    if (g.materialIndex !== src) continue;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      if ((at(i) + at(i + 1) + at(i + 2)) / 3 < floor) moved.add(i);
    }
  }
  mesh.material.push(new THREE.MeshStandardMaterial({ name: "Shoes", color: mesh.material[src].color, roughness: 0.8 }));
  console.log(`moved ${moved.size} triangles from ${from} to Shoes`);
  return { triangles: moved, materialIndex: mesh.material.length - 1 };
}

/** FBX splits a mesh into many small groups; sort the triangles so there is one per material. */
function regroup(geo, shoes) {
  const index = geo.index.array;
  const byMat = new Map();
  for (const g of geo.groups) {
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const m = shoes?.triangles.has(i) ? shoes.materialIndex : g.materialIndex;
      const list = byMat.get(m) ?? [];
      list.push(index[i], index[i + 1], index[i + 2]);
      byMat.set(m, list);
    }
  }
  const sorted = [];
  geo.clearGroups();
  for (const [materialIndex, list] of [...byMat].sort((a, b) => a[0] - b[0])) {
    geo.addGroup(sorted.length, list.length, materialIndex);
    sorted.push(...list);
  }
  geo.setIndex(sorted);
  return geo;
}

const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
writeFileSync(output, Buffer.from(glb));
console.log(`${output}: ${(glb.byteLength / 1024).toFixed(0)} KB`);
