// Phone orientation → racquet orientation in court space.
//
// DeviceOrientationEvent angles define R = Rz(alpha)·Rx(beta)·Ry(gamma), mapping phone axes into an
// earth frame (x east, y north, z up). The phone's own axes are: x = screen right, y = top edge,
// z = out of the screen. Held like a racquet handle, the top edge is the racquet's shaft and the
// screen right edge spans the strings.
//
// Alpha's zero is arbitrary (and drifts on some phones), so "toward the TV" is calibrated: we take
// the phone's heading at a moment when the player is known to face the screen.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface PhoneAxes {
  right: V3; // phone x
  top: V3; // phone y
  out: V3; // phone z (screen normal)
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Phone axes in the earth frame (x east, y north, z up). */
export function phoneAxes(alpha: number, beta: number, gamma: number): PhoneAxes {
  const [cA, sA] = [Math.cos(rad(alpha)), Math.sin(rad(alpha))];
  const [cB, sB] = [Math.cos(rad(beta)), Math.sin(rad(beta))];
  const [cG, sG] = [Math.cos(rad(gamma)), Math.sin(rad(gamma))];
  return {
    right: { x: cA * cG - sA * sB * sG, y: cG * sA + cA * sB * sG, z: -cB * sG },
    top: { x: -cB * sA, y: cA * cB, z: sB },
    out: { x: cA * sG + cG * sA * sB, y: sA * sG - cA * cG * sB, z: cB * cG },
  };
}

/**
 * Heading (radians from north) the player faces, assuming they hold the phone in front of them.
 * Upright with the screen toward them, the back of the phone points at the TV; lying flat, the top
 * edge does. Summing both covers every grip in between.
 */
export function facingHeading(a: PhoneAxes): number {
  return Math.atan2(a.top.x - a.out.x, a.top.y - a.out.y);
}

/** Earth vector → court space (x right, y up, z toward the far end), given the TV heading. */
export function toCourt(v: V3, heading: number): V3 {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return { x: v.x * c - v.y * s, y: v.z, z: v.x * s + v.y * c };
}
