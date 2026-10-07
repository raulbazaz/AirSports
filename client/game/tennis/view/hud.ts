// Heads-up display as plain DOM over the 3D canvas: crisp text at any resolution, styled in CSS.

import type { Side } from "../match";
import { pointLabels, type Tally } from "../scoring";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  return e;
}

function row(className: string, name: string) {
  const root = el(
    "div",
    `hud-row ${className}`,
    `<span class="hud-flag"></span><span class="hud-name"></span><span class="hud-games">0</span><span class="hud-pts">0</span>`,
  );
  root.querySelector(".hud-name")!.textContent = name;
  return { root, games: root.querySelector<HTMLElement>(".hud-games")!, pts: root.querySelector<HTMLElement>(".hud-pts")! };
}

const hint = (side: Side) =>
  el(
    "div",
    `hud-hint ${side}`,
    `<span class="hud-hint-tag">Serve</span><span class="hud-hint-text">Tap <b>Bounce ball</b> on your phone</span>`,
  );

export class Hud {
  readonly root = el("div", "hud");
  private readonly rows: Record<Side, ReturnType<typeof row>>;
  private readonly rally = el("div", "hud-rally", `<small>Rally</small><b>0</b>`);
  private readonly speed = el("div", "hud-speed", `<b>--</b><small>km/h</small>`);
  private readonly markers = { p1: el("div", "hud-marker"), p2: el("div", "hud-marker") };
  private readonly hints = { p1: hint("p1"), p2: hint("p2") };
  private readonly pause = el(
    "div",
    "hud-pause",
    `<div class="hud-pause-card"><b>Phone disconnected</b><span>Reconnecting…</span></div>`,
  );
  private bannerTimer = 0;

  /** `split`: two players, Player 1's view in the top half and Player 2's in the bottom. */
  constructor(parent: HTMLElement, names: Record<Side, string>, split: boolean) {
    this.rows = { p1: row("p1", names.p1), p2: row(split ? "p2" : "p2 cpu", names.p2) };
    const board = el("div", "hud-board");
    board.append(this.rows.p1.root, this.rows.p2.root);
    const stats = el("div", "hud-stats");
    stats.append(this.rally, this.speed);
    this.root.classList.toggle("split", split);
    if (split) this.root.append(el("div", "hud-divider"));
    // The AirSports logo in the corner, like a broadcast's channel badge.
    const logo = el("img", "hud-logo") as HTMLImageElement;
    logo.src = "/brand/logo-wide.png";
    logo.alt = "";
    this.root.append(board, stats, logo, ...Object.values(this.markers), ...Object.values(this.hints), this.pause);
    for (const side of ["p1", "p2"] as const) this.setMarker(side, null);
    parent.append(this.root);
  }

  setScore(t: Tally) {
    const pts = pointLabels(t);
    for (const side of ["p1", "p2"] as const) {
      const r = this.rows[side];
      set(r.games, String(t.games[side]));
      set(r.pts, pts[side]);
    }
  }

  setRally(n: number) {
    const b = this.rally.querySelector("b")!;
    if (b.textContent !== String(n)) {
      b.textContent = String(n);
      if (n > 0) bump(this.rally);
    }
  }

  setSpeed(kmh: number | null) {
    this.speed.querySelector("b")!.textContent = kmh === null ? "--" : String(kmh);
    if (kmh !== null) bump(this.speed);
  }

  /** The "your serve" arrow and hint in `side`'s view; null hides them. */
  setMarker(side: Side, at: { x: number; y: number } | null) {
    this.markers[side].hidden = !at;
    this.hints[side].hidden = !at;
    if (at) this.markers[side].style.transform = `translate(${at.x}px, ${at.y}px)`;
  }

  /** `who`: whose phone dropped, e.g. "Player 2's phone disconnected". */
  setPaused(paused: boolean, who = "Phone") {
    this.pause.hidden = !paused;
    this.pause.querySelector("b")!.textContent = `${who} disconnected`;
  }

  banner(title: string, subtitle?: string) {
    this.root.querySelector(".hud-banner")?.remove();
    clearTimeout(this.bannerTimer);
    const b = el("div", "hud-banner");
    const card = el("div", "hud-banner-card");
    const t = el("div", "hud-banner-title");
    const sub = el("div", "hud-banner-sub");
    t.textContent = title;
    sub.textContent = subtitle ?? "";
    card.append(t, sub);
    b.append(card);
    this.root.append(b);
    this.bannerTimer = window.setTimeout(() => b.remove(), 1900);
  }

  pop(text: string, at: { x: number; y: number }) {
    const p = el("div", "hud-pop");
    p.textContent = text;
    p.style.left = `${at.x}px`;
    p.style.top = `${at.y}px`;
    this.root.append(p);
    setTimeout(() => p.remove(), 1300);
  }

  destroy() {
    clearTimeout(this.bannerTimer);
    this.root.remove();
  }
}

function set(e: HTMLElement, text: string) {
  if (e.textContent === text) return;
  e.textContent = text;
  bump(e);
}

function bump(e: HTMLElement) {
  e.classList.remove("bump");
  void e.offsetWidth; // restart the animation
  e.classList.add("bump");
}
