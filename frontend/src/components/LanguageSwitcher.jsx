import React from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";

export default function LanguageSwitcher({ variant = "default" }) {
  const { i18n: i18nInstance } = useTranslation();
  const current = i18nInstance.language?.startsWith("hi") ? "hi" : "en";

  return (
    <div
      role="group"
      aria-label="Language"
      data-testid="lang-switcher"
      className={`inline-flex items-center rounded-sm border ${
        variant === "dark"
          ? "border-slate-700 bg-slate-800/60"
          : "border-slate-200 bg-white"
      } overflow-hidden`}
    >
      <Languages
        className={`w-3.5 h-3.5 ml-2 mr-1 ${
          variant === "dark" ? "text-slate-400" : "text-slate-400"
        }`}
      />
      {SUPPORTED_LANGUAGES.map((l) => {
        const active = current === l.code;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => setLanguage(l.code)}
            data-testid={`lang-btn-${l.code}`}
            className={`h-8 px-2.5 text-xs font-bold tracking-wide transition-colors ${
              active
                ? "bg-[#E65100] text-white"
                : variant === "dark"
                ? "text-slate-300 hover:bg-slate-700"
                : "text-slate-600 hover:bg-slate-100"
            }`}
            aria-pressed={active}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
