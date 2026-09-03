import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import "@/i18n";
import App from "@/App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

// Register PWA service worker — ONLY in production builds.
//
// In a CRA dev server, registering a SW that uses cache-first / network-first
// strategies + `clients.claim()` races against webpack-dev-server's HMR and
// causes an infinite refresh loop on the preview URL (HMR pushes new chunks,
// SW serves stale cached HTML referencing old chunk hashes, browser 404s and
// reloads, repeat). So in development we both SKIP registration and actively
// UNREGISTER any worker that was previously installed on this origin.
const IS_PROD = process.env.NODE_ENV === "production";

if ("serviceWorker" in navigator) {
  if (IS_PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register(`${process.env.PUBLIC_URL || ""}/service-worker.js`)
        .then((reg) => {
          if (reg.waiting) {
            try { reg.waiting.postMessage({ type: "SKIP_WAITING" }); } catch { /* ignore */ }
          }
          reg.addEventListener("updatefound", () => {
            const installing = reg.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed" && navigator.serviceWorker.controller) {
                try { installing.postMessage({ type: "SKIP_WAITING" }); } catch { /* ignore */ }
              }
            });
          });
        })
        .catch(() => {});
    });
  } else {
    // Dev mode — kill any previously registered SW and wipe its caches
    // to break the refresh loop on the preview URL.
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    if (window.caches) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {});
    }
  }
}
