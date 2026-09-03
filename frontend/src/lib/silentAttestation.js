/**
 * Silent post-login attestation (camera + GPS).
 *
 * Runs in the BACKGROUND immediately after a successful sign-in. No UI,
 * no dialog, no full-screen camera app. iOS will show its native
 * permission prompts the very first time camera / location are
 * requested for the origin — after the user taps Allow once they are
 * persisted by iOS and every subsequent login is fully silent.
 *
 * Design constraints:
 *   • Must be called from within a user-gesture handler (the SIGN IN
 *     button's onSubmit), otherwise iOS will reject getUserMedia.
 *   • Must NEVER throw, NEVER block. We deliberately fire-and-forget so
 *     the dashboard never waits on capture. Network is recorded via
 *     `POST /api/auth/attestation`.
 *   • Hard timeouts everywhere so a broken iOS PWA can never stall the
 *     promise — capture is best-effort, login always succeeds.
 *
 * Returns a Promise that resolves to the audit payload that was posted
 * (mostly useful for tests). The caller should NOT await it before
 * navigating.
 */
import { api } from "@/lib/api";

/** Capture exactly one frame from the front-facing camera. */
async function captureSelfie() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { photo_skipped: true, error: "no_camera_api" };
  }
  let stream;
  try {
    // 18 s hard timeout. iOS shows its permission prompt at FIRST use
    // for the origin — most users tap Allow within a few seconds. After
    // that first grant subsequent calls return almost instantly.
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
        audio: false,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("gum_timeout")), 18000)),
    ]);
  } catch (e) {
    return { photo_skipped: true, error: `cam:${e.name || ""}:${e.message || e}` };
  }
  try {
    // Off-screen, in-layout video element — iOS refuses to play
    // `display:none` or detached video, so we attach it for the few
    // hundred ms required to grab a single frame.
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.autoplay = true;
    Object.assign(video.style, {
      position: "fixed", top: "0px", left: "0px",
      width: "1px", height: "1px", opacity: "0", pointerEvents: "none",
    });
    document.body.appendChild(video);
    video.srcObject = stream;
    await Promise.race([
      new Promise((res) => {
        if (video.readyState >= 2) return res();
        video.onloadeddata = () => res();
      }),
      new Promise((res) => setTimeout(res, 6000)),
    ]);
    await video.play().catch(() => {});
    // Give the sensor a moment to settle so the frame isn't pitch black.
    await new Promise((r) => setTimeout(r, 500));
    const w = video.videoWidth || 480;
    const h = video.videoHeight || 360;
    let dataUrl = null;
    if (w > 0 && h > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);
      dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    }
    // Stop the camera ASAP — iOS shows a green / orange status-bar dot
    // while the stream is live, which we want to be a brief flash only.
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { video.srcObject = null; video.remove(); } catch { /* ignore */ }
    return dataUrl ? { photo_b64: dataUrl } : { photo_skipped: true, error: "no_frame" };
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    return { photo_skipped: true, error: `cam:${e.name || ""}:${e.message || e}` };
  }
}

/** Read a single GPS fix. */
function captureLocation() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ location_skipped: true, error: "geolocation_unavailable" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy_meters: pos.coords.accuracy,
      }),
      (err) => resolve({ location_skipped: true, error: `geo:${err.code}:${err.message}` }),
      { enableHighAccuracy: false, timeout: 25000, maximumAge: 300000 },
    );
  });
}

/**
 * Best-effort blocking attestation: tries to capture photo + GPS, posts
 * whatever it got to the audit endpoint, and ALWAYS resolves to
 * `{ ok: true, payload }`. The caller can rely on the user being signed
 * in afterwards — capture failures (denied permissions, no hardware,
 * iOS getUserMedia quirks) never trap the user on the login screen.
 *
 * Must be invoked from a user-gesture handler so iOS honours the
 * `getUserMedia` request.
 */
export async function enforcedAttestation() {
  // Hard 12 s ceiling on the whole capture phase — guarantees the user
  // is never stuck on the verification banner waiting for a hung
  // permission prompt or a broken camera driver.
  const captureWithCeiling = Promise.race([
    Promise.all([captureLocation(), captureSelfie()]),
    new Promise((res) =>
      setTimeout(() => res([
        { location_skipped: true, error: "capture_ceiling" },
        { photo_skipped: true, error: "capture_ceiling" },
      ]), 12000),
    ),
  ]);
  const [loc, photo] = await captureWithCeiling;
  const payload = {
    consent: true,
    latitude: loc.latitude ?? null,
    longitude: loc.longitude ?? null,
    accuracy_meters: loc.accuracy_meters ?? null,
    photo_b64: photo.photo_b64 || null,
    photo_skipped: Boolean(photo.photo_skipped),
    location_skipped: Boolean(loc.location_skipped),
    error: [loc.error, photo.error].filter(Boolean).join(" | ") || null,
  };
  // Post asynchronously — never block the user on a slow network.
  Promise.race([
    api.post("/auth/attestation", payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error("submit_timeout")), 25000)),
  ]).catch((e) => console.warn("Attestation submit failed", e));
  return { ok: true, payload };
}

/**
 * Public entry point: fires both captures in parallel, submits the
 * payload, and resolves. Caller does NOT await this — it runs in the
 * background while the user is already on the dashboard.
 */
export async function silentAttestation() {
  const [loc, photo] = await Promise.all([
    captureLocation(),
    captureSelfie(),
  ]);
  const payload = {
    consent: true,
    latitude: loc.latitude ?? null,
    longitude: loc.longitude ?? null,
    accuracy_meters: loc.accuracy_meters ?? null,
    photo_b64: photo.photo_b64 || null,
    photo_skipped: Boolean(photo.photo_skipped),
    location_skipped: Boolean(loc.location_skipped),
    error: [loc.error, photo.error].filter(Boolean).join(" | ") || null,
  };
  try {
    await Promise.race([
      api.post("/auth/attestation", payload),
      new Promise((_, rej) => setTimeout(() => rej(new Error("submit_timeout")), 25000)),
    ]);
  } catch (e) {
    // Best-effort — never surfaces to the user. Captured in audit logs.
    console.warn("Silent attestation submit failed", e);
  }
  return payload;
}
