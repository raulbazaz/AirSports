import * as THREE from "three";
import { stringsTexture } from "./textures";

// A chunky cartoon racquet with its grip at the origin: the shaft runs along +y, the strings span
// x, and the string face looks along +z. `poseRacquet` sets it from axes, so it can copy the
// phone exactly.

const SCALE = 1.45; // oversized so it reads from the camera
const HEAD = { cy: 0.42, rx: 0.13, ry: 0.165 };

let strings: THREE.Texture | null = null;

export function makeRacquet(frameColor: number, gripColor = 0xffffff) {
  const g = new THREE.Group();
  const frame = new THREE.MeshLambertMaterial({ color: frameColor });

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.24, 8), new THREE.MeshLambertMaterial({ color: gripColor }));
  handle.position.y = 0.01;
  g.add(handle);

  // Throat: a solid wedge from the handle to the head.
  const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.016, 0.16, 3, 1), frame);
  throat.scale.z = 0.25;
  throat.position.y = 0.2;
  throat.rotation.y = Math.PI / 6;
  g.add(throat);

  // Head: an elliptical ring and the string bed.
  const ring = new THREE.TorusGeometry(1, 0.016 / HEAD.ry, 6, 28);
  ring.scale(HEAD.rx, HEAD.ry, HEAD.ry);
  ring.translate(0, HEAD.cy, 0);
  g.add(new THREE.Mesh(ring, frame));

  const bed = new THREE.CircleGeometry(1, 24);
  const uv = bed.attributes.uv;
  bed.scale(HEAD.rx * 0.97, HEAD.ry * 0.97, 1);
  bed.translate(0, HEAD.cy, 0);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.3, uv.getY(i) * 1.6);
  strings ??= stringsTexture();
  strings.wrapS = strings.wrapT = THREE.RepeatWrapping;
  g.add(
    new THREE.Mesh(bed, new THREE.MeshBasicMaterial({ map: strings, transparent: true, side: THREE.DoubleSide, depthWrite: false })),
  );

  g.scale.setScalar(SCALE);
  return g;
}

const basis = new THREE.Matrix4();
const x = new THREE.Vector3();
const y = new THREE.Vector3();
const z = new THREE.Vector3();

/** Place the racquet's grip at `grip` with its shaft and string axes (scene space). */
export function poseRacquet(r: THREE.Object3D, grip: THREE.Vector3, shaft: THREE.Vector3, across: THREE.Vector3) {
  y.copy(shaft).normalize();
  x.copy(across).addScaledVector(y, -across.dot(y)).normalize();
  z.crossVectors(x, y);
  r.quaternion.setFromRotationMatrix(basis.makeBasis(x, y, z));
  r.position.copy(grip);
}
