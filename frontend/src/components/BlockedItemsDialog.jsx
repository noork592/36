import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Ban, Search, X, Save, Plus, ShieldOff } from "lucide-react";

/**
 * Admin-only dialog: manage the per-party item block-list.
 * Any item id present here is filtered out of the /items/search results
 * (and rejected by the backend order + off-order dispatch endpoints) for
 * this specific customer. Bill amount and every other flow is untouched.
 *
 * Props:
 *  - open, onOpenChange: dialog state
 *  - customer: { id, name } — the party being edited
 *  - onSaved(): callback fired after a successful save so the caller can
 *    refresh badges/counters (blocked count on the customer row, etc.)
 */
export default function BlockedItemsDialog({ open, onOpenChange, customer, onSaved }) {
  // Currently-blocked items (full item docs) + their ids as a Set for O(1)
  // lookups while the user is browsing search results.
  const [blocked, setBlocked] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Search state for adding more items to the block-list.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const blockedIdSet = useMemo(
    () => new Set(blocked.map((it) => it.id)),
    [blocked],
  );

  // Load the party's current block-list every time the dialog opens.
  useEffect(() => {
    if (!open || !customer?.id) {
      setBlocked([]);
      setQuery("");
      setResults([]);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/customers/${customer.id}/blocked-items`);
        setBlocked(data.items || []);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Failed to load blocked items");
      } finally {
        setLoading(false);
      }
    })();
  }, [open, customer?.id]);

  // Debounced fuzzy search — reuse the standard /items/search endpoint
  // WITHOUT passing customer_id so the admin can see (and block) items
  // regardless of the current block-list. Already-blocked items in the
  // results are visually greyed-out and made non-clickable.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get("/items/search", { params: { q, limit: 30 } });
        setResults(data || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  const addItem = (it) => {
    if (!it?.id || blockedIdSet.has(it.id)) return;
    setBlocked((cur) => [...cur, it]);
  };
  const removeItem = (id) => {
    setBlocked((cur) => cur.filter((it) => it.id !== id));
  };

  const save = async () => {
    if (!customer?.id) return;
    setSaving(true);
    try {
      const payload = { item_ids: blocked.map((it) => it.id) };
      await api.put(`/customers/${customer.id}/blocked-items`, payload);
      toast.success(
        blocked.length === 0
          ? "All blocks removed"
          : `Saved · ${blocked.length} item${blocked.length === 1 ? "" : "s"} blocked`,
      );
      onOpenChange(false);
      if (onSaved) onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="rounded-sm max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-0"
        data-testid="blocked-items-dialog"
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-200">
          <DialogTitle className="font-heading flex items-center gap-2 text-slate-900">
            <ShieldOff className="w-5 h-5 text-rose-600" />
            Blocked items · {customer?.name || ""}
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Items added here will never appear in this party&apos;s SKU search
            and cannot be placed on a new order or dispatch. Existing orders
            are not affected.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
          {/* Currently blocked list */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2 flex items-center gap-1">
              <Ban className="w-3 h-3 text-rose-600" />
              Currently blocked ({blocked.length})
            </div>
            {loading ? (
              <div className="text-xs text-slate-400 italic">Loading…</div>
            ) : blocked.length === 0 ? (
              <div
                className="text-xs text-slate-400 italic border border-dashed border-slate-200 rounded-sm px-3 py-4 text-center"
                data-testid="blocked-empty"
              >
                No items blocked for this party.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5" data-testid="blocked-list">
                {blocked.map((it) => (
                  <span
                    key={it.id}
                    data-testid={`blocked-chip-${it.id}`}
                    className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-sm bg-rose-50 border border-rose-200 text-rose-900 text-xs font-bold"
                  >
                    <span className="max-w-[260px] truncate" title={it.name}>{it.name}</span>
                    {it.product_name && (
                      <span className="text-[10px] font-semibold text-rose-700/70">
                        · {it.product_name}
                      </span>
                    )}
                    <button
                      onClick={() => removeItem(it.id)}
                      data-testid={`blocked-chip-remove-${it.id}`}
                      title="Remove block"
                      className="ml-1 p-0.5 rounded-sm hover:bg-rose-200/70 text-rose-700"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Search + add */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2">
              Add items to block
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search item SKU (e.g., side stand splendor, seat foam)…"
                data-testid="blocked-search-input"
                className="h-11 rounded-sm pl-9"
              />
            </div>
            <div
              className="mt-2 border border-slate-200 rounded-sm max-h-64 overflow-y-auto divide-y divide-slate-100"
              data-testid="blocked-search-results"
            >
              {searching && (
                <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>
              )}
              {!searching && results.length === 0 && (
                <div className="px-3 py-4 text-xs text-slate-400 text-center italic">
                  {query.trim()
                    ? `No items found for "${query}"`
                    : "Type to search items — top matches will show here."}
                </div>
              )}
              {!searching &&
                results.map((it, i) => {
                  const already = blockedIdSet.has(it.id);
                  return (
                    <button
                      key={it.id}
                      onClick={() => !already && addItem(it)}
                      disabled={already}
                      data-testid={`blocked-search-row-${i}`}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 transition ${
                        already
                          ? "bg-slate-50 cursor-not-allowed opacity-60"
                          : "hover:bg-orange-50"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">
                          {it.name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {it.product_name || "—"}
                        </div>
                      </div>
                      {already ? (
                        <span className="text-[10px] uppercase font-extrabold tracking-wider text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded-sm">
                          Blocked
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-extrabold tracking-wider text-[#E65100] bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-sm">
                          <Plus className="w-3 h-3" /> Block
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-3 border-t border-slate-200 bg-slate-50 gap-2 flex-wrap sm:flex-nowrap">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="blocked-cancel-btn"
            className="rounded-sm"
          >
            <X className="w-4 h-4 mr-1" /> Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || loading}
            data-testid="blocked-save-btn"
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm disabled:opacity-50"
          >
            <Save className="w-4 h-4 mr-1" />
            {saving ? "Saving…" : "Save block-list"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
