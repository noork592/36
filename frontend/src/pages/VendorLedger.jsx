import React, { useEffect, useMemo, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import {
  ScrollText, RefreshCw, Filter, CheckCircle2, Check, ChevronsUpDown, ChevronRight,
  Eye, Image as ImageIcon, FileText, Building2, Wallet, Printer, Pencil, Plus, Trash2, Save,
} from "lucide-react";
import IstBadge from "@/components/IstBadge";
import LedgerPrintDialog from "@/components/LedgerPrintDialog";
import { todayIso, isoDaysAgo } from "@/lib/dates";
import { useAuth } from "@/lib/auth";
import { Label } from "@/components/ui/label";

const fmt = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function fmtDateOnly(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Searchable combobox for vendor selection
function VendorCombobox({ vendors, value, onChange }) {
  const [open, setOpen] = useState(false);
  // Controlled cmdk search text + highlighted value.
  // Resetting them on every open + on every keystroke lets us deterministically
  // pin the list scroll to the top so the first suggested option is always
  // visible (no fragile RAF pin, no full-remount hack).
  const [search, setSearch] = useState("");
  const [activeValue, setActiveValue] = useState("");
  const listRef = useRef(null);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [open, search]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const handleOpenChange = (next) => {
    if (!next) {
      setSearch("");
      setActiveValue("");
    }
    setOpen(next);
  };

  const selected = vendors.find((v) => v.id === value);

  // Manual filter to preserve the source `vendors` order. cmdk's built-in
  // filter reorders items by match score and never restores the original
  // order after the search is cleared.
  const filteredVendors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => {
      const hay = `${v.name} ${v.phone || ""} ${v.material_category || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [vendors, search]);

  // Keep the highlighted item aligned with the visible top of the filtered list.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open) return;
    setActiveValue(filteredVendors[0]?.id || "");
  }, [open, search, filteredVendors.length]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-testid="vendor-ledger-picker"
          className="w-full sm:w-2/3 justify-between h-10 rounded-sm border-slate-300 font-normal text-sm bg-white"
        >
          <span className={selected ? "text-slate-900 font-medium truncate" : "text-slate-400"}>
            {selected ? selected.name : "— Pick a vendor —"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 rounded-sm"
        align="start"
        side="bottom"
        sideOffset={4}
        avoidCollisions={true}
        collisionPadding={12}
      >
        <Command value={activeValue} onValueChange={setActiveValue} shouldFilter={false}>
          <CommandInput
            placeholder="Search vendor by name, phone, material…"
            data-testid="vendor-ledger-search-input"
            className="h-10"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList ref={listRef}>
            {filteredVendors.length === 0 && <CommandEmpty>No matching vendor</CommandEmpty>}
            <CommandGroup>
              {filteredVendors.map((v) => (
                <CommandItem
                  key={v.id}
                  value={v.id}
                  onSelect={() => { onChange(v.id); handleOpenChange(false); }}
                  data-testid={`vendor-ledger-option-${v.id}`}
                  className="cursor-pointer"
                >
                  <Check className={`mr-2 h-4 w-4 ${value === v.id ? "opacity-100" : "opacity-0"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-900 truncate">{v.name}</div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {[v.phone, v.material_category, v.contact_person].filter(Boolean).join(" · ") || " "}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function VendorLedger() {
  const { isAdmin, canAct } = useAuth();
  const canEditVendorLedger = canAct("edit:vendorLedger");
  const [vendors, setVendors] = useState([]);
  const [draft, setDraft] = useState({
    startDate: isoDaysAgo(90),
    endDate: todayIso(),
    vendorId: "",
  });
  const [applied, setApplied] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailRow, setDetailRow] = useState(null);
  const [previewImg, setPreviewImg] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  // Admin-only edit dialog for a purchase slip
  const [editPurchase, setEditPurchase] = useState(null); // raw purchase doc

  useEffect(() => {
    api.get("/suppliers").then((r) => setVendors(r.data || []))
      .catch(() => toast.error("Failed to load vendors"));
  }, []);

  const load = async (filt = applied) => {
    if (!filt?.vendorId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/supplier-ledger/${filt.vendorId}`);
      setLedger(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load ledger");
    } finally { setLoading(false); }
  };

  const apply = () => {
    if (!draft.vendorId) { toast.error("Select a vendor"); return; }
    const filt = { ...draft };
    setApplied(filt);
    setLedger(null);
    setDetailRow(null);
    load(filt);
  };

  const resetFilters = () => { setApplied(null); setLedger(null); };

  const selectedVendor = vendors.find((v) => v.id === applied?.vendorId);

  // Client-side date filtering of ledger rows. Backend returns everything,
  // we slice to the [startDate, endDate] window so the running balance still
  // includes opening + earlier txns up to the start.
  const filteredView = useMemo(() => {
    if (!ledger || !applied) return null;
    const start = applied.startDate || "";
    const end = applied.endDate || "";
    let runningOpening = ledger.opening_balance || 0;
    const inWindow = [];
    for (const r of ledger.rows || []) {
      const day = (r.when || "").slice(0, 10);
      if (start && day < start) {
        // before window — fold into opening
        runningOpening += (r.debit || 0) - (r.credit || 0);
        continue;
      }
      if (end && day > end) continue; // after window — skip
      inWindow.push(r);
    }
    // Recompute running balance over the window
    let bal = runningOpening;
    const rows = inWindow.map((r) => {
      bal += (r.debit || 0) - (r.credit || 0);
      return { ...r, balance: Math.round(bal * 100) / 100 };
    });
    const total_debit = rows.reduce((s, r) => s + (r.debit || 0), 0);
    const total_credit = rows.reduce((s, r) => s + (r.credit || 0), 0);
    return {
      opening: Math.round(runningOpening * 100) / 100,
      closing: Math.round(bal * 100) / 100,
      rows, total_debit, total_credit,
    };
  }, [ledger, applied]);

  return (
    <div className="space-y-5" data-testid="vendor-ledger-page">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Purchases</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900 flex items-center gap-2">
            <ScrollText className="w-7 h-7 text-[#E65100]" /> Vendor Ledger
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Vendor-wise running ledger of every purchase &amp; payment — like a supplier account book.
          </p>
        </div>
        {applied && (
          <div className="flex items-center gap-2">
            <Link to={`/admin/suppliers/${applied.vendorId}`}>
              <Button data-testid="vendor-ledger-manage-entries"
                      className="bg-emerald-700 hover:bg-emerald-800 text-white rounded-sm h-10">
                <Wallet className="w-4 h-4 mr-1.5" /> Record purchase / payment
              </Button>
            </Link>
            <Button onClick={() => load()} variant="outline" size="sm"
                    data-testid="vendor-ledger-refresh"
                    className="rounded-sm border-slate-300 h-10">
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Button onClick={() => setPrintOpen(true)} variant="outline" size="sm"
                    disabled={!filteredView}
                    data-testid="vendor-ledger-print-btn"
                    className="rounded-sm border-slate-300 h-10">
              <Printer className="w-4 h-4 mr-1" /> Print / Preview
            </Button>
          </div>
        )}
      </div>

      {/* Picker card or applied bar */}
      {applied ? (
        <div className="bg-white border border-slate-200 rounded-sm p-3 flex items-center justify-between flex-wrap gap-3"
             data-testid="vendor-ledger-applied-bar">
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-bold text-slate-900">{selectedVendor?.name || "—"}</span>
            </div>
            <div className="text-slate-500 tabular-nums">
              {applied.startDate} → {applied.endDate}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={resetFilters}
                  data-testid="vendor-ledger-change-filters"
                  className="rounded-sm border-slate-300 h-9">
            <Filter className="w-3.5 h-3.5 mr-1.5" /> Change filters
          </Button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-sm p-5 space-y-5"
             data-testid="vendor-ledger-picker-card">
          {/* Step 1 — Accounting period */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#E65100] text-white text-xs font-extrabold">1</span>
              <h3 className="font-heading font-extrabold text-slate-900 text-sm uppercase tracking-wide">Accounting period</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-8">
              <div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">From</label>
                  <IstBadge />
                </div>
                <Input type="date" value={draft.startDate}
                       onChange={(e) => setDraft((p) => ({ ...p, startDate: e.target.value }))}
                       data-testid="vendor-ledger-start-date"
                       className="h-10 rounded-sm mt-1" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">To</label>
                  <IstBadge />
                </div>
                <Input type="date" value={draft.endDate}
                       onChange={(e) => setDraft((p) => ({ ...p, endDate: e.target.value }))}
                       data-testid="vendor-ledger-end-date"
                       className="h-10 rounded-sm mt-1" />
              </div>
            </div>
          </div>
          {/* Step 2 — Vendor combobox */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#E65100] text-white text-xs font-extrabold">2</span>
              <h3 className="font-heading font-extrabold text-slate-900 text-sm uppercase tracking-wide">Vendor account</h3>
            </div>
            <div className="pl-8">
              <VendorCombobox
                vendors={vendors}
                value={draft.vendorId}
                onChange={(id) => setDraft((p) => ({ ...p, vendorId: id }))}
              />
            </div>
          </div>
          <div className="flex items-center justify-end pt-2 border-t border-slate-100">
            <Button onClick={apply}
                    disabled={!draft.vendorId}
                    data-testid="vendor-ledger-apply-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-11 px-6 font-bold">
              View Ledger <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Ledger table */}
      {applied && (
        <div className="bg-white border border-slate-200 rounded-sm" data-testid="vendor-ledger-table">
          {loading ? (
            <div className="p-10 text-center text-slate-400">Loading…</div>
          ) : !filteredView ? (
            <div className="p-10 text-center text-slate-400">No data.</div>
          ) : (
            <>
              {/* Opening balance strip */}
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs flex items-center justify-between flex-wrap gap-2">
                <div className="text-slate-600">
                  <span className="font-bold uppercase tracking-wider text-[10px] text-slate-500">Opening balance</span>{" "}
                  <span className="font-bold tabular-nums text-slate-900">₹{fmt(filteredView.opening)}</span>{" "}
                  <span className="text-[10px] font-bold">{filteredView.opening >= 0 ? "Dr" : "Cr"}</span>
                </div>
                <div className="text-slate-600">
                  <span className="font-bold uppercase tracking-wider text-[10px] text-slate-500">Closing balance</span>{" "}
                  <span className="font-extrabold tabular-nums text-[#E65100]">₹{fmt(filteredView.closing)}</span>{" "}
                  <span className="text-[10px] font-bold">{filteredView.closing >= 0 ? "Dr" : "Cr"}</span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
                    <tr>
                      <th className="text-left px-3 py-2 w-28">Date</th>
                      <th className="text-left px-3 py-2">Particulars</th>
                      <th className="text-left px-3 py-2 w-28">Reference</th>
                      <th className="text-right px-3 py-2 w-28">Debit ₹</th>
                      <th className="text-right px-3 py-2 w-28">Credit ₹</th>
                      <th className="text-right px-3 py-2 w-32">Balance ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredView.rows.length === 0 ? (
                      <tr><td colSpan={6} className="text-center text-slate-400 py-10">No transactions in this period.</td></tr>
                    ) : filteredView.rows.map((r) => {
                      const isPurchase = r.kind === "purchase";
                      return (
                        <tr key={`${r.kind}-${r.id}`}
                            onClick={() => { if (isPurchase) setDetailRow(r); }}
                            className={`border-t border-slate-100 hover:bg-orange-50/30 ${isPurchase ? "cursor-pointer" : ""}`}
                            data-testid={`vendor-ledger-row-${r.id}`}>
                          <td className="px-3 py-2 text-slate-600">{fmtDateOnly(r.when)}</td>
                          <td className="px-3 py-2 text-slate-900">
                            <div className="inline-flex items-center gap-1.5">
                              {isPurchase && <Eye className="w-3.5 h-3.5 text-slate-400" />}
                              <span className={isPurchase ? "underline-offset-2 hover:underline" : ""}>
                                {r.particulars}
                              </span>
                              {isPurchase && Array.isArray(r.raw?.bill_images) && r.raw.bill_images.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-orange-50 border border-orange-200 text-orange-900 px-1.5 py-0.5 rounded-sm"
                                      title={`${r.raw.bill_images.length} bill photo(s)`}>
                                  <ImageIcon className="w-3 h-3" /> {r.raw.bill_images.length}
                                </span>
                              )}
                            </div>
                            {r.notes && <div className="text-[11px] text-slate-500 italic mt-0.5">{r.notes}</div>}
                          </td>
                          <td className="px-3 py-2 text-slate-500 font-mono text-xs">{r.reference || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.debit ? fmt(r.debit) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{r.credit ? fmt(r.credit) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">
                            {fmt(r.balance)} <span className="text-[10px] font-bold ml-1">{Number(r.balance) >= 0 ? "Dr" : "Cr"}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 border-t border-slate-200 text-xs">
                      <td colSpan={3} className="px-3 py-2 text-right font-bold uppercase tracking-wider text-slate-600">Period totals</td>
                      <td className="px-3 py-2 text-right tabular-nums font-extrabold text-slate-900">₹{fmt(filteredView.total_debit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-extrabold text-emerald-700">₹{fmt(filteredView.total_credit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-extrabold text-[#E65100]">
                        ₹{fmt(filteredView.closing)} {filteredView.closing >= 0 ? "Dr" : "Cr"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Purchase detail dialog (clicking a purchase row) */}
      <Dialog open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailRow(null); }}>
        <DialogContent className="rounded-sm max-w-2xl" data-testid="vendor-ledger-purchase-detail">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#E65100]" /> Purchase detail
            </DialogTitle>
            <DialogDescription>Full record of this purchase entry.</DialogDescription>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ["Date", fmtDateOnly(detailRow.raw?.purchased_at || detailRow.when)],
                  ["Bill #", detailRow.raw?.bill_number || detailRow.reference || "—"],
                  ["Amount", `₹${fmt(detailRow.raw?.amount ?? detailRow.debit)}`],
                  ["By", detailRow.raw?.created_by || "—"],
                ].map(([k, v], i) => (
                  <div key={i} className="border border-slate-200 rounded-sm bg-slate-50 p-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{k}</div>
                    <div className="text-sm font-bold text-slate-900 tabular-nums mt-0.5 break-words">{v}</div>
                  </div>
                ))}
              </div>
              {(detailRow.raw?.material || "").trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Material</div>
                  <div className="text-sm text-slate-800 mt-0.5">{detailRow.raw.material}</div>
                </div>
              )}
              {Array.isArray(detailRow.raw?.items) && detailRow.raw.items.length > 0 && (
                <div className="border border-slate-200 rounded-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
                      <tr>
                        <th className="text-left px-3 py-2">Raw material</th>
                        <th className="text-right px-3 py-2 w-20">Qty</th>
                        <th className="text-left px-3 py-2 w-16">Unit</th>
                        <th className="text-right px-3 py-2 w-24">Rate (₹)</th>
                        <th className="text-right px-3 py-2 w-28">Line ₹</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailRow.raw.items.map((it, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-900 font-bold">{it.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.quantity}</td>
                          <td className="px-3 py-2 text-slate-700">{it.unit || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">₹{fmt(it.rate)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">₹{fmt(it.line_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(detailRow.raw?.notes || "").trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Notes</div>
                  <div className="text-sm text-slate-700 italic mt-0.5">{detailRow.raw.notes}</div>
                </div>
              )}
              {Array.isArray(detailRow.raw?.bill_images) && detailRow.raw.bill_images.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1 inline-flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-[#E65100]" /> Bill photos ({detailRow.raw.bill_images.length})
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {detailRow.raw.bill_images.map((src, i) => (
                      <button key={i} type="button" onClick={() => setPreviewImg(src)}
                              className="aspect-square border border-slate-200 rounded-sm overflow-hidden bg-slate-50 hover:ring-2 hover:ring-[#E65100]">
                        <img src={src} alt={`bill ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {canEditVendorLedger && detailRow && (
              <Button
                onClick={() => { setEditPurchase(detailRow.raw); setDetailRow(null); }}
                data-testid="vendor-ledger-edit-purchase"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
              >
                <Pencil className="w-4 h-4 mr-1.5" /> Edit slip
              </Button>
            )}
            <Button variant="outline" onClick={() => setDetailRow(null)} className="rounded-sm">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin-only purchase edit dialog */}
      <EditPurchaseDialog
        open={!!editPurchase}
        purchase={editPurchase}
        onClose={() => setEditPurchase(null)}
        onSaved={() => { setEditPurchase(null); load(applied); }}
      />

      {/* Bill photo lightbox */}
      <Dialog open={!!previewImg} onOpenChange={(o) => { if (!o) setPreviewImg(null); }}>
        <DialogContent className="rounded-sm max-w-3xl bg-slate-900 border-slate-800">
          <DialogHeader>
            <DialogTitle className="font-heading text-white flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-[#E65100]" /> Bill photo
            </DialogTitle>
          </DialogHeader>
          {previewImg && <img src={previewImg} alt="Bill" className="max-h-[75vh] w-full object-contain rounded-sm bg-black" />}
        </DialogContent>
      </Dialog>

      {/* Print / Preview ledger statement */}
      <LedgerPrintDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Vendor Ledger"
        party={selectedVendor}
        period={{ startDate: applied?.startDate, endDate: applied?.endDate }}
        opening={filteredView?.opening || 0}
        closing={filteredView?.closing || 0}
        total_debit={filteredView?.total_debit || 0}
        total_credit={filteredView?.total_credit || 0}
        rows={filteredView?.rows || []}
      />
    </div>
  );
}

/**
 * Admin-only dialog to edit a vendor-ledger purchase slip in place.
 * Lets the admin change date, bill #, notes, items (qty / rate) and the
 * total amount. Items that match a vendor-price-list entry have their
 * rate auto-filled and locked — the same rule that governs new entries.
 */
function EditPurchaseDialog({ open, purchase, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [vendorPrices, setVendorPrices] = useState({});

  useEffect(() => {
    if (!purchase) { setForm(null); return; }
    setForm({
      id: purchase.id,
      supplier_id: purchase.supplier_id,
      bill_number: purchase.bill_number || "",
      purchased_at: (purchase.purchased_at || "").slice(0, 10) || todayIso(),
      notes: purchase.notes || "",
      items: (purchase.items || []).map((it) => ({
        raw_material_id: it.raw_material_id || null,
        name: it.name || "",
        unit: it.unit || "",
        quantity: String(it.quantity ?? ""),
        rate: String(it.rate ?? ""),
      })),
    });
  }, [purchase]);

  // Vendor price-list lookup for the slip's vendor
  useEffect(() => {
    if (!form?.supplier_id) { setVendorPrices({}); return; }
    let alive = true;
    (async () => {
      try {
        const { data: lists } = await api.get("/vendor-price-lists");
        const mine = (lists || []).filter((pl) => pl.vendor_id === form.supplier_id);
        const map = {};
        for (const pl of mine) {
          try {
            const { data } = await api.get(`/vendor-price-lists/${pl.id}`);
            for (const it of (data?.items || [])) {
              const key = String(it.name || "").trim().toLowerCase();
              const price = Number(it.price || 0);
              if (!key || price <= 0) continue;
              map[key] = { price, unit: it.unit || "", source_list: pl.name };
            }
          } catch { /* ignore */ }
        }
        if (alive) setVendorPrices(map);
      } catch { if (alive) setVendorPrices({}); }
    })();
    return () => { alive = false; };
  }, [form?.supplier_id]);

  if (!open || !form) return null;

  const update = (idx, patch) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, ...patch } : it) }));

  const addLine = () => setForm((f) => ({
    ...f,
    items: [...f.items, { raw_material_id: null, name: "", unit: "", quantity: "", rate: "" }],
  }));

  const removeLine = (idx) => setForm((f) => ({
    ...f,
    items: f.items.length === 1 ? f.items : f.items.filter((_, i) => i !== idx),
  }));

  const total = form.items.reduce((s, it) => {
    const q = Number(it.quantity || 0);
    const r = Number(it.rate || 0);
    return s + (q > 0 ? q * r : 0);
  }, 0);

  const save = async () => {
    const items = form.items
      .map((it) => ({
        raw_material_id: it.raw_material_id || null,
        name: (it.name || "").trim(),
        unit: (it.unit || "").trim(),
        quantity: Number(it.quantity || 0),
        rate: Number(it.rate || 0),
      }))
      .filter((it) => it.name && it.quantity > 0);
    setSaving(true);
    try {
      await api.patch(`/supplier-purchases/${form.id}`, {
        bill_number: form.bill_number,
        purchased_at: form.purchased_at,
        notes: form.notes,
        items,
      });
      toast.success("Purchase updated");
      onSaved?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="rounded-sm max-w-3xl" data-testid="vendor-ledger-edit-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading flex items-center gap-2">
            <Pencil className="w-4 h-4 text-[#E65100]" /> Edit purchase slip
          </DialogTitle>
          <DialogDescription>Admin-only — all fields editable. Stock movements are reconciled automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-bold uppercase">Bill number</Label>
              <Input
                value={form.bill_number}
                onChange={(e) => setForm((f) => ({ ...f, bill_number: e.target.value }))}
                data-testid="edit-purchase-bill"
                className="h-10 rounded-sm mt-1 font-mono"
              />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Date</Label>
              <Input
                type="date"
                value={form.purchased_at}
                onChange={(e) => setForm((f) => ({ ...f, purchased_at: e.target.value }))}
                data-testid="edit-purchase-date"
                className="h-10 rounded-sm mt-1"
              />
            </div>
          </div>
          <div className="border border-slate-200 rounded-sm overflow-hidden">
            <div className="bg-slate-50 px-3 py-2 text-[11px] uppercase tracking-wider font-bold text-slate-600">
              Raw material line items
            </div>
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                <tr>
                  <th className="text-left px-3 py-2">Material</th>
                  <th className="text-left px-3 py-2 w-20">Qty</th>
                  <th className="text-left px-3 py-2 w-16">Unit</th>
                  <th className="text-left px-3 py-2 w-24">Rate ₹</th>
                  <th className="text-right px-3 py-2 w-24">Line ₹</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, idx) => {
                  const vp = it.name ? vendorPrices[String(it.name).trim().toLowerCase()] : null;
                  // EditPurchaseDialog is admin-only → admin can edit any rate.
                  const lineVal = Number(it.quantity || 0) * Number(it.rate || 0);
                  return (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-2 py-1.5">
                        <Input
                          value={it.name}
                          onChange={(e) => update(idx, { name: e.target.value })}
                          data-testid={`edit-purchase-line-${idx}-name`}
                          className="h-9 rounded-sm"
                        />
                        {vp && (
                          <div className="text-[10px] text-emerald-700 mt-0.5 truncate" title={vp.source_list}>
                            From: {vp.source_list}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number" min="0" step="0.01"
                          value={it.quantity}
                          onChange={(e) => update(idx, { quantity: e.target.value })}
                          data-testid={`edit-purchase-line-${idx}-qty`}
                          className="no-spinner h-9 rounded-sm tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={it.unit}
                          onChange={(e) => update(idx, { unit: e.target.value })}
                          placeholder="kg / pcs"
                          data-testid={`edit-purchase-line-${idx}-unit`}
                          className="h-9 rounded-sm"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number" min="0" step="0.01"
                          value={it.rate}
                          onChange={(e) => update(idx, { rate: e.target.value })}
                          title={vp ? `Auto-filled from "${vp.source_list}" — you may override` : "Optional"}
                          placeholder="Optional"
                          data-testid={`edit-purchase-line-${idx}-rate`}
                          className="no-spinner h-9 rounded-sm tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-bold text-slate-900">
                        ₹{fmt(lineVal)}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        <Button variant="ghost" size="icon"
                                onClick={() => removeLine(idx)}
                                disabled={form.items.length === 1}
                                data-testid={`edit-purchase-line-${idx}-remove`}
                                className="h-8 w-8 text-red-600 hover:bg-red-50 rounded-sm disabled:opacity-30">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 border-t border-slate-200">
                  <td colSpan={4} className="px-3 py-2">
                    <Button variant="outline" size="sm" onClick={addLine}
                            data-testid="edit-purchase-add-line"
                            className="rounded-sm h-8">
                      <Plus className="w-3.5 h-3.5 mr-1" /> Add line
                    </Button>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold text-slate-900" data-testid="edit-purchase-total">
                    ₹{fmt(total)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div>
            <Label className="text-xs font-bold uppercase">Notes</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              data-testid="edit-purchase-notes"
              className="h-10 rounded-sm mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm">Cancel</Button>
          <Button
            onClick={save}
            disabled={saving}
            data-testid="edit-purchase-save"
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
          >
            <Save className="w-4 h-4 mr-1.5" /> {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
