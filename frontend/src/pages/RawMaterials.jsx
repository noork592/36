import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Pencil, X, Search, Package, History, TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";

const empty = { name: "", unit: "kg", default_rate: "0", notes: "" };

const KIND_LABEL = {
  purchase: "Purchase",
  purchase_revert: "Purchase reverted",
  dispatch: "Consumed (dispatch)",
  adjust: "Manual adjust",
};

function fmtQty(n) {
  const v = Number(n || 0);
  return v.toLocaleString("en-IN", { maximumFractionDigits: 4 });
}

function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return s; }
}

export default function RawMaterials() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);

  // Adjust dialog
  const [adjustFor, setAdjustFor] = useState(null);
  const [adjustVals, setAdjustVals] = useState({ delta: "", notes: "" });
  const [adjustSaving, setAdjustSaving] = useState(false);

  // Movements dialog
  const [movementsFor, setMovementsFor] = useState(null);
  const [movements, setMovements] = useState([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/raw-materials");
      setRows(r.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load raw materials");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.name, r.unit, r.notes].filter(Boolean).some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [rows, q]);

  const openCreate = () => { setEditingId(null); setForm(empty); setOpen(true); };
  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name || "",
      unit: r.unit || "pcs",
      default_rate: String(r.default_rate ?? "0"),
      notes: r.notes || "",
    });
    setOpen(true);
  };
  const save = async () => {
    if (!form.name.trim()) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      const body = { ...form, default_rate: Number(form.default_rate || 0) };
      if (editingId) await api.patch(`/raw-materials/${editingId}`, body);
      else await api.post("/raw-materials", body);
      toast.success(editingId ? "Raw material updated" : "Raw material added");
      setOpen(false); setEditingId(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };
  const remove = async (r) => {
    try {
      await api.delete(`/raw-materials/${r.id}`);
      toast.success("Deleted");
      setConfirm(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  const openAdjust = (r) => {
    setAdjustFor(r);
    setAdjustVals({ delta: "", notes: "" });
  };
  const saveAdjust = async () => {
    const d = parseFloat(adjustVals.delta);
    if (!d || Number.isNaN(d)) { toast.error("Enter a non-zero number"); return; }
    setAdjustSaving(true);
    try {
      await api.post(`/raw-materials/${adjustFor.id}/adjust`, {
        delta: d, notes: adjustVals.notes || "",
      });
      toast.success("Stock adjusted");
      setAdjustFor(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Adjust failed");
    } finally { setAdjustSaving(false); }
  };

  const openMovements = async (r) => {
    setMovementsFor(r);
    setMovements([]);
    setMovementsLoading(true);
    try {
      const res = await api.get(`/raw-materials/${r.id}/movements`);
      setMovements(res.data?.rows || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load movements");
    } finally { setMovementsLoading(false); }
  };

  return (
    <div className="space-y-4" data-testid="raw-materials-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Admin · Inbound Master</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900 mt-1">Raw Materials</h1>
          <p className="text-slate-500 text-sm mt-1">
            Master inventory of materials you buy from suppliers. Stock auto-credits when you record a purchase
            and auto-debits when products consuming it are dispatched.
          </p>
        </div>
        <Button onClick={openCreate}
                data-testid="raw-materials-add-btn"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10">
          <Plus className="w-4 h-4 mr-1" /> Add raw material
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="Search by name, unit…"
               data-testid="raw-materials-search-input"
               className="pl-9 h-10 rounded-sm" />
      </div>

      <div className="border border-slate-200 rounded-sm overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Unit</th>
              <th className="text-right px-4 py-2">Stock on hand</th>
              <th className="text-right px-4 py-2">Default rate (₹/unit)</th>
              <th className="text-left px-4 py-2">Notes</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500" data-testid="raw-materials-empty">
                {rows.length === 0 ? "No raw materials yet. Click Add to create your first entry." : "No items match your search."}
              </td></tr>
            )}
            {!loading && filtered.map((r) => {
              const stock = Number(r.stock_on_hand || 0);
              const low = stock <= 0;
              return (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-orange-50/30" data-testid={`raw-row-${r.id}`}>
                <td className="px-4 py-2 font-bold text-slate-900 inline-flex items-center gap-2">
                  <Package className="w-4 h-4 text-slate-400" /> {r.name}
                </td>
                <td className="px-4 py-2 text-slate-600">{r.unit || "—"}</td>
                <td className={`px-4 py-2 text-right tabular-nums font-bold ${low ? "text-rose-600" : "text-emerald-700"}`}
                    data-testid={`raw-stock-${r.id}`}>
                  {fmtQty(stock)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(r.default_rate || 0) > 0 ? `₹${Number(r.default_rate).toLocaleString("en-IN")}` : "—"}</td>
                <td className="px-4 py-2 text-slate-500 max-w-xs truncate">{r.notes || "—"}</td>
                <td className="px-4 py-2 text-right space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="outline" className="rounded-sm h-8" onClick={() => openAdjust(r)}
                          data-testid={`raw-adjust-${r.id}`} title="Adjust stock">
                    <TrendingUp className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-sm h-8" onClick={() => openMovements(r)}
                          data-testid={`raw-movements-${r.id}`} title="Movements history">
                    <History className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-sm h-8" onClick={() => openEdit(r)} data-testid={`raw-edit-${r.id}`}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-sm h-8 text-red-700 hover:bg-red-50" onClick={() => setConfirm(r)} data-testid={`raw-delete-${r.id}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-sm max-w-md" data-testid="raw-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">{editingId ? "Edit raw material" : "Add raw material"}</DialogTitle>
            <DialogDescription>Items you purchase from suppliers. Pick these as line-items in Purchase Center.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                     placeholder="MS Steel Rod 8mm"
                     data-testid="raw-name-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">Unit</Label>
                <select value={form.unit}
                        onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                        data-testid="raw-unit-select"
                        className="mt-1 w-full h-11 rounded-sm border border-slate-300 px-3 text-sm bg-white">
                  {["kg", "pcs", "litre", "metre", "ton", "bag", "box", "set", "other"].map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Default rate (₹/unit)</Label>
                <Input type="number" min="0" step="0.01" value={form.default_rate}
                       onChange={(e) => setForm((f) => ({ ...f, default_rate: e.target.value }))}
                       placeholder="0.00"
                       data-testid="raw-rate-input"
                       className="h-11 rounded-sm mt-1 tabular-nums" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Notes</Label>
              <Input value={form.notes}
                     onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                     placeholder="Internal note"
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-sm">
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.name.trim()}
                    data-testid="raw-save-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              {saving ? "Saving…" : (editingId ? "Update" : "Add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="rounded-sm max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">Delete raw material?</DialogTitle>
            <DialogDescription>Are you sure you want to delete <span className="font-bold">{confirm?.name}</span>?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} className="rounded-sm">Cancel</Button>
            <Button onClick={() => remove(confirm)} className="bg-red-700 hover:bg-red-800 text-white rounded-sm">
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjust dialog */}
      <Dialog open={!!adjustFor} onOpenChange={(o) => { if (!o) setAdjustFor(null); }}>
        <DialogContent className="rounded-sm max-w-sm" data-testid="raw-adjust-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">Adjust stock — {adjustFor?.name}</DialogTitle>
            <DialogDescription>
              Use positive numbers to add stock (e.g. opening balance, found inventory) and
              negative numbers to remove (e.g. scrap, theft). Current:{" "}
              <span className="font-bold">{fmtQty(adjustFor?.stock_on_hand)} {adjustFor?.unit}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">Delta ({adjustFor?.unit}) *</Label>
              <Input type="number" step="0.001"
                     value={adjustVals.delta}
                     onChange={(e) => setAdjustVals((v) => ({ ...v, delta: e.target.value }))}
                     placeholder="e.g. 50 or -10"
                     data-testid="raw-adjust-delta"
                     className="h-11 rounded-sm mt-1 tabular-nums" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Reason / notes</Label>
              <Input value={adjustVals.notes}
                     onChange={(e) => setAdjustVals((v) => ({ ...v, notes: e.target.value }))}
                     placeholder="Opening stock, scrap, …"
                     data-testid="raw-adjust-notes"
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustFor(null)} className="rounded-sm">Cancel</Button>
            <Button onClick={saveAdjust} disabled={adjustSaving || !adjustVals.delta}
                    data-testid="raw-adjust-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              {adjustSaving ? "Saving…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Movements history */}
      <Dialog open={!!movementsFor} onOpenChange={(o) => { if (!o) setMovementsFor(null); }}>
        <DialogContent className="rounded-sm max-w-3xl" data-testid="raw-movements-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">Movements — {movementsFor?.name}</DialogTitle>
            <DialogDescription>
              Most recent stock changes, newest first.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto border border-slate-200 rounded-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Kind</th>
                  <th className="text-right px-3 py-2">Change</th>
                  <th className="text-right px-3 py-2">Balance after</th>
                  <th className="text-left px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {movementsLoading && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Loading…</td></tr>}
                {!movementsLoading && movements.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 italic">No movements yet.</td></tr>
                )}
                {!movementsLoading && movements.map((m) => {
                  const positive = Number(m.delta) > 0;
                  return (
                    <tr key={m.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtDate(m.at)}</td>
                      <td className="px-3 py-2">{KIND_LABEL[m.kind] || m.kind}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${positive ? "text-emerald-700" : "text-rose-700"}`}>
                        {positive
                          ? <span className="inline-flex items-center gap-1"><TrendingUp className="w-3 h-3" /> +{fmtQty(m.delta)}</span>
                          : <span className="inline-flex items-center gap-1"><TrendingDown className="w-3 h-3" /> {fmtQty(m.delta)}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(m.balance_after)}</td>
                      <td className="px-3 py-2 text-slate-500">{m.notes || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovementsFor(null)} className="rounded-sm">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
