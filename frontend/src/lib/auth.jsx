import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { toast } from "sonner";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("foms_token");
    const cachedUser = localStorage.getItem("foms_user");
    if (token && cachedUser) {
      try { setUser(JSON.parse(cachedUser)); } catch (e) { console.warn("Failed to parse cached user", e); }
      api.get("/auth/me").then((r) => {
        setUser(r.data);
        localStorage.setItem("foms_user", JSON.stringify(r.data));
      }).catch(() => {
        localStorage.removeItem("foms_token");
        localStorage.removeItem("foms_user");
        setUser(null);
      }).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const applySession = (data) => {
    localStorage.setItem("foms_token", data.token);
    localStorage.setItem("foms_user", JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    // Admin accounts return an OTP challenge instead of a token — the
    // caller must collect the emailed code and call verifyOtp().
    if (data?.otp_required) {
      return {
        otpRequired: true,
        challengeId: data.challenge_id,
        sentTo: data.sent_to,
        emailSent: data.email_sent,
      };
    }
    return { otpRequired: false, user: applySession(data) };
  };

  const verifyOtp = async (challengeId, code) => {
    const { data } = await api.post("/auth/verify-otp", { challenge_id: challengeId, code });
    return applySession(data);
  };

  const logout = (reason) => {
    localStorage.removeItem("foms_token");
    localStorage.removeItem("foms_user");
    setUser(null);
    if (reason === "inactivity") {
      try { toast("Signed out after 20 minutes of inactivity"); } catch { /* ignore */ }
    }
    // Wipe SW caches so the next person using this device starts fresh —
    // the SW listens for {type:"jk-logout"} and clears every owned cache.
    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "jk-logout" });
      }
    } catch { /* ignore */ }
  };

  // ── Auto-logout after 20 minutes of inactivity ──────────────────────
  // Any real user interaction (mouse, keyboard, touch, scroll) resets the
  // idle timer. If the app sits untouched for 20 minutes, the session is
  // cleared automatically. Only armed while someone is logged in.
  useEffect(() => {
    if (!user) return;
    const IDLE_MS = 20 * 60 * 1000; // 20 minutes
    let timer;
    const doLogout = () => logout("inactivity");
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(doLogout, IDLE_MS);
    };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click", "visibilitychange"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset(); // start the countdown
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user]);

  return (
    <AuthCtx.Provider value={{
      user,
      loading,
      login,
      verifyOtp,
      logout,
      isAdmin: user?.role === "admin",
      can: (key) => hasPermission(user, key),
      canAct: (key) => hasPermission(user, key),
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
