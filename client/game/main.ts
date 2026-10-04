import QRCode from "qrcode";
import type { ControllerInput, HostMessage } from "../../shared/protocol";
import { characterSvg, CPU_LOOK, faceSvg, PLAYER_LOOK } from "../characters";
import { connectSocket } from "../net";
import type { TennisGame } from "./tennis";

const SESSION_KEY = "airsports:host";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const lobbyEl = $("#lobby");
const gameEl = $("#game");
const statusEl = $("#status");
const startBtn = $<HTMLButtonElement>("#start-btn");
const playerSide = $("#player-side");
const playerFigure = $("#player-figure");
const playerFace = $("#player-face");
const playerStatus = $("#player-status");

type Phase = "lobby" | "starting" | "playing";
let phase: Phase = "lobby";
let playerConnected = false;
let game: TennisGame | null = null;
let serveReady = false;
let audio: AudioContext | null = null;

const socket = connectSocket();

// The computer is always ready.
$("#cpu-figure").innerHTML = characterSvg(CPU_LOOK, "front");
$("#cpu-face").innerHTML = faceSvg(CPU_LOOK);

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
  startBtn.disabled = !playerConnected || phase !== "lobby";
  statusEl.textContent = playerConnected
    ? "Press Start to play"
    : socket.connected
      ? "Scan the QR code with your phone to join"
      : "Connecting to server…";
}

function showPlayer(connected: boolean, reconnected = false) {
  playerConnected = connected;
  playerSide.classList.toggle("ready", connected);

  if (connected) {
    if (!playerFigure.querySelector("svg")) {
      playerFigure.innerHTML = characterSvg(PLAYER_LOOK, "front");
      playerFigure.classList.remove("entering");
      void playerFigure.offsetWidth; // restart the hop-in animation
      playerFigure.classList.add("entering");
    }
    if (!reconnected) {
      const pop = document.createElement("span");
      pop.className = "joined-pop";
      pop.textContent = "Joined!";
      pop.addEventListener("animationend", () => pop.remove());
      playerFigure.append(pop);
    }
    playerFace.innerHTML = faceSvg(PLAYER_LOOK);
    playerStatus.textContent = "Ready";
  } else {
    playerFigure.classList.remove("entering");
    playerFigure.innerHTML = `<div class="silhouette"></div>`;
    playerFace.innerHTML = "";
    playerStatus.textContent = "Waiting for phone…";
  }
  game?.setPlayerConnected(connected);
  updateLobby();
}

function sendToPhone(msg: HostMessage) {
  socket.emit("host:send", { slot: 1, msg });
}

function sendState(state: Extract<HostMessage, { type: "state" }>["state"]) {
  sendToPhone({ type: "state", state });
}

// ---------- start / exit ----------

async function startGame() {
  if (phase !== "lobby" || !playerConnected) return;
  phase = "starting";
  updateLobby();
  lobbyEl.classList.add("leaving");
  // Sound may only start from a gesture on this page: make it now, before any await.
  audio ??= new AudioContext();
  void audio.resume();

  const { startTennis } = await import("./tennis");
  gameEl.hidden = false;
  game = await startTennis(gameEl, {
    onServeReady: (ready) => {
      serveReady = ready;
      sendToPhone({ type: "serve", ready });
    },
    onPlayerHit: (quality) => sendToPhone({ type: "vibrate", ms: quality >= 0.8 ? 55 : 30 }),
  }, audio);
  game.setPlayerConnected(playerConnected);
  lobbyEl.hidden = true;
  phase = "playing";
  sendState("playing");
}

function exitToLobby() {
  if (phase !== "playing") return;
  game?.destroy();
  game = null;
  serveReady = false;
  gameEl.hidden = true;
  lobbyEl.hidden = false;
  lobbyEl.classList.remove("leaving");
  phase = "lobby";
  updateLobby();
  sendState("lobby");
}

startBtn.addEventListener("click", startGame);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && phase === "lobby") startGame();
  if (e.key === "Escape") exitToLobby();
  if ((e.key === "d" || e.key === "D") && phase === "playing") game?.debug.toggle();
  // Keyboard stand-ins for the phone, handy for testing: B bounces, Space swings.
  if (phase === "playing" && !e.repeat) {
    if (e.key === "b" || e.key === "B") game?.handleInput({ type: "bounce" });
    if (e.key === " ") game?.handleInput({ type: "swing", power: 0.7, side: "forehand", tilt: 0, t: Date.now() });
  }
});

// ---------- socket ----------

// Fires on first connect and on every reconnect. Reclaim our room if we had one.
socket.on("connect", async () => {
  const saved = loadSession();
  if (saved) {
    const res = await socket.emitWithAck("host:rejoin", saved);
    if (res.ok) {
      showPlayer(res.players.includes(1), true);
      await showRoom(res.code);
      return;
    }
  }
  const { code, hostToken } = await socket.emitWithAck("host:create");
  saveSession(code, hostToken);
  showPlayer(false);
  await showRoom(code);
});

socket.on("disconnect", updateLobby);

socket.on("player:joined", ({ slot, reconnected }) => {
  showPlayer(true, reconnected);
  socket.emit("host:send", { slot, msg: { type: "vibrate", ms: 60 } });
  sendState(phase === "playing" ? "playing" : "lobby");
  if (phase === "playing") sendToPhone({ type: "serve", ready: serveReady });
});

socket.on("player:left", () => showPlayer(false));

socket.on("player:input", ({ input }) => {
  if (input.type === "pong") return onPong(input);
  if (phase !== "playing") return;
  game?.handleInput(input, input.type === "swing" ? phoneAge(input.t) : 0);
});

// ---------- phone clock sync and network timing ----------

// The game pings the phone every second while playing. The phone answers with its clock, which
// tells us how its Date.now() lines up with ours, so a swing's timestamp says how long ago it
// really happened (the match rewinds that far to judge it). Like NTP: the reply with the fastest
// round trip gives the best estimate, so keep the recent best.
const pings = new Map<number, number>();
let pingId = 0;
let lastServerPing = performance.now();
const clockSamples: { rtt: number; offset: number }[] = [];

setInterval(async () => {
  if (phase !== "playing" || !socket.connected) return;
  pings.clear(); // unanswered pings (phone away) don't pile up
  const id = ++pingId;
  pings.set(id, Date.now());
  sendToPhone({ type: "ping", id });
  if (!game?.debug.visible) return;
  const t0 = performance.now();
  const { tiltsIn } = await socket.emitWithAck("net:ping");
  game?.debug.server(performance.now() - t0, tiltsIn / ((performance.now() - lastServerPing) / 1000));
  lastServerPing = performance.now();
}, 1000);

function onPong({ id, now, sensorHz, sentHz }: Extract<ControllerInput, { type: "pong" }>) {
  const sent = pings.get(id);
  if (sent === undefined) return;
  pings.delete(id);
  const received = Date.now();
  const rtt = received - sent;
  clockSamples.push({ rtt, offset: now - (sent + received) / 2 });
  if (clockSamples.length > 10) clockSamples.shift();
  game?.debug.phone(rtt, sensorHz, sentHz);
}

/** How long ago (ms) the phone did something it stamped `t` on its own clock. 0 if unknown. */
function phoneAge(t: number) {
  if (!clockSamples.length) return 0;
  const best = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  return Math.max(0, Date.now() - (t - best.offset));
}

updateLobby();
