import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connectSocket(): GameSocket {
  return io({ transports: ["websocket"] });
}
