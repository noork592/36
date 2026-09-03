import React from "react";
import { Clock } from "lucide-react";

/**
 * Small visual badge that reminds operators that all date filters group days
 * by India Standard Time (UTC+5:30) — the factory's local clock — not UTC.
 * Use next to any date / date-range picker in reports and ledgers.
 */
export default function IstBadge({ className = "", title = "All reports group days by India Standard Time (UTC+5:30)" }) {
  return (
    <span
      title={title}
      data-testid="ist-tz-badge"
      className={`inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold bg-slate-100 border border-slate-300 text-slate-600 px-1.5 py-0.5 rounded-sm ${className}`}
    >
      <Clock className="w-2.5 h-2.5" /> IST · UTC+5:30
    </span>
  );
}
