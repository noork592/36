import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Boxes, Package, Truck, CheckCircle2, Users, ChevronRight, ChevronDown, Settings2, AlertTriangle, Clock, Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

const STAT_CARDS = [
  { key: "pending_orders",    i18nKey: "pending",    icon: Package,       accent: "text-amber-600",  testid: "stat-pending",    to: "/orders?status=Pending" },
  { key: "dispatched_orders", i18nKey: "dispatched", icon: Truck,         accent: "text-blue-600",   testid: "stat-dispatched", to: "/orders?status=Dispatched" },
  { key: "cleared_orders",    i18nKey: "cleared",    icon: CheckCircle2,  accent: "text-green-600",  testid: "stat-cleared",    to: "/orders?status=Cleared" },
  { key: "customers",         i18nKey: "customers",  icon: Users,         accent: "text-[#E65100]",  testid: "stat-customers",  to: "/customers" },
  { key: "total_orders",      i18nKey: "total",      icon: Boxes,         accent: "text-slate-700",  testid: "stat-total",      to: "/orders" },
  { key: "products",          i18nKey: "products",   icon: Settings2,     accent: "text-violet-600", testid: "stat-products",   to: "/products" },
];

export default function Dashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedSku, setExpandedSku] = useState(null);
  const [skuQuery, setSkuQuery] = useState("");

  useEffect(() => {
    api.get("/dashboard/summary").then((r) => setData(r.data)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-slate-500">{t("dashboard.loading")}</div>;
  if (!data) return <div className="text-slate-500">{t("dashboard.noData")}</div>;

  return (
    <div className="space-y-6" data-testid="dashboard-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("dashboard.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-extrabold text-slate-900">{t("dashboard.title")}</h1>
          <p className="text-slate-500 text-sm mt-1">{t("dashboard.subtitle")}</p>
        </div>
        <Link to="/orders/new" data-testid="dashboard-new-order"
              className="hidden sm:inline-flex bg-slate-900 text-white px-4 py-2 rounded-sm text-sm font-bold hover:bg-black transition">
          {t("dashboard.createOrder")}
        </Link>
      </div>

      {/* Stats Grid — clickable */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {STAT_CARDS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => nav(s.to)}
              data-testid={s.testid}
              className="stat-card text-left transition-transform hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#E65100] focus:ring-offset-2 active:scale-[0.99]"
            >
              <div className="flex items-center justify-between">
                <div className="text-xs sm:text-sm uppercase tracking-[0.08em] text-slate-600 font-extrabold leading-tight">{t(`dashboard.stats.${s.i18nKey}`)}</div>
                <Icon className={`w-4 h-4 ${s.accent}`} />
              </div>
              <div className="mt-3 font-mono-num text-3xl font-bold text-slate-900">{data.stats[s.key] ?? 0}</div>
              <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-400 font-bold flex items-center gap-1">
                {t("dashboard.viewList")} <ChevronRight className="w-3 h-3" />
              </div>
            </button>
          );
        })}
      </div>

      {/* Overdue Customers — ranked oldest-first */}
      <div className="bg-white border border-slate-200 rounded-sm" data-testid="overdue-customers-card">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-sm bg-rose-50 border border-rose-200 grid place-items-center text-rose-600 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.15em] text-rose-600 font-bold">{t("dashboard.overdueOverline")}</div>
              <h3 className="font-heading text-lg font-bold text-slate-900 truncate">{t("dashboard.overdueTitle")}</h3>
              <div className="text-[11px] text-slate-500">
                {t("dashboard.overdueSub", { days: data.overdue_threshold_days ?? 15 })}
              </div>
            </div>
          </div>
          <Link to="/admin/settings" className="text-[10px] uppercase tracking-wider font-bold text-slate-500 hover:text-[#E65100] inline-flex items-center gap-1"
                data-testid="overdue-tune-link">
            {t("dashboard.tuneThreshold")} <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="divide-y divide-slate-100 max-h-[360px] overflow-auto">
          {(!data.overdue_customers || data.overdue_customers.length === 0) && (
            <div className="px-5 py-8 text-center text-slate-400 text-sm" data-testid="overdue-empty">
              {t("dashboard.overdueEmpty")}
            </div>
          )}
          {(data.overdue_customers || []).map((c, idx) => (
            <button
              key={c.customer_id || c.customer_name}
              onClick={() => nav(`/orders?status=Pending&q=${encodeURIComponent(c.customer_name)}`)}
              data-testid={`overdue-row-${idx}`}
              className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-rose-50/40 transition-colors text-left"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span className={`shrink-0 w-7 h-7 grid place-items-center rounded-sm text-[11px] font-bold font-mono-num ${
                  idx === 0 ? "bg-rose-600 text-white" : idx < 3 ? "bg-rose-100 text-rose-700 border border-rose-200" : "bg-slate-100 text-slate-600 border border-slate-200"
                }`}>#{idx + 1}</span>
                <div className="min-w-0">
                  <div className="font-bold text-slate-900 text-sm truncate">{c.customer_name}</div>
                  <div className="text-[11px] text-slate-500 font-mono-num">
                    {t("dashboard.overduePending", { count: c.pending_count })}
                    {c.total_pcs > 0 && (
                      <> · {Number(c.total_pcs).toLocaleString("en-IN")} {t("common.pcs")}</>
                    )}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[9px] uppercase tracking-wider font-bold text-rose-600 flex items-center justify-end gap-1">
                  <Clock className="w-3 h-3" /> {t("dashboard.oldestLabel")}
                </div>
                <span className="number-pill text-base font-bold tabular-nums text-rose-700 bg-rose-50 border border-rose-200"
                      data-testid={`overdue-days-${idx}`}>
                  {c.oldest_days}{t("dashboard.daysShort")}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Item-wise pending totals (strict SKU view) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-sm">
          <div className="px-5 py-4 border-b border-slate-200">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dashboard.itemwiseOverline")}</div>
                <h3 className="font-heading text-lg font-bold text-slate-900">{t("dashboard.itemwiseTitle")}</h3>
              </div>
              <span className="text-xs text-slate-400">{t("dashboard.itemwiseHint")}</span>
            </div>
            <div className="relative mt-3">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={skuQuery}
                onChange={(e) => setSkuQuery(e.target.value)}
                data-testid="sku-search-input"
                placeholder={t("dashboard.itemwiseSearchPlaceholder")}
                className="w-full h-10 pl-9 pr-9 text-sm rounded-sm border border-slate-300 bg-slate-50 focus:bg-white focus:border-[#E65100] focus:ring-1 focus:ring-[#E65100] outline-none transition-colors"
              />
              {skuQuery && (
                <button
                  type="button"
                  onClick={() => setSkuQuery("")}
                  data-testid="sku-search-clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-lg leading-none px-1"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
          </div>
          <div className="divide-y divide-slate-100 max-h-[460px] overflow-auto">
            {(() => {
              const allItems = data.item_totals || data.product_totals || [];
              const q = skuQuery.trim().toLowerCase();
              const items = q
                ? allItems.filter((p) =>
                    `${p.item_name || ""} ${p.product_name || ""}`.toLowerCase().includes(q)
                  )
                : allItems;
              return (
                <>
            {allItems.length === 0 && (
              <div className="px-5 py-8 text-center text-slate-400 text-sm">{t("dashboard.noPendingOrders")}</div>
            )}
            {allItems.length > 0 && items.length === 0 && (
              <div className="px-5 py-8 text-center text-slate-400 text-sm" data-testid="sku-search-empty">
                {t("dashboard.itemwiseNoMatch", { query: skuQuery })}
              </div>
            )}
            {items.map((p) => {
              const key = p.item_id || p.item_name || p.product_name;
              const isOpen = expandedSku === key;
              const breakdown = p.breakdown || [];
              const orderCount = p.order_count ?? breakdown.length;
              const hasBreakdown = breakdown.length > 0;
              return (
                <div key={key} data-testid={`sku-total-${key}`}>
                  <div
                    role={hasBreakdown ? "button" : undefined}
                    tabIndex={hasBreakdown ? 0 : -1}
                    onClick={() => hasBreakdown && setExpandedSku(isOpen ? null : key)}
                    onKeyDown={(e) => {
                      if (!hasBreakdown) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedSku(isOpen ? null : key);
                      }
                    }}
                    data-testid={`sku-total-toggle-${key}`}
                    className={`px-5 py-3 flex items-center justify-between gap-3 transition-colors ${
                      hasBreakdown ? "cursor-pointer hover:bg-slate-50" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 pr-3">
                      {hasBreakdown && (
                        <span className="w-4 text-slate-400 shrink-0">
                          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 text-sm truncate">
                          {p.item_name || p.product_name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate">
                          {p.product_name && p.item_name && p.product_name !== p.item_name && (
                            <span>{p.product_name} · </span>
                          )}
                          {orderCount > 0 && (
                            <span className="font-mono-num">{t("dashboard.fromOrders", { count: orderCount })}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[9px] uppercase tracking-wider font-bold text-[#E65100]">
                        {t("dashboard.grandTotalLabel")}
                      </div>
                      <span
                        className="number-pill text-base font-bold tabular-nums"
                        data-testid={`sku-grand-total-${key}`}
                      >
                        {Number(p.quantity).toLocaleString("en-IN")} {t("common.pcs")}
                      </span>
                    </div>
                  </div>
                  {isOpen && hasBreakdown && (
                    <div className="px-5 pb-3 bg-slate-50/60" data-testid={`sku-breakdown-${key}`}>
                      <div className="text-[9px] uppercase tracking-wider font-bold text-slate-500 mb-2 mt-1">
                        {t("dashboard.breakdownTitle")}
                      </div>
                      <div className="space-y-1">
                        {breakdown.map((b, i) => (
                          <div
                            key={(b.order_id || "") + ":" + i}
                            className="flex items-center justify-between text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-sm"
                            data-testid={`sku-breakdown-row-${key}-${i}`}
                          >
                            <div className="min-w-0 pr-3">
                              <div className="font-bold text-slate-800 truncate">{b.customer_name}</div>
                              {b.order_id && (
                                <div className="text-[10px] text-slate-400 font-mono-num">
                                  #{String(b.order_id).slice(0, 8)}
                                  {b.order_date && <> · {new Date(b.order_date).toLocaleDateString()}</>}
                                </div>
                              )}
                            </div>
                            <span className="font-mono-num font-bold text-slate-900 tabular-nums">
                              {Number(b.quantity).toLocaleString("en-IN")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
                </>
              );
            })()}
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-sm">
          <div className="px-5 py-4 border-b border-slate-200">
            <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">{t("dashboard.partywiseOverline")}</div>
            <h3 className="font-heading text-lg font-bold text-slate-900">{t("dashboard.partywiseTitle")}</h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-[460px] overflow-auto">
            {data.party_breakdown.length === 0 && (
              <div className="px-5 py-8 text-center text-slate-400 text-sm">{t("dashboard.noPendingParties")}</div>
            )}
            {data.party_breakdown.map((p) => (
              <div key={p.customer_name} className="px-5 py-3" data-testid={`party-${p.customer_name}`}>
                <div className="font-bold text-slate-900 text-sm">{p.customer_name}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {p.items.map((it, idx) => (
                    <span key={(it.item_id || it.item_name || it.product_name) + ":" + idx}
                          title={it.product_name || ""}
                          className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-sm border border-slate-200">
                      {it.item_name || it.product_name}: <span className="font-mono-num font-bold">{it.quantity}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
