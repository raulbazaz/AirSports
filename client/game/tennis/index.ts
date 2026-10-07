import type { ControllerInput } from "../../../shared/protocol";
import type { DebugOverlay } from "./view/debug";
import { loadAthlete } from "./view/athlete";
import { loadSpectator } from "./view/crowd";
import type { Side } from "./match";
import { type CourtHooks, CourtView } from "./view/CourtView";

export type { CourtHooks, Side };

export interface TennisGame {
  /** Which phones are connected; the match pauses while any player's phone is away. */
  setConnected(connected: Record<Side, boolean>): void;
  /**
   * Input from `side`'s phone: tilt moves the racquet, swing hits, bounce drops a ball to start a
   * rally. `ageMs`: how long ago a swing actually happened (from the phone's synced clock).
   */
  handleInput(side: Side, input: ControllerInput, ageMs?: number): void;
  /** Performance overlay (?debug or the D key). */
  readonly debug: DebugOverlay;
  destroy(): void;
}

/**
 * `players`: 2 for a split-screen match between two phones, 1 to play the computer.
 * `audio`: created in the click that started the game (browsers only allow sound after a gesture
 * on the page; the phone's taps don't count).
 */
export async function startTennis(
  parent: HTMLElement,
  hooks: CourtHooks,
  { players, audio }: { players: 1 | 2; audio?: AudioContext },
): Promise<TennisGame> {
  // The HUD and banner text use these; wait so the first frames don't flash a fallback font.
  const fonts = Promise.all(
    ["italic 800 20px 'Barlow Semi Condensed'", "600 20px 'Barlow Semi Condensed'"].map((f) =>
      document.fonts.load(f).catch(() => undefined),
    ),
  );
  // The crowd is optional: without its model the stands get simple stand-ins.
  const [athlete, spectator] = await Promise.all([loadAthlete(), loadSpectator().catch(() => null), fonts]);

  const view = new CourtView(parent, hooks, { athlete, spectator }, audio, players === 2 ? "human" : "cpu");
  const match = view.match;

  // Lets the browser tests inspect the rally. Stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { __court: match });

  return {
    setConnected: (connected) => {
      const away = (["p1", "p2"] as const).filter((s) => !connected[s] && !match.isCpu(s));
      const who = players === 2 && away.length === 1 ? `${match.name(away[0])}'s phone` : undefined;
      view.setPaused(away.length > 0, who);
    },
    debug: view.debug,
    handleInput: (side, input, ageMs = 0) => {
      if (match.isCpu(side)) return;
      if (input.type === "tilt") {
        if (side === "p1") view.debug.tilt();
        match.setOrientation(side, input.alpha, input.beta, input.gamma);
      } else if (input.type === "swing") {
        view.playerSwing(side, input.power);
        match.swing(side, { power: input.power, tilt: input.tilt, ageMs, rate: input.rate, orient: input.orient });
      } else if (input.type === "bounce") {
        match.bounce(side);
      }
    },
    destroy: () => view.destroy(),
  };
}
