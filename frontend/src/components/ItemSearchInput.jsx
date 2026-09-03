import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";

/**
 * Fuzzy item-SKU search combobox.
 * - value: { item_id, item_name, product_name } | null
 * - onChange(value): called when user picks an item, with derived product_name.
 * - testIdPrefix: data-testid prefix (rows in NewOrder use this).
 * - previouslyOrdered: optional array of recent item names this customer ordered;
 *     when shown with no query, surfaces these as "Previously ordered" hints.
 */
export default function ItemSearchInput({ value, onChange, testIdPrefix = "item-search", previouslyOrdered = [], customerId = null }) {
  const [query, setQuery] = useState(value?.item_name || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  // Sync external value.item_id → query only when the picked id actually changes
  // (e.g., voice-fill, parent reset). Normalise null/undefined/"" → null so we
  // don't fire the effect on every render and wipe what the user is typing.
  const externalId = value?.item_id || null;
  const lastSyncedId = useRef(externalId);
  useEffect(() => {
    if (externalId === lastSyncedId.current) return;
    lastSyncedId.current = externalId;
    setQuery(value?.item_name || "");
  }, [externalId, value?.item_name]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const params = { q: query, limit: 20 };
        // When we know which party this row is for, ask the backend to skip
        // any SKUs the admin has blocked for that customer. This is how the
        // "block items per party" feature keeps blocked SKUs out of the
        // dropdown across New Order / Dispatch / Estimate.
        if (customerId) params.customer_id = customerId;
        const { data } = await api.get("/items/search", { params });
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [query, open, customerId]);

  useEffect(() => {
    const onClick = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const pick = (it) => {
    lastSyncedId.current = it.id;
    onChange({
      item_id: it.id,
      item_name: it.name,
      product_name: it.product_name,
      min_per_bag: it.min_per_bag ?? null,
      max_per_bag: it.max_per_bag ?? null,
    });
    setQuery(it.name);
    setOpen(false);
  };

  const clear = () => {
    lastSyncedId.current = null;
    onChange(null);
    setQuery("");
    setResults([]);
    setOpen(true);
  };

  const handleType = (e) => {
    const next = e.target.value;
    setQuery(next);
    setOpen(true);
    if (value?.item_id) {
      // User is editing a previously-picked item — invalidate the parent's
      // selection but tell the sync effect we already accounted for this null
      // transition so it doesn't wipe what the user is typing.
      lastSyncedId.current = null;
      onChange(null);
    }
  };

  const showResults = open && (results.length > 0 || busy);
  const showPrev = open && !query.trim() && previouslyOrdered.length > 0;

  // When an item is picked AND the dropdown is closed, render a "selected
  // chip" card so the FULL item name + product category are clearly visible
  // (wraps onto multiple lines if needed) instead of being clipped inside a
  // single-line text input. Clicking the card re-opens the picker for edit.
  const picked = value?.item_id ? value : null;
  if (picked && !open) {
    const bagInfo =
      picked.max_per_bag && picked.min_per_bag
        ? picked.max_per_bag === picked.min_per_bag
          ? `${picked.max_per_bag}/bag`
          : `${picked.min_per_bag}–${picked.max_per_bag}/bag`
        : null;
    return (
      <div ref={boxRef} className="relative">
        <button
          type="button"
          onClick={() => { setOpen(true); setQuery(""); }}
          data-testid={`${testIdPrefix}-selected`}
          className="w-full text-left bg-orange-50 border border-orange-200 rounded-sm px-3 py-2 pr-9 hover:bg-orange-100 transition min-h-[44px]"
          title="Click to change item"
        >
          <div className="text-sm font-bold text-slate-900 break-words leading-snug" data-testid={`${testIdPrefix}-selected-name`}>
            {picked.item_name}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {picked.product_name && (
              <span className="text-[11px] text-slate-600 break-words" data-testid={`${testIdPrefix}-selected-product`}>
                {picked.product_name}
              </span>
            )}
            {bagInfo && (
              <span className="text-[10px] uppercase font-bold tracking-wider text-[#E65100] bg-white border border-orange-200 px-1.5 py-0.5 rounded-sm font-mono-num">
                {bagInfo}
              </span>
            )}
          </div>
        </button>
        <button
          onClick={clear}
          aria-label="Clear"
          data-testid={`${testIdPrefix}-clear`}
          className="absolute right-2 top-2 text-slate-400 hover:text-red-600 hover:bg-red-50 p-1 rounded-sm"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
      <Input
        data-testid={testIdPrefix}
        placeholder="Search item SKU (e.g., side stand splendor, yamaha fz)…"
        value={query}
        onChange={handleType}
        onFocus={() => setOpen(true)}
        autoFocus={!!picked}
        className="h-11 rounded-sm pl-9 pr-9"
      />
      {value?.item_id && (
        <button onClick={clear} aria-label="Clear"
                data-testid={`${testIdPrefix}-clear`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-600 p-1">
          <X className="w-4 h-4" />
        </button>
      )}
      {(showResults || showPrev) && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-72 overflow-y-auto"
             data-testid={`${testIdPrefix}-dropdown`}>
          {showPrev && (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-slate-50 border-b border-slate-100">
                Previously ordered
              </div>
              {previouslyOrdered.slice(0, 5).map((it, i) => (
                <button key={`prev-${i}`} onClick={() => pick(it)}
                        data-testid={`${testIdPrefix}-prev-${i}`}
                        className="w-full text-left px-3 py-2 hover:bg-amber-50 border-b border-slate-100 last:border-0">
                  <div className="text-sm font-semibold text-slate-800">{it.name}</div>
                  <div className="text-[11px] text-slate-500">{it.product_name}</div>
                </button>
              ))}
            </>
          )}
          {busy && <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>}
          {!busy && results.map((it, i) => (
            <button key={it.id} onClick={() => pick(it)}
                    data-testid={`${testIdPrefix}-result-${i}`}
                    className="w-full text-left px-3 py-2 hover:bg-orange-50 border-b border-slate-100 last:border-0">
              <div className="text-sm font-semibold text-slate-800">{it.name}</div>
              <div className="flex items-center justify-between mt-0.5">
                <div className="text-[11px] text-slate-500">{it.product_name}</div>
                {typeof it.match_score === "number" && (
                  <div className="text-[10px] font-mono text-slate-400">{Math.round(it.match_score)}%</div>
                )}
              </div>
            </button>
          ))}
          {!busy && results.length === 0 && query.trim() && !showPrev && (
            <div className="px-3 py-3 text-xs text-slate-400">No items found for &quot;{query}&quot;</div>
          )}
        </div>
      )}
    </div>
  );
}
