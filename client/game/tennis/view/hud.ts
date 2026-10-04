// Heads-up display as plain DOM over the 3D canvas: crisp text at any resolution, styled in CSS.

import { pointLabels, type Tally } from "../scoring";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  return e;
}

function row(side: "player" | "cpu", name: string) {
  const root = el(
    "div",
    `hud-row ${side}`,
    `<span class="hud-flag"></span><span class="hud-name"></span><span class="hud-games">0</span><span class="hud-pts">0</span>`,
  );
  root.querySelector(".hud-name")!.textContent = name;
  return { root, games: root.querySelector<HTMLElement>(".hud-games")!, pts: root.querySelector<HTMLElement>(".hud-pts")! };
}

export class Hud {
  readonly root = el("div", "hud");
  private readonly player = row("player", "Player 1");
  private readonly cpu = row("cpu", "Computer");
  private readonly rally = el("div", "hud-rally", `<small>Rally</small><b>0</b>`);
  private readonly speed = el("div", "hud-speed", `<b>--</b><small>km/h</small>`);
  private readonly marker = el("div", "hud-marker");
  private readonly hint = el(
    "div",
    "hud-hint",
    `<span class="hud-hint-tag">Serve</span><span class="hud-hint-text">Tap <b>Bounce ball</b> on your phone</span>`,
  );
  private readonly pause = el(
    "div",
    "hud-pause",
    `<div class="hud-pause-card"><b>Phone disconnected</b><span>Reconnecting…</span></div>`,
  );
  private bannerTimer = 0;

  constructor(parent: HTMLElement) {
    const board = el("div", "hud-board");
    board.append(this.player.root, this.cpu.root);
    const stats = el("div", "hud-stats");
    stats.append(this.rally, this.speed);
    this.root.append(board, stats, this.marker, this.hint, this.pause);
    parent.append(this.root);
  }

  setScore(t: Tally) {
    const pts = pointLabels(t);
    for (const side of ["player", "cpu"] as const) {
      const r = this[side];
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

  /** The "your serve" arrow over the player's head; null hides it. */
  setMarker(at: { x: number; y: number } | null) {
    this.marker.hidden = !at;
    this.hint.hidden = !at;
    if (at) this.marker.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }

  setPaused(paused: boolean) {
    this.pause.hidden = !paused;
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
