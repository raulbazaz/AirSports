import QRCode from "qrcode";
import type { ControllerInput, HostMessage, PlayerSlot } from "../../shared/protocol";
import type { Who } from "../figure3d";
import { connectSocket } from "../net";
import type { Side, TennisGame } from "./tennis";

const SESSION_KEY = "airsports:host";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const lobbyEl = $("#lobby");
const gameEl = $("#game");
const statusEl = $("#status");
const startBtn = $<HTMLButtonElement>("#start-btn");
/** The lobby's two cards, side by side: each player's athlete, faded until their phone joins. */
const cards = {
  1: { side: $("#player-side"), figure: $("#player-figure"), face: $("#player-face") },
  2: { side: $("#opponent-side"), figure: $("#opponent-figure"), face: $("#opponent-face") },
};
/** Under the cards: without a second phone, the match is against the computer. */
const fallback = $("#fallback");
const joinTitle = $("#join-title");
const modes = { 1: $("#mode-1"), 2: $("#mode-2") };

type Phase = "lobby" | "starting" | "playing";
let phase: Phase = "lobby";
/** Which phones are connected. */
const connected: Record<PlayerSlot, boolean> = { 1: false, 2: false };
let game: TennisGame | null = null;
/** Who's playing this match: slot 2 only in a two-player match. */
let inGame: PlayerSlot[] = [];
const serveReady: Record<PlayerSlot, boolean> = { 1: false, 2: false };
let audio: AudioContext | null = null;

const socket = connectSocket();

const SLOT_SIDE: Record<PlayerSlot, Side> = { 1: "p1", 2: "p2" };
const SIDE_SLOT: Record<Side, PlayerSlot> = { p1: 1, p2: 2 };

// ---------- room / QR ----------

async function publicOrigin(): Promise<string> {
  try {
    const { publicUrl } = await (await fetch("/api/config")).json();
    if (publicUrl) return publicUrl;
  } catch {
    // fall through to the page origin
  }
  return location.origin;
}

async function showRoom(code: string) {
  const origin = await publicOrigin();
  const url = `${origin}/controller?room=${code}`;
  $("#room-code").textContent = code;
  $("#join-url").textContent = url;
  await QRCode.toCanvas($<HTMLCanvasElement>("#qr"), url, { width: 220, margin: 1 });

  const warning = $("#warning");
  const host = new URL(origin).hostname;
  warning.hidden = host !== "localhost" && host !== "127.0.0.1";
  warning.textContent = "Phones can't reach localhost. Run npm run tunnel and open this page from the tunnel URL.";
}

function loadSession(): { code: string; hostToken: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveSession(code: string, hostToken: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, hostToken }));
  } catch {
    // reload will just create a fresh room
  }
}

// ---------- lobby UI ----------

function updateLobby() {
  startBtn.disabled = !connected[1] || phase !== "lobby";
  statusEl.textContent = !socket.connected
    ? "Connecting to server…"
    : !connected[1]
      ? "Scan the QR code with your phone to join"
      : connected[2]
        ? "Press Start for a 2-player split-screen match"
        : "Press Start to play the computer, or scan with a 2nd phone for 2 players";
  // Say who the next phone to scan becomes (the server gives it the lowest free slot).
  const next = !connected[1] ? 1 : !connected[2] ? 2 : null;
  joinTitle.innerHTML = next ? `Scan to join as <b class="p${next}">Player ${next}</b>` : "Both players are in!";
  modes[1].classList.toggle("active", !connected[2]);
  modes[2].classList.toggle("active", connected[2]);
}

const CARD_WHO: Record<PlayerSlot, Who> = { 1: "p1", 2: "p2" };

/** Put each player's 3D athlete and portrait on its card (and the computer's on the note). */
async function showAthletes() {
  const { athleteFigure, athletePortrait } = await import("../figure3d");
  for (const slot of [1, 2] as const) {
    const { figure, face } = cards[slot];
    figure.replaceChildren(await athleteFigure(CARD_WHO[slot]));
    face.innerHTML = `<img src="${await athletePortrait(CARD_WHO[slot])}" alt="" />`;
  }
  $("#cpu-face").innerHTML = `<img src="${await athletePortrait("cpu")}" alt="" />`;
}

/** Hop a newly joined athlete in, with a "Joined!" pop. */
function popIn(figure: HTMLElement) {
  figure.classList.remove("entering");
  void figure.offsetWidth; // restart the hop-in animation
  figure.classList.add("entering");
  const p = document.createElement("span");
  p.className = "joined-pop";
  p.textContent = "Joined!";
  p.addEventListener("animationend", () => p.remove());
  figure.append(p);
}

function showPlayer(slot: PlayerSlot, isConnected: boolean, reconnected = false) {
  const was = connected[slot];
  connected[slot] = isConnected;
  const card = cards[slot];
  card.side.classList.toggle("ready", isConnected);
  card.figure.classList.toggle("waiting", !isConnected);
  if (isConnected && !was && !reconnected) popIn(card.figure);
  // A second phone takes the computer's place; until then, say the computer will play.
  if (slot === 2) fallback.classList.toggle("gone", isConnected);

  syncConnected();
  updateLobby();
}

/** Pause the match while a phone that's in it is away. */
function syncConnected() {
  game?.setConnected({ p1: connected[1], p2: connected[2] || !inGame.includes(2) });
}

function sendToPhone(slot: PlayerSlot, msg: HostMessage) {
  socket.emit("host:send", { slot, msg });
}

/** What a phone should show: playing, in the lobby, or waiting out a match it isn't in. */
function phoneState(slot: PlayerSlot) {
  if (phase !== "playing") return "lobby";
  return inGame.includes(slot) ? "playing" : "waiting";
}

function sendStates() {
  for (const slot of [1, 2] as const) if (connected[slot]) sendToPhone(slot, { type: "state", state: phoneState(slot) });
}

// ---------- start / exit ----------

async function startGame() {
  if (phase !== "lobby" || !connected[1]) return;
  phase = "starting";
  updateLobby();
  lobbyEl.classList.add("leaving");
  // Sound may only start from a gesture on this page: make it now, before any await.
  audio ??= new AudioContext();
  void audio.resume();

  const { startTennis } = await import("./tennis");
  gameEl.hidden = false;
  // A second phone in the room makes it a two-player, split-screen match.
  inGame = connected[2] ? [1, 2] : [1];
  game = await startTennis(
    gameEl,
    {
      onServeReady: (side, ready) => {
        const slot = SIDE_SLOT[side];
        serveReady[slot] = ready;
        sendToPhone(slot, { type: "serve", ready });
      },
      onPlayerHit: (side, quality) => sendToPhone(SIDE_SLOT[side], { type: "vibrate", ms: quality >= 0.8 ? 55 : 30 }),
    },
    { players: inGame.length as 1 | 2, audio },
  );
  syncConnected();
  lobbyEl.hidden = true;
  phase = "playing";
  sendStates();
}

function exitToLobby() {
  if (phase !== "playing") return;
  game?.destroy();
  game = null;
  inGame = [];
  serveReady[1] = serveReady[2] = false;
  gameEl.hidden = true;
  lobbyEl.hidden = false;
  lobbyEl.classList.remove("leaving");
  phase = "lobby";
  updateLobby();
  sendStates();
}

startBtn.addEventListener("click", startGame);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && phase === "lobby") startGame();
  if (e.key === "Escape") exitToLobby();
  if ((e.key === "d" || e.key === "D") && phase === "playing") game?.debug.toggle();
  // Keyboard stand-ins for the phones, handy for testing: B bounces and Space swings for Player 1,
  // N and M for Player 2.
  if (phase === "playing" && !e.repeat) {
    const swing = { type: "swing", power: 0.7, side: "forehand", tilt: 0, t: Date.now() } as const;
    if (e.key === "b" || e.key === "B") game?.handleInput("p1", { type: "bounce" });
    if (e.key === " ") game?.handleInput("p1", swing);
    if (e.key === "n" || e.key === "N") game?.handleInput("p2", { type: "bounce" });
    if (e.key === "m" || e.key === "M") game?.handleInput("p2", swing);
  }
});

// ---------- socket ----------

// Fires on first connect and on every reconnect. Reclaim our room if we had one.
socket.on("connect", async () => {
  const saved = loadSession();
  if (saved) {
    const res = await socket.emitWithAck("host:rejoin", saved);
    if (res.ok) {
      for (const slot of [1, 2] as const) showPlayer(slot, res.players.includes(slot), true);
      await showRoom(res.code);
      return;
    }
  }
  const { code, hostToken } = await socket.emitWithAck("host:create");
  saveSession(code, hostToken);
  for (const slot of [1, 2] as const) showPlayer(slot, false);
  await showRoom(code);
});

socket.on("disconnect", updateLobby);

socket.on("player:joined", ({ slot, reconnected }) => {
  showPlayer(slot, true, reconnected);
  sendToPhone(slot, { type: "vibrate", ms: 60 });
  sendToPhone(slot, { type: "state", state: phoneState(slot) });
  if (phoneState(slot) === "playing") sendToPhone(slot, { type: "serve", ready: serveReady[slot] });
});

socket.on("player:left", ({ slot }) => {
  showPlayer(slot, false);
  clocks[slot].samples.length = 0;
});

socket.on("player:input", ({ slot, input }) => {
  if (input.type === "pong") return onPong(slot, input);
  if (phase !== "playing" || !inGame.includes(slot)) return;
  game?.handleInput(SLOT_SIDE[slot], input, input.type === "swing" ? phoneAge(slot, input.t) : 0);
});

// ---------- phone clock sync and network timing ----------

// The game pings the phone every second while playing. The phone answers with its clock, which
// tells us how its Date.now() lines up with ours, so a swing's timestamp says how long ago it
// really happened (the match rewinds that far to judge it). Like NTP: the reply with the fastest
// round trip gives the best estimate, so keep the recent best.
/** Per phone: pings awaiting an answer (id → sent at) and recent clock samples. */
const clocks: Record<PlayerSlot, { pings: Map<number, number>; samples: { rtt: number; offset: number }[] }> = {
  1: { pings: new Map(), samples: [] },
  2: { pings: new Map(), samples: [] },
};
let pingId = 0;
let lastServerPing = performance.now();

setInterval(async () => {
  if (phase !== "playing" || !socket.connected) return;
  for (const slot of inGame) {
    const { pings } = clocks[slot];
    pings.clear(); // unanswered pings (phone away) don't pile up
    const id = ++pingId;
    pings.set(id, Date.now());
    sendToPhone(slot, { type: "ping", id });
  }
  if (!game?.debug.visible) return;
  const t0 = performance.now();
  const { tiltsIn } = await socket.emitWithAck("net:ping");
  game?.debug.server(performance.now() - t0, tiltsIn / ((performance.now() - lastServerPing) / 1000));
  lastServerPing = performance.now();
}, 1000);

function onPong(slot: PlayerSlot, { id, now, sensorHz, sentHz }: Extract<ControllerInput, { type: "pong" }>) {
  const { pings, samples } = clocks[slot];
  const sent = pings.get(id);
  if (sent === undefined) return;
  pings.delete(id);
  const received = Date.now();
  const rtt = received - sent;
  samples.push({ rtt, offset: now - (sent + received) / 2 });
  if (samples.length > 10) samples.shift();
  if (slot === 1) game?.debug.phone(rtt, sensorHz, sentHz);
}

/** How long ago (ms) `slot`'s phone did something it stamped `t` on its own clock. 0 if unknown. */
function phoneAge(slot: PlayerSlot, t: number) {
  const { samples } = clocks[slot];
  if (!samples.length) return 0;
  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  return Math.max(0, Date.now() - (t - best.offset));
}

updateLobby();
void showAthletes();
