import QRCode from "qrcode";
import type { PlayerSlot } from "../../shared/protocol";
import { connectSocket } from "../net";

const SESSION_KEY = "airsports:host";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const statusEl = $("#status");

const socket = connectSocket();

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
  await QRCode.toCanvas($<HTMLCanvasElement>("#qr"), url, { width: 280, margin: 2 });

  const warning = $("#warning");
  const host = new URL(origin).hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    warning.hidden = false;
    warning.textContent =
      "Phones can't reach localhost. Start an HTTPS tunnel (npm run tunnel) and open this page from the tunnel URL.";
  } else {
    warning.hidden = true;
  }
}

function setPlayer(slot: PlayerSlot, connected: boolean, note?: string) {
  const el = $(`.player[data-slot="${slot}"]`);
  el.classList.toggle("connected", connected);
  el.querySelector("em")!.textContent = note ?? (connected ? "connected" : "waiting…");
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

// Fires on first connect and on every reconnect. Reclaim our room if we had one.
socket.on("connect", async () => {
  const saved = loadSession();
  if (saved) {
    const res = await socket.emitWithAck("host:rejoin", saved);
    if (res.ok) {
      for (const slot of [1, 2] as PlayerSlot[]) setPlayer(slot, res.players.includes(slot));
      await showRoom(res.code);
      statusEl.textContent = "Connected. Waiting for players…";
      return;
    }
  }
  const { code, hostToken } = await socket.emitWithAck("host:create");
  saveSession(code, hostToken);
  setPlayer(1, false);
  setPlayer(2, false);
  await showRoom(code);
  statusEl.textContent = "Connected. Waiting for players…";
});

socket.on("disconnect", () => {
  statusEl.textContent = "Lost connection to server. Reconnecting…";
});

socket.on("player:joined", ({ slot, reconnected }) => {
  setPlayer(slot, true, reconnected ? "reconnected" : "connected");
  socket.emit("host:send", { slot, msg: { type: "vibrate", ms: 60 } });
});

socket.on("player:left", ({ slot }) => {
  setPlayer(slot, false, "disconnected, holding spot…");
});

socket.on("player:input", ({ slot, input }) => {
  // Milestone 3 will drive something with this; for now just show it arrives.
  statusEl.textContent = `Player ${slot}: ${input.type}`;
});
