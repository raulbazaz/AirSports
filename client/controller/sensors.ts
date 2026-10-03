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

/** Streams throttled tilt readings. Returns a stop function. */
export function startTilt(onTilt: (tilt: Tilt) => void, onNoData: () => void): () => void {
  let lastSent = 0;
  let gotData = false;

  const handler = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    gotData = true;
    const now = performance.now();
    if (now - lastSent < TILT_INTERVAL_MS) return;
    lastSent = now;
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
const GRAVITY = 9.81;

/** Calls `onSwing(power 0..1)` once per swing. Returns a stop function. */
export function startSwingDetector(onSwing: (power: number) => void): () => void {
  let lastSwing = 0;

  const handler = (e: DeviceMotionEvent) => {
    const now = performance.now();
    if (now - lastSwing < SWING_COOLDOWN_MS) return;

    let accel = 0;
    const a = e.acceleration;
    const ag = e.accelerationIncludingGravity;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      accel = Math.hypot(a.x, a.y, a.z);
    } else if (ag && ag.x !== null && ag.y !== null && ag.z !== null) {
      accel = Math.abs(Math.hypot(ag.x, ag.y, ag.z) - GRAVITY); // older devices lack gravity-free data
    }
    const r = e.rotationRate;
    const rotation = r ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : 0;

    // Fire on the threshold crossing rather than the peak: timing matters more than exact power.
    const strength = Math.max(accel / SWING_ACCEL, rotation / SWING_ROTATION);
    if (strength < 1) return;
    lastSwing = now;
    onSwing(Math.min(1, 0.35 + (strength - 1) / 3));
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
