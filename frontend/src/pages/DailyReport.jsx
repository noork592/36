import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import {
  Calendar, Truck, IndianRupee, Package, Phone, MapPin, Printer, ChevronDown, ChevronRight, Save, Tag, Lock, Pencil, ListChecks,
} from "lucide-react";
import IstBadge from "@/components/IstBadge";
import DispatchEditDialog from "@/components/DispatchEditDialog";

/**
 * End-of-Day Dispatch Report — grouped by party.
 *
 * All users see per-line pricing (unit price, discount, net unit price) and
 * transport details so operators can confirm what was billed. Only admins see
 * value-roll-ups — line totals, party subtotals, and the grand total — keeping
 * sensitive revenue figures restricted while still surfacing the per-piece
 * rates needed on the shop floor.
 */
function todayYmd() {
  // IST (UTC+5:30) — the factory's working clock. Stay on the IST calendar
  // day even when the browser's local timezone differs.
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const inr = (n) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(n || 0));

// Customers whose party is located in Ludhiana skip the GR number, No. of
// bags and Private mark bookkeeping — the material is picked up locally so
// there is no LR/transport paperwork and no bagging step. The report should
// therefore neither ask for nor flag those three fields as "missing" for a
// Ludhiana party. Bill amount is still required.
//
// Real data has "LUDHIANA" stored in different fields depending on how the
// customer was imported — sometimes in `city`, sometimes only in `address`
// or `location`. Match a whole-word "ludhiana" in any of the three so the
// rule fires regardless of where the operator typed it.
const isLudhianaLocation = (...parts) => {
  const hay = parts
    .map((p) => String(p || "").toLowerCase())
    .join(" | ");
  return /\bludhiana\b/.test(hay);
};

export default function DailyReport() {
  const { isAdmin } = useAuth();
  const [date, setDate] = useState(todayYmd());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState({});

  // Edit-buffer keyed by entity id: { dispatch:<id> | customer:<id> }
  const [edits, setEdits] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  // Full-dispatch edit dialog (items + GR + bill + bags) state
  const [editingDispatch, setEditingDispatch] = useState(null);
  // Local mirror so the picker label can update without re-fetch
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);

  const dispatchEdit = (did, field) => edits[`dispatch:${did}`]?.[field];
  const customerEdit = (cid, field) => edits[`customer:${cid}`]?.[field];

  const updEdit = (scope, id, patch) => {
    const k = `${scope}:${id}`;
    setEdits((e) => ({ ...e, [k]: { ...(e[k] || {}), ...patch } }));
  };

  const saveDispatchRow = async (did) => {
    const buf = edits[`dispatch:${did}`] || {};
    if (Object.keys(buf).length === 0) return;
    const body = {};
    if (buf.gr_number !== undefined) body.gr_number = buf.gr_number;
    if (buf.gr_date !== undefined) body.gr_date = buf.gr_date;
    if (buf.total_value !== undefined && buf.total_value !== "" && !Number.isNaN(Number(buf.total_value))) {
      body.total_value = Number(buf.total_value);
    }
    if (Object.keys(body).length === 0) return;
    setSavingKey(`dispatch:${did}`);
    try {
      await api.patch(`/dispatches/${did}`, body);
      setEdits((e) => { const n = { ...e }; delete n[`dispatch:${did}`]; return n; });
      toast.success("Saved");
      await reloadPreservingScroll(date);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSavingKey(null); }
  };

  const savePrivateMark = async (cid, dispatches) => {
    const buf = edits[`customer:${cid}`] || {};
    const hasMark = buf.private_mark !== undefined;
    const hasBags = buf.bag_count !== undefined && buf.bag_count !== "" && !Number.isNaN(Number(buf.bag_count));
    if (!hasMark && !hasBags) return;
    setSavingKey(`customer:${cid}`);
    try {
      if (hasMark) {
        await api.patch(`/customers/${cid}`, { private_mark: buf.private_mark });
      }
      if (hasBags && (dispatches || []).length > 0) {
        // Attach bag count to the (consolidated) dispatch for this customer.
        // After the same-day merge fix there is at most one slip per
        // customer per day, so the first entry is the right target.
        const bags = Math.max(0, parseInt(buf.bag_count, 10) || 0);
        await api.patch(`/dispatches/${dispatches[0].id}`, { bag_count: bags });
      }
      setEdits((e) => { const n = { ...e }; delete n[`customer:${cid}`]; return n; });
      toast.success("Saved");
      await reloadPreservingScroll(date);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSavingKey(null); }
  };

  /**
   * Unified save: persists GR number + Bill amount (per dispatch) AND
   * Private mark + No. of bags (per customer/party) with a SINGLE click.
   * Walks every dispatch under the party and the party-level customer
   * buffer, batching the PATCH calls and refreshing once at the end.
   */
  const saveAllForParty = async (cid, dispatches) => {
    const custBuf = edits[`customer:${cid}`] || {};
    const dispatchBufs = (dispatches || [])
      .map((d) => ({ id: d.id, can_edit: d.can_edit !== false, buf: edits[`dispatch:${d.id}`] || {} }))
      .filter((x) => Object.keys(x.buf).length > 0);

    const hasMark = custBuf.private_mark !== undefined;
    const hasBill = custBuf.bill_number !== undefined;
    const hasBags = custBuf.bag_count !== undefined && custBuf.bag_count !== "" && !Number.isNaN(Number(custBuf.bag_count));
    if (!hasMark && !hasBill && !hasBags && dispatchBufs.length === 0) return;

    setSavingKey(`party:${cid}`);
    try {
      // 1) Dispatch-level fields (GR + bill amount)
      for (const { id, can_edit, buf } of dispatchBufs) {
        if (!can_edit) continue;
        const body = {};
        if (buf.gr_number !== undefined) body.gr_number = buf.gr_number;
        if (buf.gr_date !== undefined) body.gr_date = buf.gr_date;
        if (buf.total_value !== undefined && buf.total_value !== "" && !Number.isNaN(Number(buf.total_value))) {
          body.total_value = Number(buf.total_value);
        }
        if (Object.keys(body).length > 0) {
          await api.patch(`/dispatches/${id}`, body);
        }
      }
      // 2) Party-level fields
      if (hasMark) {
        await api.patch(`/customers/${cid}`, { private_mark: custBuf.private_mark });
      }
      // Bill Number (bill-mode parties): saved onto the dispatch(es), NOT the
      // party — so a fresh bill is always required for the next dispatch.
      if (hasBill && (dispatches || []).length > 0) {
        for (const d of dispatches) {
          if (d.can_edit === false) continue;
          await api.patch(`/dispatches/${d.id}`, { bill_number: custBuf.bill_number });
        }
      }
      if (hasBags && (dispatches || []).length > 0) {
        const bags = Math.max(0, parseInt(custBuf.bag_count, 10) || 0);
        await api.patch(`/dispatches/${dispatches[0].id}`, { bag_count: bags });
      }
      // Clear all buffers for this party
      setEdits((e) => {
        const n = { ...e };
        delete n[`customer:${cid}`];
        for (const { id } of dispatchBufs) delete n[`dispatch:${id}`];
        return n;
      });
      toast.success("Saved");
      await reloadPreservingScroll(date);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSavingKey(null); }
  };


  const load = async (d) => {
    setLoading(true);
    try {
      const r = await api.get("/reports/daily-dispatch", { params: { date: d } });
      setData(r.data);
      setCollapsed({});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load report");
    } finally {
      setLoading(false);
    }
  };

  // Reload the report data WITHOUT losing the operator's scroll position.
  // Saving GR / Bill / mark / bag-count triggers a full refresh, and
  // because the page now sorts latest-slip-first the scroll would jump
  // back to the top. We snapshot scrollY → await the reload → restore
  // after two RAFs so the new markup has laid out before we scroll.
  const reloadPreservingScroll = async (d) => {
    const y = typeof window !== "undefined" ? window.scrollY : 0;
    await load(d);
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { window.scrollTo({ top: y, behavior: "auto" }); } catch { /* noop */ }
        });
      });
    }
  };

  useEffect(() => { load(date); }, [date]);

  // Sort so the LATEST slip lands at the top: within each customer group
  // we sort dispatches by slip_no DESC, then sort the groups themselves
  // by their max slip_no DESC. New dispatches therefore always surface
  // first instead of forcing operators to scroll/search the page.
  const groups = (() => {
    const raw = data?.groups || [];
    const slipNo = (d) => Number(d?.slip_no ?? 0);
    return raw
      .map((g) => ({
        ...g,
        dispatches: [...(g.dispatches || [])].sort((a, b) => slipNo(b) - slipNo(a)),
      }))
      .sort((a, b) => {
        const aMax = Math.max(0, ...((a.dispatches || []).map(slipNo)));
        const bMax = Math.max(0, ...((b.dispatches || []).map(slipNo)));
        return bMax - aMax;
      });
  })();

  const toggle = (cid) => setCollapsed((c) => ({ ...c, [cid]: !c[cid] }));

  // Expand every party group before printing so collapsed sections are
  // included in the PDF, then route the print through a hidden iframe.
  // window.print() on the top window is unreliable inside an iOS
  // standalone PWA — iframe.contentWindow.print() works much more
  // consistently because it goes through a separate webview pipeline.
  const doPrint = () => {
    setCollapsed({});
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(printViaIframe, 250);
      });
    });
  };

  // Build a self-contained HTML document that mirrors the on-screen
  // report (using the page's own stylesheets) and print it via a hidden
  // iframe. This works in Chrome, Safari, iOS PWA standalone and Android
  // PWA. Falls back to a clear toast if the standalone webview blocks
  // even the iframe approach.
  const printViaIframe = () => {
    const reportEl = document.querySelector('[data-testid="daily-report-page"]');
    if (!reportEl) {
      toast.error("Report not loaded yet — try again in a moment.");
      return;
    }

    // Capture every stylesheet rule currently active on the page. Some
    // cross-origin sheets (Google Fonts etc.) will throw on `.cssRules`;
    // we just skip those and rely on inline + same-origin styles.
    let css = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          css += rule.cssText + "\n";
        }
      } catch (_) { /* cross-origin sheet — ignore */ /* noop */ void 0; }
    }

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dispatch Report</title>
<style>${css}
html, body { margin: 0; padding: 0; background: #fff; }
body { padding: 12mm; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.print\\:hidden { display: none !important; }
@page { margin: 10mm; }
</style>
</head>
<body>${reportEl.outerHTML}</body>
</html>`;

    let iframe = document.getElementById("__print_iframe__");
    if (iframe) iframe.remove();
    iframe = document.createElement("iframe");
    iframe.id = "__print_iframe__";
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);

    const doneCleanup = () => {
      setTimeout(() => {
        try { iframe && iframe.remove(); } catch (_) { /* ignore */ void 0; }
      }, 1500);
    };

    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (err) {
        toast.error(
          "Couldn't open the print dialog. Open this page in Safari (Share → Open in Safari) and try again.",
        );
      } finally {
        doneCleanup();
      }
    };

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  };

  return (
    <div className="space-y-5" data-testid="daily-report-page">
      <div className="flex items-end justify-between flex-wrap gap-3 print:hidden">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Reports</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">Dispatch Report</h1>
          <p className="text-slate-500 text-sm mt-1">
            Consolidated end-of-day summary grouped by party with item-wise pricing &amp; transport.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs font-bold uppercase">Date</Label>
              <IstBadge />
            </div>
            <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  data-testid="report-date-input"
                  className="mt-1 h-10 rounded-sm border-slate-300 bg-white font-mono-num text-slate-900 pl-9 pr-3 justify-start relative min-w-[180px]"
                >
                  <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  {date}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-0 rounded-sm"
                align="start"
                data-testid="report-date-popover"
              >
                <CalendarUI
                  mode="single"
                  size="lg"
                  selected={(() => {
                    const [y, m, d] = (date || "").split("-").map(Number);
                    return y ? new Date(y, m - 1, d) : new Date();
                  })()}
                  onSelect={(d) => {
                    if (!d) return;
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, "0");
                    const dd = String(d.getDate()).padStart(2, "0");
                    setDate(`${y}-${m}-${dd}`);
                    setDatePopoverOpen(false);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
          <Button
            onClick={doPrint}
            variant="outline"
            data-testid="report-print-btn"
            className="rounded-sm border-slate-300 h-10"
          >
            <Printer className="w-4 h-4 mr-1.5" /> Print / Save PDF
          </Button>
        </div>
      </div>

      {/* Print header */}
      <div className="hidden print:block">
        <h1 className="text-2xl font-bold">JK Products — Dispatch Report</h1>
        <div className="text-sm text-slate-600">{data?.date}</div>
      </div>

      {/* Summary tiles */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Tile label="Parties" value={groups.length} testid="tile-parties" />
          <Tile label="Dispatches" value={data.dispatch_count} testid="tile-dispatches" />
          <Tile label="Total pieces" value={inr(data.grand_total_pcs)} testid="tile-pcs" />
          {isAdmin ? (
            <Tile
              label="Total value"
              value={`₹ ${inr(data.grand_total_value)}`}
              valueClass="text-[#E65100]"
              testid="tile-value"
            />
          ) : (
            <Tile label="Restricted" value="—" valueClass="text-slate-400" testid="tile-value-locked" />
          )}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-sm p-10 text-center text-slate-400">
          Loading…
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-sm p-10 text-center text-slate-400 text-sm">
          No dispatches on this date.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const isCollapsed = !!collapsed[g.customer_id];
            // Task 2 — color-code every party group by whether it has ALL
            // required bookkeeping fields: private_mark (party), bag_count
            // (party — stored on first dispatch), and every dispatch under
            // it must have both a GR number and a non-zero bill amount.
            // GREEN = complete, DARK RED = anything missing.
            const partyPvtEdit = customerEdit(g.customer_id, "private_mark");
            const effPvtMark = partyPvtEdit !== undefined ? partyPvtEdit : (g.private_mark || "");
            const hasPvt = !!(effPvtMark && String(effPvtMark).trim());
            // Bill-number-mode parties satisfy the "mark" requirement with a
            // Bill Number (stored per dispatch) instead of a private mark.
            const billMode = !!g.bill_number_mode;
            const billNoEdit = customerEdit(g.customer_id, "bill_number");
            const effBillNo = billNoEdit !== undefined ? billNoEdit : ((g.dispatches || [])[0]?.bill_number || "");
            const hasBillNo = !!(effBillNo && String(effBillNo).trim());
            const hasMarkReq = billMode ? hasBillNo : hasPvt;
            const bagEdit = customerEdit(g.customer_id, "bag_count");
            const dsp0 = (g.dispatches || [])[0];
            const effBags = bagEdit !== undefined ? Number(bagEdit || 0) : Number(dsp0?.bag_count || 0);
            const hasBags = effBags > 0;
            const ludhiana = isLudhianaLocation(g.city, g.location, g.address);
            const dispatchStatuses = (g.dispatches || []).map((d) => {
              const gEdit = dispatchEdit(d.id, "gr_number");
              const tEdit = dispatchEdit(d.id, "total_value");
              const effGr = gEdit !== undefined ? gEdit : (d.gr_number || "");
              const effTV = tEdit !== undefined ? Number(tEdit || 0) : Number(d.total_value || 0);
              return { id: d.id, hasGr: !!(effGr && String(effGr).trim()), hasBill: effTV > 0 };
            });
            // Per-party rule: if the customer's price list has
            // bill_amount_required=false, treat every dispatch's bill as
            // already-satisfied so the party can go Complete without one.
            const billRequired = g.bill_amount_required !== false;
            const allDispatchesOk = dispatchStatuses.length > 0
              && dispatchStatuses.every((s) => (ludhiana || s.hasGr) && (!billRequired || s.hasBill));
            const allGrOk = dispatchStatuses.length > 0 && dispatchStatuses.every((s) => s.hasGr);
            const allBillOk = !billRequired
              || (dispatchStatuses.length > 0 && dispatchStatuses.every((s) => s.hasBill));
            const isPartyComplete = ludhiana
              ? allBillOk
              : (hasMarkReq && hasBags && allDispatchesOk);
            const sectionClass = isPartyComplete
              ? "bg-white border-2 border-emerald-500 border-l-8 border-l-emerald-600 rounded-sm overflow-hidden print:break-inside-avoid"
              : "bg-white border-2 border-red-500 border-l-8 border-l-red-700 rounded-sm overflow-hidden print:break-inside-avoid";
            const headerClass = isPartyComplete
              ? "w-full px-4 py-3 flex items-center gap-3 bg-emerald-50 border-b border-emerald-200 text-left hover:bg-emerald-100 print:cursor-default"
              : "w-full px-4 py-3 flex items-center gap-3 bg-red-100 border-b border-red-300 text-left hover:bg-red-200 print:cursor-default";
            const missingParts = ludhiana
              ? [!allBillOk && "bill amt"].filter(Boolean)
              : [
                  !hasMarkReq && (billMode ? "bill number" : "pvt mark"),
                  !hasBags && "bags",
                  !allGrOk && "GR#",
                  billRequired && !allBillOk && "bill amt",
                ].filter(Boolean);
            return (
              <section
                key={g.customer_id}
                className={sectionClass}
                data-testid={`report-group-${g.customer_id}`}
                data-report-complete={isPartyComplete ? "yes" : "no"}
              >
                <button
                  onClick={() => toggle(g.customer_id)}
                  className={headerClass}
                  data-testid={`report-group-toggle-${g.customer_id}`}
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-slate-500 print:hidden" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-500 print:hidden" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-heading font-bold text-slate-900 text-base truncate flex items-center gap-2">
                      {g.customer_name}
                      {isPartyComplete ? (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-emerald-600 text-white"
                              data-testid={`report-status-badge-${g.customer_id}`}>
                          Complete
                        </span>
                      ) : (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-red-700 text-white"
                              data-testid={`report-status-badge-${g.customer_id}`}>
                          Missing: {missingParts.join(" · ")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {g.address && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {g.address}
                        </span>
                      )}
                      {(g.city || g.location) && (
                        <span className="flex items-center gap-1 font-semibold text-slate-700">
                          <MapPin className="w-3 h-3" />
                          {[g.city, g.location].filter(Boolean).join(", ")}
                        </span>
                      )}
                      {g.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="w-3 h-3" />
                          {g.phone}
                        </span>
                      )}
                      {g.transport_name && (
                        <span className="flex items-center gap-1 text-[#E65100] font-bold">
                          <Truck className="w-3 h-3" />
                          {g.transport_name}
                        </span>
                      )}
                      {g.price_list_name && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold"
                          data-testid={`report-group-pricelist-${g.customer_id}`}
                          title="Price list assigned to this customer"
                        >
                          <ListChecks className="w-3 h-3" />
                          {g.price_list_name}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                      {isAdmin ? "Total" : "Pieces"}
                    </div>
                    {isAdmin ? (
                      <div className="font-heading font-extrabold text-lg text-[#E65100] font-mono-num" data-testid={`group-total-${g.customer_id}`}>
                        ₹ {inr(g.total_value)}
                      </div>
                    ) : (
                      <div className="font-heading font-extrabold text-lg text-slate-900 font-mono-num" data-testid={`group-pcs-${g.customer_id}`}>
                        {inr(g.total_pcs)}
                      </div>
                    )}
                    <div className="text-[10px] text-slate-500 font-mono-num">
                      {g.total_pcs} pcs · {g.dispatch_count} dispatch{g.dispatch_count > 1 ? "es" : ""}
                    </div>
                  </div>
                </button>

                {!isCollapsed && (
                  <>
                    {/* Print-only bookkeeping summary — visible ONLY in the
                        printed / downloaded PDF, hidden on-screen. Shows
                        Private mark, No. of bags, GR number(s) and Bill
                        amount as plain-text rows for EVERY party (both
                        Ludhiana and non-Ludhiana) so the physical report
                        always carries this info alongside dispatched pieces. */}
                    <div
                      className="hidden print:block px-4 py-3 border-b border-slate-200 bg-white"
                      data-testid={`report-print-summary-${g.customer_id}`}
                    >
                      <div className="grid grid-cols-5 gap-3 text-[11px]">
                        <div>
                          <div className="uppercase tracking-wider text-slate-500 font-bold text-[9px]">
                            {g.bill_number_mode ? "Bill Number" : "Private mark"}
                          </div>
                          <div className="font-bold text-slate-900 mt-0.5" data-testid={`report-print-pvtmark-${g.customer_id}`}>
                            {(() => {
                              if (g.bill_number_mode) {
                                const bbuf = customerEdit(g.customer_id, "bill_number");
                                const bval = bbuf !== undefined ? bbuf : ((g.dispatches || [])[0]?.bill_number || "");
                                return String(bval).trim() || "—";
                              }
                              const buf = customerEdit(g.customer_id, "private_mark");
                              const val = buf !== undefined ? buf : (g.private_mark || "");
                              return String(val).trim() || "—";
                            })()}
                          </div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wider text-slate-500 font-bold text-[9px]">
                            No. of bags
                          </div>
                          <div className="font-bold text-slate-900 mt-0.5 font-mono-num" data-testid={`report-print-bags-${g.customer_id}`}>
                            {(() => {
                              const buf = customerEdit(g.customer_id, "bag_count");
                              const dsp0 = (g.dispatches || [])[0];
                              const savedBags = Number(dsp0?.bag_count || 0);
                              const val = buf !== undefined ? Number(buf || 0) : savedBags;
                              return val > 0 ? val : "—";
                            })()}
                          </div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wider text-slate-500 font-bold text-[9px]">
                            GR number(s)
                          </div>
                          <div className="font-bold text-slate-900 mt-0.5 font-mono-num">
                            {(() => {
                              const grs = (g.dispatches || []).map((d) => {
                                const buf = dispatchEdit(d.id, "gr_number");
                                return String(buf !== undefined ? buf : (d.gr_number || "")).trim();
                              }).filter(Boolean);
                              return grs.length ? grs.join(", ") : "—";
                            })()}
                          </div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wider text-slate-500 font-bold text-[9px]">
                            GR date(s)
                          </div>
                          <div className="font-bold text-slate-900 mt-0.5 font-mono-num" data-testid={`report-print-grdate-${g.customer_id}`}>
                            {(() => {
                              const dates = (g.dispatches || []).map((d) => {
                                const buf = dispatchEdit(d.id, "gr_date");
                                return String(buf !== undefined ? buf : (d.gr_date || "")).trim();
                              }).filter(Boolean);
                              // Show dd-mm-yyyy for readability on print
                              const fmt = (iso) => {
                                const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
                                return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
                              };
                              return dates.length ? dates.map(fmt).join(", ") : "—";
                            })()}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="uppercase tracking-wider text-slate-500 font-bold text-[9px]">
                            Bill amount ₹
                          </div>
                          <div className="font-bold text-slate-900 mt-0.5 font-mono-num">
                            {(() => {
                              if (g.bill_amount_required === false) return "Not required";
                              const total = (g.dispatches || []).reduce((s, d) => {
                                const buf = dispatchEdit(d.id, "total_value");
                                const v = buf !== undefined ? Number(buf || 0) : Number(d.total_value || 0);
                                return s + (v > 0 ? v : 0);
                              }, 0);
                              return total > 0 ? inr(total) : "—";
                            })()}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Editable bookkeeping fields per dispatch + per-party private mark */}
                    <div className="px-4 py-3 bg-orange-50/40 border-b border-orange-100 space-y-3 print:hidden">
                      {/* Per-dispatch GR + Bill amount editors */}
                      {(g.dispatches || []).map((dsp, dspIdx) => {
                        const showLabels = dspIdx === 0;
                        const gEdit = dispatchEdit(dsp.id, "gr_number");
                        const gdEdit = dispatchEdit(dsp.id, "gr_date");
                        const tEdit = dispatchEdit(dsp.id, "total_value");
                        const grVal = gEdit !== undefined ? gEdit : (dsp.gr_number || "");
                        const grDateVal = gdEdit !== undefined ? gdEdit : (dsp.gr_date || "");
                        // Bill amount is NEVER auto-filled — operator must enter it.
                        // 0 / null / undefined ⇒ empty input prompting the user.
                        const savedTV = Number(dsp.total_value || 0);
                        const tvVal = tEdit !== undefined ? tEdit : (savedTV > 0 ? String(savedTV) : "");
                        // Backend tells us if THIS user can still edit THIS
                        // dispatch (admin = always, user = within window).
                        const canEdit = dsp.can_edit !== false;
                        const lockMsg = `Editing is locked for users after ${data?.edit_window_days ?? 3} day(s). Ask an admin to edit.`;
                        return (
                          <div
                            key={dsp.id}
                            className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end"
                            data-testid={`report-dispatch-edit-${dsp.id}`}
                          >
                            <div className="sm:col-span-2 text-xs uppercase tracking-wider text-slate-800 font-extrabold flex items-center gap-1.5">
                              <span className="inline-flex items-baseline gap-1.5 px-2 py-1 rounded-sm bg-orange-50 border border-orange-200">
                                <span className="text-[11px] text-[#E65100]">Slip #</span>
                                <span className="font-mono text-sm font-black text-slate-900 tabular-nums">{dsp.slip_no ?? dsp.id.slice(0, 8).toUpperCase()}</span>
                              </span>
                              {!canEdit && (
                                <span title={lockMsg} className="inline-flex items-center text-amber-600" data-testid={`report-dispatch-locked-${dsp.id}`}>
                                  <Lock className="w-3 h-3" />
                                </span>
                              )}
                            </div>
                            <div className="sm:col-span-3">
                              {!ludhiana && showLabels && (
                                <Label className="text-[10px] uppercase font-bold text-slate-500">GR number</Label>
                              )}
                              {!ludhiana && (
                                <Input
                                  value={grVal}
                                  onChange={(e) => updEdit("dispatch", dsp.id, { gr_number: e.target.value })}
                                  placeholder="e.g. 123456"
                                  disabled={!canEdit}
                                  title={canEdit ? "" : lockMsg}
                                  data-testid={`report-gr-input-${dsp.id}`}
                                  className={`h-9 rounded-sm ${showLabels ? "mt-0.5" : ""} disabled:bg-slate-50 disabled:cursor-not-allowed`}
                                />
                              )}
                              {ludhiana && showLabels && (
                                <div className="text-[10px] uppercase font-bold text-slate-400 italic h-9 flex items-center">
                                  GR not required · Ludhiana
                                </div>
                              )}
                            </div>
                            <div className="sm:col-span-2">
                              {!ludhiana && showLabels && (
                                <Label className="text-[10px] uppercase font-bold text-slate-500">GR date</Label>
                              )}
                              {!ludhiana && (
                                <Input
                                  type="date"
                                  value={grDateVal}
                                  onChange={(e) => updEdit("dispatch", dsp.id, { gr_date: e.target.value })}
                                  disabled={!canEdit}
                                  title={canEdit ? "" : lockMsg}
                                  data-testid={`report-grdate-input-${dsp.id}`}
                                  className={`h-9 rounded-sm ${showLabels ? "mt-0.5" : ""} disabled:bg-slate-50 disabled:cursor-not-allowed`}
                                />
                              )}
                            </div>
                            <div className="sm:col-span-3">
                              {billRequired && showLabels && (
                                <Label className="text-[10px] uppercase font-bold text-slate-500">Bill amount (₹)</Label>
                              )}
                              {billRequired ? (
                                <Input
                                  type="number" min="0" step="0.01"
                                  value={tvVal}
                                  placeholder="Enter bill amount"
                                  disabled={!canEdit}
                                  title={canEdit ? "" : lockMsg}
                                  onChange={(e) => updEdit("dispatch", dsp.id, { total_value: e.target.value })}
                                  onFocus={(e) => { if (parseFloat(tvVal || "0") === 0) updEdit("dispatch", dsp.id, { total_value: "" }); e.target.select(); }}
                                  onBlur={() => { if (tvVal === "" || tvVal === "-") updEdit("dispatch", dsp.id, { total_value: "0" }); }}
                                  data-testid={`report-amount-input-${dsp.id}`}
                                  className={`no-spinner h-9 rounded-sm ${showLabels ? "mt-0.5" : ""} font-mono-num text-right disabled:bg-slate-50 disabled:cursor-not-allowed`}
                                />
                              ) : (
                                <div
                                  className={`h-9 flex items-center gap-1.5 text-[10px] uppercase font-bold text-slate-400 italic ${showLabels ? "mt-0.5" : ""}`}
                                  data-testid={`report-bill-not-required-${dsp.id}`}
                                  title={`Bill amount is not required for parties on the "${g.price_list_name || 'this'}" price list`}
                                >
                                  Bill not required · {g.price_list_name || "list rule"}
                                </div>
                              )}
                            </div>
                            <div className="sm:col-span-2 flex">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditingDispatch({ ...dsp, _customerCity: g.city || "", _customerLocation: g.location || "", _customerAddress: g.address || "" })}
                                disabled={!canEdit}
                                title={canEdit ? "Edit items, GR & bill" : lockMsg}
                                data-testid={`report-dispatch-edit-btn-${dsp.id}`}
                                className="rounded-sm h-9 w-full border-slate-300 disabled:opacity-40"
                              >
                                <Pencil className="w-3.5 h-3.5 mr-1" /> Edit items
                              </Button>
                            </div>
                          </div>
                        );
                      })}

                      {/* Per-party private mark + No. of bags + UNIFIED SAVE.
                          One button persists GR + Bill (per dispatch) AND
                          private mark + bag count (per party) in a single
                          click. Ludhiana parties skip pvt mark + bags. */}
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end pt-2 border-t border-orange-100">
                          {!ludhiana && (
                            <>
                              <div className="sm:col-span-2 text-[10px] uppercase tracking-wider font-bold flex items-center gap-1"
                                   style={{ color: g.bill_number_mode ? "#4338CA" : undefined }}>
                                <Tag className="w-3 h-3" /> {g.bill_number_mode ? "Bill Number" : "Private mark"}
                              </div>
                              <div className="sm:col-span-4">
                                <Label className="text-[10px] uppercase font-bold text-slate-500">
                                  {g.bill_number_mode ? "Bill Number" : "Mark"}
                                </Label>
                                {g.bill_number_mode ? (
                                  <Input
                                    value={
                                      customerEdit(g.customer_id, "bill_number") !== undefined
                                        ? customerEdit(g.customer_id, "bill_number")
                                        : ((g.dispatches || [])[0]?.bill_number || "")
                                    }
                                    onChange={(e) => updEdit("customer", g.customer_id, { bill_number: e.target.value })}
                                    placeholder="Enter Bill Number Here"
                                    data-testid={`report-billnumber-input-${g.customer_id}`}
                                    className="h-9 rounded-sm mt-0.5 border-indigo-400 focus-visible:ring-indigo-400 bg-indigo-50/40"
                                  />
                                ) : (
                                  <Input
                                    value={
                                      customerEdit(g.customer_id, "private_mark") !== undefined
                                        ? customerEdit(g.customer_id, "private_mark")
                                        : (g.private_mark || "")
                                    }
                                    onChange={(e) => updEdit("customer", g.customer_id, { private_mark: e.target.value })}
                                    placeholder="Stenciled mark on packages (e.g. AB)"
                                    data-testid={`report-pvtmark-input-${g.customer_id}`}
                                    className="h-9 rounded-sm mt-0.5"
                                  />
                                )}
                              </div>
                              {(() => {
                                const bagBuf = customerEdit(g.customer_id, "bag_count");
                                const dsp0 = (g.dispatches || [])[0];
                                const savedBags = Number(dsp0?.bag_count || 0);
                                const bagVal = bagBuf !== undefined ? bagBuf : (savedBags > 0 ? String(savedBags) : "");
                                return (
                                  <div className="sm:col-span-4">
                                    <Label className="text-[10px] uppercase font-bold text-slate-500">No. of bags</Label>
                                    <Input
                                      type="number" min="0" step="1"
                                      value={bagVal}
                                      placeholder="Bags"
                                      onChange={(e) => updEdit("customer", g.customer_id, { bag_count: e.target.value })}
                                      onFocus={(e) => { if (parseInt(bagVal || "0", 10) === 0) updEdit("customer", g.customer_id, { bag_count: "" }); e.target.select(); }}
                                      onBlur={() => { if (bagVal === "" || bagVal === "-") updEdit("customer", g.customer_id, { bag_count: "0" }); }}
                                      data-testid={`report-bags-input-${g.customer_id}`}
                                      className="no-spinner h-9 rounded-sm mt-0.5 font-mono-num text-right"
                                    />
                                  </div>
                                );
                              })()}
                            </>
                          )}
                          {ludhiana && (
                            <div className="sm:col-span-10 text-[11px] text-slate-500 italic flex items-center gap-1.5"
                                 data-testid={`report-ludhiana-note-${g.customer_id}`}>
                              <Tag className="w-3 h-3 text-slate-400" />
                              Ludhiana party · GR number, private mark and no. of bags are not required.
                            </div>
                          )}
                          {(() => {
                            // Single save button gathers dirty state across
                            // every dispatch row AND the party-level fields.
                            const partyDirty = customerEdit(g.customer_id, "private_mark") !== undefined
                              || customerEdit(g.customer_id, "bill_number") !== undefined
                              || customerEdit(g.customer_id, "bag_count") !== undefined;
                            const anyDispatchDirty = (g.dispatches || []).some(
                              (d) => (edits[`dispatch:${d.id}`] && Object.keys(edits[`dispatch:${d.id}`]).length > 0),
                            );
                            const anyEditable = (g.dispatches || []).some((d) => d.can_edit !== false);
                            const isSaving = savingKey === `party:${g.customer_id}`;
                            return (
                              <div className="sm:col-span-2 flex">
                                <Button
                                  size="sm"
                                  onClick={() => saveAllForParty(g.customer_id, g.dispatches)}
                                  disabled={(!partyDirty && !anyDispatchDirty) || isSaving || !anyEditable}
                                  data-testid={`report-save-all-${g.customer_id}`}
                                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-9 w-full disabled:opacity-40"
                                >
                                  <Save className="w-3.5 h-3.5 mr-1" />
                                  {isSaving ? "Saving…" : "Save all"}
                                </Button>
                              </div>
                            );
                          })()}
                        </div>
                    </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                          <th className="text-left px-4 py-2">Item</th>
                          <th className="text-right px-4 py-2">Qty</th>
                          <th className="text-right px-4 py-2">Net ₹</th>
                          {isAdmin && <th className="text-right px-4 py-2">Line ₹</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l, i) => (
                          <tr
                            key={`${g.customer_id}-${i}`}
                            data-testid={`report-line-${g.customer_id}-${i}`}
                            className="border-b border-slate-100 last:border-0"
                          >
                            <td className="px-4 py-2">
                              <div className="font-bold text-slate-900 break-words">{l.item_name}</div>
                              {l.variant && (
                                <div className="text-[10px] text-slate-500 uppercase">{l.variant}</div>
                              )}
                            </td>
                            <td className="px-4 py-2 text-right font-mono-num font-bold">{inr(l.quantity)}</td>
                            <td className="px-4 py-2 text-right font-mono-num font-bold text-slate-900">
                              {inr(l.net_unit_price)}
                            </td>
                            {isAdmin && (
                              <td className="px-4 py-2 text-right font-mono-num font-bold text-[#E65100]">
                                ₹ {inr(l.line_value)}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      {isAdmin && (
                        <tfoot>
                          <tr className="bg-orange-50 border-t border-orange-200">
                            <td className="px-4 py-2 text-xs font-bold text-slate-700">
                              Subtotal
                            </td>
                            <td className="px-4 py-2 text-right font-mono-num font-bold">{inr(g.total_pcs)}</td>
                            <td className="px-4 py-2" />
                            <td className="px-4 py-2 text-right font-mono-num font-extrabold text-[#E65100]">
                              ₹ {inr(g.total_value)}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}

      <DispatchEditDialog
        open={!!editingDispatch}
        onOpenChange={(o) => { if (!o) setEditingDispatch(null); }}
        dispatch={editingDispatch}
        customerCity={editingDispatch?._customerCity || ""}
        customerLocation={editingDispatch?._customerLocation || ""}
        customerAddress={editingDispatch?._customerAddress || ""}
        onSaved={() => load(date)}
      />
    </div>
  );
}

function Tile({ label, value, valueClass = "text-slate-900", testid }) {
  return (
    <div className="bg-white border border-slate-200 rounded-sm p-4" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
      <div className={`font-heading font-extrabold text-2xl ${valueClass} font-mono-num mt-1`}>{value}</div>
    </div>
  );
}
