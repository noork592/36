import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useSearchParams } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  PackageCheck, Sparkles, Boxes, AlertCircle, Plus, Trash2,
  Search, Truck, ChevronRight, UserPlus, X, CalendarDays, MapPin,
} from "lucide-react";
import ItemSearchInput from "@/components/ItemSearchInput";
import DatePicker from "@/components/DatePicker";

export default function Dispatch() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5" data-testid="dispatch-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("dispatch.overline")}</div>
        <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("dispatch.title")}</h1>
        <p className="text-slate-500 text-sm mt-1">
          {t("dispatch.subtitle")}
        </p>
      </div>

      <Tabs defaultValue="stock-match" className="w-full">
        <TabsList className="bg-slate-100 h-10 p-1 rounded-sm w-full sm:w-auto">
          <TabsTrigger value="stock-match" data-testid="tab-stock-match" className="rounded-sm h-8 px-3 sm:px-4 flex-1 sm:flex-none text-xs sm:text-sm">
            <Boxes className="w-3.5 h-3.5 mr-1.5" /> {t("dispatch.tabStockMatch")}
          </TabsTrigger>
          <TabsTrigger value="direct" data-testid="tab-direct" className="rounded-sm h-8 px-3 sm:px-4 flex-1 sm:flex-none text-xs sm:text-sm">
            <Truck className="w-3.5 h-3.5 mr-1.5" /> {t("dispatch.tabDirect")}
          </TabsTrigger>
          <TabsTrigger value="off-order" data-testid="tab-off-order" className="rounded-sm h-8 px-3 sm:px-4 flex-1 sm:flex-none text-xs sm:text-sm">
            <UserPlus className="w-3.5 h-3.5 mr-1.5" /> {t("dispatch.tabOffOrder")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stock-match" className="mt-4">
          <StockMatchDispatch />
        </TabsContent>

        <TabsContent value="direct" className="mt-4">
          <DirectDispatch />
        </TabsContent>

        <TabsContent value="off-order" className="mt-4">
          <OffOrderDispatch />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Helper: today as YYYY-MM-DD in IST (matches backend backdating semantics).
const todayInIST = () => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  } catch {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
};

// =========================================================================
// Stock-Match Dispatch (existing flow, loosened to allow off-list items)
// =========================================================================
function StockMatchDispatch() {
  const { t } = useTranslation();
  // Each stock row: { item_id, item_name, product_name, qty, manual? }
  const [rows, setRows] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // Per-order editable allocations: { [order_id]: { [item_id]: giving_qty } }
  const [editedAlloc, setEditedAlloc] = useState({});
  const [dispatchingOrderId, setDispatchingOrderId] = useState(null);
  // Date of dispatch — defaults to today (IST). Operators may backdate
  // a slip when entering it later in the day or the next morning.
  const [dispatchDate, setDispatchDate] = useState(todayInIST());
  // Task 1 — Price list selection per dispatch suggestion.
  // Shape: { [order_id]: priceListId }. Pre-filled from the customer's
  // saved `price_list_id` when match results arrive, so the operator
  // sees their LAST CHOICE for that customer automatically.
  const [priceLists, setPriceLists] = useState([]);
  const [selectedPL, setSelectedPL] = useState({});

  // Load price-list catalog once for the dropdown options.
  useEffect(() => {
    api.get("/price-lists")
      .then((r) => setPriceLists(r.data || []))
      .catch(() => setPriceLists([]));
  }, []);

  // Voice agent prefill: ?prefill=<urlencoded JSON [{item_id,item_name,product_name,qty}]>
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const raw = searchParams.get("prefill");
    if (!raw) return;
    try {
      const arr = JSON.parse(decodeURIComponent(raw));
      if (Array.isArray(arr) && arr.length > 0) {
        setRows(arr.map((it) => ({
          item_id: it.item_id || null,
          item_name: it.item_name || it.name || "",
          product_name: it.product_name || "",
          qty: String(it.qty || it.quantity || ""),
        })));
        toast.success("Voice prefill applied — tap Match to run.");
      }
    } catch (_e) {
      // ignore malformed prefill
    }
    const next = new URLSearchParams(searchParams);
    next.delete("prefill");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addRow = () => setRows((rs) => [...rs, { item_id: null, item_name: "", product_name: "", qty: "", description: "" }]);
  const removeRow = (idx) => setRows((rs) => rs.filter((_, i) => i !== idx));
  const updateRow = (idx, patch) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const onItemPick = (idx, item) => {
    if (!item) {
      updateRow(idx, { item_id: null, item_name: "", product_name: "" });
      return;
    }
    const iid = item.item_id;
    const iname = item.item_name;
    if (rows.some((r, i) => i !== idx && r.item_id === iid)) {
      toast.warning(t("dispatch.errors.alreadyAdded", { name: iname }));
      return;
    }
    updateRow(idx, {
      item_id: iid,
      item_name: iname,
      product_name: item.product_name || "",
    });
  };

  const run = async () => {
    const valid = rows.filter((r) => r.item_id && Number(r.qty) > 0);
    if (valid.length === 0) {
      toast.error(t("dispatch.errors.addAtLeastOneItem"));
      return;
    }
    const items = Object.fromEntries(valid.map((r) => [r.item_id, Number(r.qty)]));
    setBusy(true);
    try {
      const { data } = await api.post("/dispatch/match", { items });
      setResult(data);
      const next = {};
      const nextPL = {};
      for (const s of data.suggestions) {
        next[s.order_id] = {};
        for (const a of s.allocations) {
          if (a.item_id) next[s.order_id][a.item_id] = a.allocated;
        }
        // Task 1 — pre-select the customer's saved price list so the
        // operator sees their previous choice and only changes it when
        // they want to override.
        if (s.price_list_id) nextPL[s.order_id] = s.price_list_id;
      }
      setEditedAlloc(next);
      setSelectedPL(nextPL);
      if (data.suggestions.length === 0) toast.warning(t("dispatch.errors.noMatches"));
      else toast.success(t("dispatch.success.matched", { count: data.suggestions.length }));
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("dispatch.errors.matchFailed"));
    } finally {
      setBusy(false);
    }
  };

  const updateGiving = (orderId, itemId, value) => {
    const num = Math.max(0, Number(value) || 0);
    setEditedAlloc((prev) => ({
      ...prev,
      [orderId]: { ...(prev[orderId] || {}), [itemId]: num },
    }));
  };

  const confirmDispatch = async (suggestion) => {
    const allocMap = editedAlloc[suggestion.order_id] || {};
    const allocations = suggestion.allocations
      .filter((a) => a.item_id && Number(allocMap[a.item_id] || 0) > 0)
      .map((a) => ({
        item_id: a.item_id, item_name: a.item_name, product_name: a.product_name,
        quantity: Number(allocMap[a.item_id]),
      }));
    if (allocations.length === 0) {
      toast.error(t("dispatch.errors.qtyGtZero"));
      return;
    }
    // Soft-warn (don't block) when giving more than what's in stock for an item.
    // Off-list items: no stock row → auto-add as manual entry after dispatch.
    const offList = [];
    for (const a of allocations) {
      const stockRow = rows.find((r) => r.item_id === a.item_id);
      if (!stockRow) {
        offList.push(a);
        continue;
      }
      const available = Number(stockRow.qty) || 0;
      if (a.quantity > available) {
        toast.warning(
          t("dispatch.errors.exceedsStock", { qty: a.quantity, name: a.item_name, available })
        );
      }
    }
    setDispatchingOrderId(suggestion.order_id);
    try {
      await api.post("/dispatch/execute", {
        order_id: suggestion.order_id,
        allocations: allocations.map((a) => {
          const stockRow = rows.find((rr) => rr.item_id === a.item_id);
          return {
            item_id: a.item_id,
            quantity: a.quantity,
            description: (stockRow?.description || "").trim(),
          };
        }),
        // Task 1 — persist the operator's price-list choice on the
        // customer so it auto-suggests next time. Send `""` to clear an
        // earlier choice if the dropdown was reset to "None".
        price_list_id: selectedPL[suggestion.order_id] ?? null,
        dispatched_at: dispatchDate || null,
      });
      const totalGiven = allocations.reduce((s, a) => s + a.quantity, 0);
      toast.success(t("dispatch.success.dispatched", { total: totalGiven, name: suggestion.customer_name }));
      // Subtract dispatched amount from existing stock rows.
      setRows((prev) => {
        const next = prev.map((r) => {
          const given = allocations.find((a) => a.item_id === r.item_id);
          if (!given) return r;
          const left = Math.max(0, Number(r.qty) - given.quantity);
          return { ...r, qty: String(left) };
        });
        // Auto-add off-list dispatched items as manual stock entries.
        for (const a of offList) {
          if (!next.some((r) => r.item_id === a.item_id)) {
            next.push({
              item_id: a.item_id,
              item_name: a.item_name,
              product_name: a.product_name || "",
              qty: "0",
              manual: true,
            });
          }
        }
        return next;
      });
      setResult((r) => ({
        ...r,
        suggestions: r.suggestions.filter((s) => s.order_id !== suggestion.order_id),
      }));
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("dispatch.errors.dispatchFailed"));
    } finally {
      setDispatchingOrderId(null);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <div className="lg:col-span-5 bg-white border border-slate-200 rounded-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Boxes className="w-4 h-4 text-[#E65100]" />
            <div className="text-[10px] uppercase tracking-[0.15em] font-bold text-slate-600">{t("dispatch.availableStock")}</div>
          </div>
          <span className="text-xs text-slate-400 font-mono-num">{t("dispatch.rowsCount", { count: rows.length })}</span>
        </div>

        {/* Dispatch date — applies to every slip dispatched from this panel */}
        <div className="mb-4 flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-sm">
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="w-4 h-4 text-[#E65100] shrink-0" />
            <div className="text-[10px] uppercase tracking-[0.15em] font-bold text-slate-600 whitespace-nowrap">
              Dispatch date
            </div>
          </div>
          <div className="w-48">
            <DatePicker
              value={dispatchDate}
              onChange={setDispatchDate}
              max={todayInIST()}
              testId="stock-match-dispatch-date"
              buttonClassName="h-9 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2.5">
          {rows.length === 0 && (
            <div className="text-center py-6 border border-dashed border-slate-200 rounded-sm text-slate-400 text-sm">
              {t("dispatch.noItemsYet")}
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-start" data-testid={`stock-row-${i}`}>
              <div className="col-span-7">
                <ItemSearchInput
                  value={r.item_id ? { item_id: r.item_id, item_name: r.item_name, product_name: r.product_name } : null}
                  onChange={(it) => onItemPick(i, it)}
                  testIdPrefix={`stock-item-${i}`}
                />
                {r.product_name && (
                  <div className="text-[10px] text-slate-400 mt-1 truncate flex items-center gap-1.5">
                    {r.product_name}
                    {r.manual && (
                      <span className="text-[9px] uppercase tracking-wider font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded-sm">
                        {t("dispatch.manual")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="col-span-4">
                <Input
                  type="number"
                  min="0"
                  placeholder={t("common.qty")}
                  value={r.qty}
                  onChange={(e) => updateRow(i, { qty: e.target.value })}
                  data-testid={`stock-qty-${i}`}
                  className="h-10 rounded-sm font-mono-num text-right"
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(i)}
                  data-testid={`stock-remove-${i}`}
                  className="h-10 w-10 p-0 rounded-sm text-slate-400 hover:text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              {/* Per-item description / note — prints under the item on the slip */}
              <div className="col-span-12">
                <Input
                  value={r.description || ""}
                  onChange={(e) => updateRow(i, { description: e.target.value })}
                  placeholder="Description / note (optional) — prints on slip under this item"
                  data-testid={`stock-desc-${i}`}
                  className="h-9 rounded-sm text-sm bg-slate-50"
                />
              </div>
            </div>
          ))}
        </div>

        <Button
          onClick={addRow}
          variant="outline"
          data-testid="add-stock-row-btn"
          className="w-full mt-3 h-10 rounded-sm border-dashed border-slate-300 text-slate-600 hover:bg-slate-50"
        >
          <Plus className="w-4 h-4 mr-1" /> {t("dispatch.addItem")}
        </Button>

        <Button
          onClick={run}
          disabled={busy || rows.length === 0}
          data-testid="match-stock-btn"
          className="w-full mt-3 h-12 bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm font-bold active:scale-[0.98]"
        >
          <Sparkles className="w-4 h-4 mr-2" /> {busy ? t("dispatch.matching") : t("dispatch.suggestMatches")}
        </Button>

        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
          <Trans i18nKey="dispatch.stockTip" components={{ b: <b /> }} />
        </div>
      </div>

      <div className="lg:col-span-7 space-y-4">
        {!result && (
          <div className="bg-white border border-dashed border-slate-300 rounded-sm p-10 text-center text-slate-400" data-testid="dispatch-empty">
            <PackageCheck className="w-10 h-10 mx-auto mb-2 text-slate-300" />
            <Trans i18nKey="dispatch.emptyPrompt" components={{ b: <b className="text-slate-600" /> }} />
          </div>
        )}
        {result && (
          <>
            {result.per_item_allocated?.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-sm">
                <div className="px-5 py-3 border-b border-slate-200">
                  <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dispatch.itemAllocations")}</div>
                  <h3 className="font-heading text-base font-bold text-slate-900">{t("dispatch.skusShipping")}</h3>
                </div>
                <div className="divide-y divide-slate-100">
                  {result.per_item_allocated.map((a) => (
                    <div key={a.item_id} className="px-5 py-2.5 flex items-center justify-between" data-testid={`alloc-${a.item_id}`}>
                      <div className="min-w-0 pr-3">
                        <div className="font-semibold text-slate-900 text-sm truncate">{a.item_name}</div>
                        {a.product_name && (
                          <div className="text-[11px] text-slate-400 truncate">{a.product_name}</div>
                        )}
                      </div>
                      <span className="number-pill shrink-0">{a.allocated_qty} {t("common.pcs")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-sm">
              <div className="px-5 py-3 border-b border-slate-200">
                <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dispatch.bagCalc")}</div>
                <h3 className="font-heading text-base font-bold text-slate-900">{t("dispatch.packingPlan")}</h3>
              </div>
              {result.bag_calculation.length === 0 ? (
                <div className="p-5 text-sm text-slate-400">{t("dispatch.noAllocations")}</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {result.bag_calculation.map((b, idx) => {
                    const label = b.scope === "item" ? b.item_name : b.product_name;
                    const sub = b.scope === "item"
                      ? `${b.product_name} · ${t("dispatch.skuBagSize")}`
                      : t("dispatch.categoryBagSize");
                    return (
                      <div key={`${b.scope || "p"}-${b.item_id || b.product_name}-${idx}`}
                           className="px-5 py-3 flex items-center justify-between"
                           data-testid={`bag-${b.item_id || b.product_name}`}>
                        <div>
                          <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                            {label}
                            {b.scope === "item" && (
                              <span className="text-[9px] uppercase tracking-wider font-bold text-[#E65100] bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-sm">SKU</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            {t("dispatch.perBag", { allocated: b.allocated_qty, min: b.min_per_bag, max: b.max_per_bag, sub })}
                          </div>
                        </div>
                        <span className="number-pill">{b.bag_range_label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {result.leftover_stock?.length > 0 && (
                <div className="px-5 py-3 border-t border-slate-200 bg-amber-50 text-xs text-amber-900 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold">{t("dispatch.leftoverStock")}</span>{" "}
                    {result.leftover_stock.map((l) => `${l.item_name} ×${l.quantity}`).join(", ")}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-sm">
              <div className="px-5 py-3 border-b border-slate-200">
                <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dispatch.suggestedFulfillment")}</div>
                <h3 className="font-heading text-base font-bold text-slate-900">{t("dispatch.matchingOrders", { count: result.suggestions.length })}</h3>
              </div>
              {result.suggestions.length === 0 ? (
                <div className="p-6 text-sm text-slate-400">{t("dispatch.noOrdersMatch")}</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {result.suggestions.map((s) => {
                    const allocMap = editedAlloc[s.order_id] || {};
                    const totalGiving = s.allocations.reduce(
                      (sum, a) => sum + (a.item_id ? Number(allocMap[a.item_id] || 0) : 0),
                      0
                    );
                    const isDispatching = dispatchingOrderId === s.order_id;
                    return (
                    <div key={s.order_id} className="p-4" data-testid={`suggest-${s.order_id}`}>
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-bold text-slate-900">{s.customer_name}</div>
                            {[s.customer_city, s.customer_location].filter(Boolean).length > 0 && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-[#E65100] bg-orange-50 border border-orange-200 rounded-sm px-1.5 py-0.5"
                                data-testid={`suggest-city-${s.order_id}`}
                              >
                                <MapPin className="w-3 h-3" />
                                {[s.customer_city, s.customer_location].filter(Boolean).join(", ")}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            #{s.order_id.slice(0, 8)} · {new Date(s.order_date).toLocaleDateString()}
                            {s.fully_fulfilled && <span className="ml-2 text-green-700 font-bold">{t("dispatch.fullMatch")}</span>}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => confirmDispatch(s)}
                          disabled={isDispatching || totalGiving === 0}
                          data-testid={`dispatch-btn-${s.order_id}`}
                          className="h-9 bg-slate-900 hover:bg-black text-white rounded-sm disabled:opacity-50"
                        >
                          <PackageCheck className="w-3.5 h-3.5 mr-1" />
                          {isDispatching ? t("dispatch.dispatching") : t("dispatch.dispatchPcs", { n: totalGiving })}
                        </Button>
                      </div>
                      {/* Task 1 — price list selector. Pre-filled from the
                          customer's last saved choice; the next dispatch
                          for the same party auto-suggests this value. */}
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                          Price list
                        </div>
                        <select
                          value={selectedPL[s.order_id] || ""}
                          onChange={(e) => setSelectedPL((p) => ({ ...p, [s.order_id]: e.target.value }))}
                          data-testid={`pricelist-select-${s.order_id}`}
                          className="text-xs border border-slate-300 rounded-sm px-2 py-1 bg-white focus:border-[#E65100] focus:outline-none"
                        >
                          <option value="">— None —</option>
                          {priceLists.map((pl) => (
                            <option key={pl.id} value={pl.id}>{pl.name}</option>
                          ))}
                        </select>
                        {selectedPL[s.order_id] && s.price_list_id === selectedPL[s.order_id] && (
                          <span className="text-[10px] text-emerald-700 font-bold">
                            (saved for this customer)
                          </span>
                        )}
                        {selectedPL[s.order_id] && s.price_list_id !== selectedPL[s.order_id] && (
                          <span className="text-[10px] text-amber-700 font-bold">
                            (will be saved on dispatch)
                          </span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {s.allocations.map((a, i) => {
                          if (!a.item_id) {
                            return (
                              <div key={i} className="p-2 border rounded-sm text-xs bg-slate-50 border-slate-200">
                                <div className="font-bold text-slate-800">
                                  {a.item_name || a.product_name}{a.variant ? ` (${a.variant})` : ""}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">{t("dispatch.noSku")}</div>
                              </div>
                            );
                          }
                          const giving = Number(allocMap[a.item_id] ?? a.allocated);
                          const inStock = a.allocated > 0;
                          return (
                          <div
                            key={i}
                            className={`p-3 border rounded-sm text-sm ${
                              giving >= a.needed && a.needed > 0
                                ? "bg-green-50 border-green-200"
                                : giving > 0
                                ? "bg-amber-50 border-amber-200"
                                : "bg-slate-50 border-slate-200"
                            }`}
                          >
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-1.5">
                              {a.item_name || a.product_name}{a.variant ? ` (${a.variant})` : ""}
                              {!inStock && (
                                <span className="text-[9px] uppercase tracking-wider font-bold text-amber-700 bg-amber-50 border border-amber-300 px-1 py-0.5 rounded-sm" data-testid={`off-list-${s.order_id}-${a.item_id}`}>
                                  {t("dispatch.offList")}
                                </span>
                              )}
                            </div>
                            {a.product_name && a.item_name && a.product_name !== a.item_name && (
                              <div className="text-[10px] text-slate-400">{a.product_name}</div>
                            )}
                            <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                              <div className="flex items-baseline gap-3 font-mono-num tabular-nums">
                                <span className="text-slate-500">
                                  <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mr-1">{t("dispatch.needLabel")}</span>
                                  <span className="text-lg font-bold text-slate-900">{Number(a.needed).toLocaleString("en-IN")}</span>
                                </span>
                                <span className="text-slate-500">
                                  <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mr-1">{t("dispatch.suggestedLabel")}</span>
                                  <span className="text-lg font-bold text-slate-700">{Number(a.allocated).toLocaleString("en-IN")}</span>
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">{t("dispatch.give")}</span>
                                <Input
                                  type="number"
                                  min="0"
                                  max={a.needed}
                                  value={allocMap[a.item_id] ?? a.allocated}
                                  onChange={(e) => updateGiving(s.order_id, a.item_id, e.target.value)}
                                  onFocus={(e) => e.target.select()}
                                  data-testid={`give-input-${s.order_id}-${a.item_id}`}
                                  className="h-10 w-24 text-right font-mono-num text-lg font-bold rounded-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                />
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Direct Dispatch — pick any pending order, dispatch any quantity
// =========================================================================
function DirectDispatch() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [giveMap, setGiveMap] = useState({}); // { [order_id]: { [item_id]: qty } }
  const [descMap, setDescMap] = useState({}); // { [order_id]: { [item_id]: description } }
  const [dispatchingId, setDispatchingId] = useState(null);
  const [dispatchDate, setDispatchDate] = useState(todayInIST());

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/orders", { params: { status_filter: "Pending" } });
      setOrders(data);
    } catch (e) {
      toast.error(t("dispatch.errors.loadPendingFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => {
      if (o.customer_name?.toLowerCase().includes(q)) return true;
      if (o.id?.toLowerCase().includes(q)) return true;
      return (o.items || []).some(
        (it) =>
          it.item_name?.toLowerCase().includes(q) ||
          it.product_name?.toLowerCase().includes(q)
      );
    });
  }, [orders, query]);

  const setGiveQty = (orderId, itemId, value) => {
    const num = Math.max(0, Number(value) || 0);
    setGiveMap((prev) => ({
      ...prev,
      [orderId]: { ...(prev[orderId] || {}), [itemId]: num },
    }));
  };

  const setGiveDesc = (orderId, itemId, value) => {
    setDescMap((prev) => ({
      ...prev,
      [orderId]: { ...(prev[orderId] || {}), [itemId]: value },
    }));
  };

  const fillAll = (order) => {
    const next = {};
    (order.items || []).forEach((it) => {
      if (it.item_id) next[it.item_id] = Number(it.quantity) || 0;
    });
    setGiveMap((prev) => ({ ...prev, [order.id]: next }));
  };

  const clearAll = (orderId) => {
    setGiveMap((prev) => ({ ...prev, [orderId]: {} }));
  };

  const dispatch = async (order) => {
    const allocMap = giveMap[order.id] || {};
    const orderDescs = descMap[order.id] || {};
    const allocations = (order.items || [])
      .filter((it) => it.item_id && Number(allocMap[it.item_id] || 0) > 0)
      .map((it) => ({
        item_id: it.item_id,
        quantity: Math.min(Number(allocMap[it.item_id]), Number(it.quantity) || 0),
        description: (orderDescs[it.item_id] || "").trim(),
      }));
    if (allocations.length === 0) {
      toast.error(t("dispatch.errors.qtyGtZeroDirect"));
      return;
    }
    setDispatchingId(order.id);
    try {
      const { data } = await api.post("/dispatch/execute", {
        order_id: order.id,
        allocations,
        dispatched_at: dispatchDate || null,
      });
      const total = allocations.reduce((s, a) => s + a.quantity, 0);
      toast.success(t("dispatch.success.dispatched", { total, name: order.customer_name }));
      // Refresh orders
      setGiveMap((prev) => {
        const next = { ...prev }; delete next[order.id]; return next;
      });
      setDescMap((prev) => {
        const next = { ...prev }; delete next[order.id]; return next;
      });
      if (data.fully_dispatched) {
        setOrders((prev) => prev.filter((o) => o.id !== order.id));
        setExpandedId(null);
      } else {
        setOrders((prev) => prev.map((o) => (o.id === order.id ? data.order : o)));
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("dispatch.errors.dispatchFailedShort"));
    } finally {
      setDispatchingId(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-sm" data-testid="direct-dispatch-panel">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dispatch.tabDirect")}</div>
          <h3 className="font-heading text-base font-bold text-slate-900">
            {t("dispatch.directHeading")}
          </h3>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-sm px-2.5 py-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-[#E65100]" />
            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-600 whitespace-nowrap">
              Dispatch date
            </span>
            <div className="w-44">
              <DatePicker
                value={dispatchDate}
                onChange={setDispatchDate}
                max={todayInIST()}
                testId="direct-dispatch-date"
                buttonClassName="h-8 text-xs"
              />
            </div>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder={t("dispatch.directSearch")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="direct-search"
              className="h-9 pl-8 rounded-sm"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-slate-400 text-sm">{t("dispatch.loadingPending")}</div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-slate-400 text-sm" data-testid="direct-empty">
          {orders.length === 0 ? t("dispatch.noPending") : t("dispatch.noSearchMatch")}
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {filtered.map((o) => {
            const isOpen = expandedId === o.id;
            const allocMap = giveMap[o.id] || {};
            const totalGiving = (o.items || []).reduce(
              (s, it) => s + (it.item_id ? Number(allocMap[it.item_id] || 0) : 0),
              0
            );
            const isBusy = dispatchingId === o.id;
            return (
              <div key={o.id} data-testid={`direct-order-${o.id}`}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : o.id)}
                  data-testid={`direct-order-toggle-${o.id}`}
                  className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50 transition text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-bold text-slate-900 truncate">{o.customer_name}</div>
                      {[o.customer_city, o.customer_location].filter(Boolean).length > 0 && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-[#E65100] bg-orange-50 border border-orange-200 rounded-sm px-1.5 py-0.5"
                          data-testid={`direct-order-city-${o.id}`}
                        >
                          <MapPin className="w-3 h-3" />
                          {[o.customer_city, o.customer_location].filter(Boolean).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono-num">
                      #{o.id.slice(0, 8)} · {new Date(o.order_date || o.created_at).toLocaleDateString()} · {t("dispatch.rowsCount", { count: (o.items || []).length })}
                    </div>
                  </div>
                  <ChevronRight className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 bg-slate-50/50 border-t border-slate-100">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                      {(o.items || []).map((it, i) => {
                        const give = it.item_id ? Number(allocMap[it.item_id] || 0) : 0;
                        const need = Number(it.quantity) || 0;
                        const orderDescs = descMap[o.id] || {};
                        const descVal = it.item_id ? (orderDescs[it.item_id] || "") : "";
                        return (
                          <div
                            key={i}
                            className={`p-3 border rounded-sm text-sm ${
                              give >= need && need > 0
                                ? "bg-green-50 border-green-200"
                                : give > 0
                                ? "bg-amber-50 border-amber-200"
                                : "bg-white border-slate-200"
                            }`}
                            data-testid={`direct-item-${o.id}-${i}`}
                          >
                            <div className="font-bold text-slate-900 text-sm truncate">
                              {it.item_name || it.product_name}
                              {it.variant ? ` (${it.variant})` : ""}
                            </div>
                            {it.product_name && it.item_name && it.product_name !== it.item_name && (
                              <div className="text-[10px] text-slate-400 truncate">{it.product_name}</div>
                            )}
                            <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                              <span className="font-mono-num tabular-nums">
                                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mr-1">{t("dispatch.needLabel")}</span>
                                <span className="text-lg font-bold text-slate-900">{Number(need).toLocaleString("en-IN")}</span>
                              </span>
                              {it.item_id ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">{t("dispatch.give")}</span>
                                  <Input
                                    type="number"
                                    min="0"
                                    max={need}
                                    value={allocMap[it.item_id] ?? ""}
                                    onChange={(e) => setGiveQty(o.id, it.item_id, e.target.value)}
                                    onFocus={(e) => e.target.select()}
                                    data-testid={`direct-give-${o.id}-${it.item_id}`}
                                    className="h-10 w-24 text-right font-mono-num text-lg font-bold rounded-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  />
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-400">{t("dispatch.noSkuShort")}</span>
                              )}
                            </div>
                            {/* Per-item description / note — prints on slip under this item */}
                            {it.item_id && (
                              <div className="mt-2">
                                <Input
                                  value={descVal}
                                  onChange={(e) => setGiveDesc(o.id, it.item_id, e.target.value)}
                                  placeholder="Description / note (optional)"
                                  data-testid={`direct-desc-${o.id}-${it.item_id}`}
                                  className="h-8 rounded-sm text-xs bg-white/70 border-slate-300"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => fillAll(o)}
                          data-testid={`direct-fill-${o.id}`}
                          className="h-8 rounded-sm text-xs border-slate-300"
                        >
                          {t("dispatch.fillFullQty")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => clearAll(o.id)}
                          data-testid={`direct-clear-${o.id}`}
                          className="h-8 rounded-sm text-xs text-slate-500"
                        >
                          {t("dispatch.clearGive")}
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => dispatch(o)}
                        disabled={isBusy || totalGiving === 0}
                        data-testid={`direct-dispatch-${o.id}`}
                        className="h-9 bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm disabled:opacity-50"
                      >
                        <PackageCheck className="w-3.5 h-3.5 mr-1" />
                        {isBusy ? t("dispatch.dispatching") : t("dispatch.dispatchPcs", { n: totalGiving })}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// =========================================================================
// Off-Order Dispatch — dispatch any SKUs to any party WITHOUT an order
// =========================================================================
function OffOrderDispatch() {
  const { t } = useTranslation();
  const [customers, setCustomers] = useState([]); // search results
  const [customer, setCustomer] = useState(null); // { id, name, transport_name, ... } OR { name: "...", walkIn: true }
  const [custQuery, setCustQuery] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [transport, setTransport] = useState("");
  const [pvtMark, setPvtMark] = useState("");
  const [bagCount, setBagCount] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([{ id: crypto.randomUUID(), item: null, qty: "", description: "" }]);
  const [busy, setBusy] = useState(false);
  const [lastDispatch, setLastDispatch] = useState(null);
  const [dispatchDate, setDispatchDate] = useState(todayInIST());
  // Task 1 — Price list per-customer selector. Loaded once for the dropdown.
  // `priceListId` is auto-filled from the picked customer's saved choice and
  // is persisted on dispatch so the next slip auto-suggests the same list.
  const [priceLists, setPriceLists] = useState([]);
  const [priceListId, setPriceListId] = useState("");

  // Load the price-list catalog once.
  useEffect(() => {
    api.get("/price-lists")
      .then((r) => setPriceLists(r.data || []))
      .catch(() => setPriceLists([]));
  }, []);

  // Customer fuzzy search (skip when the user has already picked one)
  useEffect(() => {
    if (customer) return;
    const q = custQuery.trim();
    if (!q) { setCustomers([]); return; }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/customers/search", { params: { q } });
        setCustomers(data || []);
        setShowSuggest(true);
      } catch (e) {
        console.warn("customer search failed", e);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [custQuery, customer]);

  const pickCustomer = (c) => {
    setCustomer(c);
    setCustQuery(c.name);
    setShowSuggest(false);
    setTransport(c.transport_name || "");
    // Bill-number-mode parties: start with an EMPTY box for a manually-typed
    // bill number (do NOT prefill the party's private mark).
    setPvtMark(c.bill_number_mode ? "" : (c.private_mark || ""));
    // Pre-select the customer's saved price list, if any.
    setPriceListId(c.price_list_id || "");
  };

  const useWalkIn = () => {
    const name = custQuery.trim();
    if (!name) {
      toast.error(t("dispatch.offOrder.errors.nameRequired"));
      return;
    }
    setCustomer({ id: null, name, walkIn: true });
    setShowSuggest(false);
    setPvtMark("");
    setPriceListId("");
  };

  const clearCustomer = () => {
    setCustomer(null);
    setCustQuery("");
    setTransport("");
    setPvtMark("");
    setCustomers([]);
    setPriceListId("");
  };

  const addRow = () => setRows((r) => [...r, { id: crypto.randomUUID(), item: null, qty: "", description: "" }]);
  const removeRow = (id) => setRows((r) => (r.length === 1 ? r : r.filter((x) => x.id !== id)));
  const updateRow = (id, patch) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const totalPcs = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.qty) > 0 && r.item?.item_id ? Number(r.qty) : 0), 0),
    [rows],
  );

  const canDispatch = customer && rows.some((r) => r.item?.item_id && Number(r.qty) > 0);

  const doDispatch = async () => {
    const items = rows
      .filter((r) => r.item?.item_id && Number(r.qty) > 0)
      .map((r) => ({ item_id: r.item.item_id, quantity: Number(r.qty), description: (r.description || "").trim() }));
    if (items.length === 0) {
      toast.error(t("dispatch.offOrder.errors.itemRequired"));
      return;
    }
    setBusy(true);
    try {
      // If the operator edited the private mark for an existing customer,
      // persist it on the customer record so future dispatches inherit it.
      // Skip this entirely for bill-number-mode parties — the typed value is
      // a per-dispatch Bill Number, NOT a saved private mark.
      if (!customer.bill_number_mode && customer.id && (pvtMark || "") !== (customer.private_mark || "")) {
        try {
          await api.patch(`/customers/${customer.id}`, { private_mark: pvtMark || "" });
        } catch (e) {
          // Non-fatal — dispatch should still proceed even if the mark
          // couldn't be saved. Operator will see the toast for the main call.
          console.warn("Failed to persist private_mark", e);
        }
      }
      const payload = {
        customer_id: customer.id || null,
        customer_name: customer.id ? null : customer.name,
        transport_name: transport || null,
        items,
        notes: notes || null,
        // Bill-number-mode parties: send the manually-typed value as the
        // dispatch's Bill Number instead of a private mark.
        bill_number: customer.bill_number_mode ? (pvtMark || null) : null,
        dispatched_at: dispatchDate || null,
        bag_count: bagCount === "" || bagCount === null ? null : Math.max(0, parseInt(bagCount, 10) || 0),
        // Task 1 — Persist the operator's chosen price list on the
        // customer so the NEXT off-order dispatch auto-suggests it.
        // Walk-ins (no customer.id) have nowhere to save, so we omit.
        ...(customer.id ? { price_list_id: priceListId || "" } : {}),
      };
      const { data } = await api.post("/dispatch/off-order", payload);
      setLastDispatch(data.dispatch);
      toast.success(t("dispatch.offOrder.success", { pcs: data.dispatch.total_pcs }));
      // Fully clear the form for the next entry — customer, transport,
      // price-list, notes, item rows. Operators were seeing stale fields
      // bleeding into the next slip after a dispatch, which led to
      // accidental misattribution.
      setRows([{ id: crypto.randomUUID(), item: null, qty: "", description: "" }]);
      setNotes("");
      setCustomer(null);
      setCustQuery("");
      setTransport("");
      setPvtMark("");
      setBagCount("");
      setPriceListId("");
      setCustomers([]);
      setShowSuggest(false);
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("dispatch.offOrder.errors.dispatchFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="off-order-dispatch">
      {/* Help banner */}
      <div className="bg-orange-50 border border-orange-200 rounded-sm p-3 text-xs text-orange-900 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div>{t("dispatch.offOrder.hint")}</div>
      </div>

      {/* Customer */}
      <div className="bg-white border border-slate-200 rounded-sm p-4">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2">
          {t("dispatch.offOrder.partyLabel")}
        </div>
        {!customer ? (
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  data-testid="off-order-customer-input"
                  value={custQuery}
                  onChange={(e) => setCustQuery(e.target.value)}
                  onFocus={() => setShowSuggest(true)}
                  placeholder={t("dispatch.offOrder.partyPlaceholder")}
                  className="pl-9 h-10 rounded-sm"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={useWalkIn}
                disabled={!custQuery.trim()}
                data-testid="off-order-walkin-btn"
                className="rounded-sm h-10 whitespace-nowrap"
              >
                <UserPlus className="w-4 h-4 mr-1" /> {t("dispatch.offOrder.useAsWalkIn")}
              </Button>
            </div>
            {showSuggest && customers.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-60 overflow-y-auto" data-testid="off-order-suggestions">
                {customers.slice(0, 12).map((c) => {
                  const locLabel = [c.city, c.location].filter(Boolean).join(", ");
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pickCustomer(c)}
                      className="w-full text-left px-3 py-2 hover:bg-orange-50 border-b border-slate-100 last:border-b-0"
                      data-testid={`off-order-suggestion-${c.id}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-bold text-sm text-slate-900 truncate">{c.name}</div>
                        {locLabel && (
                          <span
                            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-[#E65100] bg-orange-50 border border-orange-200 rounded-sm px-1.5 py-0.5"
                            data-testid={`off-order-suggestion-city-${c.id}`}
                          >
                            <MapPin className="w-3 h-3" />
                            {locLabel}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {c.address ? c.address : "—"}
                        {c.transport_name ? ` · ${c.transport_name}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-sm px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="font-bold text-slate-900 text-sm truncate">
                  {customer.name}
                </div>
                {customer.walkIn && (
                  <span className="inline-block px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] uppercase tracking-wider font-bold rounded-sm">
                    {t("dispatch.offOrder.walkInBadge")}
                  </span>
                )}
                {[customer.city, customer.location].filter(Boolean).length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-[#E65100] bg-orange-50 border border-orange-200 rounded-sm px-1.5 py-0.5"
                    data-testid="off-order-selected-city"
                  >
                    <MapPin className="w-3 h-3" />
                    {[customer.city, customer.location].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
              {(customer.address || customer.transport_name) && (
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {customer.address || ""}
                  {customer.transport_name ? ` · ${customer.transport_name}` : ""}
                </div>
              )}
            </div>
            <button type="button" onClick={clearCustomer} className="text-slate-400 hover:text-slate-700" data-testid="off-order-clear-customer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Transport override + Dispatch date + Party private mark + No. of bags — single row */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block mb-1">
              {t("dispatch.offOrder.transportLabel")}
            </label>
            <Input
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              placeholder={t("dispatch.offOrder.transportPlaceholder")}
              className="h-10 rounded-sm"
              data-testid="off-order-transport"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block mb-1 flex items-center gap-1">
              <CalendarDays className="w-3 h-3 text-[#E65100]" />
              Dispatch date
            </label>
            <DatePicker
              value={dispatchDate}
              onChange={setDispatchDate}
              max={todayInIST()}
              testId="off-order-dispatch-date"
              buttonClassName="h-10 w-full"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold block mb-1"
                   style={{ color: customer?.bill_number_mode ? "#4338CA" : undefined }}>
              {customer?.bill_number_mode ? "Bill Number" : "Customer pvt mark"}
            </label>
            <Input
              value={pvtMark}
              onChange={(e) => setPvtMark(e.target.value)}
              placeholder={
                !customer
                  ? "Pick a party first"
                  : customer.bill_number_mode
                    ? "Enter Bill Number Here"
                    : (!customer.walkIn ? "e.g. MRK-A · saved to party" : "Optional mark")
              }
              disabled={!customer}
              className={`h-10 rounded-sm disabled:bg-slate-50 disabled:cursor-not-allowed ${customer?.bill_number_mode ? "border-indigo-400 focus-visible:ring-indigo-400 bg-indigo-50/40" : ""}`}
              data-testid="off-order-pvt-mark"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block mb-1">
              No. of bags
            </label>
            <Input
              type="number"
              min="0"
              step="1"
              value={bagCount}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") { setBagCount(""); return; }
                const n = parseInt(v, 10);
                setBagCount(Number.isNaN(n) || n < 0 ? "" : String(n));
              }}
              placeholder="e.g. 12"
              className="no-spinner h-10 rounded-sm font-mono-num text-right"
              data-testid="off-order-bag-count"
            />
          </div>
        </div>

        {/* Task 1 — Predefined price list per customer.
             Pre-fills from the picked customer's saved choice; saved back
             on dispatch so the next slip auto-suggests the same list. */}
        {customer && !customer.walkIn && (
          <div className="mt-3" data-testid="off-order-pricelist-row">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block mb-1">
              Price list (saved per customer)
            </label>
            <select
              value={priceListId}
              onChange={(e) => setPriceListId(e.target.value)}
              data-testid="off-order-pricelist-select"
              className="h-10 w-full px-3 rounded-sm border border-slate-300 bg-white text-sm focus:border-[#E65100] focus:outline-none"
            >
              <option value="">— None —</option>
              {priceLists.map((pl) => (
                <option key={pl.id} value={pl.id}>{pl.name}</option>
              ))}
            </select>
            {priceListId && customer.price_list_id === priceListId && (
              <div className="text-[10px] text-emerald-700 font-bold mt-1">
                Pre-selected from this customer's last dispatch.
              </div>
            )}
            {priceListId && customer.price_list_id !== priceListId && (
              <div className="text-[10px] text-amber-700 font-bold mt-1">
                This will be saved on dispatch and used next time.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Items */}
      <div className="bg-white border border-slate-200 rounded-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
            {t("dispatch.offOrder.itemsLabel")} ({rows.length})
          </div>
          <Button type="button" onClick={addRow} variant="outline" size="sm" className="rounded-sm h-8" data-testid="off-order-add-row">
            <Plus className="w-3.5 h-3.5 mr-1" /> {t("dispatch.offOrder.addItem")}
          </Button>
        </div>
        <div className="space-y-2">
          {rows.map((r, idx) => (
            <div key={r.id} className="grid grid-cols-12 gap-2 items-start" data-testid={`off-order-row-${r.id}`}>
              <div className="col-span-12 sm:col-span-8">
                <ItemSearchInput
                  value={r.item}
                  onChange={(it) => updateRow(r.id, { item: it })}
                  testIdPrefix={`off-order-item-${idx}`}
                  customerId={customer?.id || null}
                />
              </div>
              <div className="col-span-9 sm:col-span-3">
                <Input
                  type="number"
                  min="0"
                  value={r.qty}
                  onChange={(e) => updateRow(r.id, { qty: e.target.value })}
                  onFocus={(e) => e.target.select()}
                  placeholder={t("dispatch.offOrder.qty")}
                  className="h-10 rounded-sm font-mono-num text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  data-testid={`off-order-qty-${idx}`}
                />
              </div>
              <div className="col-span-3 sm:col-span-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => removeRow(r.id)}
                  disabled={rows.length === 1}
                  className="h-10 w-full text-red-600 hover:bg-red-50 rounded-sm disabled:opacity-30"
                  data-testid={`off-order-remove-${idx}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              {/* Per-item description / note — prints on slip directly under item name */}
              <div className="col-span-12 sm:col-span-11">
                <Input
                  value={r.description || ""}
                  onChange={(e) => updateRow(r.id, { description: e.target.value })}
                  placeholder="Description / note (optional) — prints on slip under this item"
                  data-testid={`off-order-desc-${idx}`}
                  className="h-9 rounded-sm text-sm bg-slate-50"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Notes + Dispatch */}
      <div className="bg-white border border-slate-200 rounded-sm p-4 space-y-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block mb-1">
            {t("dispatch.offOrder.notesLabel")}
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("dispatch.offOrder.notesPlaceholder")}
            className="h-10 rounded-sm"
            data-testid="off-order-notes"
          />
        </div>
        <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
          <div className="text-xs text-slate-500">
            {t("dispatch.offOrder.totalLabel")}: <span className="font-mono-num font-bold text-slate-900 text-base">{totalPcs.toLocaleString("en-IN")}</span>
          </div>
          <Button
            type="button"
            onClick={doDispatch}
            disabled={!canDispatch || busy}
            className="h-10 px-6 bg-[#E65100] hover:bg-[#CC4800] text-white font-bold rounded-sm disabled:opacity-50"
            data-testid="off-order-dispatch-btn"
          >
            <PackageCheck className="w-4 h-4 mr-1.5" />
            {busy ? t("dispatch.dispatching") : t("dispatch.offOrder.dispatchBtn")}
          </Button>
        </div>
      </div>

      {/* Last successful dispatch — recap */}
      {lastDispatch && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-sm p-4" data-testid="off-order-last-dispatch">
          <div className="flex items-start gap-2 text-emerald-900">
            <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wider mb-1">{t("dispatch.offOrder.lastSent")}</div>
              <div className="text-sm">
                {lastDispatch.total_pcs} {t("dispatch.offOrder.pieces")} → <b>{lastDispatch.customer_name}</b>
                {lastDispatch.transport_name ? ` (${lastDispatch.transport_name})` : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
