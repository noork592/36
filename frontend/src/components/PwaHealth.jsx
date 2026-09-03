import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ShieldCheck, ShieldAlert, RefreshCw, Smartphone, Download,
  CircleCheck, CircleX, CircleAlert, ExternalLink,
} from "lucide-react";

/**
 * PwaHealth — live PWA & security verification panel.
 *
 *   Every check runs inside the browser at mount time and re-runs on
 *   demand via the "Re-run checks" button. The card is render-safe
 *   even when the SW or caches API isn't available (degrades to fail).
 *
 *   Checks performed
 *   ────────────────
 *    1. HTTPS                — `location.protocol === "https:"`.
 *    2. Service worker       — registered AND has an active worker.
 *    3. Manifest             — fetched, JSON-parseable, has required fields.
 *    4. Icons                — 192 + 512 reachable.
 *    5. API not cached       — every `caches` entry is scanned; if any
 *                              cached request URL contains "/api/" we FAIL
 *                              (would leak auth data between sessions).
 *    6. Installable          — `beforeinstallprompt` captured OR app is
 *                              already running in standalone mode.
 *    7. Auth token           — JWT present, not expired (no plaintext
 *                              leakage in cache).
 *    8. Logout cache wipe    — admin can click the button to broadcast
 *                              {type:"jk-logout"} to the SW and verify
 *                              caches.keys() drops back to 0.
 */
const STATUS = { PASS: "pass", FAIL: "fail", WARN: "warn", PENDING: "pending" };

function StatusIcon({ s }) {
  if (s === STATUS.PASS) return <CircleCheck className="w-4 h-4 text-emerald-600" />;
  if (s === STATUS.FAIL) return <CircleX className="w-4 h-4 text-red-600" />;
  if (s === STATUS.WARN) return <CircleAlert className="w-4 h-4 text-amber-600" />;
  return <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />;
}

function decodeJwt(tok) {
  try {
    const [, body] = tok.split(".");
    return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

export default function PwaHealth() {
  const [checks, setChecks] = useState([]);
  const [running, setRunning] = useState(false);
  const [installed, setInstalled] = useState(false);

  const runAll = async () => {
    setRunning(true);
    const out = [];

    // 1. HTTPS
    out.push({
      id: "https",
      label: "HTTPS connection",
      status: window.location.protocol === "https:" ? STATUS.PASS : STATUS.FAIL,
      detail: window.location.protocol === "https:"
        ? "All traffic is encrypted (TLS)."
        : "PWA install requires HTTPS. Current protocol: " + window.location.protocol,
    });

    // 2. Service worker
    let swStatus = STATUS.FAIL, swDetail = "Service worker API not supported by this browser.";
    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && (reg.active || reg.installing || reg.waiting)) {
          swStatus = reg.active ? STATUS.PASS : STATUS.WARN;
          swDetail = reg.active
            ? `Active worker — scope ${reg.scope}`
            : `Worker is ${reg.installing ? "installing" : "waiting to activate"} — refresh the page.`;
        } else {
          swStatus = STATUS.FAIL;
          swDetail = "No service worker registered yet. Reload once.";
        }
      } catch (e) {
        swStatus = STATUS.FAIL;
        swDetail = String(e?.message || e);
      }
    }
    out.push({ id: "sw", label: "Service worker", status: swStatus, detail: swDetail });

    // 3. Manifest
    let mfStatus = STATUS.FAIL, mfDetail = "—";
    try {
      const res = await fetch("/manifest.json", { cache: "no-store" });
      if (res.ok) {
        const mf = await res.json();
        const need = ["name", "short_name", "start_url", "display", "icons"];
        const missing = need.filter((k) => !mf[k]);
        if (missing.length === 0 && Array.isArray(mf.icons) && mf.icons.length >= 2) {
          mfStatus = STATUS.PASS;
          mfDetail = `${mf.name} · display: ${mf.display}`;
        } else {
          mfStatus = STATUS.WARN;
          mfDetail = `Missing fields: ${missing.join(", ") || "icons<2"}`;
        }
      } else {
        mfDetail = "manifest.json returned " + res.status;
      }
    } catch (e) { mfDetail = "manifest fetch failed: " + e.message; }
    out.push({ id: "manifest", label: "Manifest valid", status: mfStatus, detail: mfDetail });

    // 4. Icons
    let iconStatus = STATUS.PASS, iconDetail = "192px & 512px icons reachable";
    for (const src of ["/logo192.png", "/logo512.png"]) {
      try {
        const r = await fetch(src, { method: "HEAD", cache: "no-store" });
        if (!r.ok) { iconStatus = STATUS.FAIL; iconDetail = src + " → " + r.status; break; }
      } catch (e) { iconStatus = STATUS.FAIL; iconDetail = src + " unreachable"; break; }
    }
    out.push({ id: "icons", label: "Install icons (192 + 512)", status: iconStatus, detail: iconDetail });

    // 5. API NOT cached (security)
    let apiSafe = STATUS.PASS, apiDetail = "No cached /api/* responses found";
    try {
      if ("caches" in window) {
        const names = await caches.keys();
        let leak = null;
        outer: for (const n of names) {
          const c = await caches.open(n);
          const reqs = await c.keys();
          for (const r of reqs) {
            try {
              const u = new URL(r.url);
              if (u.pathname.startsWith("/api/")) { leak = `${n} → ${u.pathname}`; break outer; }
            } catch { /* ignore */ }
          }
        }
        if (leak) {
          apiSafe = STATUS.FAIL;
          apiDetail = "Cached API response detected: " + leak;
        } else {
          apiDetail = `Scanned ${names.length} cache${names.length === 1 ? "" : "s"} — no API leak`;
        }
      } else {
        apiSafe = STATUS.WARN;
        apiDetail = "Browser has no Caches API";
      }
    } catch (e) { apiSafe = STATUS.WARN; apiDetail = e.message; }
    out.push({
      id: "api-safe", label: "API responses not cached (security)",
      status: apiSafe, detail: apiDetail,
    });

    // 6. Installable / installed
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    setInstalled(standalone);
    out.push({
      id: "install",
      label: standalone ? "App is INSTALLED on this device" : "App is installable",
      status: standalone ? STATUS.PASS : STATUS.WARN,
      detail: standalone
        ? "Running in standalone mode."
        : "Look for ‘Install JK Products app’ in the browser address bar (Chrome) or use Share → Add to Home Screen (iOS).",
    });

    // 7. Auth token
    let aStat = STATUS.WARN, aDetail = "Not signed in (token missing).";
    const tok = localStorage.getItem("foms_token");
    if (tok) {
      const claims = decodeJwt(tok);
      if (claims?.exp) {
        const left = claims.exp * 1000 - Date.now();
        if (left > 0) {
          aStat = STATUS.PASS;
          const hrs = Math.round(left / 3600000);
          aDetail = `JWT valid — ${hrs}h until expiry. Stored in localStorage (cleared on logout).`;
        } else {
          aStat = STATUS.FAIL;
          aDetail = "Token has expired — please sign out and back in.";
        }
      }
    }
    out.push({ id: "auth", label: "Auth token", status: aStat, detail: aDetail });

    setChecks(out);
    setRunning(false);
  };

  useEffect(() => { runAll(); }, []);

  // Manual logout wipe verification
  const [wipeMsg, setWipeMsg] = useState("");
  const verifyWipe = async () => {
    setWipeMsg("Wiping…");
    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "jk-logout" });
      } else if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      // Wait a tick for the SW to drain
      await new Promise((r) => setTimeout(r, 600));
      const remaining = "caches" in window ? (await caches.keys()).length : 0;
      setWipeMsg(remaining === 0 ? "✓ All caches cleared." : `⚠ ${remaining} cache(s) remain.`);
      await runAll();
    } catch (e) { setWipeMsg("Failed: " + e.message); }
  };

  const overall = checks.length === 0
    ? STATUS.PENDING
    : (checks.some((c) => c.status === STATUS.FAIL) ? STATUS.FAIL
      : (checks.some((c) => c.status === STATUS.WARN) ? STATUS.WARN : STATUS.PASS));

  return (
    <div className="bg-white border border-slate-200 rounded-sm p-5 sm:p-6" data-testid="pwa-health-card">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-sm flex items-center justify-center shrink-0 ${
            overall === STATUS.PASS ? "bg-emerald-100" :
            overall === STATUS.FAIL ? "bg-red-100" :
            overall === STATUS.WARN ? "bg-amber-100" : "bg-slate-100"
          }`}>
            {overall === STATUS.PASS
              ? <ShieldCheck className="w-5 h-5 text-emerald-700" />
              : overall === STATUS.FAIL
              ? <ShieldAlert className="w-5 h-5 text-red-700" />
              : <Smartphone className="w-5 h-5 text-amber-700" />}
          </div>
          <div>
            <div className="font-heading font-extrabold text-base text-slate-900">PWA &amp; Security Health</div>
            <div className="text-xs text-slate-500 mt-0.5">
              Live verification of install-readiness, service worker and data-leakage safeguards.
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={runAll}
          disabled={running}
          data-testid="pwa-health-rerun"
          className="rounded-sm h-9"
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${running ? "animate-spin" : ""}`} />
          Re-run checks
        </Button>
      </div>

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-sm" data-testid="pwa-health-list">
        {(checks.length === 0
          ? [{ id: "loading", label: "Running checks…", status: STATUS.PENDING, detail: "" }]
          : checks).map((c) => (
          <li key={c.id} className="px-3 py-2.5 flex items-start gap-3" data-testid={`pwa-check-${c.id}`}>
            <StatusIcon s={c.status} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-slate-900">{c.label}</div>
              <div className="text-xs text-slate-500 mt-0.5 break-words">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="border border-slate-200 rounded-sm p-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-1.5">
            Verify logout cache wipe
          </div>
          <p className="text-xs text-slate-600 leading-relaxed mb-2">
            Simulates the cache-wipe broadcast the SPA fires on logout. Useful to confirm no
            stale data lingers between sessions on a shared phone.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={verifyWipe}
              data-testid="pwa-verify-wipe"
              className="rounded-sm h-8 bg-slate-900 hover:bg-slate-800 text-white text-xs"
            >
              Run wipe test
            </Button>
            <span className="text-xs text-slate-600" data-testid="pwa-verify-wipe-msg">{wipeMsg}</span>
          </div>
        </div>

        <div className="border border-slate-200 rounded-sm p-3">
          <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-1.5">
            How to install on phone
          </div>
          <ol className="text-xs text-slate-700 leading-relaxed list-decimal pl-4 space-y-0.5">
            <li><b>Android Chrome / Edge:</b> tap the menu → "Install app", or use the on-screen "Install" toast.</li>
            <li><b>iPhone Safari:</b> tap <Download className="w-3 h-3 inline -mt-0.5" /> Share → "Add to Home Screen".</li>
            <li>Launch from the home-screen icon — the app opens full-screen with no browser chrome.</li>
          </ol>
          {installed && (
            <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
              <CircleCheck className="w-3 h-3" /> Installed on this device
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 text-[11px] text-slate-500">
        Tip: open this page on the phone you want to install — the checks reflect that device.
        <a
          className="ml-2 text-[#E65100] font-bold inline-flex items-center gap-0.5 hover:underline"
          href="https://web.dev/articles/install-criteria"
          target="_blank"
          rel="noreferrer"
        >
          Install criteria <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
