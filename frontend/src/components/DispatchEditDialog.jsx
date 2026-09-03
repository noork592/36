import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Trash2, Save, X, CalendarDays, User } from "lucide-react";
import ItemSearchInput from "@/components/ItemSearchInput";
import DatePicker from "@/components/DatePicker";

// Convert an ISO timestamp to YYYY-MM-DD in IST for use in <input type="date">
function isoToDateInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function todayInIST() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  } catch {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
}

/**
 * Full-dispatch editor: line items + GR + bill amount + bag count.
 * Submits to PATCH /dispatches/{id} which also flows into the customer ledger
 * (the ledger reads from the same dispatch document).
 *
 * Backend enforces the user-edit window — if the dispatch is older than the
 * admin-configured `edit_window_days`, non-admin users get a 403 and we
 * surface that as a toast.
 */
export default function DispatchEditDialog({ open, onOpenChange, dispatch, customerCity = "", customerLocation = "", customerAddress = "", customerId = "", onSaved }) {
  const _hay = `${customerCity} | ${customerLocation} | ${customerAddress}`.toLowerCase();
  const isLudhiana = /\bludhiana\b/.test(_hay);
  const _customerId = customerId || dispatch?.customer_id || null;
  const [items, setItems] = useState([]);
  const [gr, setGr] = useState("");
  const [bill, setBill] = useState("");
  const [bags, setBags] = useState("");
  const [dispatchDate, setDispatchDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Customer reassignment (edit which party this slip belongs to)
  const [custId, setCustId] = useState("");
  const [custName, setCustName] = useState("");
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState([]);
  const [custOpen, setCustOpen] = useState(false);

  useEffect(() => {
    if (!open || !dispatch) return;
    setItems(
      (dispatch.items || []).map((it) => ({
        item_id: it.item_id || "",
        item_name: it.item_name || "",
        product_name: it.product_name || "",
        variant: it.variant || "",
        quantity: String(it.quantity ?? ""),
        unit_price: String(it.unit_price ?? ""),
        net_unit_price: it.net_unit_price != null ? String(it.net_unit_price) : "",
        discount_value: String(it.discount_value ?? 0),
        discount_type: it.discount_type || "",
        description: it.description || "",
      })),
    );
    setGr(dispatch.gr_number || "");
    setBill(dispatch.total_value > 0 ? String(dispatch.total_value) : "");
    setBags(dispatch.bag_count > 0 ? String(dispatch.bag_count) : "");
    setDispatchDate(isoToDateInput(dispatch.dispatched_at || dispatch.created_at));
    setCustId(dispatch.customer_id || "");
    setCustName(dispatch.customer_name || "");
    setCustQuery("");
    setCustResults([]);
    setCustOpen(false);
  }, [open, dispatch]);

  if (!dispatch) return null;

  const searchCustomers = async (val) => {
    setCustQuery(val);
    const q = (val || "").trim();
    if (!q) { setCustResults([]); setCustOpen(false); return; }
    try {
      const { data } = await api.get("/customers/search", { params: { q } });
      setCustResults(data || []);
      setCustOpen(true);
    } catch (e) { setCustResults([]); }
  };

  const pickCustomer = (c) => {
    setCustId(c.id);
    setCustName(c.name);
    setCustQuery("");
    setCustResults([]);
    setCustOpen(false);
  };

  const updateItem = (idx, patch) =>
    setItems((arr) => arr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const addRow = () =>
    setItems((arr) => [
      ...arr,
      { item_id: "", item_name: "", product_name: "", variant: "", quantity: "1", unit_price: "0", net_unit_price: "", discount_value: "0", discount_type: "", description: "" },
    ]);

  const removeRow = (idx) => setItems((arr) => arr.filter((_, i) => i !== idx));

  const computedLineTotal = (r) => {
    const q = Number(r.quantity || 0);
    const net = r.net_unit_price !== "" ? Number(r.net_unit_price) : Number(r.unit_price || 0);
    return q * net;
  };
  const computedGrand = items.reduce((s, r) => s + computedLineTotal(r), 0);

  const submit = async () => {
    const cleanItems = items
      .map((r) => ({
        item_id: r.item_id || undefined,
        item_name: (r.item_name || "").trim(),
        product_name: (r.product_name || "").trim(),
        variant: (r.variant || "").trim(),
        quantity: Number(r.quantity || 0),
        unit_price: Number(r.unit_price || 0),
        net_unit_price: r.net_unit_price !== "" ? Number(r.net_unit_price) : Number(r.unit_price || 0),
        discount_value: Number(r.discount_value || 0),
        discount_type: r.discount_type || "",
        description: (r.description || "").trim(),
      }))
      .filter((r) => r.item_name && r.quantity > 0);
    if (cleanItems.length === 0) {
      toast.error("Add at least one item with a name and quantity");
      return;
    }
    const body = { items: cleanItems, gr_number: gr };
    if (bill !== "") body.total_value = Number(bill);
    if (bags !== "") body.bag_count = Math.max(0, parseInt(bags, 10) || 0);
    // Reassign customer if it was changed in the picker.
    if (custId && custId !== dispatch.customer_id) body.customer_id = custId;
    // Send the (possibly changed) dispatch date — backend normalises a
    // bare YYYY-MM-DD into noon-IST so the slip lands cleanly on that day.
    const originalDate = isoToDateInput(dispatch.dispatched_at || dispatch.created_at);
    if (dispatchDate && dispatchDate !== originalDate) {
      body.dispatched_at = dispatchDate;
    }
    setSaving(true);
    try {
      await api.patch(`/dispatches/${dispatch.id}`, body);
      toast.success("Dispatch updated — pending order recalculated");
      onOpenChange(false);
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setSaving(false);
    }
  };

  const performDelete = async () => {
    setDeleting(true);
    try {
      const { data } = await api.delete(`/dispatches/${dispatch.id}`);
      const restored = (data?.order_ids_restored || []).length;
      const slipNo = data?.slip_no ?? dispatch?.slip_no;
      const slipTag = slipNo != null ? `Slip #${slipNo} deleted` : "Dispatch deleted";
      const qtyMsg = restored > 0 ? ` — qty restored to ${restored} order(s)` : "";
      toast.success(
        `${slipTag}${qtyMsg}. This slip number is permanently reserved and will not be reused.`,
        { duration: 6000 },
      );
      setConfirmDeleteOpen(false);
      onOpenChange(false);
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        data-testid="dispatch-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-heading">Edit dispatch</DialogTitle>
          <DialogDescription className="text-xs">
            Changes save to this dispatch and flow into the customer ledger immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Customer (editable — reassigns the slip to another party) */}
          <div className="relative">
            <Label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1">
              <User className="w-3 h-3 text-[#E65100]" />
              Customer
            </Label>
            <div className="mt-0.5 flex items-center gap-2 flex-wrap">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 h-9 rounded-sm border border-slate-300 bg-slate-50 text-sm font-bold text-slate-800"
                data-testid="dispatch-edit-current-customer"
              >
                {custName || "—"}
              </span>
              <span className="text-[11px] text-slate-400">change to:</span>
              <div className="relative flex-1 min-w-[180px]">
                <Input
                  value={custQuery}
                  onChange={(e) => searchCustomers(e.target.value)}
                  onFocus={() => { if (custResults.length) setCustOpen(true); }}
                  placeholder="Search customer by name…"
                  data-testid="dispatch-edit-customer-search"
                  className="h-9 rounded-sm"
                />
                {custOpen && custResults.length > 0 && (
                  <div
                    className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-sm shadow-lg"
                    data-testid="dispatch-edit-customer-results"
                  >
                    {custResults.map((c) => {
                      const loc = [c.city, c.location, c.address].map((x) => (x || "").trim()).find(Boolean) || "";
                      return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pickCustomer(c)}
                        data-testid={`dispatch-edit-customer-option-${c.id}`}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 border-b border-slate-100 last:border-0"
                      >
                        <span className="font-bold text-slate-800">{c.name}</span>
                        {loc ? <span className="text-slate-400 text-xs"> · {loc}</span> : null}
                      </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {custId && dispatch.customer_id && custId !== dispatch.customer_id && (
              <div className="mt-1 text-[11px] text-[#E65100] font-bold" data-testid="dispatch-edit-customer-changed">
                Will move this slip to {custName}.
              </div>
            )}
          </div>

          {/* Date + GR + bags + bill */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 ${isLudhiana ? "lg:grid-cols-2" : "lg:grid-cols-4"} gap-3`}>
            <div>
              <Label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1">
                <CalendarDays className="w-3 h-3 text-[#E65100]" />
                Dispatch date
              </Label>
              <div className="mt-0.5">
                <DatePicker
                  value={dispatchDate}
                  onChange={setDispatchDate}
                  max={todayInIST()}
                  testId="dispatch-edit-date"
                  buttonClassName="h-9"
                />
              </div>
            </div>
            {!isLudhiana && (
              <div>
                <Label className="text-[10px] uppercase font-bold text-slate-500">GR number</Label>
                <Input
                  value={gr}
                  onChange={(e) => setGr(e.target.value)}
                  placeholder="e.g. 123456"
                  data-testid="dispatch-edit-gr"
                  className="h-9 rounded-sm mt-0.5"
                />
              </div>
            )}
            <div>
              <Label className="text-[10px] uppercase font-bold text-slate-500">Bill amount (₹)</Label>
              <Input
                type="number" min="0" step="0.01"
                value={bill}
                onChange={(e) => setBill(e.target.value)}
                placeholder="Auto from items if blank"
                data-testid="dispatch-edit-bill"
                className="no-spinner h-9 rounded-sm mt-0.5 font-mono-num text-right"
              />
            </div>
            {!isLudhiana && (
              <div>
                <Label className="text-[10px] uppercase font-bold text-slate-500">No. of bags</Label>
                <Input
                  type="number" min="0" step="1"
                  value={bags}
                  onChange={(e) => setBags(e.target.value)}
                  placeholder="Bags"
                  data-testid="dispatch-edit-bags"
                  className="no-spinner h-9 rounded-sm mt-0.5 font-mono-num text-right"
                />
              </div>
            )}
          </div>
          {isLudhiana && (
            <div className="text-[11px] text-slate-500 italic -mt-2"
                 data-testid="dispatch-edit-ludhiana-note">
              Ludhiana party · GR number and No. of bags are not required.
            </div>
          )}

          {/* Items table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">Items</Label>
              <Button
                size="sm" variant="outline" onClick={addRow}
                data-testid="dispatch-edit-add-row"
                className="h-8 rounded-sm border-slate-300"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add row
              </Button>
            </div>
            <div className="border border-slate-200 rounded-sm divide-y divide-slate-100">
              <div className="grid grid-cols-12 gap-2 px-2 py-2 bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                <div className="col-span-4">Item name</div>
                <div className="col-span-2">Variant</div>
                <div className="col-span-1 text-right">Qty</div>
                <div className="col-span-2 text-right">Net ₹/pc</div>
                <div className="col-span-2 text-right">Line total</div>
                <div className="col-span-1" />
              </div>
              {items.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-400">
                  No items. Click <span className="font-bold">Add row</span> to insert one.
                </div>
              ) : (
                items.map((r, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 px-2 py-2 items-start" data-testid={`dispatch-edit-row-${idx}`}>
                    <div className="col-span-4">
                      <ItemSearchInput
                        testIdPrefix={`dispatch-edit-row-name-${idx}`}
                        value={r.item_id ? { item_id: r.item_id, item_name: r.item_name, product_name: r.product_name } : null}
                        onChange={(picked) => updateItem(idx, picked
                          ? { item_id: picked.item_id, item_name: picked.item_name, product_name: picked.product_name || "" }
                          : { item_id: "", item_name: "", product_name: "" }
                        )}
                        customerId={_customerId}
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        value={r.variant}
                        onChange={(e) => updateItem(idx, { variant: e.target.value })}
                        placeholder="optional"
                        className="h-8 rounded-sm"
                      />
                    </div>
                    <div className="col-span-1">
                      <Input
                        type="number" min="0" step="1"
                        value={r.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        data-testid={`dispatch-edit-row-qty-${idx}`}
                        className="no-spinner h-8 rounded-sm font-mono-num text-right"
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number" min="0" step="0.01"
                        value={r.net_unit_price !== "" && r.net_unit_price !== undefined
                          ? r.net_unit_price
                          : (r.unit_price ?? "")}
                        onChange={(e) => updateItem(idx, { net_unit_price: e.target.value, unit_price: e.target.value })}
                        onFocus={(e) => e.target.select()}
                        data-testid={`dispatch-edit-row-price-${idx}`}
                        className="no-spinner h-8 rounded-sm font-mono-num text-right"
                      />
                    </div>
                    <div className="col-span-2 text-right font-mono-num text-sm pr-1">
                      ₹ {computedLineTotal(r).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => removeRow(idx)}
                        data-testid={`dispatch-edit-row-remove-${idx}`}
                        className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    {/* Per-item description / note — prints on slip under this item */}
                    <div className="col-span-12 -mt-1">
                      <Input
                        value={r.description || ""}
                        onChange={(e) => updateItem(idx, { description: e.target.value })}
                        placeholder="Description / note (optional) — prints on slip under this item"
                        data-testid={`dispatch-edit-row-desc-${idx}`}
                        className="h-8 rounded-sm text-xs bg-slate-50 border-slate-200"
                      />
                    </div>
                  </div>
                ))
              )}
              <div className="grid grid-cols-12 gap-2 px-2 py-2 bg-slate-50 text-xs font-bold">
                <div className="col-span-9 text-right text-slate-500 uppercase tracking-wider">Items total</div>
                <div className="col-span-2 text-right font-mono-num text-slate-900" data-testid="dispatch-edit-grand">
                  ₹ {computedGrand.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </div>
                <div className="col-span-1" />
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Bill amount defaults to the items total when left blank.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={saving || deleting}
            data-testid="dispatch-edit-delete"
            className="rounded-sm border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
          >
            <Trash2 className="w-4 h-4 mr-1" /> Delete slip
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="dispatch-edit-cancel"
              className="rounded-sm border-slate-300"
            >
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={saving}
              data-testid="dispatch-edit-save"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm font-bold"
            >
              <Save className="w-4 h-4 mr-1" /> {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent data-testid="dispatch-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this dispatch slip?</AlertDialogTitle>
            <AlertDialogDescription>
              The slip will be removed from the customer ledger. All items on this slip
              will be <span className="font-bold">added back to the parent order</span>
              {" "}(orders that were fully dispatched will reopen to Pending), and the
              raw-material stock consumed by this slip will be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} data-testid="dispatch-delete-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={performDelete}
              disabled={deleting}
              data-testid="dispatch-delete-confirm-btn"
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {deleting ? "Deleting…" : "Delete & restore qty"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
