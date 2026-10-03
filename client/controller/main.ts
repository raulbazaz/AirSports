import type { HostMessage, JoinError } from "../../shared/protocol";
import { characterSvg, PLAYER_LOOK } from "../characters";
import { racquetAngle } from "../racquet";
import { connectSocket } from "../net";
import { keepAwake, requestSensorPermission, startSwingDetector, startTilt } from "./sensors";

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
  ROOM_FULL: "Someone is already playing in this game.",
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

$("#avatar").innerHTML = characterSvg(PLAYER_LOOK, "front");

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
  const stopSwings = startSwingDetector((power) => {
    socket.emit("controller:input", {
      type: "swing",
      power,
      side: angle >= 0 ? "forehand" : "backhand",
      tilt: angle,
      t: Date.now(),
    });
  });
  stopTilt = () => {
    stopOrientation();
    stopSwings();
  };
}

function showGameState(state: Extract<HostMessage, { type: "state" }>["state"]) {
  const playing = state !== "lobby";
  bounceBtn.hidden = !playing;
  connectedEl.classList.toggle("playing", playing);
  hintEl.textContent = playing
    ? "Face the TV and hold your phone like a racquet handle, screen facing you. Tap Bounce, then swing!"
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
  $("#slot").textContent = `Player ${res.slot}`;
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
});

socket.on("room:closed", () => {
  joinedCode = null;
  stopTilt?.();
  stopTilt = null;
  form.hidden = false;
  connectedEl.hidden = true;
  setStatus("The game ended. Scan the new QR code to join again.", true);
});
