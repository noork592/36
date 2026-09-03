import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plus, Trash2, Edit3, ArrowLeft, IndianRupee, Save, Building2, Search, Tag,
  Upload, Download, FileSpreadsheet,
} from "lucide-react";

const fmt = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default function VendorPriceLists() {
  const { isAdmin } = useAuth();
  const [lists, setLists] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", vendor_id: "", description: "" });
  const [active, setActive] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [newItem, setNewItem] = useState({ name: "", unit: "", price: "" });
  const [savingNew, setSavingNew] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null); // { kind:'list'|'item', target }
  // Excel import/export
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const loadLists = async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        api.get("/vendor-price-lists"),
        api.get("/suppliers"),
      ]);
      setLists(r1.data || []);
      setVendors(r2.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load");
    } finally { setLoading(false); }
  };
  useEffect(() => { loadLists(); }, []);

  const loadDetail = async (vplId) => {
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/vendor-price-lists/${vplId}`);
      setDetail(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load vendor price list");
    } finally { setDetailLoading(false); }
  };
  useEffect(() => {
    if (active?.id) loadDetail(active.id);
    else setDetail(null);
  }, [active]);

  const createList = async () => {
    if (!form.name.trim()) { toast.error("Name required"); return; }
    if (!form.vendor_id) { toast.error("Pick a vendor"); return; }
    try {
      const { data } = await api.post("/vendor-price-lists", form);
      toast.success(`"${data.name}" created`);
      setShowAdd(false);
      setForm({ name: "", vendor_id: "", description: "" });
      loadLists();
      // Auto-open the freshly-created list so the user can immediately add items
      setActive(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
  };

  const openCreateDialog = async () => {
    // Re-fetch vendors so any newly-added supplier (from another tab) shows up
    try {
      const { data } = await api.get("/suppliers");
      setVendors(data || []);
    } catch { /* keep existing list on failure */ }
    setForm({ name: "", vendor_id: "", description: "" });
    setShowAdd(true);
  };

  const deleteList = async (pl) => {
    try {
      await api.delete(`/vendor-price-lists/${pl.id}`);
      toast.success(`"${pl.name}" deleted`);
      if (active?.id === pl.id) setActive(null);
      setConfirmDel(null);
      loadLists();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  const addItem = async () => {
    if (!newItem.name.trim()) { toast.error("Item name required"); return; }
    setSavingNew(true);
    try {
      await api.post(`/vendor-price-lists/${active.id}/items`, {
        name: newItem.name.trim(),
        unit: newItem.unit.trim(),
        price: Number(newItem.price || 0),
      });
      setNewItem({ name: "", unit: "", price: "" });
      await loadDetail(active.id);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add item");
    } finally { setSavingNew(false); }
  };

  const updateItem = async (item, patch) => {
    try {
      await api.patch(`/vendor-price-lists/${active.id}/items/${item.id}`, patch);
      setDetail((d) => ({
        ...d,
        items: d.items.map((it) => it.id === item.id ? { ...it, ...patch } : it),
      }));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
  };

  const deleteItem = async (item) => {
    try {
      await api.delete(`/vendor-price-lists/${active.id}/items/${item.id}`);
      setDetail((d) => ({ ...d, items: d.items.filter((it) => it.id !== item.id) }));
      setConfirmDel(null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  const filteredRows = useMemo(() => {
    const items = detail?.items || [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter((r) =>
      [r.name, r.unit, r.notes].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [detail, search]);

  // ---- Excel import / export ----
  const downloadTemplate = async () => {
    try {
      const res = await api.get(`/vendor-price-lists/${active.id}/import/template`, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      const safe = (active.name || "list").replace(/[^a-z0-9]+/gi, "_");
      a.download = `vendor_price_list_${safe}_template.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Download failed");
    }
  };

  const downloadXlsx = async () => {
    try {
      const res = await api.get(`/vendor-price-lists/${active.id}/export`, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      const safe = (active.name || "list").replace(/[^a-z0-9]+/gi, "_");
      a.download = `vendor_price_list_${safe}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Download failed");
    }
  };

  const uploadImport = async () => {
    if (!importFile) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      const { data } = await api.post(
        `/vendor-price-lists/${active.id}/import`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      const msg = `${data.inserted || 0} added · ${data.updated || 0} updated` +
        (data.skipped_count ? ` · ${data.skipped_count} skipped` : "");
      toast.success(msg);
      if (data.skipped && data.skipped.length) {
        console.warn("Vendor price list import — skipped rows:", data.skipped);
      }
      setImportOpen(false);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadDetail(active.id);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Import failed");
    } finally { setImporting(false); }
  };

  if (!isAdmin) return <div className="p-6 text-slate-500">Admin only.</div>;

  // -------------------- List view --------------------
  if (!active) {
    return (
      <div className="space-y-5" data-testid="vendor-price-lists-page">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Inbound · Vendor Pricing</div>
            <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">Vendor Price Lists</h1>
            <p className="text-slate-500 text-sm mt-1">
              One price list per vendor. Each list holds the vendor&apos;s own items + prices.
            </p>
          </div>
          <Button
            onClick={openCreateDialog}
            data-testid="add-vendor-price-list-btn"
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold"
          >
            <Plus className="w-4 h-4 mr-1.5" /> New vendor price list
          </Button>
        </div>

        <div className="bg-white border border-slate-200 rounded-sm">
          {loading ? (
            <div className="p-10 text-center text-slate-400">Loading…</div>
          ) : lists.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm" data-testid="vendor-price-lists-empty">
              {vendors.length === 0
                ? "Add a vendor first from the Vendors tab, then create a price list for it."
                : "No vendor price lists yet. Click 'New vendor price list' to create one."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {lists.map((pl) => (
                <div
                  key={pl.id}
                  data-testid={`vendor-price-list-row-${pl.id}`}
                  className="p-4 sm:p-5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors"
                >
                  <button
                    onClick={() => setActive(pl)}
                    data-testid={`open-vendor-price-list-${pl.id}`}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="font-bold text-slate-900 truncate inline-flex items-center gap-2">
                      <Tag className="w-4 h-4 text-slate-400" />
                      {pl.name}
                    </div>
                    <div className="text-xs text-slate-600 mt-1 inline-flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-bold">{pl.vendor_name || "—"}</span>
                    </div>
                    {pl.description && (
                      <div className="text-xs text-slate-500 mt-0.5">{pl.description}</div>
                    )}
                    <div className="flex gap-3 mt-1.5">
                      <span className="text-[10px] uppercase tracking-wider font-bold bg-orange-50 border border-orange-200 text-orange-900 px-2 py-1 rounded-sm">
                        {pl.items_count} items priced
                      </span>
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setActive(pl)}
                    data-testid={`manage-vendor-price-list-${pl.id}`}
                    className="rounded-sm border-slate-300"
                  >
                    <Edit3 className="w-3.5 h-3.5 mr-1" /> Manage
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDel({ kind: "list", target: pl })}
                    data-testid={`delete-vendor-price-list-${pl.id}`}
                    className="rounded-sm border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Create dialog */}
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogContent className="rounded-sm" data-testid="vendor-price-list-create-dialog">
            <DialogHeader>
              <DialogTitle className="font-heading">New vendor price list</DialogTitle>
              <DialogDescription>One vendor can have multiple lists (e.g. &quot;Standard&quot;, &quot;Bulk discount&quot;).</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-bold uppercase">Vendor *</Label>
                <select
                  value={form.vendor_id}
                  onChange={(e) => setForm((p) => ({ ...p, vendor_id: e.target.value }))}
                  data-testid="vendor-price-list-vendor-select"
                  className="mt-1 w-full h-11 rounded-sm border border-slate-300 px-3 text-sm bg-white"
                >
                  <option value="">— Pick a vendor —</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}{v.city ? ` · ${v.city}` : ""}</option>
                  ))}
                </select>
                {vendors.length === 0 && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-sm px-2 py-1.5" data-testid="vendor-price-list-no-vendors-warning">
                    No vendors yet. Add one from the <span className="font-bold">Vendors</span> tab first, then come back.
                  </div>
                )}
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">List name *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder='e.g. "Standard", "Bulk Q4"'
                  data-testid="vendor-price-list-name-input"
                  className="h-11 rounded-sm mt-1"
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Description</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  rows={2}
                  className="rounded-sm mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdd(false)} className="rounded-sm">Cancel</Button>
              <Button
                onClick={createList}
                data-testid="vendor-price-list-save-btn"
                disabled={!form.name.trim() || !form.vendor_id}
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirm delete list */}
        <Dialog open={!!confirmDel} onOpenChange={(o) => { if (!o) setConfirmDel(null); }}>
          <DialogContent className="rounded-sm max-w-sm">
            <DialogHeader>
              <DialogTitle className="font-heading">Delete vendor price list?</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete <span className="font-bold">{confirmDel?.target?.name}</span>? All items inside this list will also be removed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDel(null)} className="rounded-sm">Cancel</Button>
              <Button onClick={() => deleteList(confirmDel.target)} className="bg-red-700 hover:bg-red-800 text-white rounded-sm">
                <Trash2 className="w-4 h-4 mr-1" /> Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // -------------------- Detail view --------------------
  return (
    <div className="space-y-5" data-testid="vendor-price-list-detail-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => { setActive(null); loadLists(); }}
            data-testid="back-to-vendor-price-lists"
            className="rounded-sm border-slate-300 h-9"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Vendor price list</div>
            <h1 className="font-heading text-2xl font-extrabold text-slate-900">{active.name}</h1>
            <div className="text-xs text-slate-600 mt-0.5 inline-flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-bold">{detail?.vendor_name || active.vendor_name}</span>
              {active.description && <span className="text-slate-400">· {active.description}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            data-testid="vendor-price-list-import-btn"
            className="rounded-sm border-slate-300 h-9"
          >
            <Upload className="w-4 h-4 mr-1.5" /> Upload Excel
          </Button>
          <Button
            variant="outline"
            onClick={downloadXlsx}
            data-testid="vendor-price-list-download-btn"
            className="rounded-sm border-slate-300 h-9"
          >
            <Download className="w-4 h-4 mr-1.5" /> Download
          </Button>
        </div>
      </div>

      {/* Add item row */}
      <section className="bg-white border border-slate-200 rounded-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <Plus className="w-4 h-4 text-[#E65100]" />
          <h2 className="font-heading font-bold text-slate-900">Add item</h2>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
          <div className="sm:col-span-5">
            <Label className="text-[10px] uppercase font-bold text-slate-500">Item name *</Label>
            <Input
              value={newItem.name}
              onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
              placeholder="MS Sheet 1.2mm, Spring 80mm…"
              data-testid="vendor-item-name-input"
              className="h-11 rounded-sm mt-1"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-[10px] uppercase font-bold text-slate-500">Unit</Label>
            <Input
              value={newItem.unit}
              onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
              placeholder="kg / pcs"
              data-testid="vendor-item-unit-input"
              className="h-11 rounded-sm mt-1"
            />
          </div>
          <div className="sm:col-span-3">
            <Label className="text-[10px] uppercase font-bold text-slate-500">Price (₹) *</Label>
            <div className="relative mt-1">
              <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <Input
                type="number" min="0" step="0.01"
                value={newItem.price}
                onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))}
                placeholder="0.00"
                data-testid="vendor-item-price-input"
                className="no-spinner h-11 pl-9 rounded-sm font-mono-num tabular-nums"
              />
            </div>
          </div>
          <div className="sm:col-span-2">
            <Button
              onClick={addItem}
              disabled={savingNew || !newItem.name.trim()}
              data-testid="vendor-item-add-btn"
              className="w-full h-11 bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
            >
              {savingNew ? "Adding…" : (<><Plus className="w-4 h-4 mr-1" /> Add</>)}
            </Button>
          </div>
        </div>
      </section>

      {/* Items table */}
      <section className="bg-white border border-slate-200 rounded-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3 flex-wrap">
          <h2 className="font-heading font-bold text-slate-900">Items</h2>
          <div className="relative ml-auto max-w-xs w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item, unit, note…"
              data-testid="vendor-items-search"
              className="h-9 pl-9 rounded-sm"
            />
          </div>
        </div>
        {detailLoading ? (
          <div className="p-10 text-center text-slate-400">Loading items…</div>
        ) : filteredRows.length === 0 ? (
          <div className="p-10 text-center text-slate-400 text-sm" data-testid="vendor-items-empty">
            {(detail?.items?.length || 0) === 0 ? "No items yet. Add one above." : "No items match your search."}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredRows.map((row) => (
              <VendorItemRow
                key={row.id}
                row={row}
                onSave={(patch) => updateItem(row, patch)}
                onDelete={() => setConfirmDel({ kind: "item", target: row })}
              />
            ))}
          </div>
        )}
      </section>

      {/* Confirm delete item */}
      <Dialog open={!!confirmDel && confirmDel.kind === "item"} onOpenChange={(o) => { if (!o) setConfirmDel(null); }}>
        <DialogContent className="rounded-sm max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">Delete item?</DialogTitle>
            <DialogDescription>
              Remove <span className="font-bold">{confirmDel?.target?.name}</span> from this vendor price list?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)} className="rounded-sm">Cancel</Button>
            <Button
              onClick={() => deleteItem(confirmDel.target)}
              data-testid="vendor-item-delete-confirm"
              className="bg-red-700 hover:bg-red-800 text-white rounded-sm"
            >
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk import dialog */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!o) { setImportOpen(false); setImportFile(null); } }}>
        <DialogContent className="rounded-sm" data-testid="vendor-price-list-import-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-[#E65100]" />
              Import items from Excel
            </DialogTitle>
            <DialogDescription>
              Columns: <span className="font-mono">name, unit, price, notes</span>. Existing items with the same name will be overwritten; new names are added.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button
              onClick={downloadTemplate}
              variant="outline"
              size="sm"
              data-testid="vendor-price-list-download-template"
              className="rounded-sm border-slate-300 w-full sm:w-auto"
            >
              <Download className="w-4 h-4 mr-1" /> Download blank template
            </Button>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                data-testid="vendor-price-list-import-file-input"
                className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-sm file:border-0 file:font-bold file:bg-[#E65100] file:text-white hover:file:bg-[#CC4800] file:cursor-pointer"
              />
              {importFile && (
                <div className="mt-2 text-xs text-slate-600" data-testid="vendor-price-list-import-file-name">
                  {importFile.name} · {(importFile.size / 1024).toFixed(1)} KB
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setImportOpen(false); setImportFile(null); }}
              className="rounded-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={uploadImport}
              disabled={!importFile || importing}
              data-testid="vendor-price-list-import-upload-btn"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
            >
              <Upload className="w-4 h-4 mr-1" /> {importing ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VendorItemRow({ row, onSave, onDelete }) {
  const [name, setName] = useState(row.name || "");
  const [unit, setUnit] = useState(row.unit || "");
  const [price, setPrice] = useState(String(row.price ?? 0));
  useEffect(() => {
    setName(row.name || "");
    setUnit(row.unit || "");
    setPrice(String(row.price ?? 0));
  }, [row.id, row.name, row.unit, row.price]);
  const dirty =
    name !== (row.name || "") ||
    unit !== (row.unit || "") ||
    Number(price || 0) !== Number(row.price || 0);
  const persist = () => {
    if (!dirty) return;
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      unit: unit.trim(),
      price: Number(price || 0),
    });
  };
  return (
    <div className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50" data-testid={`vendor-item-row-${row.id}`}>
      <div className="flex-1 min-w-0 grid grid-cols-12 gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={persist}
          data-testid={`vendor-item-name-${row.id}`}
          className="col-span-7 h-9 rounded-sm font-bold"
        />
        <Input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          onBlur={persist}
          placeholder="unit"
          data-testid={`vendor-item-unit-${row.id}`}
          className="col-span-2 h-9 rounded-sm"
        />
        <div className="col-span-3 relative">
          <IndianRupee className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <Input
            type="number" min="0" step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onFocus={(e) => { if (Number(price || 0) === 0) setPrice(""); e.target.select(); }}
            onBlur={() => { if (price === "" || price === "-" || price === ".") setPrice("0"); persist(); }}
            data-testid={`vendor-item-price-${row.id}`}
            className="no-spinner h-9 pl-7 rounded-sm font-mono-num tabular-nums text-right"
          />
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {dirty && (
          <Button
            size="sm"
            onClick={persist}
            data-testid={`vendor-item-save-${row.id}`}
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-9 px-3"
          >
            <Save className="w-3.5 h-3.5" />
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onDelete}
          data-testid={`vendor-item-delete-${row.id}`}
          className="rounded-sm h-9 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}


