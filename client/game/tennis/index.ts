import type { ControllerInput } from "../../../shared/protocol";
import type { DebugOverlay } from "./view/debug";
import { loadAthlete } from "./view/athlete";
import { type CourtHooks, CourtView } from "./view/CourtView";

export type { CourtHooks };

export interface TennisGame {
  setPlayerConnected(connected: boolean): void;
  /**
   * Phone input: tilt moves the racquet, swing hits, bounce drops a ball to start a rally.
   * `ageMs`: how long ago a swing actually happened (from the phone's synced clock).
   */
  handleInput(input: ControllerInput, ageMs?: number): void;
  /** Performance overlay (?debug or the D key). */
  readonly debug: DebugOverlay;
  destroy(): void;
}

/**
 * `audio`: created in the click that started the game (browsers only allow sound after a gesture
 * on the page; the phone's taps don't count).
 */
export async function startTennis(parent: HTMLElement, hooks: CourtHooks, audio?: AudioContext): Promise<TennisGame> {
  // The HUD and banner text use these; wait so the first frames don't flash a fallback font.
  const fonts = Promise.all(
    ["italic 800 20px 'Barlow Semi Condensed'", "600 20px 'Barlow Semi Condensed'"].map((f) =>
      document.fonts.load(f).catch(() => undefined),
    ),
  );
  const [athlete] = await Promise.all([loadAthlete(), fonts]);

  const view = new CourtView(parent, hooks, athlete, audio);
  const match = view.match;

  // Lets the browser tests inspect the rally. Stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { __court: match });

  return {
    setPlayerConnected: (connected) => view.setPaused(!connected),
    debug: view.debug,
    handleInput: (input, ageMs = 0) => {
      if (input.type === "tilt") {
        view.debug.tilt();
        match.setOrientation(input.alpha, input.beta, input.gamma);
      } else if (input.type === "swing") {
        view.playerSwing(input.power);
        match.swing({ power: input.power, tilt: input.tilt, ageMs, rate: input.rate, orient: input.orient });
      } else if (input.type === "bounce") {
        match.bounce();
      }
    },
    destroy: () => view.destroy(),
  };
}
