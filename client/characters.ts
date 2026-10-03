// Procedural cartoon tennis players, drawn as SVG so the lobby, phone, and Phaser game
// share one look with zero image assets. Body drawn around x=60 in a 148x200 box; feet at y=196.

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  shorts: string;
  racquet: string;
  hairStyle: "short" | "buzz";
}

export const PLAYER_LOOK: Look = {
  skin: "#f6d3b3",
  hair: "#7a4a26",
  shirt: "#2f7de1",
  shorts: "#ffffff",
  racquet: "#2f7de1",
  hairStyle: "short",
};

export const CPU_LOOK: Look = {
  skin: "#a8694a",
  hair: "#2b1d16",
  shirt: "#f08a24",
  shorts: "#ffffff",
  racquet: "#e5532d",
  hairStyle: "buzz",
};

export type View = "front" | "back";

function hair(look: Look, view: View) {
  if (view === "back") {
    return look.hairStyle === "buzz"
      ? `<path d="M31 44 Q31 13 60 13 Q89 13 89 44 Q89 56 82 60 L38 60 Q31 56 31 44Z" fill="${look.hair}" opacity="0.85"/>`
      : `<path d="M29 46 Q28 10 60 10 Q92 10 91 46 Q91 62 80 66 L40 66 Q29 62 29 46Z" fill="${look.hair}"/>`;
  }
  return look.hairStyle === "buzz"
    ? `<path d="M32 36 Q35 13 60 12 Q85 13 88 36 Q76 24 60 24 Q44 24 32 36Z" fill="${look.hair}" opacity="0.85"/>`
    : `<path d="M29 44 Q26 9 60 9 Q94 9 91 44 Q88 30 78 26 Q70 34 52 30 Q40 28 33 34 Q30 38 29 44Z" fill="${look.hair}"/>`;
}

function face() {
  return `
    <ellipse cx="49" cy="44" rx="3.4" ry="4.6" fill="#222"/>
    <ellipse cx="71" cy="44" rx="3.4" ry="4.6" fill="#222"/>
    <circle cx="50.2" cy="42.4" r="1.2" fill="#fff"/>
    <circle cx="72.2" cy="42.4" r="1.2" fill="#fff"/>
    <path d="M43 35 q6 -4 12 -1 M65 34 q6 -3 12 1" stroke="#3a2a20" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M60 47 q-2.5 5 0.5 7" stroke="#00000033" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M52 58 q8 7 16 0" stroke="#8a3b2b" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <circle cx="42" cy="53" r="4.5" fill="#ff7a7a" opacity="0.18"/>
    <circle cx="78" cy="53" r="4.5" fill="#ff7a7a" opacity="0.18"/>`;
}

function head(look: Look, view: View) {
  return `
    <rect x="53" y="62" width="14" height="14" rx="5" fill="${look.skin}"/>
    <circle cx="30" cy="46" r="6" fill="${look.skin}"/>
    <circle cx="90" cy="46" r="6" fill="${look.skin}"/>
    <circle cx="60" cy="42" r="30" fill="${look.skin}"/>
    ${view === "front" ? face() : ""}
    ${hair(look, view)}`;
}

function racquet(look: Look, side: "left" | "right") {
  // Drawn for the viewer's left hand; mirrored for the right.
  const g = `
    <line x1="28" y1="122" x2="17" y2="100" stroke="#333" stroke-width="4.5" stroke-linecap="round"/>
    <g transform="rotate(-24 10 80)">
      <ellipse cx="10" cy="80" rx="12" ry="17" fill="#ffffff55" stroke="${look.racquet}" stroke-width="4"/>
      <path d="M4 68 v24 M10 64 v32 M16 68 v24 M0 76 h20 M-1 84 h22" stroke="#ffffffaa" stroke-width="0.8"/>
    </g>`;
  return side === "left" ? g : `<g transform="translate(120 0) scale(-1 1)">${g}</g>`;
}

/**
 * Full-body character. Front = facing the camera (far player); back = seen from behind (near player).
 */
export function characterSvg(look: Look, view: View, px?: { width: number; height: number }) {
  const size = px ? `width="${px.width}" height="${px.height}"` : "";
  const hand = view === "front" ? "left" : "right";
  const arm = (side: "left" | "right") => {
    const s = side === "left" ? -1 : 1;
    const x = (v: number) => 60 + s * v;
    return `
    <line x1="${x(24)}" y1="84" x2="${x(32)}" y2="118" stroke="${look.skin}" stroke-width="11" stroke-linecap="round"/>
    <line x1="${x(23)}" y1="84" x2="${x(26)}" y2="96" stroke="${look.shirt}" stroke-width="13" stroke-linecap="round"/>`;
  };
  const other = hand === "left" ? "right" : "left";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 0 148 200" ${size}>
    <rect x="47" y="146" width="10" height="40" rx="5" fill="${look.skin}"/>
    <rect x="63" y="146" width="10" height="40" rx="5" fill="${look.skin}"/>
    <ellipse cx="51" cy="189" rx="9" ry="6" fill="#fff" stroke="#c9c9c9" stroke-width="1.5"/>
    <ellipse cx="69" cy="189" rx="9" ry="6" fill="#fff" stroke="#c9c9c9" stroke-width="1.5"/>
    <rect x="42" y="124" width="36" height="26" rx="7" fill="${look.shorts}" stroke="#d6d6d6" stroke-width="1.5"/>
    ${arm(other)}
    ${arm(hand)}
    <rect x="38" y="74" width="44" height="58" rx="16" fill="${look.shirt}"/>
    <path d="M52 75 L60 86 L68 75" stroke="#ffffff" stroke-width="3" fill="none" stroke-linejoin="round" opacity="${view === "front" ? 0.9 : 0}"/>
    ${racquet(look, hand)}
    <circle cx="${hand === "left" ? 28 : 92}" cy="120" r="6.5" fill="${look.skin}"/>
    <circle cx="${hand === "left" ? 92 : 28}" cy="120" r="6.5" fill="${look.skin}"/>
    ${head(look, view)}
  </svg>`;
}

/** Head-and-shoulders portrait for name tags and the scoreboard. */
export function faceSvg(look: Look, px?: number) {
  const size = px ? `width="${px}" height="${px}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="22 6 76 76" ${size}>
    <rect x="22" y="6" width="76" height="76" fill="#dff1ff"/>
    <rect x="34" y="74" width="52" height="20" rx="12" fill="${look.shirt}"/>
    ${head(look, "front")}
  </svg>`;
}

export function svgToDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
