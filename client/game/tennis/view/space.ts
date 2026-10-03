import * as THREE from "three";
import type { V3 } from "../orientation";

// Court space (see court.ts) is x right, y up, z toward the far end. Three.js cameras look down
// -z, so the far end of the court is -z in the scene: flip z on the way in.

export const w = (x: number, y: number, z: number) => new THREE.Vector3(x, y, -z);
export const wv = (v: V3) => new THREE.Vector3(v.x, v.y, -v.z);
