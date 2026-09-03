import React, { useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Convert "YYYY-MM-DD" → Date (interpreted as IST midnight) without TZ shift.
function parseYmd(value) {
  if (!value) return undefined;
  const [y, m, d] = String(value).split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

// Convert a Date object → "YYYY-MM-DD" using the LOCAL calendar fields (no TZ shift).
function toYmd(date) {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Pretty label like "23 Jun 2026" — short, scannable, language-neutral enough.
function formatPretty(value) {
  const d = parseYmd(value);
  if (!d) return "";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * High-contrast date picker built on shadcn Popover + Calendar.
 * Props:
 *   value:    "YYYY-MM-DD" string (or empty)
 *   onChange: (newYmd: string) => void
 *   max:      optional "YYYY-MM-DD" — disables dates after this
 *   min:      optional "YYYY-MM-DD" — disables dates before this
 *   className, buttonClassName, placeholder, testId
 *   disabled
 */
export default function DatePicker({
  value,
  onChange,
  max,
  min,
  className,
  buttonClassName,
  placeholder = "Pick a date",
  testId,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const selected = parseYmd(value);
  const maxDate = parseYmd(max);
  const minDate = parseYmd(min);

  const disabledMatchers = [];
  if (maxDate) disabledMatchers.push({ after: maxDate });
  if (minDate) disabledMatchers.push({ before: minDate });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid={testId}
          className={cn(
            "h-10 w-full justify-start rounded-sm border-slate-300 bg-white text-left font-mono-num text-sm text-slate-900 hover:bg-slate-50",
            !selected && "text-slate-400",
            buttonClassName,
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 text-[#E65100]" />
          {selected ? formatPretty(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0 bg-white border border-slate-200 shadow-xl rounded-sm"
      >
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected || maxDate || new Date()}
          onSelect={(d) => {
            if (!d) return;
            onChange && onChange(toYmd(d));
            setOpen(false);
          }}
          disabled={disabledMatchers.length ? disabledMatchers : undefined}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
