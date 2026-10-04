import type * as THREE from "three";

// Performance overlay: open the game with ?debug in the URL, or press D during play.
// Shows where time goes so we know what to optimise:
// - Frame: fps, average and worst frame time, and how much of it is our JavaScript (CPU). If the
//   frame is slow but the CPU part is small, the GPU is the bottleneck.
// - GPU: draw calls, triangles, render size, whether the soft-focus post chain is on.
// - Phone: how often its sensor fires, how often it sends, how often tilts arrive here, and the
//   gaps between arrivals (big gaps = the racquet stutters).
// - Network: round trip game → server → phone → back, and the game ↔ server leg alone.

const REFRESH_MS = 500;

export interface RenderStats {
  calls: number;
  triangles: number;
  width: number;
  height: number;
  pixelRatio: number;
  post: boolean;
}

export class DebugOverlay {
  private readonly el = document.createElement("pre");
  private shown = false;
  private gpuName = "";

  // Frame stats since the last refresh.
  private frames = 0;
  private frameMs = 0;
  private worstMs = 0;
  private cpuMs = 0;
  private render: RenderStats | null = null;

  // Tilt arrivals since the last refresh.
  private lastTilt = 0;
  private tilts = 0;
  private gapSum = 0;
  private gapMax = 0;

  // Latest network results (ms) and phone rates (Hz).
  private phoneRtt: number | null = null;
  private serverRtt: number | null = null;
  private serverHz: number | null = null;
  private sensorHz: number | null = null;
  private sentHz: number | null = null;

  private lastRefresh = performance.now();

  constructor(parent: HTMLElement, renderer: THREE.WebGLRenderer) {
    this.el.className = "debug-overlay";
    this.el.hidden = true;
    parent.append(this.el);
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown GPU";
    if (new URLSearchParams(location.search).has("debug")) this.toggle(true);
  }

  get visible() {
    return this.shown;
  }

  toggle(show = !this.shown) {
    this.shown = show;
    this.el.hidden = !show;
  }

  /** Once per rendered frame. */
  frame(frameMs: number, cpuMs: number, render: RenderStats) {
    this.frames++;
    this.frameMs += frameMs;
    this.worstMs = Math.max(this.worstMs, frameMs);
    this.cpuMs += cpuMs;
    this.render = render;
    const now = performance.now();
    if (now - this.lastRefresh >= REFRESH_MS) this.refresh(now);
  }

  /** A tilt reading arrived from the phone. */
  tilt() {
    const now = performance.now();
    if (this.lastTilt) {
      const gap = now - this.lastTilt;
      this.gapSum += gap;
      this.gapMax = Math.max(this.gapMax, gap);
    }
    this.lastTilt = now;
    this.tilts++;
  }

  phone(rttMs: number, sensorHz: number, sentHz: number) {
    this.phoneRtt = rttMs;
    this.sensorHz = sensorHz;
    this.sentHz = sentHz;
  }

  /** Game ↔ server round trip, and tilts per second the server got from the phone. */
  server(rttMs: number, tiltsInHz: number) {
    this.serverRtt = rttMs;
    this.serverHz = Math.round(tiltsInHz);
  }

  destroy() {
    this.el.remove();
  }

  private refresh(now: number) {
    const secs = (now - this.lastRefresh) / 1000;
    if (this.shown && this.frames) {
      const ms = (v: number | null) => (v === null ? "–" : `${Math.round(v)} ms`);
      const hz = (v: number | null) => (v === null ? "–" : `${v}/s`);
      const r = this.render;
      const avg = this.frameMs / this.frames;
      const gaps = this.tilts > 1 ? this.gapSum / (this.tilts - 1) : null;
      const stale = this.lastTilt ? now - this.lastTilt : null;
      this.el.textContent = [
        `FPS      ${Math.round(this.frames / secs)}   frame ${avg.toFixed(1)} ms (worst ${this.worstMs.toFixed(0)})   cpu ${(this.cpuMs / this.frames).toFixed(1)} ms`,
        r
          ? `GPU      ${r.calls} draws   ${Math.round(r.triangles / 1000)}k tris   ${r.width}×${r.height} @${r.pixelRatio.toFixed(2)}   post ${r.post ? "on" : "off"}`
          : "",
        `         ${this.gpuName}`,
        `PHONE    sensor ${hz(this.sensorHz)}   sent ${hz(this.sentHz)}   at server ${hz(this.serverHz)}   received ${Math.round(this.tilts / secs)}/s`,
        `         gap avg ${ms(gaps)}   max ${ms(this.tilts > 1 ? this.gapMax : null)}   last ${ms(stale)} ago`,
        `NETWORK  phone round trip ${ms(this.phoneRtt)} (≈${ms(this.phoneRtt === null ? null : this.phoneRtt / 2)} delay)   game↔server ${ms(this.serverRtt)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    this.frames = this.frameMs = this.worstMs = this.cpuMs = 0;
    this.tilts = this.gapSum = this.gapMax = 0;
    this.lastRefresh = now;
  }
}
