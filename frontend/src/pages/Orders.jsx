import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Search, Trash2, Edit3, AlertTriangle, Truck, Clock, CheckCircle2, MapPin } from "lucide-react";
import { useAuth } from "@/lib/auth";
import OrderEditDialog from "@/components/OrderEditDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";

const STATUSES = ["Pending", "Dispatched", "Cleared"];

function StatusBadge({ status }) {
  const { t } = useTranslation();
  const cls = {
    Pending: "badge-pending",
    Dispatched: "badge-dispatched",
    Cleared: "badge-cleared",
  }[status] || "badge-pending";
  return <span className={`badge-status ${cls}`}>{t(`orders.status.${status}`, status)}</span>;
}

// A compact chip for a single order line. `tone` switches the palette so the
// same component renders both pending (red) and dispatched (indigo) items.
function ItemChip({ it, tone = "pending", testid }) {
  const cls = tone === "dispatched"
    ? "bg-indigo-50 text-indigo-900 border-indigo-200"
    : "bg-red-50 text-red-800 border-red-200";
  const subCls = tone === "dispatched" ? "text-indigo-400" : "text-red-400";
  return (
    <span title={it.product_name || ""} data-testid={testid}
          className={`text-xs px-2 py-1 rounded-sm border ${cls}`}>
      <span className="font-semibold">{it.item_name || it.product_name}</span>
      {it.variant ? ` (${it.variant})` : ""}: <span className="font-mono-num font-bold">{it.quantity}</span>
      {it.product_name && it.item_name && it.product_name !== it.item_name && (
        <span className={`text-[10px] ml-1 ${subCls}`}>· {it.product_name}</span>
      )}
    </span>
  );
}

const fmtDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
};

export default function Orders() {
  const { isAdmin, canAct } = useAuth();
  const canEditOrders = canAct("edit:orders");
  const canDeleteOrders = canAct("delete:orders");
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [filter, setFilter] = useState(searchParams.get("status") || "all");
  const [editTarget, setEditTarget] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [discCount, setDiscCount] = useState(0);
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const load = async (opts = {}) => {
    // On a silent refresh (e.g. right after editing an order) we skip the
    // loading skeleton so the list doesn't collapse and reset the scroll
    // position — the user stays exactly where they were.
    if (!opts.silent) setLoading(true);
    try {
      // "discrepancy" is a client-side view over ALL orders (the backend
      // only annotates discrepancies, it doesn't filter by them), so we
      // fetch everything and narrow it down in `filtered` below.
      const serverFilter = (filter === "all" || filter === "discrepancy") ? {} : { status_filter: filter };
      const { data } = await api.get("/orders", { params: serverFilter });
      setOrders(data);
      // Keep the discrepancy badge accurate whenever we already hold the
      // full (unfiltered) dataset; otherwise refresh it separately.
      if (filter === "all" || filter === "discrepancy") {
        setDiscCount(data.filter((o) => o.discrepancy).length);
      } else {
        loadDiscCount();
      }
    } catch (e) {
      toast.error(t("orders.loadFailed"));
    } finally { setLoading(false); }
  };

  // Standalone count of orders flagged with a timing discrepancy, used for
  // the badge on the "Discrepancy" filter option.
  const loadDiscCount = async () => {
    try {
      const { data } = await api.get("/orders");
      setDiscCount(data.filter((o) => o.discrepancy).length);
    } catch (e) { /* non-critical — leave prior count */ }
  };

  useEffect(() => { load(); }, [filter]);

  // After an edit, refresh in place then bring the edited order into view and
  // briefly highlight it, so users never have to scroll to find it again.
  const handleSaved = async (savedId) => {
    await load({ silent: true });
    if (savedId) setHighlightId(savedId);
  };

  useEffect(() => {
    if (!highlightId) return;
    const el = document.querySelector(`[data-testid="order-row-${highlightId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightId(null), 2600);
    return () => clearTimeout(timer);
  }, [highlightId, orders]);

  const filtered = orders.filter((o) => {
    // Discrepancy view — only orders flagged with a timing discrepancy.
    if (filter === "discrepancy" && !o.discrepancy) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return (o.customer_name || "").toLowerCase().includes(s) ||
           (o.customer_address || "").toLowerCase().includes(s) ||
           o.items?.some((it) =>
             (it.item_name || "").toLowerCase().includes(s) ||
             (it.product_name || "").toLowerCase().includes(s)
           );
  });

  const updateStatus = async (id, status) => {
    try {
      await api.patch(`/orders/${id}/status`, { status });
      toast.success(t("orders.markedStatus", { status: t(`orders.status.${status}`, status) }));
      load();
    } catch (e) { toast.error(t("common.failed")); }
  };

  const del = (id) => {
    confirm({
      title: t("orders.confirmDeleteTitle"),
      description: t("orders.confirmDelete"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/orders/${id}`);
          toast.success(t("orders.deleted"));
          load();
        } catch (e) { toast.error(t("common.failed")); }
      },
    });
  };

  // Resolve a dispatch-before-order discrepancy. `action` is one of
  // update_date | clear | delete | keep. Reloads the list afterwards.
  const resolveDiscrepancy = async (order, action) => {
    try {
      await api.post(`/orders/${order.id}/resolve-discrepancy`, {
        action,
        dispatch_id: order.discrepancy?.dispatch_id,
      });
      toast.success(action === "delete" ? t("orders.discDeleted") : t("orders.discResolved"));
      load({ silent: true });
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("common.failed"));
    }
  };

  return (
    <div className="space-y-5" data-testid="orders-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("orders.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("orders.title")}</h1>
        </div>
        <Link to="/orders/new" data-testid="orders-new-btn"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold inline-flex items-center transition active:scale-[0.98]">
          <Plus className="w-4 h-4 mr-1.5" /> {t("orders.newBtn")}
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1 w-full">
            <Search className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input data-testid="orders-search" placeholder={t("orders.searchPlaceholder")}
                   value={q} onChange={(e) => setQ(e.target.value)}
                   className="pl-11 h-12 text-base rounded-sm" />
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger data-testid="orders-filter" className="w-full sm:w-52 h-12 rounded-sm text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" data-testid="orders-tab-all">{t("orders.tabAll")}</SelectItem>
              <SelectItem value="Pending" data-testid="orders-tab-pending">{t("orders.tabPending")}</SelectItem>
              <SelectItem value="Dispatched" data-testid="orders-tab-dispatched">{t("orders.tabDispatched")}</SelectItem>
              <SelectItem value="Cleared" data-testid="orders-tab-cleared">{t("orders.status.Cleared", "Cleared")}</SelectItem>
              <SelectItem value="discrepancy" data-testid="orders-tab-discrepancy">
                <span className="inline-flex items-center gap-2">
                  {t("orders.tabDiscrepancy")}
                  {discCount > 0 && (
                    <span data-testid="orders-discrepancy-badge"
                          className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none">
                      {discCount}
                    </span>
                  )}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          {discCount > 0 && filter !== "discrepancy" && (
            <button type="button" onClick={() => setFilter("discrepancy")}
                    data-testid="orders-discrepancy-pill"
                    className="inline-flex items-center gap-1.5 h-12 px-3 rounded-sm border border-amber-300 bg-amber-50 text-amber-800 text-sm font-bold hover:bg-amber-100 transition whitespace-nowrap">
              <AlertTriangle className="w-4 h-4" />
              {discCount}
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-10 text-center text-slate-400">{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            <div className="text-sm">{t("orders.noMatch")}</div>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((o) => (
              <div key={o.id} className={`p-4 sm:p-5 hover:bg-slate-50 transition-colors ${o.id === highlightId ? "bg-amber-100 ring-2 ring-inset ring-[#E65100]" : (o.is_overdue ? "bg-rose-50/40 border-l-2 border-l-rose-400" : "")}`} data-testid={`order-row-${o.id}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-900">{o.customer_name}</span>
                      {(o.customer_address || o.customer_city || o.customer_location) && (
                        <span className="text-xs text-slate-600 inline-flex items-center gap-1"
                              data-testid={`order-address-${o.id}`}>
                          <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          {[o.customer_address, o.customer_location, o.customer_city]
                            .filter(Boolean).join(", ")}
                        </span>
                      )}
                      <StatusBadge status={o.status} />
                      {o.is_overdue && (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.5 rounded-sm"
                              data-testid={`overdue-badge-${o.id}`}>
                          <AlertTriangle className="w-3 h-3" />
                          {t("orders.overdueBadge", { days: o.days_open })}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 font-mono-num">
                      #{o.id.slice(0, 8)} · {new Date(o.order_date || o.created_at).toLocaleDateString()}
                      {o.delivery_date && <> · {t("orders.delivery")}: {new Date(o.delivery_date).toLocaleDateString()}</>}
                    </div>
                    {/* PENDING tab — remaining (still-open) items only */}
                    {filter === "Pending" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {o.items?.map((it, i) => (
                          <ItemChip key={i} it={it} tone="pending" />
                        ))}
                      </div>
                    )}

                    {/* DISPATCHED tab — quantities actually shipped. Includes
                        PARTIALLY dispatched orders so shipped qty is never hidden. */}
                    {filter === "Dispatched" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {o.dispatched_items?.length > 0
                          ? o.dispatched_items.map((it, i) => (
                              <ItemChip key={`d-${i}`} it={it} tone="dispatched"
                                        testid={`order-dispatched-item-${o.id}-${i}`} />
                            ))
                          : <span className="text-xs text-slate-400">{t("orders.briefNoDispatch")}</span>}
                      </div>
                    )}

                    {/* CLEARED tab — closed orders. Show the order's items
                        (falling back to shipped items if the list was emptied). */}
                    {filter === "Cleared" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(o.items?.length > 0 ? o.items : (o.dispatched_items || [])).map((it, i) => (
                          <ItemChip key={`c-${i}`} it={it}
                                    tone={o.items?.length > 0 ? "pending" : "dispatched"} />
                        ))}
                      </div>
                    )}

                    {/* ALL STATUS tab — full brief: what shipped & when, plus
                        what's still pending. */}
                    {(filter === "all" || filter === "discrepancy") && (
                      <div className="mt-2 space-y-1.5" data-testid={`order-brief-${o.id}`}>
                        {o.discrepancy && (
                          <div className="rounded-sm border border-amber-300 bg-amber-50 p-2.5" data-testid={`order-discrepancy-${o.id}`}>
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                              <div className="min-w-0">
                                <div className="text-xs font-bold text-amber-900">{t("orders.discTitle")}</div>
                                <div className="text-[11px] text-slate-700 mt-0.5 leading-relaxed">
                                  {t("orders.discMsg", {
                                    disp: fmtDate(o.discrepancy.dispatched_at),
                                    slip: o.discrepancy.slip_no,
                                    entered: fmtDate(o.discrepancy.entered_at),
                                  })}
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {o.discrepancy.items?.map((it, i) => (
                                    <ItemChip key={`disc-${i}`} it={it} tone="dispatched" />
                                  ))}
                                </div>
                                {canEditOrders && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Button size="sm" onClick={() => resolveDiscrepancy(o, "clear")}
                                            data-testid={`disc-clear-${o.id}`}
                                            className="h-8 rounded-sm bg-[#E65100] hover:bg-[#CC4800] text-white text-xs font-bold">
                                      {t("orders.discActClear")}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => resolveDiscrepancy(o, "update_date")}
                                            data-testid={`disc-updatedate-${o.id}`}
                                            className="h-8 rounded-sm text-xs font-semibold">
                                      {t("orders.discActUpdateDate")}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => resolveDiscrepancy(o, "keep")}
                                            data-testid={`disc-keep-${o.id}`}
                                            className="h-8 rounded-sm text-xs font-semibold">
                                      {t("orders.discActKeep")}
                                    </Button>
                                    {canDeleteOrders && (
                                      <Button size="sm" variant="outline" onClick={() => resolveDiscrepancy(o, "delete")}
                                              data-testid={`disc-delete-${o.id}`}
                                              className="h-8 rounded-sm text-xs font-semibold text-red-600 border-red-200 hover:bg-red-50">
                                        {t("orders.discActDelete")}
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {o.dispatch_summary?.map((grp, gi) => (
                          <div key={`g-${gi}`} className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded-sm">
                              <Truck className="w-3 h-3" /> {t("orders.briefDispatchedOn", { date: fmtDate(grp.date) })}
                              {grp.slip_no ? ` · ${t("orders.slip", "Slip")} #${grp.slip_no}` : ""}
                            </span>
                            {grp.items.map((it, i) => (
                              <ItemChip key={`gi-${i}`} it={it} tone="dispatched"
                                        testid={`order-brief-dispatched-${o.id}-${gi}-${i}`} />
                            ))}
                          </div>
                        ))}
                        {o.dispatch_inferred && o.dispatch_summary?.length > 0 && (
                          <div className="text-[10px] text-slate-400 italic">{t("orders.slipInferred")}</div>
                        )}
                        {o.items?.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-sm">
                              <Clock className="w-3 h-3" /> {t("orders.briefPending")}
                            </span>
                            {o.items.map((it, i) => (
                              <ItemChip key={`p-${i}`} it={it} tone="pending"
                                        testid={`order-brief-pending-${o.id}-${i}`} />
                            ))}
                          </div>
                        )}
                        {/* Dispatched order with NO dispatch records on file
                            (e.g. marked Dispatched manually). Fall back to the
                            original item snapshot so details still show. */}
                        {(!o.items || o.items.length === 0) &&
                          (!o.dispatch_summary || o.dispatch_summary.length === 0) &&
                          o.status === "Dispatched" && o.original_items?.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded-sm">
                              <Truck className="w-3 h-3" /> {t("orders.status.Dispatched", "Dispatched")}
                            </span>
                            {o.original_items.map((it, i) => (
                              <ItemChip key={`oi-${i}`} it={it} tone="dispatched" />
                            ))}
                          </div>
                        )}
                        {/* Status-aware closing note — never contradict the
                            status badge (fixes "Dispatched" + "Not dispatched yet"). */}
                        {(!o.items || o.items.length === 0) && (
                          (o.dispatch_summary?.length > 0 || o.status === "Dispatched") ? (
                            <div className="text-[11px] font-semibold text-emerald-700 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              {o.dispatch_summary?.length > 0
                                ? t("orders.briefFullyDispatched")
                                : t("orders.briefDispatchedNoSlip")}
                            </div>
                          ) : o.status === "Cleared" ? (
                            <div className="text-[11px] font-semibold text-slate-500 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> {t("orders.briefCleared")}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">{t("orders.briefNoDispatch")}</span>
                          )
                        )}
                      </div>
                    )}
                    {o.notes && <div className="mt-2 text-xs text-slate-500 italic">&ldquo;{o.notes}&rdquo;</div>}
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <Select value={o.status} onValueChange={(v) => updateStatus(o.id, v)} disabled={!canEditOrders}>
                      <SelectTrigger data-testid={`status-select-${o.id}`} className="h-10 flex-1 sm:flex-none sm:w-36 rounded-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`orders.status.${s}`, s)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {canEditOrders && (
                      <Button variant="ghost" size="sm" onClick={() => setEditTarget(o)}
                              data-testid={`order-edit-${o.id}`}
                              className="h-10 w-10 p-0 rounded-sm text-slate-500 hover:text-[#E65100] hover:bg-orange-50 shrink-0">
                        <Edit3 className="w-4 h-4" />
                      </Button>
                    )}
                    {canDeleteOrders && (
                      <Button variant="ghost" size="sm" onClick={() => del(o.id)}
                              data-testid={`order-delete-${o.id}`}
                              className="h-10 w-10 p-0 rounded-sm text-slate-500 hover:text-red-600 hover:bg-red-50 shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <OrderEditDialog
        open={!!editTarget}
        order={editTarget}
        onOpenChange={(o) => { if (!o) setEditTarget(null); }}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />
    </div>
  );
}
