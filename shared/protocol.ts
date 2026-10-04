// Socket event contract shared by server, game screen, and phone controller.

export type PlayerSlot = 1 | 2;
/** 1 = single player vs computer. Set to 2 to enable two-player mode. */
export const MAX_PLAYERS = 1;

/** Messages a phone sends that the server relays verbatim to the game screen. */
export type ControllerInput =
  | { type: "bounce" } // drop a ball next to the player to start a rally
  /** Full phone orientation (DeviceOrientationEvent angles, degrees). */
  | { type: "tilt"; alpha: number; beta: number; gamma: number; t: number }
  | {
      type: "swing";
      power: number; // 0..1, normalized peak acceleration
      side: "forehand" | "backhand";
      tilt: number; // phone orientation at impact, degrees
      t: number; // phone clock (Date.now) at the peak of the swing
      /** Gyro rotation rate at the peak (DeviceMotionEvent.rotationRate, deg/s). */
      rate?: { alpha: number; beta: number; gamma: number };
      /** Phone orientation at the peak (DeviceOrientationEvent angles, degrees). */
      orient?: { alpha: number; beta: number; gamma: number };
    }
  /**
   * Reply to a host "ping": the phone's clock when it answered (for syncing swing timestamps) and
   * its own sensor/send rates (debug overlay).
   */
  | { type: "pong"; id: number; now: number; sensorHz: number; sentHz: number };

/** Messages the game screen sends to a specific phone. */
export type HostMessage =
  | { type: "vibrate"; ms: number }
  | { type: "state"; state: "lobby" | "calibrate" | "playing" | "paused" }
  /** Whether the phone's "Bounce ball" button should be enabled. */
  | { type: "serve"; ready: boolean }
  /** The phone answers with a "pong" input right away (clock sync and the debug round trip). */
  | { type: "ping"; id: number };

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
  /**
   * Debug overlay: acked immediately, to time the game screen ↔ server leg. Also reports how many
   * tilts the server received from the room's phone since the last ping (finds which leg drops them).
   */
  "net:ping": (ack: Ack<{ tiltsIn: number }>) => void;
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
