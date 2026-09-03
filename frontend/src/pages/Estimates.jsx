import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  Calculator, Trash2, Plus, Printer, MapPin, Phone, Building2, Truck, Tag, FileText,
  Home, ClipboardList, Hash, Search, Eye, ListChecks, PencilLine,
} from "lucide-react";
import ItemSearchInput from "@/components/ItemSearchInput";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";
import { useAuth } from "@/lib/auth";

const EMPTY_ROW = { item_id: "", item_name: "", product_name: "", quantity: "" };

/**
 * Estimates — quotation flow that mirrors the New-Order screen layout so
 * operators feel at home:
 *   • Top row = customer picker (same design as Order Dispatch)
 *   • Below that a single card with items table, price-list selector,
 *     bill amount input, generate button
 *   • Result renders inline as a printable slip
 */
export default function Estimates() {
  const [allCustomers, setAllCustomers] = useState([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showSuggest, setShowSuggest] = useState(false);
  const suggestBoxRef = useRef(null);

  const [rows, setRows] = useState([{ ...EMPTY_ROW }]);
  const [billAmount, setBillAmount] = useState("");
  const [estimate, setEstimate] = useState(null);
  const [busy, setBusy] = useState(false);

  // Price-list override state — "" ⇒ use the customer's default list.
  const [priceLists, setPriceLists] = useState([]);
  const [priceListOverride, setPriceListOverride] = useState("");

  // Live per-row pricing preview. Recomputed with a debounced call to
  // /estimates/compute whenever the customer, price list, or any row's
  // item/qty changes — this lets the row show rate + net + line total
  // BEFORE the operator clicks "Generate estimate", so the total updates
  // in real time as they type quantities.
  //   linePricing[item_id] = { unit_price, net_unit_price, discount_value,
  //                             discount_type, price_list_name, line_value,
  //                             quantity }
  const [linePricing, setLinePricing] = useState({});
  const [livePreview, setLivePreview] = useState(null); // { subtotal, gst, grand, price_list_id, price_list_name }
  const [previewBusy, setPreviewBusy] = useState(false);

  // ── Saved-estimate records ────────────────────────────────────────────
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();
  const [view, setView] = useState("new");        // "new" | "records"
  const [savedNo, setSavedNo] = useState(null);    // estimate_no once persisted
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordSearch, setRecordSearch] = useState("");

  const loadRecords = async (q = "") => {
    setRecordsLoading(true);
    try {
      const { data } = await api.get("/estimates", { params: q ? { q } : {} });
      setRecords(data?.estimates || []);
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  };

  // Load records whenever the Records tab is opened.
  useEffect(() => {
    if (view === "records") loadRecords(recordSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Debounced search within records.
  useEffect(() => {
    if (view !== "records") return;
    const t = setTimeout(() => loadRecords(recordSearch), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordSearch]);

  const viewRecord = async (id) => {
    try {
      const { data } = await api.get(`/estimates/${id}`);
      setEstimate({ ...data, generated_at: data.generated_at || data.created_at });
      setSavedNo(data.estimate_no);
      setView("new");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not open estimate");
    }
  };

  const deleteRecord = (rec) => {
    confirm({
      title: `Delete estimate #${rec.estimate_no}?`,
      description: `This permanently removes the saved estimate for ${rec.customer_name}. The estimate number will not be reused.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/estimates/${rec.id}`);
          toast.success(`Estimate #${rec.estimate_no} deleted`);
          setRecords((prev) => prev.filter((r) => r.id !== rec.id));
        } catch (e) {
          toast.error(e?.response?.data?.detail || "Delete failed");
        }
      },
    });
  };

  // Load customers + price lists once for fast local filtering / dropdown.
  useEffect(() => {
    api.get("/customers").then((r) => setAllCustomers(r.data)).catch(() => {});
    api.get("/price-lists").then((r) => setPriceLists(r.data || [])).catch(() => setPriceLists([]));
  }, []);

  // Live customer suggestions from the server (fuzzy match).
  useEffect(() => {
    if (!customerQuery.trim() || selectedCustomer) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get("/customers/search", { params: { q: customerQuery } });
        setSuggestions(data || []);
      } catch {
        setSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [customerQuery, selectedCustomer]);

  // Close suggestion dropdown on outside click.
  useEffect(() => {
    const onClick = (e) => {
      if (!suggestBoxRef.current?.contains(e.target)) setShowSuggest(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const pickCustomer = (c) => {
    setSelectedCustomer(c);
    setCustomerQuery(c.name);
    setSuggestions([]);
    setShowSuggest(false);
    setPriceListOverride(""); // new customer → default to their assigned list
    setEstimate(null);
  };
  const clearCustomer = () => {
    setSelectedCustomer(null);
    setCustomerQuery("");
    setPriceListOverride("");
    setEstimate(null);
  };

  const updateRow = (idx, patch) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setEstimate(null);
  };
  const addRow = () => { setRows((prev) => [...prev, { ...EMPTY_ROW }]); setEstimate(null); };
  const removeRow = (idx) => {
    setRows((prev) => (prev.length === 1 ? [{ ...EMPTY_ROW }] : prev.filter((_, i) => i !== idx)));
    setEstimate(null);
  };

  const compute = async () => {
    if (!selectedCustomer) { toast.error("Please select a customer first"); return; }
    const items = rows
      .filter((r) => r.item_id && Number(r.quantity) > 0)
      .map((r) => ({ item_id: r.item_id, quantity: Number(r.quantity) }));
    if (items.length === 0) { toast.error("Add at least one SKU with a quantity"); return; }
    setBusy(true);
    try {
      // Generating an estimate persists it and assigns a unique estimate
      // number in one step — there is no separate save action.
      const { data } = await api.post("/estimates", {
        customer_id: selectedCustomer.id,
        items,
        bill_amount: Number(billAmount || 0),
        price_list_id_override: priceListOverride || null,
      });
      setEstimate({ ...data, generated_at: data.created_at });
      setSavedNo(data.estimate_no);
      toast.success(`Estimate #${data.estimate_no} saved`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to generate estimate");
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    setRows([{ ...EMPTY_ROW }]);
    setBillAmount("");
    setPriceListOverride("");
    setEstimate(null);
    setSavedNo(null);
    setLinePricing({});
    setLivePreview(null);
  };

  // ── Live pricing preview ──────────────────────────────────────────────
  // Fire a debounced /estimates/compute whenever the operator picks a
  // customer / changes the price list / picks items / edits quantities.
  // We only submit rows that have both item_id and qty > 0 so half-typed
  // rows don't spam the backend or trip validation. The response feeds
  // per-row rate + net + line total AND the live subtotal footer.
  useEffect(() => {
    if (!selectedCustomer) {
      setLinePricing({});
      setLivePreview(null);
      return;
    }
    const validRows = rows.filter((r) => r.item_id && Number(r.quantity) > 0);
    if (validRows.length === 0) {
      setLinePricing({});
      setLivePreview(null);
      return;
    }
    let cancelled = false;
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.post("/estimates/compute", {
          customer_id: selectedCustomer.id,
          items: validRows.map((r) => ({
            item_id: r.item_id,
            quantity: Number(r.quantity),
          })),
          bill_amount: 0, // preview only — bill amount only matters at "Generate"
          price_list_id_override: priceListOverride || null,
        });
        if (cancelled) return;
        const pricing = {};
        for (const l of data.lines || []) {
          if (!l.item_id) continue;
          pricing[l.item_id] = l;
        }
        setLinePricing(pricing);
        const totals = data.totals || {};
        setLivePreview({
          subtotal: Number(totals.line_total || 0),
          gst: Number(totals.gst || 0),
          grand_total: Number(totals.grand_total || 0),
          cash_amount: Number(totals.cash_amount || 0),
          price_list_id: data.price_list_id || null,
          price_list_name: data.price_list_name || "",
        });
      } catch (_e) {
        if (!cancelled) {
          setLinePricing({});
          setLivePreview(null);
        }
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id, priceListOverride, JSON.stringify(rows.map((r) => ({ i: r.item_id, q: r.quantity })))]);

  const fmtINR = (n) =>
    new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(n || 0));

  // Local fallback filter used only when the fuzzy-search endpoint returns nothing
  // (e.g. exotic characters). Keeps the UX snappy.
  const localCustomerHits = useMemo(() => {
    if (!customerQuery.trim() || selectedCustomer) return [];
    return allCustomers
      .filter((c) => c.name?.toLowerCase().includes(customerQuery.toLowerCase()))
      .slice(0, 8);
  }, [customerQuery, allCustomers, selectedCustomer]);
  const displayHits = suggestions.length > 0 ? suggestions : localCustomerHits;

  return (
    <div className="space-y-5" data-testid="estimates-page">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">
            Quotations
          </div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">
            Estimates
          </h1>
        </div>
        {view === "new" && estimate && (
          <div className="flex items-center gap-2 print:hidden">
            <Button variant="outline" onClick={resetAll} className="rounded-sm h-10">
              New estimate
            </Button>
            <Button
              onClick={() => window.print()}
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10"
              data-testid="estimate-print-btn"
            >
              <Printer className="w-4 h-4 mr-1.5" /> Print / Save PDF
            </Button>
          </div>
        )}
      </div>

      {/* Tabs: New estimate vs. Records */}
      <div className="flex items-center gap-1 border-b border-slate-200 print:hidden">
        <button
          type="button"
          onClick={() => setView("new")}
          data-testid="estimates-tab-new"
          className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold rounded-t-sm border-b-2 -mb-px transition-colors ${
            view === "new"
              ? "border-[#E65100] text-[#E65100]"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <PencilLine className="w-4 h-4" /> New Estimate
        </button>
        <button
          type="button"
          onClick={() => setView("records")}
          data-testid="estimates-tab-records"
          className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold rounded-t-sm border-b-2 -mb-px transition-colors ${
            view === "records"
              ? "border-[#E65100] text-[#E65100]"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <ListChecks className="w-4 h-4" /> Records
          {records.length > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-slate-200 text-slate-700 text-[10px] font-bold">
              {records.length}
            </span>
          )}
        </button>
      </div>

      {/* ── RECORDS VIEW ─────────────────────────────────────────────── */}
      {view === "records" && (
        <section className="bg-white border border-slate-200 rounded-sm" data-testid="estimates-records">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-slate-600">
              All saved estimates, newest first. Each has a unique estimate number.
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                value={recordSearch}
                onChange={(e) => setRecordSearch(e.target.value)}
                placeholder="Search by customer or estimate #"
                data-testid="estimates-records-search"
                className="h-10 rounded-sm pl-9"
              />
            </div>
          </div>

          {recordsLoading ? (
            <div className="p-10 text-center text-slate-500 text-sm">Loading records…</div>
          ) : records.length === 0 ? (
            <div className="p-10 text-center text-slate-500">
              <ClipboardList className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <div className="text-sm font-semibold">No saved estimates yet</div>
              <div className="text-xs mt-1">
                Generate an estimate and hit <span className="font-bold text-emerald-700">Save estimate</span> to keep a record here.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50">
                    <th className="text-left py-2.5 px-4 w-24">Est. #</th>
                    <th className="text-left py-2.5 px-4">Customer</th>
                    <th className="text-right py-2.5 px-4 w-20">Items</th>
                    <th className="text-right py-2.5 px-4 w-28">Grand ₹</th>
                    <th className="text-left py-2.5 px-4 w-44">Date</th>
                    <th className="text-right py-2.5 px-4 w-32">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-slate-100 hover:bg-orange-50/40"
                      data-testid={`estimate-record-${r.estimate_no}`}
                    >
                      <td className="py-2.5 px-4">
                        <span className="inline-flex items-center gap-1 font-mono font-extrabold text-slate-900">
                          <Hash className="w-3 h-3 text-[#E65100]" />{r.estimate_no}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-semibold text-slate-900">{r.customer_name || "—"}</div>
                        {r.price_list_name && (
                          <div className="text-[11px] text-slate-500">{r.price_list_name}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums font-mono">{r.item_count}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums font-mono font-bold text-[#E65100]">
                        ₹{Number(r.grand_total || 0).toLocaleString("en-IN")}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600 text-xs">
                        {r.created_at ? new Date(r.created_at).toLocaleString("en-IN", { hour12: false }) : "—"}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => viewRecord(r.id)}
                            data-testid={`estimate-record-view-${r.estimate_no}`}
                            className="h-8 rounded-sm"
                          >
                            <Eye className="w-3.5 h-3.5 mr-1" /> View
                          </Button>
                          {isAdmin && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => deleteRecord(r)}
                              data-testid={`estimate-record-delete-${r.estimate_no}`}
                              className="h-8 w-8 p-0 rounded-sm text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Single card — same style as the New-Order page. */}
      {view === "new" && (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 print:hidden">
        <div className="lg:col-span-12 bg-white border border-slate-200 rounded-sm p-5 space-y-4">
          {/* Customer picker */}
          <div>
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Customer
            </Label>
            <div className="relative mt-1.5" ref={suggestBoxRef}>
              <Input
                data-testid="estimate-customer-search"
                placeholder="Type customer name…"
                value={customerQuery}
                onChange={(e) => { setCustomerQuery(e.target.value); setSelectedCustomer(null); setShowSuggest(true); }}
                onFocus={() => setShowSuggest(true)}
                className="h-11 rounded-sm pr-24"
              />
              {selectedCustomer && (
                <Button
                  size="sm" variant="ghost" onClick={clearCustomer}
                  data-testid="estimate-customer-clear"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-9 px-3 text-xs"
                >
                  Change
                </Button>
              )}
              {showSuggest && customerQuery && !selectedCustomer && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-72 overflow-auto">
                  {displayHits.length === 0 && (
                    <div className="p-3 text-sm text-slate-500">No matching customer</div>
                  )}
                  {displayHits.map((c) => {
                    const place = [c.city, c.location].filter(Boolean).join(", ") || c.address || "";
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pickCustomer(c)}
                        data-testid={`estimate-customer-option-${c.id}`}
                        className="w-full text-left px-3 py-2.5 hover:bg-orange-50 border-b border-slate-100 last:border-0"
                      >
                        <div className="font-bold text-slate-900 text-sm leading-tight">{c.name}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5 flex-wrap">
                          {c.phone && <span>{c.phone}</span>}
                          {typeof c.match_score === "number" && (
                            <span className="font-mono-num">match {c.match_score}%</span>
                          )}
                        </div>
                        {place && (
                          <div className="mt-1 text-[11px] text-slate-600 leading-snug"
                               data-testid={`estimate-customer-place-${c.id}`}>
                            <span className="font-semibold text-slate-700">{place}</span>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected-customer card (mirrors New Order) */}
            {selectedCustomer && (
              <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded-sm"
                   data-testid="estimate-selected-customer-card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-slate-900">{selectedCustomer.name}</div>
                    <div className="text-xs text-slate-600">{selectedCustomer.phone}</div>
                  </div>
                  {selectedCustomer.private_mark && (
                    <span className="text-[10px] uppercase tracking-wider font-bold bg-white border border-orange-300 text-orange-900 px-2 py-1 rounded-sm">
                      Pvt mark: {selectedCustomer.private_mark}
                    </span>
                  )}
                </div>
                {(selectedCustomer.city || selectedCustomer.location || selectedCustomer.address || selectedCustomer.transport_name) && (
                  <div className="mt-2 pt-2 border-t border-orange-200 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
                    {selectedCustomer.city && (
                      <span className="flex items-center gap-1.5">
                        <Building2 className="w-3 h-3 text-orange-700" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">City:</span>
                        <span className="font-bold">{selectedCustomer.city}</span>
                      </span>
                    )}
                    {selectedCustomer.location && (
                      <span className="flex items-center gap-1.5">
                        <MapPin className="w-3 h-3 text-orange-700" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Location:</span>
                        <span className="font-bold">{selectedCustomer.location}</span>
                      </span>
                    )}
                    {selectedCustomer.transport_name && (
                      <span className="flex items-center gap-1.5">
                        <Truck className="w-3 h-3 text-orange-700" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Transport:</span>
                        <span className="font-bold">{selectedCustomer.transport_name}</span>
                      </span>
                    )}
                    {selectedCustomer.address && (
                      <span className="flex items-start gap-1.5 w-full">
                        <Home className="w-3 h-3 text-orange-700 mt-0.5 shrink-0" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px] shrink-0">Address:</span>
                        <span className="font-bold break-words">{selectedCustomer.address}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Price list — chosen right after the customer so item pricing
              is already known by the time the operator picks SKUs. Hidden
              until a customer is chosen to keep the flow linear. */}
          {selectedCustomer && (
            <div
              className="border-t border-slate-200 pt-4"
              data-testid="estimate-pricelist-block"
            >
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-[#E65100]" />
                Price list
              </Label>
              <Select
                value={priceListOverride || "__default__"}
                onValueChange={(v) => {
                  setPriceListOverride(v === "__default__" ? "" : v);
                  setEstimate(null);
                }}
              >
                <SelectTrigger
                  data-testid="estimate-pricelist-select"
                  className="h-11 rounded-sm mt-1.5"
                >
                  <SelectValue placeholder="Customer's default price list" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__" data-testid="estimate-pricelist-option-default">
                    Customer&apos;s default price list
                    {selectedCustomer?.price_list_id && (() => {
                      const def = priceLists.find((p) => p.id === selectedCustomer.price_list_id);
                      return def ? ` · ${def.name}` : "";
                    })()}
                  </SelectItem>
                  {priceLists.map((pl) => (
                    <SelectItem
                      key={pl.id}
                      value={pl.id}
                      data-testid={`estimate-pricelist-option-${pl.id}`}
                    >
                      {pl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5">
                {livePreview?.price_list_name ? (
                  <>
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span>
                      Live pricing from{" "}
                      <span className="font-bold text-slate-700">
                        {livePreview.price_list_name}
                      </span>
                    </span>
                  </>
                ) : (
                  <span>
                    Overrides the customer&apos;s assigned list for this estimate only.
                  </span>
                )}
              </div>
            </div>
          )}


          {/* Items — same 12-column grid style as New Order */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <ClipboardList className="w-3.5 h-3.5 text-[#E65100]" />
                Items &amp; quantity
              </Label>
              <Button
                size="sm" type="button" variant="outline" onClick={addRow}
                data-testid="estimate-add-row"
                className="h-8 rounded-sm border-slate-300"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add row
              </Button>
            </div>
            <div className="space-y-2">
              {rows.map((r, idx) => {
                const priced = r.item_id ? linePricing[r.item_id] : null;
                const net = Number(priced?.net_unit_price || 0);
                const qty = Number(r.quantity || 0);
                const lineTotal = qty > 0 ? qty * net : 0;
                const hasPrice = !!(r.item_id && priced && net > 0);
                return (
                  <div
                    key={idx}
                    className="border border-slate-200 rounded-sm p-2 bg-slate-50/40"
                    data-testid={`estimate-row-${idx}`}
                  >
                    {/* One-line layout:
                        [ Item search ] [ NET rate ] [ Qty ] [ Qty × Net ] [ Delete ]
                        NET sits BETWEEN the item name and the qty field so
                        the operator sees the per-piece rate the moment
                        they pick an item, and the line total updates as
                        qty is typed. */}
                    <div className="grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-12 sm:col-span-5">
                        <ItemSearchInput
                          value={r.item_id ? {
                            item_id: r.item_id,
                            item_name: r.item_name,
                            product_name: r.product_name,
                          } : null}
                          onChange={(picked) => updateRow(idx, {
                            item_id: picked?.item_id || "",
                            item_name: picked?.item_name || "",
                            product_name: picked?.product_name || "",
                          })}
                          testIdPrefix={`estimate-item-search-${idx}`}
                          customerId={selectedCustomer?.id || null}
                        />
                      </div>
                      {/* NET price cell — sits between item and qty */}
                      <div
                        className="col-span-6 sm:col-span-2 h-11 rounded-sm border border-slate-200 bg-white flex flex-col items-end justify-center px-3"
                        data-testid={`estimate-row-inline-net-${idx}`}
                      >
                        <span className="uppercase font-bold text-[9px] tracking-wider text-slate-500 leading-none">
                          Price
                        </span>
                        {r.item_id && hasPrice ? (
                          <span
                            className="font-mono-num font-extrabold text-slate-900 text-base leading-tight"
                            data-testid={`estimate-row-net-${idx}`}
                          >
                            ₹{fmtINR(net)}
                          </span>
                        ) : r.item_id && previewBusy ? (
                          <span className="italic text-slate-400 text-[11px] leading-tight">…</span>
                        ) : r.item_id ? (
                          <span className="italic text-rose-600 font-semibold text-[10px] leading-tight">
                            no price
                          </span>
                        ) : (
                          <span className="text-slate-300 text-base leading-tight">—</span>
                        )}
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        <Input
                          type="number" min="1"
                          placeholder="Qty"
                          value={r.quantity}
                          onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                          onFocus={(e) => e.target.select()}
                          data-testid={`estimate-qty-${idx}`}
                          className="h-11 rounded-sm font-mono-num no-spinner text-center"
                        />
                      </div>
                      <div
                        className="col-span-6 sm:col-span-2 h-11 rounded-sm border border-slate-200 bg-white flex flex-col items-end justify-center px-3"
                        data-testid={`estimate-row-line-wrap-${idx}`}
                      >
                        <span className="uppercase font-bold text-[9px] tracking-wider text-slate-500 leading-none">
                          Sum
                        </span>
                        <span
                          className="font-mono-num font-extrabold text-[#E65100] text-base leading-tight"
                          data-testid={`estimate-row-line-${idx}`}
                        >
                          ₹{fmtINR(lineTotal)}
                        </span>
                      </div>
                      <div className="col-span-3 sm:col-span-1">
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => removeRow(idx)}
                          data-testid={`estimate-row-remove-${idx}`}
                          className="h-11 w-full text-slate-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {r.product_name && (
                      <div className="mt-1.5 text-[11px] text-slate-500">
                        Master product:{" "}
                        <span className="font-semibold text-slate-700">{r.product_name}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Live totals footer — mirrors the final estimate slip so the
                operator knows the grand total BEFORE clicking Generate. */}
            {livePreview && livePreview.grand_total > 0 && (
              <div
                className="mt-3 border border-slate-300 rounded-sm bg-white overflow-hidden"
                data-testid="estimate-live-totals"
              >
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Live estimate · updates as you type
                </div>
                <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Subtotal</div>
                    <div className="font-mono-num font-bold text-slate-900"
                         data-testid="estimate-live-subtotal">
                      ₹{fmtINR(livePreview.subtotal)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">GST 18%</div>
                    <div className="font-mono-num font-bold text-slate-900"
                         data-testid="estimate-live-gst">
                      ₹{fmtINR(livePreview.gst)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Grand total</div>
                    <div className="font-mono-num font-extrabold text-[#E65100] text-base"
                         data-testid="estimate-live-grand">
                      ₹{fmtINR(livePreview.grand_total)}/-
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Total pieces</div>
                    <div className="font-mono-num font-bold text-slate-900"
                         data-testid="estimate-live-pcs">
                      {rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bill amount + generate button — price list picker is now
              above (right after customer selection). */}
          <div className="border-t border-slate-200 pt-4 grid grid-cols-12 gap-3 items-end">
            <div className="col-span-12 sm:col-span-6">
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Bill amount ₹
              </Label>
              <Input
                type="number" min="0" step="0.01"
                value={billAmount}
                onChange={(e) => { setBillAmount(e.target.value); setEstimate(null); }}
                onFocus={(e) => e.target.select()}
                placeholder="0.00"
                data-testid="estimate-bill-amount"
                className="h-11 rounded-sm mt-1.5 font-mono-num text-right no-spinner"
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Optional · cash = grand − bill
              </div>
            </div>
            <div className="col-span-12 sm:col-span-6">
              <Button
                onClick={compute}
                disabled={busy || !selectedCustomer}
                data-testid="estimate-compute-btn"
                className="w-full bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-11 px-6 font-bold"
              >
                <Calculator className="w-4 h-4 mr-1.5" />
                {busy ? "Computing…" : "Generate estimate"}
              </Button>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Result — slip-style breakdown (unchanged) */}
      {view === "new" && estimate && (
        <section
          className="bg-white border border-slate-300 rounded-sm p-6 print:border-slate-400 print:shadow-none"
          data-testid="estimate-result"
        >
          <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3 mb-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold flex items-center gap-2">
                Estimate
                {(savedNo || estimate.estimate_no) ? (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-slate-900 text-white text-[11px] font-mono font-bold tracking-normal"
                    data-testid="estimate-number-badge"
                  >
                    <Hash className="w-3 h-3" />{savedNo || estimate.estimate_no}
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm bg-amber-100 text-amber-800 text-[10px] font-bold tracking-normal">
                    Unsaved
                  </span>
                )}
              </div>
              <div className="font-heading text-2xl font-extrabold text-slate-900">
                {estimate.customer.name}
              </div>
              <div className="text-xs text-slate-600 mt-1 space-y-0.5">
                {estimate.customer.address && (<div>{estimate.customer.address}</div>)}
                {(estimate.customer.city || estimate.customer.location) && (
                  <div>{[estimate.customer.city, estimate.customer.location].filter(Boolean).join(", ")}</div>
                )}
                {estimate.customer.phone && (<div>Ph: {estimate.customer.phone}</div>)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                Date
              </div>
              <div className="text-sm font-mono font-bold text-slate-900">
                {new Date(estimate.generated_at).toLocaleString("en-IN", { hour12: false })}
              </div>
              {estimate.price_list_name && (
                <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-bold">
                  <FileText className="w-3 h-3" /> {estimate.price_list_name}
                </div>
              )}
              {!estimate.price_list_id && (
                <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-red-50 text-red-700 border border-red-200 text-[11px] font-bold">
                  No price list assigned
                </div>
              )}
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-slate-800 text-[11px] uppercase tracking-wider text-slate-700">
                <th className="text-left py-2 px-2">Item</th>
                <th className="text-right py-2 px-2 w-16">Qty</th>
                <th className="text-right py-2 px-2 w-24">Rate ₹</th>
                <th className="text-right py-2 px-2 w-24">Disc.</th>
                <th className="text-right py-2 px-2 w-24">Net ₹</th>
                <th className="text-right py-2 px-2 w-28">Line ₹</th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.map((l, i) => (
                <tr
                  key={`${l.item_id || l.item_name}-${i}`}
                  className={`border-b border-slate-200 ${!l.found ? "bg-red-50" : ""}`}
                  data-testid={`estimate-line-${i}`}
                >
                  <td className="py-2 px-2">
                    <div className="font-semibold text-slate-900">{l.item_name}</div>
                    {l.product_name && (
                      <div className="text-[11px] text-slate-500">{l.product_name}</div>
                    )}
                    {!l.found && (
                      <div className="text-[10px] font-bold text-red-700 uppercase tracking-wider">
                        Not found in catalog
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-mono">{l.quantity}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-mono">
                    {l.unit_price.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-mono">
                    {l.discount_value > 0 ? `${l.discount_value}${l.discount_type}` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-mono">
                    {l.net_unit_price.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-mono font-bold text-slate-900">
                    {l.line_value.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-800">
                <td colSpan={5} className="py-2 px-2 text-right font-bold uppercase tracking-wider text-slate-800">
                  Line total
                </td>
                <td
                  className="py-2 px-2 text-right tabular-nums font-mono font-extrabold text-slate-900"
                  data-testid="estimate-line-total"
                >
                  ₹ {estimate.totals.line_total.toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="mt-5 flex flex-wrap items-start gap-3">
            <div className="inline-block border-2 border-slate-400 rounded-sm divide-y divide-slate-300 min-w-[240px]">
              <div className="px-3 py-2 flex items-center justify-between gap-6">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  GST 18%
                </span>
                <span className="tabular-nums font-bold text-slate-900"
                      data-testid="estimate-gst-total">
                  ₹{Math.round(estimate.totals.gst || 0).toLocaleString("en-IN")}/-
                </span>
              </div>
              <div className="px-3 py-2 flex items-center justify-between gap-6">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Bill amount
                </span>
                <span className="tabular-nums font-bold text-slate-900"
                      data-testid="estimate-bill-total">
                  ₹{Math.round(estimate.totals.bill_amount).toLocaleString("en-IN")}/-
                </span>
              </div>
              {/* Hide the Cash row entirely when the bill amount already
                  covers the full GST-inclusive grand total (cash is 0 within
                  a ±₹2 rounding tolerance) — only the bill amount shows. */}
              {Number(estimate.totals.cash_amount) > 2 && (
                <div className="px-3 py-2 flex items-center justify-between gap-6">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Cash amount
                  </span>
                  <span className="tabular-nums font-bold text-slate-900"
                        data-testid="estimate-cash-total">
                    ₹{estimate.totals.cash_amount.toLocaleString("en-IN")}/-
                  </span>
                </div>
              )}
              <div className="px-3 py-2 flex items-center justify-between gap-6 bg-orange-50">
                <span className="text-xs font-extrabold uppercase tracking-wider text-[#E65100]">
                  Grand total
                </span>
                <span className="tabular-nums font-extrabold text-[#E65100]"
                      data-testid="estimate-grand-total">
                  ₹{estimate.totals.grand_total.toLocaleString("en-IN")}/-
                </span>
              </div>
            </div>

            {(estimate.customer.private_mark || estimate.customer.transport_name) && (
              <div className="inline-block border-2 border-slate-400 rounded-sm divide-y divide-slate-300 min-w-[240px]">
                {estimate.customer.private_mark && (
                  <div className="px-3 py-2 flex items-center justify-between gap-6">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Private mark
                    </span>
                    <span className="font-bold text-slate-900">
                      {estimate.customer.private_mark}
                    </span>
                  </div>
                )}
                {estimate.customer.transport_name && (
                  <div className="px-3 py-2 flex items-center justify-between gap-6">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Transport
                    </span>
                    <span className="font-bold text-slate-900">
                      {estimate.customer.transport_name}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 pt-3 border-t border-dashed border-slate-300 text-[10px] text-slate-500 flex justify-between">
            <div>Estimate only — not a tax invoice.</div>
            <div>Signature: ____________________</div>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />
    </div>
  );
}
