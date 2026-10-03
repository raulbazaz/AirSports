// Socket event contract shared by server, game screen, and phone controller.

export type PlayerSlot = 1 | 2;
export const MAX_PLAYERS = 2;

/** Messages a phone sends that the server relays verbatim to the game screen. */
export type ControllerInput =
  | { type: "tilt"; beta: number; gamma: number; t: number }
  | {
      type: "swing";
      power: number; // 0..1, normalized peak acceleration
      side: "forehand" | "backhand";
      tilt: number; // phone orientation at impact, degrees
      t: number; // phone timestamp (ms)
    };

/** Messages the game screen sends to a specific phone. */
export type HostMessage =
  | { type: "vibrate"; ms: number }
  | { type: "state"; state: "lobby" | "calibrate" | "playing" | "paused" };

export type JoinError = "ROOM_NOT_FOUND" | "ROOM_FULL";

export type Ack<T> = (res: T) => void;

export type CreateRoomResult = { code: string; hostToken: string };
export type RejoinHostResult =
  | { ok: true; code: string; players: PlayerSlot[] }
  | { ok: false; error: "ROOM_NOT_FOUND" | "BAD_TOKEN" };
export type JoinResult =
  | { ok: true; code: string; slot: PlayerSlot; playerToken: string }
  | { ok: false; error: JoinError };

export interface ClientToServerEvents {
  // game screen
  "host:create": (ack: Ack<CreateRoomResult>) => void;
  "host:rejoin": (req: { code: string; hostToken: string }, ack: Ack<RejoinHostResult>) => void;
  "host:send": (req: { slot: PlayerSlot; msg: HostMessage }) => void;
  // phone
  "controller:join": (req: { code: string; playerToken?: string }, ack: Ack<JoinResult>) => void;
  "controller:input": (input: ControllerInput) => void;
}

export interface ServerToClientEvents {
  // to game screen
  "player:joined": (p: { slot: PlayerSlot; reconnected: boolean }) => void;
  "player:left": (p: { slot: PlayerSlot }) => void;
  "player:input": (p: { slot: PlayerSlot; input: ControllerInput }) => void;
  // to phone
  "host:message": (msg: HostMessage) => void;
  "host:status": (p: { connected: boolean }) => void;
  "room:closed": () => void;
}
