import React, { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ShieldCheck, MapPin, Camera, X, AlertTriangle, LogOut, Smartphone } from "lucide-react";
import { isIOS, isStandalonePWA } from "@/lib/device";

/**
 * Post-login security verification.
 *
 * Two modes:
 *  - SOFT (enforced=false, desktop): user must still click Allow or Skip.
 *    If capture fails or user skips, login still proceeds. The event is
 *    recorded with consent=false so admins can see who skipped.
 *  - ENFORCED (enforced=true, mobile/tablet): capture is mandatory.
 *    If either the photo or location can't be captured (permission
 *    denied, hardware missing, user cancels), the user is signed out
 *    and shown an instructive error. They cannot reach the dashboard
 *    without a successful capture.
 *
 * Props:
 *   open       — show the dialog
 *   enforced   — true on mobile / tablet
 *   onDone     — called with ({allowed, signOut}) when the user has
 *                either succeeded ({allowed:true}) or hard-cancelled
 *                ({allowed:false, signOut:true}). On desktop "Skip"
 *                the parent gets ({allowed:false, signOut:false}) and
 *                should navigate to the dashboard.
 */
export default function LoginAttestationDialog({ open, enforced = false, onDone }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState("ask"); // ask | capturing | error
  const [msg, setMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [pendingLocation, setPendingLocation] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // Native file input used as the photo source on iOS (where
  // getUserMedia in standalone PWAs is unreliable). The `capture="user"`
  // attribute tells iOS to open the front-facing camera directly.
  const fileInputRef = useRef(null);

  /** iOS / iOS-standalone PWA must use the native camera picker — its
   *  getUserMedia silently hangs in many iOS versions. Everywhere else
   *  the in-page video capture is faster and avoids a context switch. */
  const useNativeCameraPicker = isIOS() || isStandalonePWA();

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      try { s.getTracks().forEach((t) => t.stop()); } catch (e) { console.warn(e); }
      streamRef.current = null;
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  // Reset internal state every time the dialog re-opens (so user can retry).
  useEffect(() => {
    if (open) {
      setPhase("ask");
      setErrMsg("");
      setMsg("");
    }
  }, [open]);

  /**
   * Safety net: ONLY fires after a generous 90 s of no progress so iOS
   * permission prompts (which are user-paced and can easily take 20-30 s
   * combined for camera + location) never get prematurely killed. If the
   * user genuinely needs to escape they can use the always-visible Cancel
   * button below.
   */
  useEffect(() => {
    if (phase !== "capturing") return;
    const t = setTimeout(() => {
      setPhase("error");
      setErrMsg("Verification timed out. Tap Retry or sign out.");
    }, 90000);
    return () => clearTimeout(t);
  }, [phase]);

  /** Best-effort POST — never throws, never hangs (20 s hard timeout). */
  const submitRecord = async (payload) => {
    try {
      await Promise.race([
        api.post("/auth/attestation", payload),
        new Promise((_, rej) => setTimeout(() => rej(new Error("submit_timeout")), 20000)),
      ]);
    } catch (e) {
      console.warn("Login attestation submit failed", e);
    }
  };

  const captureLocation = () =>
    new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        resolve({ location_skipped: true, error: "geolocation_unavailable" });
        return;
      }
      // 60 s native timeout. iOS shows a permission prompt that the user
      // reads at their own pace; 5 s is far too short to even tap "Allow".
      // The outer dialog safety net (90 s) plus the manual Cancel button
      // handle truly broken hardware.
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_meters: pos.coords.accuracy,
        }),
        (err) => resolve({
          location_skipped: true,
          error: `geo:${err.code}:${err.message}`,
        }),
        { enableHighAccuracy: false, timeout: 60000, maximumAge: 300000 },
      );
    });

  const capturePhoto = async () => {
    // iOS Safari exposes `mediaDevices` only inside http(s) + after a
    // direct user gesture. Guard tightly so we never reach an unhandled
    // exception that leaves the user stuck at "Capturing…".
    if (!navigator.mediaDevices?.getUserMedia) {
      return { photo_skipped: true, error: "no_camera_api" };
    }
    let stream;
    try {
      // NO Promise.race timeout here — iOS shows a native permission
      // prompt and the user may take 10-20 s to read & tap "Allow". A
      // timer would race the user and abort their tap, producing the
      // "timeout, please re-authorise" loop. The dialog's outer 90 s
      // safety-net + manual Cancel button handle truly-broken devices.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
        audio: false,
      });
    } catch (e) {
      return { photo_skipped: true, error: `cam:${e.name || ""}:${e.message || e}` };
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stopStream();
      return { photo_skipped: true, error: "no_video_el" };
    }
    try {
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      // Wait for the first frame — iOS may need a moment after permission
      // is granted before metadata is available.
      await Promise.race([
        new Promise((res) => {
          if (video.readyState >= 2) return res();
          video.onloadeddata = () => res();
        }),
        new Promise((res) => setTimeout(res, 6000)),
      ]);
      await video.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const w = video.videoWidth || 480;
      const h = video.videoHeight || 360;
      if (w === 0 || h === 0) {
        stopStream();
        return { photo_skipped: true, error: "video_no_frame" };
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      stopStream();
      return { photo_b64: dataUrl };
    } catch (e) {
      stopStream();
      return { photo_skipped: true, error: `cam:${e.name || ""}:${e.message || e}` };
    }
  };

  /**
   * Convert a File / Blob to a downsized JPEG data URL (max 640px on
   * the longest side) so we never upload a 4-MB iPhone selfie.
   */
  const fileToDataUrl = (file) =>
    new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            try {
              const maxDim = 640;
              let w = img.naturalWidth || img.width || 480;
              let h = img.naturalHeight || img.height || 360;
              const scale = Math.min(1, maxDim / Math.max(w, h));
              w = Math.round(w * scale);
              h = Math.round(h * scale);
              const canvas = document.createElement("canvas");
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, w, h);
              resolve(canvas.toDataURL("image/jpeg", 0.6));
            } catch (e) {
              resolve(reader.result); // fall back to original data URL
            }
          };
          img.onerror = () => resolve(reader.result);
          img.src = reader.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      } catch (e) { resolve(null); }
    });

  /** iOS native camera flow — triggers the OS camera UI. */
  const handleAllowIOS = () => {
    setErrMsg("");
    setMsg(t("attestation.capturingPhoto"));
    // Trigger geolocation BEFORE opening the camera so iOS can chain the
    // two permission prompts together; the result waits in state.
    captureLocation().then((loc) => setPendingLocation(loc));
    // Native camera UI takes over here. The user snaps a photo, returns
    // to the PWA, and `onChange` fires on the input — we then submit.
    try {
      fileInputRef.current?.click();
    } catch (e) {
      setPhase("error");
      setErrMsg(`${t("attestation.errEnforced")} ${t("attestation.errPhoto")}`);
    }
  };

  const onNativePhotoSelected = async (event) => {
    const file = event.target?.files?.[0];
    // Reset the input so the same photo can be retaken later.
    try { event.target.value = ""; } catch { /* ignore */ }
    if (!file) {
      // User cancelled the camera picker — stay in ask state, no error.
      setPhase("ask");
      setMsg("");
      return;
    }
    setPhase("capturing");
    setMsg(t("attestation.capturingPhoto"));
    const dataUrl = await fileToDataUrl(file);
    // Pick up whatever location result is ready (or wait a moment).
    let loc = pendingLocation;
    if (!loc) {
      // Give geolocation up to 8 s to settle after the photo capture.
      loc = await Promise.race([
        captureLocation(),
        new Promise((res) => setTimeout(() => res({ location_skipped: true, error: "geo_post_photo_timeout" }), 8000)),
      ]);
    }
    setPendingLocation(null);

    const payload = {
      consent: true,
      latitude: loc?.latitude ?? null,
      longitude: loc?.longitude ?? null,
      accuracy_meters: loc?.accuracy_meters ?? null,
      photo_b64: dataUrl || null,
      photo_skipped: !dataUrl,
      location_skipped: Boolean(loc?.location_skipped),
      error: [loc?.error].filter(Boolean).join(" | ") || null,
    };

    if (enforced && !payload.photo_b64) {
      await submitRecord({ ...payload, consent: false });
      setPhase("error");
      setErrMsg(`${t("attestation.errEnforced")} ${t("attestation.errPhoto")}`);
      return;
    }
    await submitRecord(payload);
    onDone?.({ allowed: true, signOut: false });
  };

  const handleAllow = async () => {
    // iOS / iOS-standalone PWAs: use the native camera picker, which
    // works reliably where getUserMedia historically hangs.
    if (useNativeCameraPicker) {
      handleAllowIOS();
      return;
    }
    // Android / desktop path — in-page video capture.
    setPhase("capturing");
    setErrMsg("");
    setMsg(t("attestation.capturing"));
    const loc = await captureLocation();
    setMsg(t("attestation.capturingPhoto"));
    const photo = await capturePhoto();

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

    // ----- Enforced mode: PHOTO is mandatory (it's the identity proof).
    // Location is best-effort: captured when the user grants it, but missing
    // location alone never blocks sign-in (GPS often fails indoors / on
    // browsers without geolocation hardware). -----
    if (enforced) {
      const missingPhoto = !payload.photo_b64;
      if (missingPhoto) {
        // Record the failed-photo attempt so admins can see who tried
        await submitRecord({ ...payload, consent: false });
        setPhase("error");
        setErrMsg(`${t("attestation.errEnforced")} ${t("attestation.errPhoto")}`);
        return;
      }
    }

    await submitRecord(payload);
    stopStream();
    onDone?.({ allowed: true, signOut: false });
  };

  const handleSkip = async () => {
    // Soft mode only — record + proceed
    setPhase("capturing");
    await submitRecord({
      consent: false,
      photo_skipped: true,
      location_skipped: true,
      error: "user_skipped",
    });
    stopStream();
    onDone?.({ allowed: false, signOut: false });
  };

  const handleSignOut = () => {
    stopStream();
    onDone?.({ allowed: false, signOut: true });
  };

  const handleRetry = () => {
    setPhase("ask");
    setErrMsg("");
  };

  if (!open) return null;

  const inProgress = phase === "capturing";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/70 px-4" data-testid="attestation-dialog">
      <div className="bg-white rounded-md w-full max-w-md shadow-2xl border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-[#E65100]/10 text-[#E65100] flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="font-heading font-extrabold text-slate-900 text-base leading-none">{t("attestation.title")}</h2>
            <p className="text-[11px] text-slate-500 mt-1">{t("attestation.subtitle")}</p>
          </div>
          {enforced && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-800 rounded-sm text-[10px] font-bold uppercase tracking-wider" data-testid="attestation-required-badge">
              <Smartphone className="w-3 h-3" /> {t("attestation.requiredBadge")}
            </span>
          )}
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-700 leading-relaxed">
            {enforced ? t("attestation.noticeEnforced") : t("attestation.notice")}
          </p>

          <ul className="text-xs text-slate-600 space-y-1.5">
            <li className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-slate-400" /> {t("attestation.bulletLocation")}</li>
            <li className="flex items-center gap-2"><Camera className="w-3.5 h-3.5 text-slate-400" /> {t("attestation.bulletPhoto")}</li>
            <li className="flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5 text-slate-400" /> {t("attestation.bulletAdminOnly")}</li>
          </ul>

          {/*
            iOS native camera picker. Hidden visually but click-triggerable
            from a user-gesture handler (handleAllow → handleAllowIOS).
            `capture="user"` opens the front-facing camera directly.
           */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="user"
            onChange={onNativePhotoSelected}
            data-testid="attestation-native-camera-input"
            style={{ position: "fixed", top: 0, left: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          />

          {/*
            Off-screen video element used only by the Android/desktop
            getUserMedia path. We CANNOT use `display:none` or `hidden`:
            iOS Safari refuses to play a video element that is not in the
            layout. The 1×1 px absolute placement keeps it invisible while
            remaining playable.
           */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />

          {phase === "capturing" && (
            <div className="text-xs text-slate-700 bg-amber-50 border border-amber-200 rounded-sm px-3 py-2 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <div>
                <div className="font-bold text-slate-800">
                  {msg || t("attestation.capturing")}
                </div>
                <div className="mt-1 text-[11px] text-slate-600 leading-relaxed">
                  {useNativeCameraPicker
                    ? "Your iPhone camera app is opening. Snap a quick selfie and tap Use Photo — you'll be returned here automatically."
                    : "Your phone may show \u201CAllow Camera\u201D and then \u201CAllow Location\u201D. Tap Allow on each — take your time, this screen will wait."}
                </div>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="text-xs bg-red-50 border border-red-200 text-red-800 rounded-sm px-3 py-2 flex items-start gap-2" data-testid="attestation-error">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">{t("attestation.blockedTitle")}</div>
                <div className="mt-1 leading-relaxed">{errMsg}</div>
                <div className="mt-2 text-[11px] text-red-700">{t("attestation.howToFix")}</div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex flex-wrap justify-end gap-2">
          {phase === "capturing" ? (
            // During capture, only show a clear "Cancel & sign out" so
            // the user has a manual escape if iOS permission prompts
            // misbehave. We deliberately do NOT show a "Retry" here —
            // the capture is in progress and the user should let it
            // finish or cancel.
            <Button
              variant="outline"
              onClick={handleSignOut}
              data-testid="attestation-cancel"
              className="rounded-sm h-10"
            >
              <LogOut className="w-4 h-4 mr-1" /> {t("attestation.cancel") || "Cancel & sign out"}
            </Button>
          ) : phase === "error" ? (
            <>
              <Button
                variant="outline"
                onClick={handleSignOut}
                data-testid="attestation-signout"
                className="rounded-sm h-10"
              >
                <LogOut className="w-4 h-4 mr-1" /> {t("attestation.signOut")}
              </Button>
              <Button
                onClick={handleRetry}
                data-testid="attestation-retry"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 font-bold"
              >
                <ShieldCheck className="w-4 h-4 mr-1" /> {t("attestation.retry")}
              </Button>
            </>
          ) : enforced ? (
            <>
              <Button
                variant="outline"
                onClick={handleSignOut}
                disabled={inProgress}
                data-testid="attestation-signout"
                className="rounded-sm h-10"
              >
                <LogOut className="w-4 h-4 mr-1" /> {t("attestation.signOut")}
              </Button>
              <Button
                onClick={handleAllow}
                disabled={inProgress}
                data-testid="attestation-allow"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 font-bold"
              >
                <ShieldCheck className="w-4 h-4 mr-1" /> {t("attestation.allow")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={handleSkip}
                disabled={inProgress}
                data-testid="attestation-skip"
                className="rounded-sm h-10"
              >
                <X className="w-4 h-4 mr-1" /> {t("attestation.skip")}
              </Button>
              <Button
                onClick={handleAllow}
                disabled={inProgress}
                data-testid="attestation-allow"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 font-bold"
              >
                <ShieldCheck className="w-4 h-4 mr-1" /> {t("attestation.allow")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
