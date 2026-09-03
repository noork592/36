import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, X, Share } from "lucide-react";

/**
 * InstallPrompt — Android & iOS Add-to-Home-Screen helper.
 *
 *  - Android Chrome / Edge: captures `beforeinstallprompt` and shows a one-tap
 *    "Install app" toast. After dismissal we remember the choice in localStorage
 *    so we don't nag users.
 *  - iOS Safari (no native API): when running on iOS (not in standalone mode),
 *    surfaces a tiny help card explaining the Share → Add to Home Screen flow.
 *  - Hidden when the app is already installed (standalone display mode).
 */
const DISMISS_KEY = "jk-pwa-install-dismissed";

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  const ua = window.navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [show, setShow] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS Safari has no beforeinstallprompt — show static hint after a short delay
    if (isIOS()) {
      const t = setTimeout(() => setIosHint(true), 1500);
      return () => {
        clearTimeout(t);
        window.removeEventListener("beforeinstallprompt", onPrompt);
      };
    }

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setShow(false);
    setDeferred(null);
    if (outcome !== "accepted") {
      localStorage.setItem(DISMISS_KEY, "1");
    }
  };

  const dismiss = () => {
    setShow(false);
    setIosHint(false);
    localStorage.setItem(DISMISS_KEY, "1");
  };

  if (!show && !iosHint) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 z-50 sm:left-auto sm:right-4 sm:max-w-sm"
      data-testid="pwa-install-prompt"
    >
      <div className="bg-slate-900 text-white rounded-sm border border-slate-700 shadow-2xl p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-sm bg-[#E65100] flex items-center justify-center shrink-0">
          <Download className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-heading font-bold text-sm">Install JK Products app</div>
          {show && (
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">
              Install on this device for faster access and offline-friendly use.
            </p>
          )}
          {iosHint && (
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">
              Tap <Share className="w-3 h-3 inline -mt-0.5" /> in Safari, then{" "}
              <b className="text-white">Add to Home Screen</b>.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {show && (
              <Button
                size="sm"
                onClick={install}
                data-testid="pwa-install-btn"
                className="h-8 bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm font-bold text-xs px-3"
              >
                Install
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={dismiss}
              data-testid="pwa-install-dismiss"
              className="h-8 rounded-sm text-xs text-slate-400 hover:text-white hover:bg-slate-800 px-2"
            >
              Not now
            </Button>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Close"
          className="text-slate-500 hover:text-white p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
