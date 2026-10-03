import type { ControllerInput } from "../../../shared/protocol";
import { type CourtHooks, CourtView } from "./view/CourtView";

export type { CourtHooks };

export interface TennisGame {
  setPlayerConnected(connected: boolean): void;
  /** Phone input: tilt moves the racquet, swing hits, bounce drops a ball to start a rally. */
  handleInput(input: ControllerInput): void;
  destroy(): void;
}

export async function startTennis(parent: HTMLElement, hooks: CourtHooks): Promise<TennisGame> {
  // The HUD and banner text use these; wait so the first frames don't flash a fallback font.
  await Promise.all(
    ["italic 800 20px 'Barlow Semi Condensed'", "600 20px 'Barlow Semi Condensed'"].map((f) =>
      document.fonts.load(f).catch(() => undefined),
    ),
  );

  const view = new CourtView(parent, hooks);
  const match = view.match;

  // Lets the browser tests inspect the rally. Stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { __court: match });

  return {
    setPlayerConnected: (connected) => view.setPaused(!connected),
    handleInput: (input) => {
      if (input.type === "tilt") match.setOrientation(input.alpha, input.beta, input.gamma);
      else if (input.type === "swing") match.swing(input.power, input.tilt);
      else if (input.type === "bounce") match.bounce();
    },
    destroy: () => view.destroy(),
  };
}
