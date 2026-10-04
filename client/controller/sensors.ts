/** Up to ~60 Hz: the on-screen racquet mirrors the phone directly, with no smoothing. */
const TILT_INTERVAL_MS = 15;
/** If no orientation event arrives this soon after starting, the device likely has no sensor. */
const NO_DATA_TIMEOUT_MS = 2000;

type PermissionFn = () => Promise<"granted" | "denied">;
const iosPermission = (ctor: unknown): PermissionFn | undefined => {
  const fn = (ctor as { requestPermission?: PermissionFn } | undefined)?.requestPermission;
  return typeof fn === "function" ? fn.bind(ctor) : undefined;
};

/**
 * iOS gates motion sensors behind a prompt that may only be triggered from a user gesture.
 * Call this synchronously at the top of a tap handler, before any await.
 */
export function requestSensorPermission(): Promise<boolean> {
  const requests = [
    iosPermission(globalThis.DeviceOrientationEvent),
    iosPermission(globalThis.DeviceMotionEvent),
  ]
    .filter((fn): fn is PermissionFn => !!fn)
    .map((fn) => fn());
  if (requests.length === 0) return Promise.resolve(true); // Android / desktop
  return Promise.all(requests).then(
    (results) => results.every((r) => r === "granted"),
    () => false,
  );
}

export type Tilt = { alpha: number; beta: number; gamma: number; t: number };

/** Orientation events received and tilts sent, for the game's debug overlay. */
export const tiltCounts = { sensor: 0, sent: 0 };

type Angles = { alpha: number; beta: number; gamma: number };
/** Latest orientation, unthrottled (a swing reports the one at its peak). */
let orientation: Angles = { alpha: 0, beta: 90, gamma: 0 };

/** Streams throttled tilt readings. Returns a stop function. */
export function startTilt(onTilt: (tilt: Tilt) => void, onNoData: () => void): () => void {
  let lastSent = 0;
  let gotData = false;

  const handler = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    gotData = true;
    tiltCounts.sensor++;
    orientation = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma };
    const now = performance.now();
    if (now - lastSent < TILT_INTERVAL_MS) return;
    lastSent = now;
    tiltCounts.sent++;
    onTilt({ alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma, t: Date.now() });
  };

  window.addEventListener("deviceorientation", handler);
  const watchdog = setTimeout(() => gotData || onNoData(), NO_DATA_TIMEOUT_MS);

  return () => {
    clearTimeout(watchdog);
    window.removeEventListener("deviceorientation", handler);
  };
}

/** A swing is a spike in linear acceleration or rotation speed. Tuned for a brisk wrist flick. */
const SWING_ACCEL = 14; // m/s², gravity removed
const SWING_ROTATION = 350; // deg/s
const SWING_COOLDOWN_MS = 450;
/** After the threshold, keep watching this long for the swing's peak (the moment of contact). */
const PEAK_WINDOW_MS = 70;
const GRAVITY = 9.81;

export interface Swing {
  /** 0..1 from the peak strength. */
  power: number;
  /** Phone clock (Date.now) at the peak. */
  t: number;
  /** Rotation rate at the peak (deg/s): the racquet head's path. */
  rate: Angles;
  /** Orientation at the peak: the racquet face at contact. */
  orient: Angles;
}

/**
 * Calls `onSwing` once per swing, with the readings at its peak. The game rewinds to the peak's
 * timestamp, so waiting for the peak doesn't make hits late. Returns a stop function.
 */
export function startSwingDetector(onSwing: (swing: Swing) => void): () => void {
  let lastSwing = -Infinity;
  let peak: { strength: number; swing: Swing } | null = null;

  const handler = (e: DeviceMotionEvent) => {
    let accel = 0;
    const a = e.acceleration;
    const ag = e.accelerationIncludingGravity;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      accel = Math.hypot(a.x, a.y, a.z);
    } else if (ag && ag.x !== null && ag.y !== null && ag.z !== null) {
      accel = Math.abs(Math.hypot(ag.x, ag.y, ag.z) - GRAVITY); // older devices lack gravity-free data
    }
    const r = e.rotationRate;
    const rate = { alpha: r?.alpha ?? 0, beta: r?.beta ?? 0, gamma: r?.gamma ?? 0 };
    const strength = Math.max(accel / SWING_ACCEL, Math.hypot(rate.alpha, rate.beta, rate.gamma) / SWING_ROTATION);

    if (peak) {
      if (strength > peak.strength) peak = { strength, swing: { ...peak.swing, t: Date.now(), rate, orient: orientation } };
      return;
    }
    const now = performance.now();
    if (strength < 1 || now - lastSwing < SWING_COOLDOWN_MS) return;
    lastSwing = now;
    peak = { strength, swing: { power: 0, t: Date.now(), rate, orient: orientation } };
    setTimeout(() => {
      const { strength: s, swing } = peak!;
      peak = null;
      onSwing({ ...swing, power: Math.min(1, 0.35 + (s - 1) / 3) });
    }, PEAK_WINDOW_MS);
  };

  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}

let wakeLock: WakeLockSentinel | null = null;

/** Keep the phone screen on while playing. Re-acquired when the page becomes visible again. */
export async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Denied (low battery, not visible); the screen may dim but play still works.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeLock?.released) keepAwake();
});
