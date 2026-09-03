import React, { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { ShieldCheck, AlertTriangle, Heart, Smile, Clock, Bookmark, Star, MessageCircle } from "lucide-react";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { enforcedAttestation, silentAttestation } from "@/lib/silentAttestation";
import { probeCapabilities, isMobileDevice } from "@/lib/device";

// Login palette
const BLUE = "#1877F2";
const BLUE_HOVER = "#166FE5";

export default function Login() {
  const { login, verifyOtp, user } = useAuth();
  const { t } = useTranslation();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // `verifying` flips on during the blocking attestation so we can show
  // a calm progress banner instead of a spinning button forever.
  const [verifying, setVerifying] = useState(false);
  // `caps` = result of capability probe. While null we treat the device
  // as not-yet-classified and the submit handler re-probes on demand.
  const [caps, setCaps] = useState(null);
  // ── Admin email OTP (second step) ──────────────────────────────
  const [otpStep, setOtpStep] = useState(false);
  const [challengeId, setChallengeId] = useState(null);
  const [sentTo, setSentTo] = useState(null);
  const [otpCode, setOtpCode] = useState("");
  // Cooldown (seconds) before "Resend code" is available again.
  const [resendIn, setResendIn] = useState(0);
  const [resending, setResending] = useState(false);

  // Tick the resend cooldown down to zero.
  React.useEffect(() => {
    if (resendIn <= 0) return;
    const id = setInterval(() => setResendIn((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  React.useEffect(() => {
    let alive = true;
    probeCapabilities().then((c) => { if (alive) setCaps(c); });
    return () => { alive = false; };
  }, []);

  React.useEffect(() => {
    // Only auto-route when we're NOT in the middle of a blocking
    // attestation — the verification flow handles its own navigation.
    if (user && !verifying) nav("/");
  }, [user, nav, verifying]);

  // Post-authentication attestation + navigation. Shared by the password
  // step (non-admin) and the OTP step (admin) so both behave identically.
  const finishLogin = async () => {
    const probed = caps || (await probeCapabilities());
    const mobile = isMobileDevice();
    if (mobile && probed?.camera && probed?.gps) {
      setVerifying(true);
      toast.success(t("login.loggedIn"));
      await enforcedAttestation();
      nav("/");
      return;
    }
    try { silentAttestation(); } catch (_) { /* ignore */ }
    toast.success(t("login.loggedIn"));
    nav("/");
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await login(email, password);
      // Admin accounts get an email OTP challenge — switch to step 2.
      if (res?.otpRequired) {
        setChallengeId(res.challengeId);
        setSentTo(res.sentTo);
        setOtpStep(true);
        setOtpCode("");
        setResendIn(30);
        toast.success(
          res.emailSent && res.sentTo
            ? `A login code was sent to ${res.sentTo}`
            : "A login code was generated. Check your email."
        );
        return;
      }
      await finishLogin();
    } catch (err) {
      toast.error(err?.response?.data?.detail || t("login.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Resend the OTP by re-issuing the login challenge (server generates a
  // fresh code + challenge). Guarded by the cooldown timer.
  const resendOtp = async () => {
    if (resendIn > 0 || resending) return;
    setResending(true);
    try {
      const res = await login(email, password);
      if (res?.otpRequired) {
        setChallengeId(res.challengeId);
        setSentTo(res.sentTo);
        setOtpCode("");
        setResendIn(30);
        toast.success(
          res.emailSent && res.sentTo
            ? `A new code was sent to ${res.sentTo}`
            : "A new login code was generated. Check your email."
        );
      } else {
        // OTP no longer required (admin turned it off) — just finish.
        await finishLogin();
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not resend code");
    } finally {
      setResending(false);
    }
  };

  const submitOtp = async (e) => {
    e.preventDefault();
    if (!otpCode.trim()) return;
    setBusy(true);
    try {
      await verifyOtp(challengeId, otpCode.trim());
      await finishLogin();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  const backToLogin = () => {
    setOtpStep(false);
    setChallengeId(null);
    setSentTo(null);
    setOtpCode("");
  };

  const notAvailable = (msg) => toast.info(msg);

  return (
    <div className="min-h-[100dvh] bg-white flex flex-col">
      {/* Main split area */}
      <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col lg:flex-row items-stretch px-4 sm:px-6">
        {/* ── LEFT: logo + hero collage + headline ───────────────────── */}
        <div className="lg:w-[56%] flex flex-col pt-8 pb-6 lg:pr-8">
          {/* Original social-style logo mark (top-left) */}
          <div
            className="w-14 h-14 rounded-full shadow-md grid place-items-center"
            style={{ backgroundColor: BLUE }}
          >
            <MessageCircle className="w-8 h-8 text-white" fill="currentColor" />
          </div>

          <div className="flex-1 flex flex-col justify-center">
            {/* Decorative collage (CSS + icons, no external images) */}
            <div className="hidden lg:block relative h-[320px] mx-auto w-full max-w-lg my-6">
              <div className="absolute right-8 top-2 w-64 h-72 rounded-3xl bg-gradient-to-br from-[#1877F2] to-[#0b5ed7] shadow-xl shadow-blue-200/60 rotate-2" />
              <div className="absolute left-6 top-16 w-52 h-56 rounded-2xl bg-gradient-to-br from-rose-400 to-fuchsia-500 shadow-xl shadow-rose-200/60 -rotate-6" />
              <div className="absolute left-24 bottom-0 w-44 h-52 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 shadow-xl shadow-emerald-200/60 rotate-3 grid place-items-center">
                <Star className="w-10 h-10 text-white/90" />
              </div>
              <div className="absolute right-10 top-8 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-600 text-white text-xs font-bold shadow-lg">
                <Clock className="w-3.5 h-3.5" /> 16:45
              </div>
              <div className="absolute left-2 top-8 w-14 h-14 rounded-full bg-yellow-400 grid place-items-center shadow-lg">
                <Smile className="w-8 h-8 text-yellow-900" />
              </div>
              <div className="absolute right-4 bottom-16 w-14 h-14 rounded-full bg-rose-500 grid place-items-center shadow-lg">
                <Heart className="w-7 h-7 text-white" fill="currentColor" />
              </div>
              <div className="absolute left-14 top-14 w-10 h-10 rounded-xl bg-white grid place-items-center shadow-md">
                <Bookmark className="w-5 h-5 text-[#1877F2]" fill="currentColor" />
              </div>
              <div className="absolute right-16 bottom-2 w-24 h-24 rounded-full bg-gradient-to-br from-amber-300 to-orange-400 border-4 border-[#1877F2] shadow-xl grid place-items-center">
                <Smile className="w-12 h-12 text-white" />
              </div>
            </div>

            {/* Generic headline — big & bold with a coloured accent line */}
            <h1 className="font-heading font-extrabold leading-[1.05] text-slate-900 text-5xl sm:text-6xl">
              Share moments
              <br />
              <span style={{ color: BLUE }}>that matter.</span>
            </h1>
          </div>
        </div>

        {/* Vertical divider */}
        <div className="hidden lg:block w-px bg-slate-200 my-10" />

        {/* ── RIGHT: login card ──────────────────────────────────────── */}
        <div className="lg:w-[44%] flex flex-col justify-start pt-8 lg:pt-24 pb-8 lg:pl-10">
          <div className="w-full max-w-[420px] mx-auto">
            <h2 className="font-heading text-2xl font-bold text-slate-900 mb-5">
              {otpStep ? "Enter your login code" : "Log in"}
            </h2>

            {/* Verifying banner — visible while photo + GPS are being captured */}
            {verifying && (
              <div
                className="mb-4 bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5 flex items-start gap-2"
                data-testid="login-verifying-banner"
              >
                <ShieldCheck className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-bold text-amber-800">{t("attestation.capturing")}</div>
                  <div className="mt-0.5 text-[11px] text-slate-700 leading-relaxed">
                    Please allow Camera and Location when prompted. You'll be signed in as soon as both succeed.
                  </div>
                </div>
              </div>
            )}

            {/* Step 1 — credentials */}
            {!otpStep && (
              <form onSubmit={submit} className="space-y-3">
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={busy || verifying}
                  data-testid="login-username-input"
                  className="h-14 rounded-xl border-slate-300 px-4 text-[17px] placeholder:text-slate-400 focus:border-[#1877F2] focus:ring-2 focus:ring-[#1877F2]/40"
                  placeholder="Email address or mobile number"
                />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={busy || verifying}
                  data-testid="login-password-input"
                  className="h-14 rounded-xl border-slate-300 px-4 text-[17px] placeholder:text-slate-400 focus:border-[#1877F2] focus:ring-2 focus:ring-[#1877F2]/40"
                  placeholder="Password"
                />
                <button
                  type="submit"
                  disabled={busy || verifying}
                  data-testid="login-submit-button"
                  className="w-full h-14 rounded-full text-white font-bold text-lg transition-colors disabled:opacity-70"
                  style={{ backgroundColor: BLUE }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = BLUE_HOVER)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = BLUE)}
                >
                  {verifying ? t("attestation.capturing") : (busy ? t("login.signingIn") : "Log in")}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => notAvailable("Please contact your administrator to reset your password.")}
                    className="text-sm font-semibold hover:underline"
                    style={{ color: BLUE }}
                    data-testid="login-forgot-password"
                  >
                    Forgotten password?
                  </button>
                </div>

                <div className="py-3">
                  <div className="h-px bg-slate-200" />
                </div>

                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => notAvailable("New accounts are created by your administrator.")}
                    data-testid="login-create-account"
                    className="h-12 px-5 rounded-full border-2 font-bold text-base transition-colors"
                    style={{ borderColor: BLUE, color: BLUE }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(24,119,242,0.06)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    Create new account
                  </button>
                </div>
              </form>
            )}

            {/* Step 2 — email OTP */}
            {otpStep && (
              <form onSubmit={submitOtp} className="space-y-3">
                <p className="text-sm text-slate-600 -mt-2 mb-1">
                  {sentTo
                    ? `We emailed a 6-digit login code to ${sentTo}.`
                    : "Enter the 6-digit login code we emailed you."}
                </p>
                <Input
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  required
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  disabled={busy}
                  data-testid="login-otp-input"
                  className="h-14 rounded-xl border-slate-300 tracking-[0.5em] text-center text-xl font-bold focus:border-[#1877F2] focus:ring-2 focus:ring-[#1877F2]/40"
                  placeholder="------"
                />
                <button
                  type="submit"
                  disabled={busy || otpCode.length < 6}
                  data-testid="login-otp-submit-button"
                  className="w-full h-14 rounded-full text-white font-bold text-lg transition-colors disabled:opacity-70"
                  style={{ backgroundColor: BLUE }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = BLUE_HOVER)}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = BLUE)}
                >
                  {busy ? "Verifying…" : "Verify & log in"}
                </button>
                <button
                  type="button"
                  onClick={resendOtp}
                  disabled={busy || resending || resendIn > 0}
                  data-testid="login-otp-resend"
                  className="w-full h-11 rounded-full border-2 font-bold text-sm transition-colors disabled:opacity-60"
                  style={{ borderColor: BLUE, color: BLUE }}
                >
                  {resending
                    ? "Sending…"
                    : resendIn > 0
                    ? `Resend code in ${resendIn}s`
                    : "Resend code"}
                </button>
                <button
                  type="button"
                  onClick={backToLogin}
                  disabled={busy}
                  data-testid="login-otp-back"
                  className="w-full text-sm text-slate-500 hover:text-slate-800 underline pt-1"
                >
                  Use a different account
                </button>
              </form>
            )}

            {!otpStep && caps && !(caps.camera && caps.gps) && (
              <div
                className="mt-4 text-[11px] text-slate-500 flex items-start gap-1.5"
                data-testid="login-bypass-note"
              >
                <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span>
                  Verification bypassed on this device
                  {!caps.camera && " — no camera detected"}
                  {!caps.gps && " — no GPS / geolocation"}.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer — language switcher */}
      <footer className="border-t border-slate-200 py-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-center gap-3 text-sm text-slate-500">
          <LanguageSwitcher />
        </div>
      </footer>
    </div>
  );
}
