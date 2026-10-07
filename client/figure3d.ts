import * as THREE from "three";
import { AthleteModel, type AthleteAsset, CPU_LOOK, loadAthlete, PLAYER2_LOOK, PLAYER_LOOK } from "./game/tennis/view/athlete";
import { makeRacquet, poseRacquet } from "./game/tennis/view/racquet";

// The match's 3D athlete for the lobby cards, the phone, and the name-tag portraits, so every
// screen shows the same character. One shared WebGL renderer draws each figure and copies the
// frame onto that figure's own 2D canvas: no extra GL contexts however many figures are up.

export type Who = "p1" | "p2" | "cpu";

const LOOKS = { p1: PLAYER_LOOK, p2: PLAYER2_LOOK, cpu: CPU_LOOK };
const RACQUET = { p1: 0x2f7de1, p2: 0x9b5de5, cpu: 0xe5532d };

/** Figure canvases keep the lobby cards' 148:200 shape. */
const SIZE = { width: 296, height: 400 };
const PORTRAIT = 96;

let asset: Promise<AthleteAsset> | null = null;
let renderer: THREE.WebGLRenderer | null = null;

function gl() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
  }
  return renderer;
}

/** The athlete in `who`'s colours, facing the viewer in a ready stance, racquet up. */
function stage(a: AthleteAsset, who: Who) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8fb070, 1.9));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.7);
  sun.position.set(2, 4, 5);
  scene.add(sun);

  const model = new AthleteModel(a, LOOKS[who], 0);
  const racquet = makeRacquet(RACQUET[who]);
  scene.add(model.root, racquet);

  const up = new THREE.Vector3(0, 1, 0);
  const pose = (dt: number, time: number) => {
    model.update(dt, time, 0, 0);
    // Its right (racquet) hand is on its -x; it faces +z, toward the camera.
    const right = model.toWorldDir(-1, 0, 0);
    const fwd = model.toWorldDir(0, 0, 1);
    const bob = Math.sin(time * 2.2) * 0.04;
    const shaft = right.clone().multiplyScalar(0.25).addScaledVector(up, 0.85 + bob).addScaledVector(fwd, 0.35).normalize();
    const strings = new THREE.Vector3().crossVectors(shaft, fwd).normalize();
    const S = model.shoulderWorld();
    const hand = S.clone().addScaledVector(
      right.clone().multiplyScalar(0.25).addScaledVector(up, -0.75).addScaledVector(fwd, 0.6).normalize(),
      model.armLength * 0.78,
    );
    const pole = right.clone().multiplyScalar(0.6).addScaledVector(up, -1).addScaledVector(fwd, -0.6);
    model.reach(hand, pole, shaft);
    poseRacquet(racquet, model.handWorld(), shaft, strings);
  };
  // Let the springs and feet settle before the first frame is seen.
  for (let i = 0; i < 60; i++) pose(1 / 60, i / 60);
  return { scene, model, pose };
}

interface Live {
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  pose: (dt: number, time: number) => void;
}

const live = new Set<Live>();
const fullBody = new THREE.PerspectiveCamera(24, SIZE.width / SIZE.height, 0.1, 50);
fullBody.position.set(0, 1.05, 6.1);
fullBody.lookAt(0, 1.05, 0);

let last = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  const r = gl();
  r.setSize(SIZE.width, SIZE.height, false);
  for (const f of live) {
    if (!f.canvas.isConnected) {
      live.delete(f);
      continue;
    }
    f.pose(dt, now / 1000);
    r.render(f.scene, fullBody);
    const ctx = f.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, SIZE.width, SIZE.height);
    ctx.drawImage(r.domElement, 0, 0);
  }
  if (live.size) requestAnimationFrame(frame);
}

/** A canvas showing `who`'s athlete, idling until it is taken off the page. */
export async function athleteFigure(who: Who): Promise<HTMLCanvasElement> {
  const a = await (asset ??= loadAthlete());
  const canvas = document.createElement("canvas");
  canvas.width = SIZE.width;
  canvas.height = SIZE.height;
  canvas.className = "athlete3d";
  const { scene, pose } = stage(a, who);
  if (!live.size) requestAnimationFrame((t) => ((last = t), frame(t)));
  live.add({ canvas, scene, pose });
  return canvas;
}

const portraits = new Map<Who, Promise<string>>();

/** Head-and-shoulders picture of `who`'s athlete (a data URL), for name tags. */
export function athletePortrait(who: Who): Promise<string> {
  let p = portraits.get(who);
  if (!p) {
    p = (async () => {
      const a = await (asset ??= loadAthlete());
      const { scene, model } = stage(a, who);
      const head = model.headWorld().add(new THREE.Vector3(0, -0.2, 0));
      const cam = new THREE.PerspectiveCamera(22, 1, 0.1, 20);
      cam.position.set(head.x, head.y + 0.05, 2.1);
      cam.lookAt(head.x, head.y - 0.02, 0);
      const r = gl();
      r.setSize(PORTRAIT, PORTRAIT, false);
      r.render(scene, cam);
      return r.domElement.toDataURL("image/png");
    })();
    portraits.set(who, p);
  }
  return p;
}
