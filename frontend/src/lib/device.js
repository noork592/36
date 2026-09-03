/**
 * Lightweight device classification used to decide whether the login
 * attestation (photo + location) is MANDATORY (mobile / tablet) or
 * SOFT (desktop — the user still sees the prompt and clicks Allow,
 * but is not blocked if capture fails or is skipped).
 *
 * Detection rules:
 *  - Any UA matching the standard mobile/tablet token list → mobile
 *  - iPad on iPadOS 13+ which masquerades as "Macintosh" + has touch → mobile
 *  - Tablets where UA reports the word "Tablet" → mobile
 *  - Everything else (desktop browsers, headless / SSR) → desktop
 */
export function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i.test(ua)) {
    return true;
  }
  // iPad on iPadOS 13+ reports as "Macintosh" — distinguish via touch
  if (/Mac/i.test(ua) && navigator.maxTouchPoints > 1) {
    return true;
  }
  if (/Tablet|iPad/i.test(ua)) return true;
  return false;
}

/** Human-readable label, useful for logging / audit messages. */
export function deviceClass() {
  return isMobileDevice() ? "mobile" : "desktop";
}

/**
 * iOS-specific detection. iOS Safari + the iOS standalone "Add to Home
 * Screen" web-view have well-known restrictions around getUserMedia,
 * play() and permission persistence. We use these flags to soften the
 * attestation flow on iOS so users don't get stuck at the security
 * verification screen.
 */
export function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad on iPadOS 13+ masquerades as Macintosh
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (/Mac/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

/** Is the app currently running in standalone PWA mode (home-screen launch)? */
export function isStandalonePWA() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch { /* ignore */ }
  // iOS legacy flag
  return window.navigator?.standalone === true;
}

/**
 * Probe whether the current device has BOTH a front-facing camera and
 * a geolocation API available. Used to decide if login security
 * verification should be enforced or bypassed entirely.
 *
 *  - Camera: at least one `videoinput` device is enumerable. We use
 *    `enumerateDevices()` which works without prompting the user for
 *    permission (labels are empty without permission, but the device
 *    count / kind is reported).
 *  - GPS: the standard `navigator.geolocation` API exists. (Mobile
 *    browsers expose it; Windows desktops without a location provider
 *    typically don't, or the API exists but fails immediately — both
 *    cases are handled in `probeCapabilities` below.)
 *
 * Returns `{ camera: boolean, gps: boolean, both: boolean }`.
 */
export async function probeCapabilities() {
  const result = { camera: false, gps: false, both: false };
  if (typeof navigator === "undefined") return result;

  // ---- Camera probe (no user prompt) ----
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      result.camera = devices.some((d) => d.kind === "videoinput");
    }
  } catch (e) {
    console.warn("probeCapabilities: enumerateDevices failed", e);
    result.camera = false;
  }

  // ---- Geolocation probe (API surface only — actual fix happens at capture) ----
  // We can't trigger a real GPS read without the user prompt, so we use the
  // API surface as the capability signal. A desktop Chrome on a wired PC
  // exposes the API and falls back to IP-based location, which is acceptable
  // for the attestation use case. A truly geolocation-less device (e.g. old
  // Windows + Firefox stripped down) will not expose the API.
  result.gps = typeof navigator.geolocation?.getCurrentPosition === "function";

  result.both = result.camera && result.gps;
  return result;
}

