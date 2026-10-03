import type { JoinError } from "../../shared/protocol";
import { connectSocket } from "../net";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const form = $<HTMLFormElement>("#join-form");
const codeInput = $<HTMLInputElement>("#code");
const joinBtn = $<HTMLButtonElement>("#join-btn");
const statusEl = $("#status");

const JOIN_ERRORS: Record<JoinError, string> = {
  ROOM_NOT_FOUND: "No game with that code. Check the code on the screen.",
  ROOM_FULL: "That game already has 2 players.",
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
  $("#connected").hidden = false;
  $("#slot").textContent = `Player ${res.slot}`;
  $("#room").textContent = res.code;
  history.replaceState(null, "", `/controller?room=${res.code}`);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
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
  setStatus(connected ? "Connected! Look at the screen." : "Game screen disconnected. Waiting…", !connected);
});

socket.on("host:message", (msg) => {
  if (msg.type === "vibrate") navigator.vibrate?.(msg.ms);
});

socket.on("room:closed", () => {
  joinedCode = null;
  form.hidden = false;
  $("#connected").hidden = true;
  setStatus("The game ended. Scan the new QR code to join again.", true);
});
