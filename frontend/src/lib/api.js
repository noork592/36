import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("foms_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      // The stored token is invalid or its user no longer exists
      // (e.g. after a database restore that replaced the users
      // collection). Instead of leaving the app in a broken state where
      // every request fails with "User not found" / "Invalid token" and
      // stale cached IDs trigger "Customer not found", clear the session
      // and bounce the user to a clean login screen.
      const url = err?.config?.url || "";
      const isAuthCall = url.includes("/auth/login") || url.includes("/auth/verify-otp");
      if (!isAuthCall) {
        try {
          localStorage.removeItem("foms_token");
          localStorage.removeItem("foms_user");
        } catch (_) { /* ignore */ }
        // Avoid redirect loops if we're already on the login page.
        if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
          window.location.assign("/login");
        }
      }
    }
    // Normalize FastAPI / Pydantic v2 validation errors so `detail` is
    // ALWAYS a plain string by the time UI code reads it. Pydantic returns
    // `detail` as an array of { type, loc, msg, input, ctx } objects on
    // 422 responses — rendering that directly into JSX (e.g. via
    // toast.error(err.response.data.detail)) crashes React with
    // "Objects are not valid as a React child".
    try {
      const d = err?.response?.data?.detail;
      if (Array.isArray(d)) {
        const flat = d
          .map((it) => {
            if (!it || typeof it !== "object") return String(it ?? "");
            const loc = Array.isArray(it.loc)
              ? it.loc.filter((p) => p !== "body").join(".")
              : "";
            const msg = it.msg || it.message || it.type || "Invalid value";
            return loc ? `${loc}: ${msg}` : msg;
          })
          .filter(Boolean)
          .join("; ");
        err.response.data.detail = flat || "Validation failed";
      } else if (d && typeof d === "object") {
        err.response.data.detail =
          d.msg || d.message || d.detail || JSON.stringify(d);
      }
    } catch (_) {
      // best-effort — never let the interceptor itself throw
    }
    return Promise.reject(err);
  }
);
