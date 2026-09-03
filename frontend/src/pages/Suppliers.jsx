import React, { useEffect, useState, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Plus, Trash2, Pencil, X, Search, Building2, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";

const empty = {
  name: "", phone: "", address: "",
  contact_person: "", material_category: "",
  opening_balance: "0", notes: "",
};

export default function Suppliers() {
  const location = useLocation();
  // `/admin/suppliers` → Vendor Ledger view (shows Ledger button + ledger-y copy)
  // `/admin/vendors`   → plain Vendors master view (Add / Edit / Delete only)
  const isLedgerView = location.pathname.startsWith("/admin/suppliers");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // supplier to delete

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/suppliers");
      setRows(r.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load suppliers");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((s) =>
      [s.name, s.phone, s.material_category, s.contact_person]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [rows, q]);

  const openCreate = () => { setEditingId(null); setForm(empty); setOpen(true); };
  const openEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name || "",
      phone: s.phone || "",
      address: s.address || "",
      contact_person: s.contact_person || "",
      material_category: s.material_category || "",
      opening_balance: String(s.opening_balance ?? 0),
      notes: s.notes || "",
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      const body = { ...form, opening_balance: Number(form.opening_balance || 0) };
      if (editingId) await api.patch(`/suppliers/${editingId}`, body);
      else await api.post("/suppliers", body);
      toast.success(editingId ? "Supplier updated" : "Supplier added");
      setOpen(false); setEditingId(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  const remove = async (s) => {
    try {
      await api.delete(`/suppliers/${s.id}`);
      toast.success("Supplier removed");
      setConfirm(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div className="space-y-4" data-testid="suppliers-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">
            Admin · {isLedgerView ? "Vendor Ledger" : "Vendor Master"}
          </div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900 mt-1">
            {isLedgerView ? "Vendor Ledger" : "Vendors"}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {isLedgerView
              ? <>Vendors that provide raw material. Click <span className="font-bold text-slate-700">Ledger</span> on any row to view that vendor&apos;s purchases, payments and running balance.</>
              : <>Manage vendor master records — add, edit, and remove vendors. Open a vendor&apos;s purchase / payment history from <span className="font-bold text-slate-700">Vendor Ledger</span> in the main menu.</>
            }
          </p>
        </div>
        <Button onClick={openCreate}
                data-testid="suppliers-add-btn"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10">
          <Plus className="w-4 h-4 mr-1" /> Add vendor
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="Search by name, phone, material…"
               data-testid="suppliers-search-input"
               className="pl-9 h-10 rounded-sm" />
      </div>

      <div className="border border-slate-200 rounded-sm overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Material</th>
              <th className="text-left px-4 py-2">Phone</th>
              <th className="text-right px-4 py-2">Opening Bal.</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500" data-testid="suppliers-empty">
                {rows.length === 0 ? "No vendors yet. Click Add vendor to begin." : "No vendors match your search."}
              </td></tr>
            )}
            {!loading && filtered.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-orange-50/30" data-testid={`supplier-row-${s.id}`}>
                <td className="px-4 py-2 font-bold text-slate-900 flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-400" />
                  {s.name}
                  {s.contact_person && <span className="text-[11px] text-slate-500 font-normal">· {s.contact_person}</span>}
                </td>
                <td className="px-4 py-2 text-slate-600">{s.material_category || "—"}</td>
                <td className="px-4 py-2 text-slate-600 font-mono-num">{s.phone || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">₹{Number(s.opening_balance || 0).toLocaleString("en-IN")}</td>
                <td className="px-4 py-2 text-right space-x-1 whitespace-nowrap">
                  {isLedgerView && (
                    <Link to={`/admin/suppliers/${s.id}`}>
                      <Button size="sm" variant="outline" className="rounded-sm h-8" data-testid={`supplier-ledger-${s.id}`}>
                        <ScrollText className="w-3.5 h-3.5 mr-1" /> Ledger
                      </Button>
                    </Link>
                  )}
                  <Button size="sm" variant="outline" className="rounded-sm h-8" onClick={() => openEdit(s)} data-testid={`supplier-edit-${s.id}`}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-sm h-8 text-red-700 hover:bg-red-50" onClick={() => setConfirm(s)} data-testid={`supplier-delete-${s.id}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-sm max-w-2xl" data-testid="supplier-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">
              {editingId ? "Edit vendor" : "Add vendor"}
            </DialogTitle>
            <DialogDescription>
              {editingId ? "Update vendor master details." : "Add a new vendor that supplies you raw material."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs font-bold uppercase">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                     placeholder="ACME Steels" data-testid="supplier-name-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Contact person</Label>
              <Input value={form.contact_person} onChange={(e) => setForm((f) => ({ ...f, contact_person: e.target.value }))}
                     placeholder="Mr. Sharma" data-testid="supplier-contact-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                     placeholder="98XXX XXXXX" data-testid="supplier-phone-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs font-bold uppercase">Address</Label>
              <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                     placeholder="Street, area"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs font-bold uppercase">Material category</Label>
              <Input value={form.material_category} onChange={(e) => setForm((f) => ({ ...f, material_category: e.target.value }))}
                     placeholder="e.g. MS Steel Rods, Springs, Nuts & Bolts"
                     data-testid="supplier-material-input"
                     className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Opening balance (₹)</Label>
              <Input type="number" min="0" step="0.01" value={form.opening_balance}
                     onChange={(e) => setForm((f) => ({ ...f, opening_balance: e.target.value }))}
                     placeholder="0"
                     data-testid="supplier-opening-input"
                     className="h-11 rounded-sm mt-1 tabular-nums" />
              <div className="text-[10px] text-slate-500 mt-1">+ve = we owe the supplier at start.</div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                     placeholder="Internal note"
                     className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-sm">
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.name.trim()}
                    data-testid="supplier-save-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              {saving ? "Saving…" : (editingId ? "Update vendor" : "Add vendor")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="rounded-sm max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">Delete vendor?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-bold">{confirm?.name}</span>? This cannot be undone. Vendors with purchase or payment history cannot be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} className="rounded-sm">Cancel</Button>
            <Button onClick={() => remove(confirm)}
                    data-testid="supplier-delete-confirm"
                    className="bg-red-700 hover:bg-red-800 text-white rounded-sm">
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
