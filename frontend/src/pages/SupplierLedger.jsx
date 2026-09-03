import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Building2, Wallet, FileText, Eye, Image as ImageIcon, X, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";

const fmt = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB"); // dd/mm/yyyy
};
const todayIso = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

export default function SupplierLedger() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [purchaseForm, setPurchaseForm] = useState({ amount: "", bill_number: "", material: "", purchased_at: todayIso(), notes: "" });
  const [paymentForm, setPaymentForm] = useState({ amount: "", source: "cash", reference: "", paid_at: todayIso(), notes: "" });
  const [returnForm, setReturnForm] = useState({ amount: "", reference: "", material: "", reason: "", returned_at: todayIso(), notes: "" });
  const [confirm, setConfirm] = useState(null); // row to delete
  const [saving, setSaving] = useState(false);
  const [detailRow, setDetailRow] = useState(null); // purchase row whose details are open
  const [previewImg, setPreviewImg] = useState(null); // bill photo lightbox

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/supplier-ledger/${id}`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load ledger");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [id]);

  const savePurchase = async () => {
    const amt = Number(purchaseForm.amount);
    if (!amt || amt <= 0) { toast.error("Amount > 0"); return; }
    setSaving(true);
    try {
      await api.post("/supplier-purchases", { supplier_id: id, ...purchaseForm, amount: amt });
      toast.success("Purchase recorded");
      setPurchaseOpen(false);
      setPurchaseForm({ amount: "", bill_number: "", material: "", purchased_at: todayIso(), notes: "" });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  const savePayment = async () => {
    const amt = Number(paymentForm.amount);
    if (!amt || amt <= 0) { toast.error("Amount > 0"); return; }
    setSaving(true);
    try {
      await api.post("/supplier-payments", { supplier_id: id, ...paymentForm, amount: amt });
      toast.success("Payment recorded");
      setPaymentOpen(false);
      setPaymentForm({ amount: "", source: "cash", reference: "", paid_at: todayIso(), notes: "" });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  const saveReturn = async () => {
    const amt = Number(returnForm.amount);
    if (!amt || amt <= 0) { toast.error("Amount > 0"); return; }
    setSaving(true);
    try {
      await api.post("/purchase-returns", { supplier_id: id, ...returnForm, amount: amt });
      toast.success("Purchase return recorded");
      setReturnOpen(false);
      setReturnForm({ amount: "", reference: "", material: "", reason: "", returned_at: todayIso(), notes: "" });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  const deleteRow = async (row) => {
    try {
      let path;
      if (row.kind === "purchase") path = `/supplier-purchases/${row.id}`;
      else if (row.kind === "purchase_return") path = `/purchase-returns/${row.id}`;
      else path = `/supplier-payments/${row.id}`;
      await api.delete(path);
      toast.success("Row deleted");
      setConfirm(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  if (loading && !data) return <div className="p-6 text-slate-500">Loading…</div>;
  if (!data) return <div className="p-6 text-slate-500">Supplier not found.</div>;
  const s = data.supplier;

  return (
    <div className="space-y-4" data-testid="supplier-ledger-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/admin/suppliers" className="text-[11px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to suppliers
          </Link>
          <div className="flex items-center gap-2 mt-1">
            <Building2 className="w-5 h-5 text-[#E65100]" />
            <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900" data-testid="supplier-name-header">
              {s.name}
            </h1>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {[s.city, s.phone, s.gst_number && `GST ${s.gst_number}`, s.material_category].filter(Boolean).join(" · ") || " "}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => setPurchaseOpen(true)}
                  data-testid="record-purchase-btn"
                  className="bg-slate-900 hover:bg-slate-800 text-white rounded-sm h-10">
            <FileText className="w-4 h-4 mr-1" /> Record purchase
          </Button>
          <Button onClick={() => setPaymentOpen(true)}
                  data-testid="record-supplier-payment-btn"
                  className="bg-emerald-700 hover:bg-emerald-800 text-white rounded-sm h-10">
            <Wallet className="w-4 h-4 mr-1" /> Record payment
          </Button>
          <Button onClick={() => setReturnOpen(true)}
                  data-testid="record-purchase-return-btn"
                  className="bg-amber-600 hover:bg-amber-700 text-white rounded-sm h-10">
            <Undo2 className="w-4 h-4 mr-1" /> Purchase Return
          </Button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["Opening", data.opening_balance],
          ["Total purchased (Dr)", data.total_debit],
          ["Total paid (Cr)", data.total_credit],
          ["Closing balance", data.closing_balance],
        ].map(([label, val], i) => (
          <div key={i} className="border border-slate-200 rounded-sm bg-white p-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
            <div className={`mt-1 text-lg font-extrabold tabular-nums ${
              i === 3 && Number(val) > 0 ? "text-red-700" : i === 3 && Number(val) < 0 ? "text-emerald-700" : "text-slate-900"
            }`}>
              {fmt(val)} {i === 3 ? <span className="text-[10px] font-bold ml-1">{Number(val) >= 0 ? "Dr" : "Cr"}</span> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Ledger table */}
      <div className="border border-slate-200 rounded-sm overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
            <tr>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Particulars</th>
              <th className="text-left px-3 py-2">Reference</th>
              <th className="text-right px-3 py-2">Debit (₹)</th>
              <th className="text-right px-3 py-2">Credit (₹)</th>
              <th className="text-right px-3 py-2">Balance</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-orange-50/40 border-t border-slate-100">
              <td className="px-3 py-2 italic text-slate-500">—</td>
              <td className="px-3 py-2 italic text-slate-500">Opening balance</td>
              <td colSpan={3}></td>
              <td className="px-3 py-2 text-right tabular-nums font-bold">{fmt(data.opening_balance)} <span className="text-[10px] font-bold ml-1">Dr</span></td>
              <td></td>
            </tr>
            {(data.rows || []).length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500" data-testid="ledger-empty">
                No transactions yet.
              </td></tr>
            )}
            {(data.rows || []).map((r) => {
              const isPurchase = r.kind === "purchase";
              const isReturn = r.kind === "purchase_return";
              return (
              <tr
                key={`${r.kind}-${r.id}`}
                onClick={() => { if (isPurchase) setDetailRow(r); }}
                className={`border-t border-slate-100 hover:bg-orange-50/30 ${isPurchase ? "cursor-pointer" : ""}`}
                data-testid={isReturn ? `ledger-return-row-${r.id}` : `ledger-row-${r.id}`}
              >
                <td className="px-3 py-2 text-slate-600">{fmtDate(r.when)}</td>
                <td className="px-3 py-2 text-slate-900">
                  <div className="inline-flex items-center gap-1.5 flex-wrap">
                    {isPurchase && <Eye className="w-3.5 h-3.5 text-slate-400" />}
                    {isReturn && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-amber-100 border border-amber-300 text-amber-900 px-1.5 py-0.5 rounded-sm">
                        <Undo2 className="w-3 h-3" /> Return
                      </span>
                    )}
                    <span className={isPurchase ? "underline-offset-2 hover:underline" : ""}>
                      {r.particulars}
                    </span>
                    {isPurchase && Array.isArray(r.raw?.bill_images) && r.raw.bill_images.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-orange-50 border border-orange-200 text-orange-900 px-1.5 py-0.5 rounded-sm"
                        title={`${r.raw.bill_images.length} bill photo(s)`}
                        data-testid={`ledger-row-${r.id}-photo-badge`}
                      >
                        <ImageIcon className="w-3 h-3" /> {r.raw.bill_images.length}
                      </span>
                    )}
                  </div>
                  {r.notes && <div className="text-[11px] text-slate-500 italic mt-0.5">{r.notes}</div>}
                </td>
                <td className="px-3 py-2 text-slate-500 font-mono text-xs">{r.reference || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.debit ? fmt(r.debit) : "—"}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${isReturn ? "text-amber-700" : "text-emerald-700"}`}>{r.credit ? fmt(r.credit) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">{fmt(r.balance)} <span className="text-[10px] font-bold ml-1">{Number(r.balance) >= 0 ? "Dr" : "Cr"}</span></td>
                <td className="px-3 py-2 text-right">
                  {!r.raw?.customer_payment_id && (
                    <Button size="sm" variant="outline" className="rounded-sm h-7 text-red-700 hover:bg-red-50"
                            onClick={(e) => { e.stopPropagation(); setConfirm(r); }}
                            data-testid={`ledger-delete-${r.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Record Purchase Dialog */}
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="rounded-sm max-w-md" data-testid="purchase-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">Record purchase</DialogTitle>
            <DialogDescription>Add a debit entry to {s.name}&apos;s ledger — material we received from them.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">Amount (₹) *</Label>
                <Input type="number" min="0" step="0.01" value={purchaseForm.amount}
                       onChange={(e) => setPurchaseForm((p) => ({ ...p, amount: e.target.value }))}
                       data-testid="purchase-amount-input" placeholder="0.00"
                       className="h-11 rounded-sm mt-1 tabular-nums" />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Date</Label>
                <Input type="date" value={purchaseForm.purchased_at}
                       onChange={(e) => setPurchaseForm((p) => ({ ...p, purchased_at: e.target.value }))}
                       className="h-11 rounded-sm mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Bill number</Label>
              <Input value={purchaseForm.bill_number}
                     onChange={(e) => setPurchaseForm((p) => ({ ...p, bill_number: e.target.value }))}
                     placeholder="e.g. INV-2026-001"
                     className="h-11 rounded-sm mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Material</Label>
              <Input value={purchaseForm.material}
                     onChange={(e) => setPurchaseForm((p) => ({ ...p, material: e.target.value }))}
                     placeholder="e.g. 100kg MS rod 8mm"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Notes</Label>
              <Input value={purchaseForm.notes}
                     onChange={(e) => setPurchaseForm((p) => ({ ...p, notes: e.target.value }))}
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurchaseOpen(false)} className="rounded-sm">Cancel</Button>
            <Button onClick={savePurchase} disabled={saving || !purchaseForm.amount}
                    data-testid="purchase-save-btn"
                    className="bg-slate-900 hover:bg-slate-800 text-white rounded-sm">
              {saving ? "Saving…" : "Save purchase"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record Payment Dialog */}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="rounded-sm max-w-md" data-testid="supplier-payment-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">Record payment</DialogTitle>
            <DialogDescription>Record a payment we made to {s.name}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">Amount (₹) *</Label>
                <Input type="number" min="0" step="0.01" value={paymentForm.amount}
                       onChange={(e) => setPaymentForm((p) => ({ ...p, amount: e.target.value }))}
                       data-testid="supplier-payment-amount-input" placeholder="0.00"
                       className="h-11 rounded-sm mt-1 tabular-nums" />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Date</Label>
                <Input type="date" value={paymentForm.paid_at}
                       onChange={(e) => setPaymentForm((p) => ({ ...p, paid_at: e.target.value }))}
                       className="h-11 rounded-sm mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Source</Label>
              <select value={paymentForm.source}
                      onChange={(e) => setPaymentForm((p) => ({ ...p, source: e.target.value }))}
                      className="mt-1 w-full h-11 rounded-sm border border-slate-300 px-3 text-sm bg-white">
                {["cash", "upi", "bank_transfer", "neft", "rtgs", "cheque", "card", "adjustment", "other"].map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Reference</Label>
              <Input value={paymentForm.reference}
                     onChange={(e) => setPaymentForm((p) => ({ ...p, reference: e.target.value }))}
                     placeholder="UTR / cheque no."
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Notes</Label>
              <Input value={paymentForm.notes}
                     onChange={(e) => setPaymentForm((p) => ({ ...p, notes: e.target.value }))}
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentOpen(false)} className="rounded-sm">Cancel</Button>
            <Button onClick={savePayment} disabled={saving || !paymentForm.amount}
                    data-testid="supplier-payment-save-btn"
                    className="bg-emerald-700 hover:bg-emerald-800 text-white rounded-sm">
              {saving ? "Saving…" : "Save payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="rounded-sm max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">Delete row?</DialogTitle>
            <DialogDescription>
              This will remove this {confirm?.kind?.replace(/_/g, " ") || "row"} from the supplier ledger. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} className="rounded-sm">Cancel</Button>
            <Button onClick={() => deleteRow(confirm)}
                    className="bg-red-700 hover:bg-red-800 text-white rounded-sm">
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record Purchase Return Dialog */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="rounded-sm max-w-md" data-testid="purchase-return-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Undo2 className="w-5 h-5 text-amber-600" />
              Record Purchase Return
            </DialogTitle>
            <DialogDescription>
              Goods returned to <span className="font-bold">{s.name}</span>. This will be a
              CREDIT entry on their ledger (reduces what we owe).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">Amount (₹) *</Label>
                <Input type="number" min="0" step="0.01" value={returnForm.amount}
                       onChange={(e) => setReturnForm((p) => ({ ...p, amount: e.target.value }))}
                       data-testid="purchase-return-amount-input" placeholder="0.00"
                       className="h-11 rounded-sm mt-1 tabular-nums" autoFocus />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Date</Label>
                <Input type="date" value={returnForm.returned_at}
                       onChange={(e) => setReturnForm((p) => ({ ...p, returned_at: e.target.value }))}
                       data-testid="purchase-return-date-input"
                       className="h-11 rounded-sm mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Debit Note # / Reference</Label>
              <Input value={returnForm.reference}
                     onChange={(e) => setReturnForm((p) => ({ ...p, reference: e.target.value }))}
                     placeholder="e.g. DN-001"
                     data-testid="purchase-return-ref-input"
                     className="h-11 rounded-sm mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Material returned</Label>
              <Input value={returnForm.material}
                     onChange={(e) => setReturnForm((p) => ({ ...p, material: e.target.value }))}
                     placeholder="e.g. 5kg MS rod 8mm"
                     data-testid="purchase-return-material-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Reason</Label>
              <Input value={returnForm.reason}
                     onChange={(e) => setReturnForm((p) => ({ ...p, reason: e.target.value }))}
                     placeholder="e.g. defective, wrong material"
                     data-testid="purchase-return-reason-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Notes</Label>
              <Input value={returnForm.notes}
                     onChange={(e) => setReturnForm((p) => ({ ...p, notes: e.target.value }))}
                     data-testid="purchase-return-notes-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)} className="rounded-sm"
                    data-testid="purchase-return-cancel-btn">Cancel</Button>
            <Button onClick={saveReturn} disabled={saving || !returnForm.amount}
                    data-testid="purchase-return-save-btn"
                    className="bg-amber-600 hover:bg-amber-700 text-white rounded-sm">
              <Undo2 className="w-4 h-4 mr-1" /> {saving ? "Saving…" : "Save return"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Purchase detail dialog — opens when a purchase row is clicked */}
      <Dialog open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailRow(null); }}>
        <DialogContent className="rounded-sm max-w-2xl" data-testid="purchase-detail-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#E65100]" /> Purchase detail
            </DialogTitle>
            <DialogDescription>
              Full record of this purchase entry.
            </DialogDescription>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {/* Summary chips */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ["Date", fmtDate(detailRow.raw?.purchased_at || detailRow.when)],
                  ["Bill #", detailRow.raw?.bill_number || detailRow.reference || "—"],
                  ["Amount", fmt(detailRow.raw?.amount ?? detailRow.debit)],
                  ["Created by", detailRow.raw?.created_by || "—"],
                ].map(([label, val], i) => (
                  <div key={i} className="border border-slate-200 rounded-sm bg-slate-50 p-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
                    <div className="text-sm font-bold text-slate-900 tabular-nums mt-0.5 break-words">{val}</div>
                  </div>
                ))}
              </div>

              {/* Material summary */}
              {(detailRow.raw?.material || "").trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Material</div>
                  <div className="text-sm text-slate-800 mt-0.5" data-testid="purchase-detail-material">
                    {detailRow.raw.material}
                  </div>
                </div>
              )}

              {/* Line items */}
              {Array.isArray(detailRow.raw?.items) && detailRow.raw.items.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Line items</div>
                  <div className="border border-slate-200 rounded-sm overflow-hidden">
                    <table className="w-full text-sm" data-testid="purchase-detail-items">
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
                            <td className="px-3 py-2 text-right tabular-nums">{fmt(it.rate)}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-bold">{fmt(it.line_value)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <td colSpan={4} className="px-3 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Total</td>
                          <td className="px-3 py-2 text-right tabular-nums font-extrabold text-slate-900">
                            {fmt(detailRow.raw?.amount ?? detailRow.debit)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Notes */}
              {(detailRow.raw?.notes || "").trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Notes</div>
                  <div className="text-sm text-slate-700 italic mt-0.5" data-testid="purchase-detail-notes">
                    {detailRow.raw.notes}
                  </div>
                </div>
              )}

              {/* Bill photos */}
              {Array.isArray(detailRow.raw?.bill_images) && detailRow.raw.bill_images.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1 inline-flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-[#E65100]" />
                    Bill photos ({detailRow.raw.bill_images.length})
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2" data-testid="purchase-detail-bill-images">
                    {detailRow.raw.bill_images.map((src, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPreviewImg(src)}
                        data-testid={`purchase-detail-bill-${i}`}
                        className="aspect-square border border-slate-200 rounded-sm overflow-hidden bg-slate-50 hover:ring-2 hover:ring-[#E65100]"
                      >
                        <img src={src} alt={`bill ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)} className="rounded-sm" data-testid="purchase-detail-close">
              Close
            </Button>
            {detailRow && !detailRow.raw?.customer_payment_id && (
              <Button
                onClick={() => { setConfirm(detailRow); setDetailRow(null); }}
                data-testid="purchase-detail-delete"
                className="bg-red-700 hover:bg-red-800 text-white rounded-sm"
              >
                <Trash2 className="w-4 h-4 mr-1" /> Delete purchase
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bill photo lightbox */}
      <Dialog open={!!previewImg} onOpenChange={(o) => { if (!o) setPreviewImg(null); }}>
        <DialogContent className="rounded-sm max-w-3xl bg-slate-900 border-slate-800" data-testid="supplier-ledger-bill-preview">
          <DialogHeader>
            <DialogTitle className="font-heading text-white flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-[#E65100]" /> Bill photo
            </DialogTitle>
          </DialogHeader>
          {previewImg && (
            <img
              src={previewImg}
              alt="Bill"
              className="max-h-[75vh] w-full object-contain rounded-sm bg-black"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
