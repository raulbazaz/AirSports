import { randomBytes, randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import {
  MAX_PLAYERS,
  type ClientToServerEvents,
  type PlayerSlot,
  type ServerToClientEvents,
} from "../shared/protocol.js";

type SocketData = { role?: "host" | "controller"; code?: string; slot?: PlayerSlot };
type IO = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

/** How long a disconnected phone keeps its slot. */
const PLAYER_GRACE_MS = 60_000;
/** How long a room survives without its game screen. */
const HOST_GRACE_MS = 30_000;

// No I/O/0/1 so codes are easy to read off a TV.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 4;

interface PlayerSeat {
  token: string;
  socketId: string | null;
  graceTimer?: NodeJS.Timeout;
}

interface Room {
  code: string;
  hostToken: string;
  hostSocketId: string | null;
  hostGraceTimer?: NodeJS.Timeout;
  seats: Map<PlayerSlot, PlayerSeat>;
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(private io: IO) {}

  get roomCount() {
    return this.rooms.size;
  }

  attach(socket: IOSocket) {
    socket.on("host:create", (ack) => {
      this.leaveCurrent(socket);
      const room: Room = {
        code: this.newCode(),
        hostToken: randomUUID(),
        hostSocketId: socket.id,
        seats: new Map(),
      };
      this.rooms.set(room.code, room);
      socket.data = { role: "host", code: room.code };
      ack({ code: room.code, hostToken: room.hostToken });
    });

    socket.on("host:rejoin", (req, ack) => {
      const room = this.rooms.get(normalize(req?.code));
      if (!room) return ack({ ok: false, error: "ROOM_NOT_FOUND" });
      if (room.hostToken !== req.hostToken) return ack({ ok: false, error: "BAD_TOKEN" });
      this.leaveCurrent(socket);
      clearTimeout(room.hostGraceTimer);
      room.hostSocketId = socket.id;
      socket.data = { role: "host", code: room.code };
      this.io.to(playersChannel(room.code)).emit("host:status", { connected: true });
      ack({ ok: true, code: room.code, players: this.connectedSlots(room) });
    });

    socket.on("host:send", ({ slot, msg }) => {
      const room = this.hostRoom(socket);
      const seat = room?.seats.get(slot);
      if (seat?.socketId) this.io.to(seat.socketId).emit("host:message", msg);
    });

    socket.on("controller:join", (req, ack) => {
      const room = this.rooms.get(normalize(req?.code));
      if (!room) return ack({ ok: false, error: "ROOM_NOT_FOUND" });

      // Reclaim a held seat if the phone presents its token.
      let slot = req.playerToken ? this.slotForToken(room, req.playerToken) : undefined;
      const reconnected = slot !== undefined;
      if (slot === undefined) slot = this.freeSlot(room);
      if (slot === undefined) return ack({ ok: false, error: "ROOM_FULL" });

      this.leaveCurrent(socket);
      const existing = room.seats.get(slot);
      if (existing?.socketId && existing.socketId !== socket.id) {
        // Same token, new socket (e.g. page reload before the old socket timed out).
        this.io.sockets.sockets.get(existing.socketId)?.disconnect(true);
      }
      clearTimeout(existing?.graceTimer);
      const seat: PlayerSeat = { token: existing?.token ?? randomUUID(), socketId: socket.id };
      room.seats.set(slot, seat);

      socket.data = { role: "controller", code: room.code, slot };
      socket.join(playersChannel(room.code));
      if (room.hostSocketId) {
        this.io.to(room.hostSocketId).emit("player:joined", { slot, reconnected });
      }
      ack({ ok: true, code: room.code, slot, playerToken: seat.token });
      socket.emit("host:status", { connected: room.hostSocketId !== null });
    });

    socket.on("controller:input", (input) => {
      const { role, code, slot } = socket.data;
      if (role !== "controller" || !code || !slot) return;
      const room = this.rooms.get(code);
      if (!room?.hostSocketId) return;
      const host = this.io.to(room.hostSocketId);
      // Tilt is a stream: drop stale frames rather than queue them. Everything else must arrive.
      (input.type === "tilt" ? host.volatile : host).emit("player:input", { slot, input });
    });

    socket.on("disconnect", () => this.leaveCurrent(socket));
  }

  /** Detach a socket from whatever room it belongs to, starting grace timers. */
  private leaveCurrent(socket: IOSocket) {
    const { role, code, slot } = socket.data ?? {};
    socket.data = {};
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;

    if (role === "host" && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      this.io.to(playersChannel(code)).emit("host:status", { connected: false });
      room.hostGraceTimer = setTimeout(() => this.closeRoom(code), HOST_GRACE_MS);
    }

    if (role === "controller" && slot) {
      socket.leave(playersChannel(code));
      const seat = room.seats.get(slot);
      if (seat?.socketId !== socket.id) return;
      seat.socketId = null;
      if (room.hostSocketId) this.io.to(room.hostSocketId).emit("player:left", { slot });
      seat.graceTimer = setTimeout(() => room.seats.delete(slot), PLAYER_GRACE_MS);
    }
  }

  private closeRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    clearTimeout(room.hostGraceTimer);
    for (const seat of room.seats.values()) clearTimeout(seat.graceTimer);
    this.io.to(playersChannel(code)).emit("room:closed");
    this.io.in(playersChannel(code)).socketsLeave(playersChannel(code));
    this.rooms.delete(code);
  }

  private hostRoom(socket: IOSocket) {
    const { role, code } = socket.data;
    if (role !== "host" || !code) return undefined;
    const room = this.rooms.get(code);
    return room?.hostSocketId === socket.id ? room : undefined;
  }

  private slotForToken(room: Room, token: string): PlayerSlot | undefined {
    for (const [slot, seat] of room.seats) if (seat.token === token) return slot;
    return undefined;
  }

  private freeSlot(room: Room): PlayerSlot | undefined {
    for (let s = 1; s <= MAX_PLAYERS; s++) {
      if (!room.seats.has(s as PlayerSlot)) return s as PlayerSlot;
    }
    return undefined;
  }

  private connectedSlots(room: Room): PlayerSlot[] {
    return [...room.seats].filter(([, seat]) => seat.socketId).map(([slot]) => slot);
  }

  private newCode(): string {
    for (;;) {
      const bytes = randomBytes(CODE_LENGTH);
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      if (!this.rooms.has(code)) return code;
    }
  }
}

function playersChannel(code: string) {
  return `players:${code}`;
}

function normalize(code: unknown) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}
