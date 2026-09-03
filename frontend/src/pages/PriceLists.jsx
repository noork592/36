import React, { useEffect, useRef, useState } from "react";
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
  Plus, Upload, Download, Trash2, Edit3, ArrowLeft, Tag, Percent, IndianRupee, Save, X, Unlink, Copy, Receipt,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";

/**
 * Price Lists admin page.
 *
 *  - Browse / create / rename / delete price lists.
 *  - Drill into a price list → manage per-item prices + per-category discounts.
 *  - Excel template upload (Item Name | Price) and download.
 */
export default function PriceLists() {
  const { isAdmin } = useAuth();
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  // Clone dialog state — separate from the "new price list" flow so the
  // source list stays selected while the admin picks a new name.
  const [cloneSource, setCloneSource] = useState(null);
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);
  // Edit-name dialog state
  const [editSource, setEditSource] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState(null); // selected price list detail
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [savingRow, setSavingRow] = useState(null);
  const fileInputRef = useRef(null);
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const loadLists = async () => {
    setLoading(true);
    try { const { data } = await api.get("/price-lists"); setLists(data); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadLists(); }, []);

  const loadDetail = async (plid) => {
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/price-lists/${plid}`);
      setDetail(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load price list");
    } finally { setDetailLoading(false); }
  };

  useEffect(() => {
    if (active?.id) loadDetail(active.id);
    else setDetail(null);
  }, [active]);

  const createList = async () => {
    if (!form.name.trim()) { toast.error("Name required"); return; }
    try {
      const { data } = await api.post("/price-lists", form);
      toast.success(`Price list "${data.name}" created`);
      setShowAdd(false);
      setForm({ name: "", description: "" });
      loadLists();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
  };

  const openEditDialog = (pl) => {
    setEditSource(pl);
    setEditForm({ name: pl.name || "", description: pl.description || "" });
  };

  const closeEditDialog = () => {
    setEditSource(null);
    setEditForm({ name: "", description: "" });
    setEditing(false);
  };

  const submitEdit = async () => {
    if (!editSource) return;
    const nm = (editForm.name || "").trim();
    if (!nm) { toast.error("Name required"); return; }
    // Guard against colliding with another list's name
    const clash = lists.find(
      (l) => l.id !== editSource.id && (l.name || "").trim().toLowerCase() === nm.toLowerCase()
    );
    if (clash) { toast.error(`Another price list is already called "${clash.name}"`); return; }
    setEditing(true);
    try {
      const { data } = await api.patch(`/price-lists/${editSource.id}`, {
        name: nm,
        description: (editForm.description || "").trim(),
      });
      toast.success(`Renamed to "${data.name}"`);
      // Keep the currently-open list in sync if it was the one we edited
      if (active?.id === editSource.id) setActive({ ...active, ...data });
      closeEditDialog();
      loadLists();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to update");
    } finally {
      setEditing(false);
    }
  };

  const deleteList = (pl) => {
    confirm({
      title: "Delete price list?",
      description: `"${pl.name}" — all per-item prices and discounts inside this list will be removed.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await api.delete(`/price-lists/${pl.id}`);
          toast.success(`"${pl.name}" deleted`);
          if (active?.id === pl.id) setActive(null);
          loadLists();
        } catch (e) {
          toast.error(e?.response?.data?.detail || "Failed");
        }
      },
    });
  };

  /**
   * Flip the "Bill amount required" toggle on a price list. Optimistic UI
   * update — the switch flips instantly, the row's badge follows, and we
   * PATCH the list. On failure we roll back and show a toast so the
   * operator understands why the toggle snapped back.
   */
  const toggleBillRequired = async (pl, next) => {
    const prev = pl.bill_amount_required ?? true;
    setLists((cur) => cur.map((x) => x.id === pl.id ? { ...x, bill_amount_required: next } : x));
    try {
      await api.patch(`/price-lists/${pl.id}`, { bill_amount_required: !!next });
      toast.success(
        next
          ? `"${pl.name}" — dispatch report will ask for Bill amount`
          : `"${pl.name}" — dispatch report will NOT ask for Bill amount`,
      );
    } catch (e) {
      // Roll back on failure
      setLists((cur) => cur.map((x) => x.id === pl.id ? { ...x, bill_amount_required: prev } : x));
      toast.error(e?.response?.data?.detail || "Failed to update toggle");
    }
  };


  /**
   * Clone an existing price list under a new name. The dialog pre-fills
   * the name field with "<original> — Copy" so the admin can either
   * accept it or type a fresh one before confirming.
   */
  const openCloneDialog = (pl) => {
    setCloneSource(pl);
    setCloneName(`${pl.name} - Copy`);
  };

  const closeCloneDialog = () => {
    if (cloning) return;
    setCloneSource(null);
    setCloneName("");
  };

  const submitClone = async () => {
    if (!cloneSource) return;
    const name = cloneName.trim();
    if (!name) {
      toast.error("New name required");
      return;
    }
    if (name.toLowerCase() === (cloneSource.name || "").trim().toLowerCase()) {
      toast.error("Pick a name different from the source list");
      return;
    }
    setCloning(true);
    try {
      const { data } = await api.post(
        `/price-lists/${cloneSource.id}/clone`,
        { name },
      );
      toast.success(
        `Cloned "${cloneSource.name}" → "${data.name}" (${data.items_copied} items, ${data.discounts_copied} discounts)`,
      );
      setCloneSource(null);
      setCloneName("");
      loadLists();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Clone failed");
    } finally {
      setCloning(false);
    }
  };

  /**
   * Task 3 — bulk-detach the active price list from every customer it is
   * linked to. Asks the operator to confirm explicitly because this
   * touches potentially hundreds of customer records at once. The list
   * data (items + discounts) is preserved; only the per-customer
   * pointers are cleared.
   */
  const delinkList = (pl, count) => {
    confirm({
      title: "De-link this price list?",
      description:
        `Are you sure you want to delink this list from all associated customers?\n\n` +
        `"${pl.name}" is currently linked to ${count} customer${count === 1 ? "" : "s"}. ` +
        `Clicking Yes will remove this list from every one of them in a single action. ` +
        `The list itself (items + discounts) stays intact and can be re-assigned later.`,
      confirmLabel: "Yes, de-link",
      cancelLabel: "Cancel",
      variant: "destructive",
      onConfirm: async () => {
        try {
          const { data } = await api.post(`/price-lists/${pl.id}/delink-customers`);
          toast.success(`De-linked from ${data.delinked_customers} customer${data.delinked_customers === 1 ? "" : "s"}`);
          // Refresh both the list summary and the open detail card.
          loadLists();
          if (active?.id === pl.id) loadDetail(pl.id);
        } catch (e) {
          toast.error(e?.response?.data?.detail || "De-link failed");
        }
      },
    });
  };

  const saveRow = async (row, newPrice) => {
    setSavingRow(row.item_id);
    try {
      await api.post(`/price-lists/${active.id}/items`, {
        item_id: row.item_id,
        price: parseFloat(newPrice) || 0,
      });
      setDetail((d) => ({
        ...d,
        items: d.items.map((it) =>
          it.item_id === row.item_id ? { ...it, price: parseFloat(newPrice) || 0 } : it,
        ),
      }));
    } catch (e) {
      toast.error("Save failed");
    } finally {
      setSavingRow(null);
    }
  };

  const saveDiscount = async (productName, value, type) => {
    const numVal = parseFloat(value) || 0;
    // Defensive default: if user entered a non-zero discount but forgot to
    // pick ₹ or %, default to ₹ so the discount actually applies on
    // dispatch & in the daily report (instead of silently being ignored).
    const finalType = numVal > 0 && !type ? "₹" : (type || "");
    try {
      await api.post(`/price-lists/${active.id}/discounts`, {
        product_name: productName,
        discount_value: numVal,
        discount_type: finalType,
      });
      setDetail((d) => {
        const existing = d.discounts.find((x) => x.product_name === productName);
        const next = existing
          ? d.discounts.map((x) =>
              x.product_name === productName
                ? { ...x, discount_value: numVal, discount_type: finalType }
                : x,
            )
          : [
              ...d.discounts,
              { product_name: productName, discount_value: numVal, discount_type: finalType },
            ];
        return { ...d, discounts: next };
      });
      toast.success("Discount saved");
    } catch (e) {
      toast.error("Save failed");
    }
  };

  const downloadXlsx = async () => {
    try {
      const res = await api.get(`/price-lists/${active.id}/export`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      const safe = active.name.replace(/[^a-z0-9]+/gi, "_");
      a.download = `price_list_${safe}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Download failed");
    }
  };

  const onUploadFile = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post(`/price-lists/${active.id}/import`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success(`Updated ${data.updated} item price(s)${data.unknown_count ? ` — ${data.unknown_count} row(s) skipped` : ""}`);
      if (data.unknown && data.unknown.length) {
        console.warn("Unmatched rows:", data.unknown);
      }
      loadDetail(active.id);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Import failed");
    }
  };

  if (!isAdmin) return <div className="p-6 text-slate-500">Admin only.</div>;

  // -------------------- List view --------------------
  if (!active) {
    return (
      <div className="space-y-5" data-testid="price-lists-page">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Pricing</div>
            <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">Customer Price Lists</h1>
            <p className="text-slate-500 text-sm mt-1">
              Maintain multiple customer price lists. Assign one to each party from the Customers page.
            </p>
          </div>
          <Button
            onClick={() => setShowAdd(true)}
            data-testid="add-price-list-btn"
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold"
          >
            <Plus className="w-4 h-4 mr-1.5" /> New price list
          </Button>
        </div>

        <div className="bg-white border border-slate-200 rounded-sm">
          {loading ? (
            <div className="p-10 text-center text-slate-400">Loading…</div>
          ) : lists.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              No price lists yet. Create your first one.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {lists.map((pl) => (
                <div
                  key={pl.id}
                  data-testid={`price-list-row-${pl.id}`}
                  className="p-4 sm:p-5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors"
                >
                  <button
                    onClick={() => setActive(pl)}
                    data-testid={`open-price-list-${pl.id}`}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="font-bold text-slate-900 truncate">{pl.name}</div>
                    {pl.description && (
                      <div className="text-xs text-slate-500 mt-0.5">{pl.description}</div>
                    )}
                    <div className="flex gap-3 mt-1.5 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider font-bold bg-orange-50 border border-orange-200 text-orange-900 px-2 py-1 rounded-sm">
                        {pl.items_count} items priced
                      </span>
                      <span className="text-[10px] uppercase tracking-wider font-bold bg-slate-50 border border-slate-200 text-slate-700 px-2 py-1 rounded-sm">
                        {pl.discounts_count} category discounts
                      </span>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-sm border ${
                          pl.customers_count > 0
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-slate-50 border-slate-200 text-slate-500"
                        }`}
                        data-testid={`price-list-customers-count-${pl.id}`}
                      >
                        {pl.customers_count || 0} customer{pl.customers_count === 1 ? "" : "s"} linked
                      </span>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-sm border inline-flex items-center gap-1 ${
                          (pl.bill_amount_required ?? true)
                            ? "bg-orange-50 border-orange-200 text-orange-900"
                            : "bg-slate-100 border-slate-300 text-slate-600"
                        }`}
                        data-testid={`price-list-billreq-badge-${pl.id}`}
                        title={(pl.bill_amount_required ?? true)
                          ? "Dispatch report will ask for Bill amount for parties on this list"
                          : "Dispatch report will NOT prompt for Bill amount for parties on this list"}
                      >
                        <Receipt className="w-3 h-3" />
                        {(pl.bill_amount_required ?? true) ? "Bill required" : "Bill not required"}
                      </span>
                    </div>
                  </button>
                  {isAdmin && (
                    <div
                      className="flex flex-col items-center gap-0.5 pr-2 border-r border-slate-200"
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`price-list-billreq-wrap-${pl.id}`}
                    >
                      <span className="text-[9px] uppercase tracking-wider font-bold text-slate-500">
                        Bill required
                      </span>
                      <Switch
                        checked={pl.bill_amount_required ?? true}
                        onCheckedChange={(v) => toggleBillRequired(pl, v)}
                        data-testid={`price-list-billreq-switch-${pl.id}`}
                        className="data-[state=checked]:bg-[#E65100]"
                      />
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setActive(pl)}
                    className="rounded-sm border-slate-300"
                  >
                    <Edit3 className="w-3.5 h-3.5 mr-1" /> Manage
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEditDialog(pl)}
                    data-testid={`edit-price-list-${pl.id}`}
                    className="rounded-sm border-slate-300 text-slate-700 hover:bg-orange-50 hover:text-[#E65100] hover:border-orange-200"
                    title="Rename this price list"
                  >
                    <Edit3 className="w-3.5 h-3.5 mr-1" /> Edit name
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openCloneDialog(pl)}
                    data-testid={`clone-price-list-${pl.id}`}
                    className="rounded-sm border-slate-300 text-slate-700 hover:bg-orange-50 hover:text-[#E65100] hover:border-orange-200"
                  >
                    <Copy className="w-3.5 h-3.5 mr-1" /> Clone
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deleteList(pl)}
                    data-testid={`delete-price-list-${pl.id}`}
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
          <DialogContent className="rounded-sm">
            <DialogHeader>
              <DialogTitle className="font-heading">New price list</DialogTitle>
              <DialogDescription>e.g. "Wholesale", "Retail", "Premium dealer"</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-bold uppercase">Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  data-testid="price-list-name-input"
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
              <Button variant="outline" onClick={() => setShowAdd(false)} className="rounded-sm">
                Cancel
              </Button>
              <Button
                onClick={createList}
                data-testid="price-list-save-btn"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={!!confirmState}
          onOpenChange={(o) => { if (!o) closeConfirm(); }}
          {...(confirmState || {})}
        />

        {/* Clone dialog — duplicate an existing price list under a new name */}
        <Dialog open={!!cloneSource} onOpenChange={(o) => { if (!o) closeCloneDialog(); }}>
          <DialogContent className="rounded-sm" data-testid="clone-price-list-dialog">
            <DialogHeader>
              <DialogTitle className="font-heading">
                Clone price list
              </DialogTitle>
              <DialogDescription>
                {cloneSource ? (
                  <>
                    Copying <span className="font-bold text-slate-900">{cloneSource.name}</span>{" "}
                    (<span className="font-mono-num">{cloneSource.items_count || 0}</span> items,{" "}
                    <span className="font-mono-num">{cloneSource.discounts_count || 0}</span> category discounts).
                    Customer linkages are not copied — assign the new list from the Customers page.
                  </>
                ) : (
                  "Duplicate a price list."
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-bold uppercase">New name</Label>
                <Input
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                  data-testid="clone-price-list-name-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitClone();
                    }
                  }}
                  className="h-11 rounded-sm mt-1"
                  placeholder="e.g. Wholesale 2025"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeCloneDialog}
                disabled={cloning}
                className="rounded-sm"
              >
                Cancel
              </Button>
              <Button
                onClick={submitClone}
                disabled={cloning || !cloneName.trim()}
                data-testid="clone-price-list-submit"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
              >
                <Copy className="w-4 h-4 mr-1.5" />
                {cloning ? "Cloning…" : "Clone list"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit-name dialog — rename a price list and/or update its description */}
        <Dialog open={!!editSource} onOpenChange={(o) => { if (!o) closeEditDialog(); }}>
          <DialogContent className="rounded-sm" data-testid="edit-price-list-dialog">
            <DialogHeader>
              <DialogTitle className="font-heading">Edit price list</DialogTitle>
              <DialogDescription>
                {editSource ? (
                  <>Rename <span className="font-bold text-slate-900">{editSource.name}</span> or update its description. Customers already assigned to this list keep their assignment.</>
                ) : null}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-bold uppercase">Name</Label>
                <Input
                  value={editForm.name}
                  onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                  data-testid="edit-price-list-name-input"
                  className="h-11 rounded-sm mt-1"
                  autoFocus
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Description</Label>
                <Textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))}
                  rows={2}
                  data-testid="edit-price-list-description-input"
                  className="rounded-sm mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeEditDialog}
                disabled={editing}
                className="rounded-sm"
              >
                Cancel
              </Button>
              <Button
                onClick={submitEdit}
                disabled={editing || !editForm.name.trim()}
                data-testid="edit-price-list-submit"
                className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
              >
                <Save className="w-4 h-4 mr-1.5" />
                {editing ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // -------------------- Detail view --------------------
  const rows = (detail?.items || []).filter(
    (r) =>
      !search ||
      r.item_name.toLowerCase().includes(search.toLowerCase()) ||
      (r.product_name || "").toLowerCase().includes(search.toLowerCase()),
  );

  // Group rows by category for category-discount section
  const categories = Array.from(
    new Set((detail?.items || []).map((r) => r.product_name).filter(Boolean)),
  ).sort();
  const discountMap = Object.fromEntries(
    (detail?.discounts || []).map((d) => [d.product_name, d]),
  );

  return (
    <div className="space-y-5" data-testid="price-list-detail-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => setActive(null)}
            data-testid="back-to-price-lists"
            className="rounded-sm border-slate-300 h-9"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">Price list</div>
            <h1 className="font-heading text-2xl font-extrabold text-slate-900">{active.name}</h1>
            {active.description && (
              <div className="text-xs text-slate-500 mt-0.5">{active.description}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              onUploadFile(f);
              e.target.value = "";
            }}
            data-testid="price-list-upload-input"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            data-testid="upload-price-xlsx"
            className="rounded-sm border-slate-300 h-9"
          >
            <Upload className="w-4 h-4 mr-1.5" /> Upload Excel
          </Button>
          <Button
            variant="outline"
            onClick={downloadXlsx}
            data-testid="download-price-xlsx"
            className="rounded-sm border-slate-300 h-9"
          >
            <Download className="w-4 h-4 mr-1.5" /> Download
          </Button>
          {/* Task 3 — De-link from all customers in one click. Always
              visible to admins so the affordance is discoverable; disabled
              when no customer is linked. */}
          {isAdmin && (
            <Button
              variant="outline"
              onClick={() => delinkList(active, detail.customers_count || 0)}
              disabled={!(detail?.customers_count > 0)}
              data-testid="delink-price-list"
              className="rounded-sm border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 h-9 disabled:opacity-40 disabled:cursor-not-allowed"
              title={detail?.customers_count > 0
                ? `De-link this list from ${detail.customers_count} customer${detail.customers_count === 1 ? "" : "s"}`
                : "No customer is currently linked to this list"}
            >
              <Unlink className="w-4 h-4 mr-1.5" />
              De-link ({detail?.customers_count || 0})
            </Button>
          )}
        </div>
      </div>

      {/* Category discounts */}
      <section className="bg-white border border-slate-200 rounded-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <Tag className="w-4 h-4 text-[#E65100]" />
          <h2 className="font-heading font-bold text-slate-900">Category-level discounts</h2>
          <span className="text-xs text-slate-500 ml-2">Applied automatically when a customer on this price list is dispatched.</span>
        </div>
        {categories.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">No item categories found.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {categories.map((cat) => {
              const d = discountMap[cat] || { discount_value: 0, discount_type: "" };
              return (
                <DiscountRow
                  key={cat}
                  category={cat}
                  value={d.discount_value}
                  type={d.discount_type}
                  onSave={saveDiscount}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Per-item prices */}
      <section className="bg-white border border-slate-200 rounded-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3 flex-wrap">
          <h2 className="font-heading font-bold text-slate-900">Item prices</h2>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU or category…"
            data-testid="price-list-search"
            className="h-9 rounded-sm ml-auto max-w-xs"
          />
        </div>
        {detailLoading ? (
          <div className="p-10 text-center text-slate-400">Loading prices…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            {detail?.items?.length === 0 ? "No items found in master." : "No matching SKUs."}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((r) => (
              <PriceRow
                key={r.item_id}
                row={r}
                saving={savingRow === r.item_id}
                onSave={(p) => saveRow(r, p)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Confirm dialog — also mounted in the detail view so the De-link
          button (Task 3) can prompt for confirmation. Previously this was
          only in the list view, which silently swallowed the click. */}
      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />
    </div>
  );
}

function PriceRow({ row, onSave, saving }) {
  const [val, setVal] = useState(String(row.price ?? 0));
  useEffect(() => { setVal(String(row.price ?? 0)); }, [row.price]);
  const dirty = parseFloat(val || "0") !== parseFloat(row.price || 0);
  // Highlight: green background when the item has a real price (> 0),
  // dark red background when the price is missing / zero. Users asked
  // for this so they can spot un-priced SKUs at a glance.
  const hasPrice = parseFloat(row.price || 0) > 0;
  const rowTone = hasPrice
    ? "bg-emerald-50 hover:bg-emerald-100 border-l-4 border-l-emerald-500"
    : "bg-red-100 hover:bg-red-200 border-l-4 border-l-red-700";
  const nameTone = hasPrice ? "text-emerald-900" : "text-red-900";
  const subTone = hasPrice ? "text-emerald-700" : "text-red-700";
  return (
    <div
      className={`px-4 py-3 flex items-center gap-3 ${rowTone}`}
      data-testid={`price-row-${row.item_id}`}
      data-has-price={hasPrice ? "yes" : "no"}
    >
      <div className="flex-1 min-w-0">
        <div className={`font-bold break-words leading-snug ${nameTone}`}>{row.item_name}</div>
        {row.product_name && (
          <div className={`text-[11px] mt-0.5 ${subTone}`}>{row.product_name}</div>
        )}
        {!hasPrice && (
          <div className="text-[11px] font-bold text-red-800 uppercase tracking-wider mt-1">
            No price set
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="relative">
          <IndianRupee className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <Input
            type="number"
            min="0"
            step="0.01"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onFocus={(e) => { if (parseFloat(val || "0") === 0) setVal(""); e.target.select(); }}
            onBlur={() => {
              if (val === "" || val === "-" || val === ".") setVal("0");
              if (dirty) onSave(val || "0");
            }}
            data-testid={`price-input-${row.item_id}`}
            className="no-spinner h-9 w-28 pl-7 rounded-sm font-mono-num text-right"
          />
        </div>
        {dirty && (
          <Button
            size="sm"
            onClick={() => onSave(val)}
            disabled={saving}
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-9 px-3"
          >
            <Save className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function DiscountRow({ category, value, type, onSave }) {
  const [val, setVal] = useState(String(value || 0));
  const [tp, setTp] = useState(type || "");
  useEffect(() => { setVal(String(value || 0)); setTp(type || ""); }, [value, type]);
  const dirty = parseFloat(val || "0") !== parseFloat(value || 0) || tp !== (type || "");
  const numVal = parseFloat(val || "0");
  const needsType = numVal > 0 && !tp;
  return (
    <div className="px-4 py-3 flex items-center gap-3 flex-wrap" data-testid={`discount-row-${category}`}>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-slate-900">{category}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">All items in this category get the discount below.</div>
        {needsType && (
          <div className="text-[11px] text-rose-600 mt-1 font-bold" data-testid={`discount-warn-${category}`}>
            Pick ₹ or % — otherwise we'll default to ₹ on save.
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onFocus={(e) => { if (parseFloat(val || "0") === 0) setVal(""); e.target.select(); }}
          onBlur={() => { if (val === "" || val === "-" || val === ".") setVal("0"); }}
          data-testid={`discount-value-${category}`}
          className={`no-spinner h-9 w-24 rounded-sm font-mono-num text-right ${needsType ? "border-rose-400" : ""}`}
        />
        <div className="flex">
          <button
            type="button"
            onClick={() => setTp(tp === "₹" ? "" : "₹")}
            data-testid={`discount-type-rs-${category}`}
            className={`h-9 px-2 rounded-l-sm border text-xs font-bold ${tp === "₹" ? "bg-[#E65100] text-white border-[#E65100]" : `bg-white text-slate-700 ${needsType ? "border-rose-400" : "border-slate-300"}`}`}
          >
            <IndianRupee className="w-3 h-3 inline -mt-0.5" />
          </button>
          <button
            type="button"
            onClick={() => setTp(tp === "%" ? "" : "%")}
            data-testid={`discount-type-pct-${category}`}
            className={`h-9 px-2 rounded-r-sm border -ml-px text-xs font-bold ${tp === "%" ? "bg-[#E65100] text-white border-[#E65100]" : `bg-white text-slate-700 ${needsType ? "border-rose-400" : "border-slate-300"}`}`}
          >
            <Percent className="w-3 h-3 inline -mt-0.5" />
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => onSave(category, val, tp)}
          disabled={!dirty}
          data-testid={`discount-save-${category}`}
          className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-9 px-3 disabled:opacity-40"
        >
          <Save className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
