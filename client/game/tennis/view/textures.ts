import * as THREE from "three";
import { COURT } from "../court";

// Every texture is painted procedurally on a canvas: no image assets to ship or license.

function canvas(w: number, h = w) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d")! };
}

function toTexture(c: HTMLCanvasElement, opts: { repeat?: [number, number]; color?: boolean } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (opts.color !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...opts.repeat);
  }
  t.anisotropy = 4;
  return t;
}

/** The ground inside the walls, in court coordinates. */
export const GROUND = { x0: -9, x1: 9, z0: -6.5, z1: COURT.length + 6.5 };

/**
 * Mowed grass with the court lines painted in, as one texture: the whole playing area is a
 * single quad and a single draw call. Canvas top is the far end.
 */
export function groundTexture() {
  const W = 1024;
  const H = 2048;
  const { c, ctx } = canvas(W, H);
  const sx = W / (GROUND.x1 - GROUND.x0);
  const sz = H / (GROUND.z1 - GROUND.z0);
  const px = (x: number) => (x - GROUND.x0) * sx;
  const pz = (z: number) => (GROUND.z1 - z) * sz;

  // Mowing stripes across the court.
  const stripe = 1.6;
  for (let z = GROUND.z0, i = 0; z < GROUND.z1; z += stripe, i++) {
    ctx.fillStyle = i % 2 ? "#7fbf45" : "#6cad37";
    ctx.fillRect(0, pz(z + stripe), W, stripe * sz + 1);
  }
  // A little wear and speckle so it reads as grass, not paint.
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = r() < 0.5 ? "rgba(40, 90, 20, 0.10)" : "rgba(220, 255, 160, 0.10)";
    ctx.fillRect(r() * W, r() * H, 2, 3);
  }
  // Worn patches behind each baseline.
  for (const z of [-0.8, COURT.length + 0.8]) {
    const g = ctx.createRadialGradient(px(0), pz(z), 0, px(0), pz(z), 2.6 * sx);
    g.addColorStop(0, "rgba(196, 190, 120, 0.45)");
    g.addColorStop(1, "rgba(196, 190, 120, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.fillStyle = "#ffffff";
  const t = 0.08;
  const line = (x0: number, x1: number, z0: number, z1: number) =>
    ctx.fillRect(px(x0), pz(z1), (x1 - x0) * sx, (z1 - z0) * sz);
  const d = COURT.doublesWidth / 2;
  const s = COURT.singlesWidth / 2;
  const L = COURT.length;
  const sv1 = COURT.netZ - COURT.serviceFromNet;
  const sv2 = COURT.netZ + COURT.serviceFromNet;
  line(-d, d, -t / 2, t / 2);
  line(-d, d, L - t / 2, L + t / 2);
  for (const x of [-d, d, -s, s]) line(x - t / 2, x + t / 2, 0, L);
  line(-s, s, sv1 - t / 2, sv1 + t / 2);
  line(-s, s, sv2 - t / 2, sv2 + t / 2);
  line(-t / 2, t / 2, sv1, sv2);
  line(-t / 2, t / 2, 0, 0.25);
  line(-t / 2, t / 2, L - 0.25, L);

  return toTexture(c);
}

/** Mowed stripes for the grass outside the walls. */
export function outerGrassTexture() {
  const { c, ctx } = canvas(8, 64);
  ctx.fillStyle = "#5f9e33";
  ctx.fillRect(0, 0, 8, 64);
  ctx.fillStyle = "#6aa93a";
  ctx.fillRect(0, 0, 8, 32);
  return toTexture(c, { repeat: [1, 30] });
}

/** Net: a light grey square grid on transparent, tiled per metre. */
export function netTexture() {
  const { c, ctx } = canvas(64);
  ctx.fillStyle = "rgba(50, 56, 62, 0.28)";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(235, 238, 240, 0.9)";
  ctx.lineWidth = 3;
  for (const p of [0, 32]) {
    ctx.beginPath();
    ctx.moveTo(p + 1.5, 0);
    ctx.lineTo(p + 1.5, 64);
    ctx.moveTo(0, p + 1.5);
    ctx.lineTo(64, p + 1.5);
    ctx.stroke();
  }
  return toTexture(c, { repeat: [1, 1] });
}

/** Racquet strings: a fine white grid on transparent. */
export function stringsTexture() {
  const { c, ctx } = canvas(128);
  ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 2;
  for (let i = 6; i < 128; i += 12) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  return toTexture(c);
}

/** Tennis ball felt with the white seam. */
export function ballTexture() {
  const { c, ctx } = canvas(128, 64);
  ctx.fillStyle = "#e4f53a";
  ctx.fillRect(0, 0, 128, 64);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let x = 0; x <= 128; x += 2) {
    const y = 32 + Math.sin((x / 128) * Math.PI * 4) * 17;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  return toTexture(c);
}

/** Sky gradient for the scene background. */
export function skyTexture() {
  const { c, ctx } = canvas(4, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#4f9be3");
  g.addColorStop(0.55, "#9fd0f4");
  g.addColorStop(1, "#e8f6fd");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  return toTexture(c);
}

/** Soft round shadow, multiplied onto the ground under players and the ball. */
export function shadowTexture() {
  const { c, ctx } = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0, 0, 0, 0.55)");
  g.addColorStop(0.55, "rgba(0, 0, 0, 0.35)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c, { color: false });
}

/** White glow for the hit flash. */
export function glowTexture() {
  const { c, ctx } = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,220,0.6)");
  g.addColorStop(1, "rgba(255,255,200,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c, { color: false });
}
