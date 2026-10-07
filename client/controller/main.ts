import type { HostMessage, JoinError } from "../../shared/protocol";
import { lookForSlot } from "../characters";
import { racquetAngle } from "../racquet";
import { connectSocket } from "../net";
import { keepAwake, requestSensorPermission, startSwingDetector, startTilt, tiltCounts } from "./sensors";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const form = $<HTMLFormElement>("#join-form");
const codeInput = $<HTMLInputElement>("#code");
const joinBtn = $<HTMLButtonElement>("#join-btn");
const statusEl = $("#status");
const connectedEl = $("#connected");
const bounceBtn = $<HTMLButtonElement>("#bounce-btn");
const hintEl = $("#hint");

const JOIN_ERRORS: Record<JoinError, string> = {
  ROOM_NOT_FOUND: "No game with that code. Check the code on the screen.",
  ROOM_FULL: "This game already has two players.",
};

const tokenKey = (code: string) => `airsports:player:${code}`;

function storage<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined; // private mode etc.; reconnect just won't reclaim the seat
  }
}

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

const params = new URLSearchParams(location.search);
codeInput.value = (params.get("room") ?? "").toUpperCase();

const socket = connectSocket();
let joinedCode: string | null = null;
let stopTilt: (() => void) | null = null;

let shownSlot = 0;

/** Dress the phone in its player's colours and athlete (Player 1 blue, Player 2 purple). */
async function showSlot(slot: number) {
  $("#slot").textContent = `Player ${slot}`;
  document.documentElement.style.setProperty("--player", lookForSlot(slot).shirt);
  if (slot === shownSlot) return;
  shownSlot = slot;
  // Three.js and the model load after the page, so joining is never held up by them.
  const { athleteFigure } = await import("../figure3d");
  const figure = await athleteFigure(slot === 2 ? "p2" : "p1");
  if (shownSlot === slot) $("#avatar").replaceChildren(figure);
}

void showSlot(1);

let angle = 0;

function startStreaming() {
  if (stopTilt) return;
  const stopOrientation = startTilt(
    ({ alpha, beta, gamma, t }) => {
      angle = racquetAngle(beta, gamma, angle);
      socket.volatile.emit("controller:input", { type: "tilt", alpha, beta, gamma, t });
    },
    () => setStatus("No motion data from this device. Open this page on a phone.", true),
  );
  const stopSwings = startSwingDetector(({ power, t, rate, orient }) => {
    socket.emit("controller:input", {
      type: "swing",
      power,
      side: angle >= 0 ? "forehand" : "backhand",
      tilt: angle,
      t,
      rate,
      orient,
    });
  });
  stopTilt = () => {
    stopOrientation();
    stopSwings();
  };
}

function showGameState(state: Extract<HostMessage, { type: "state" }>["state"]) {
  const playing = state !== "lobby" && state !== "waiting";
  bounceBtn.hidden = !playing;
  connectedEl.classList.toggle("playing", playing);
  hintEl.textContent = playing
    ? "Face the TV and hold your phone like a racquet handle, screen facing you. Tap Bounce when it's your serve, then swing!"
    : state === "waiting"
      ? "A match against the computer is on. You'll play in the next one."
      : "Press Start on the big screen to play.";
}

bounceBtn.addEventListener("click", () => {
  socket.emit("controller:input", { type: "bounce" });
  bounceBtn.disabled = true; // re-enabled by the next "serve" message
});

async function join(code: string) {
  joinBtn.disabled = true;
  setStatus("Connecting…");
  const playerToken = storage(() => localStorage.getItem(tokenKey(code))) ?? undefined;
  const res = await socket.emitWithAck("controller:join", { code, playerToken });
  joinBtn.disabled = false;

  if (!res.ok) {
    joinedCode = null;
    setStatus(JOIN_ERRORS[res.error], true);
    return;
  }

  joinedCode = res.code;
  storage(() => localStorage.setItem(tokenKey(res.code), res.playerToken));
  form.hidden = true;
  connectedEl.hidden = false;
  showSlot(res.slot);
  $("#room").textContent = res.code;
  setStatus("");
  history.replaceState(null, "", `/controller?room=${res.code}`);
  startStreaming();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  // Must run first, while we're still inside the tap gesture (iOS requirement).
  const permission = requestSensorPermission();
  keepAwake();
  if (!(await permission)) {
    return setStatus("Motion access was denied. Allow it and tap again (iOS: quit Safari and reopen the link).", true);
  }
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) return setStatus("Enter the 4-letter code from the screen.", true);
  if (!socket.connected) return setStatus("Still connecting to server…", true);
  join(code);
});

// On reconnect, silently reclaim our seat.
socket.on("connect", () => {
  if (joinedCode) join(joinedCode);
  else setStatus("");
});

socket.on("disconnect", () => {
  if (joinedCode) setStatus("Connection lost. Reconnecting…", true);
});

socket.on("host:status", ({ connected }) => {
  setStatus(connected ? "" : "Game screen disconnected. Waiting…", !connected);
});

socket.on("host:message", (msg) => {
  if (msg.type === "vibrate") navigator.vibrate?.(msg.ms);
  if (msg.type === "state") showGameState(msg.state);
  if (msg.type === "serve") bounceBtn.disabled = !msg.ready;
  if (msg.type === "ping") pong(msg.id);
});

/**
 * Answer the game's ping with our clock (it syncs swing timestamps with it) and, for its debug
 * overlay, how often the sensor fired and tilts went out since the last one.
 */
let rateSince = performance.now();
function pong(id: number) {
  const now = performance.now();
  const s = Math.max(0.001, (now - rateSince) / 1000);
  socket.emit("controller:input", { type: "pong", id, now: Date.now(), sensorHz: Math.round(tiltCounts.sensor / s), sentHz: Math.round(tiltCounts.sent / s) });
  tiltCounts.sensor = tiltCounts.sent = 0;
  rateSince = now;
}

socket.on("room:closed", () => {
  joinedCode = null;
  stopTilt?.();
  stopTilt = null;
  form.hidden = false;
  connectedEl.hidden = true;
  setStatus("The game ended. Scan the new QR code to join again.", true);
});
