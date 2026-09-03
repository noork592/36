import React, { useEffect, useState, useRef } from "react";
import { api, API_BASE } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { UserPlus, Phone, MapPin, Edit3, Save, X, Trash2, Truck, Tag, Upload, Download, FileSpreadsheet, ShieldOff } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";
import BlockedItemsDialog from "@/components/BlockedItemsDialog";

const PREF_OPTIONS = {
  side_stand_type: ["Type A", "Type B", "Type C"],
  seat_kunda_type: ["Fix", "Folding"],
  center_stand_kit: ["With Kit", "Without Kit"],
};

export default function Customers() {
  const { isAdmin, canAct } = useAuth();
  const canEditCustomers = canAct("edit:customers");
  const canDeleteCustomers = canAct("delete:customers");
  const { t } = useTranslation();
  const [list, setList] = useState([]);
  const [priceLists, setPriceLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", address: "", city: "", location: "", transport_name: "", private_mark: "", bill_number_mode: false, price_list_id: "" });
  const [editing, setEditing] = useState(null);
  const [editPrefs, setEditPrefs] = useState({});
  const [editDetails, setEditDetails] = useState(null); // admin: name/phone/address edit
  const [detailsForm, setDetailsForm] = useState({ name: "", phone: "", address: "", city: "", location: "", transport_name: "", private_mark: "", bill_number_mode: false, price_list_id: "" });
  // Bulk selection (admin)
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Bulk import dialog
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // {imported, skipped, skipped_reasons} | {error}
  const fileInputRef = useRef(null);
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();
  // Blocked-items dialog state — admin picks a customer, opens the dialog,
  // and manages the SKUs that should never appear for that party in search
  // / order / dispatch flows.
  const [blockedCustomer, setBlockedCustomer] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [{ data }, pl] = await Promise.all([
        api.get("/customers"),
        api.get("/price-lists").catch(() => ({ data: [] })),
      ]);
      setList(data);
      setPriceLists(pl.data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = list.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.phone || "").includes(q));

  const save = async () => {
    if (!form.name.trim()) { toast.error(t("newOrder.errors.nameRequired")); return; }
    try {
      await api.post("/customers", {
        ...form,
        price_list_id: form.price_list_id || null,
      });
      toast.success(t("customers.added"));
      setShowAdd(false); setForm({ name: "", phone: "", address: "", city: "", location: "", transport_name: "", private_mark: "", bill_number_mode: false, price_list_id: "" });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const openEdit = (c) => {
    setEditing(c);
    setEditPrefs(c.preferences || {});
  };

  const savePrefs = async () => {
    try {
      await api.patch(`/customers/${editing.id}`, { preferences: editPrefs });
      toast.success(t("customers.prefsUpdated"));
      setEditing(null);
      load();
    } catch (e) { toast.error(t("common.failed")); }
  };

  const openEditDetails = (c) => {
    setEditDetails(c);
    setDetailsForm({
      name: c.name || "",
      phone: c.phone || "",
      address: c.address || "",
      city: c.city || "",
      location: c.location || "",
      transport_name: c.transport_name || "",
      private_mark: c.private_mark || "",
      bill_number_mode: !!c.bill_number_mode,
      price_list_id: c.price_list_id || "",
    });
  };

  const saveDetails = async () => {
    if (!detailsForm.name.trim()) { toast.error(t("newOrder.errors.nameRequired")); return; }
    try {
      await api.patch(`/customers/${editDetails.id}`, {
        ...detailsForm,
        price_list_id: detailsForm.price_list_id || null,
      });
      toast.success(t("customers.detailsUpdated"));
      setEditDetails(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const del = (c) => {
    confirm({
      title: t("customers.confirmDeleteTitle"),
      description: t("customers.confirmDelete", { name: c.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/customers/${c.id}`);
          toast.success(t("customers.deleted"));
          load();
        } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
      },
    });
  };

  // ---- Bulk selection ----
  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) clearSelection();
    else setSelectedIds(new Set(filtered.map((c) => c.id)));
  };
  const bulkDelete = () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    confirm({
      title: t("customerBulk.confirmBulkDeleteTitle"),
      description: t("customerBulk.confirmBulkDelete", { n: ids.length }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          const { data } = await api.post("/customers/bulk-delete", { ids });
          toast.success(t("customerBulk.bulkDeleted", { n: data.deleted }));
          clearSelection();
          load();
        } catch (e) {
          const detail = e?.response?.data?.detail;
          toast.error(typeof detail === "string" ? detail : (detail?.message || t("common.failed")));
        }
      },
    });
  };

  // ---- Excel import ----
  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem("foms_token");
      const res = await fetch(`${API_BASE}/customers/import/template`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "customers_import_template.xlsx"; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error(t("common.failed")); }
  };
  const uploadImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      const token = localStorage.getItem("foms_token");
      const res = await fetch(`${API_BASE}/customers/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      // Try JSON first, fall back to plain text so we never lose the
      // backend's error string.
      let data = {};
      let rawText = "";
      try { data = await res.clone().json(); }
      catch { rawText = await res.text().catch(() => ""); }
      if (!res.ok) {
        // Robustly extract the actual reason from any of: a JSON `detail`
        // (string OR {message}), a plain text body, or the HTTP status.
        const detail = data?.detail;
        let msg;
        if (typeof detail === "string" && detail.trim()) msg = detail;
        else if (detail?.message) msg = detail.message;
        else if (rawText && rawText.trim()) msg = rawText.trim();
        else msg = `${t("customerBulk.importFailed")} (HTTP ${res.status})`;
        toast.error(msg);
        setImportResult({ error: msg });
        return;
      }
      const imported = data?.imported || 0;
      const skipped = data?.skipped || 0;
      setImportResult(data);
      if (imported > 0) {
        toast.success(t("customerBulk.imported", { n: imported }));
      } else if (skipped > 0) {
        toast.error(`No new customers added — all ${skipped} row(s) skipped`);
      } else {
        toast.error("No customer rows found in the file");
      }
      load();
    } catch (e) {
      const msg = e?.message ? `${t("customerBulk.importFailed")}: ${e.message}` : t("customerBulk.importFailed");
      toast.error(msg);
      setImportResult({ error: msg });
    } finally { setImporting(false); }
  };

  return (
    <div className="space-y-5" data-testid="customers-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("customers.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("customers.title")}</h1>
          <p className="text-slate-500 text-sm mt-1">{t("customers.subtitle")}</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={downloadTemplate} data-testid="customers-download-template-btn"
                    variant="outline"
                    className="rounded-sm h-10 px-3 border-slate-300 font-bold">
              <Download className="w-4 h-4 mr-1.5" /> {t("customerBulk.downloadTemplate")}
            </Button>
            <Button onClick={() => setImportOpen(true)} data-testid="customers-import-btn"
                    variant="outline"
                    className="rounded-sm h-10 px-3 border-slate-300 font-bold">
              <Upload className="w-4 h-4 mr-1.5" /> {t("customerBulk.importBtn")}
            </Button>
            <Button onClick={() => setShowAdd(true)} data-testid="add-customer-page-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold">
              <UserPlus className="w-4 h-4 mr-1.5" /> {t("customers.newBtn")}
            </Button>
          </div>
        )}
      </div>

      {/* Bulk selection action bar — admin only, visible when something is selected */}
      {canDeleteCustomers && selectedIds.size > 0 && (
        <div data-testid="bulk-action-bar"
             className="bg-orange-50 border-2 border-[#E65100] rounded-sm p-3 flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm font-bold text-[#7c2d12]" data-testid="bulk-selected-count">
            {t("customerBulk.selectedCount", { n: selectedIds.size })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={clearSelection}
                    data-testid="bulk-clear-btn"
                    className="rounded-sm">{t("customerBulk.clearSelection")}</Button>
            <Button onClick={bulkDelete} data-testid="bulk-delete-btn"
                    className="bg-rose-600 hover:bg-rose-700 text-white rounded-sm font-bold">
              <Trash2 className="w-4 h-4 mr-1" /> {t("customerBulk.bulkDeleteBtn")}
            </Button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="p-4 border-b border-slate-200 flex items-center gap-3 flex-wrap">
          {canDeleteCustomers && filtered.length > 0 && (
            <label className="flex items-center gap-2 text-xs font-bold text-slate-600 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && selectedIds.size === filtered.length}
                onChange={toggleSelectAll}
                data-testid="select-all-customers"
                className="w-4 h-4 accent-[#E65100] cursor-pointer"
              />
              <span className="hidden sm:inline">{t("customerBulk.selectAll")}</span>
            </label>
          )}
          <Input data-testid="customers-search" placeholder={t("customers.searchPlaceholder")}
                 value={q} onChange={(e) => setQ(e.target.value)} className="h-10 rounded-sm flex-1 min-w-[180px]" />
        </div>
        {loading ? <div className="p-10 text-center text-slate-400">{t("common.loading")}</div> :
         filtered.length === 0 ? <div className="p-10 text-center text-slate-400 text-sm">{t("customers.noneYet")}</div> :
         <div className="divide-y divide-slate-100">
           {filtered.map((c) => (
             <div key={c.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 hover:bg-slate-50 transition-colors"
                  data-testid={`customer-row-${c.id}`}>
               {canDeleteCustomers && (
                 <input
                   type="checkbox"
                   checked={selectedIds.has(c.id)}
                   onChange={() => toggleSelected(c.id)}
                   data-testid={`select-customer-${c.id}`}
                   className="w-4 h-4 mt-1 accent-[#E65100] cursor-pointer shrink-0"
                 />
               )}
               <div className="flex-1 min-w-0">
                 <div className="font-bold text-slate-900">{c.name}</div>
                 <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-3 flex-wrap">
                   {c.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                   {c.city && <span className="flex items-center gap-1 font-semibold text-slate-700"><MapPin className="w-3 h-3" />{c.city}{c.location ? `, ${c.location}` : ""}</span>}
                   {c.address && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{c.address}</span>}
                   {c.transport_name && (
                     <span className="flex items-center gap-1 text-[#E65100] font-bold" data-testid={`customer-transport-${c.id}`}>
                       <Truck className="w-3 h-3" />{c.transport_name}
                     </span>
                   )}
                   {c.price_list_id && (
                     <span className="flex items-center gap-1 text-slate-700" data-testid={`customer-pl-${c.id}`}>
                       <Tag className="w-3 h-3" />
                       {priceLists.find((p) => p.id === c.price_list_id)?.name || "—"}
                     </span>
                   )}
                   {Array.isArray(c.blocked_items) && c.blocked_items.length > 0 && (
                     <span
                       className="flex items-center gap-1 text-rose-700 font-bold"
                       data-testid={`customer-blocked-count-${c.id}`}
                       title="Blocked items for this party"
                     >
                       <ShieldOff className="w-3 h-3" />
                       {c.blocked_items.length} blocked
                     </span>
                   )}
                 </div>
                 {c.preferences && Object.keys(c.preferences).length > 0 ? (
                   <div className="mt-2 flex flex-wrap gap-1.5">
                     {Object.entries(c.preferences).map(([k, v]) => (
                       <span key={k} className="text-[10px] uppercase tracking-wider font-bold bg-orange-50 border border-orange-200 text-orange-900 px-2 py-1 rounded-sm">
                         {t(`customers.pref.${k}`, k)}: {v}
                       </span>
                     ))}
                   </div>
                 ) : <div className="mt-2 text-xs text-slate-400 italic">{t("customers.noPrefs")}</div>}
               </div>
               <div className="flex items-center gap-2 shrink-0 flex-wrap">
                 {canEditCustomers && (
                   <Button size="sm" variant="outline" onClick={() => openEditDetails(c)}
                           data-testid={`edit-details-${c.id}`}
                           className="rounded-sm border-slate-300">
                     <Edit3 className="w-3.5 h-3.5 mr-1" /> {t("customers.editDetailsBtn")}
                   </Button>
                 )}
                 {canEditCustomers && (
                   <Button size="sm" variant="outline" onClick={() => setBlockedCustomer(c)}
                           data-testid={`block-items-${c.id}`}
                           className="rounded-sm border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800">
                     <ShieldOff className="w-3.5 h-3.5 mr-1" /> Block items
                   </Button>
                 )}
                 {canEditCustomers && (
                 <Button size="sm" variant="outline" onClick={() => openEdit(c)}
                         data-testid={`edit-prefs-${c.id}`}
                         className="rounded-sm border-slate-300">
                   <Edit3 className="w-3.5 h-3.5 mr-1" /> {t("customers.prefsBtn")}
                 </Button>
                 )}
                 {canDeleteCustomers && (
                   <Button size="sm" variant="outline" onClick={() => del(c)}
                           data-testid={`delete-customer-${c.id}`}
                           className="rounded-sm border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                     <Trash2 className="w-3.5 h-3.5" />
                   </Button>
                 )}
               </div>
             </div>
           ))}
         </div>}
      </div>

      {/* Add Customer Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("customers.addTitle")}</DialogTitle>
            <DialogDescription>{t("customers.addSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.name")}</Label>
              <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                     data-testid="cust-add-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.phone")}</Label>
              <Input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                     data-testid="cust-add-phone" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.address")}</Label>
              <Textarea value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                        data-testid="cust-add-address" rows={2} className="rounded-sm mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">City</Label>
                <Input value={form.city} onChange={(e) => setForm((p) => ({ ...p, city: e.target.value }))}
                       placeholder="e.g. Indore"
                       data-testid="cust-add-city" className="h-11 rounded-sm mt-1" />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Location / Area</Label>
                <Input value={form.location} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
                       placeholder="e.g. Sapna Sangeeta"
                       data-testid="cust-add-location" className="h-11 rounded-sm mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Transport (company name)</Label>
              <Input value={form.transport_name}
                     onChange={(e) => setForm((p) => ({ ...p, transport_name: e.target.value }))}
                     placeholder="e.g. DTDC, Self pickup, ABC Roadlines"
                     data-testid="cust-add-transport" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Private mark / Bill Number</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                <Input value={form.private_mark}
                       disabled={form.bill_number_mode}
                       onChange={(e) => {
                         const v = e.target.value;
                         if (/[a-zA-Z]/.test(v)) {
                           // Contains letters → it's a Private Mark.
                           setForm((p) => ({ ...p, private_mark: v, bill_number_mode: false }));
                         } else if (/^\d+$/.test(v.trim())) {
                           // Purely numeric → clear input & switch to Bill Number.
                           setForm((p) => ({ ...p, private_mark: "", bill_number_mode: true }));
                         } else {
                           setForm((p) => ({ ...p, private_mark: v, bill_number_mode: v ? p.bill_number_mode : false }));
                         }
                       }}
                       placeholder="Type mark (letters) — digits switch to Bill Number"
                       data-testid="cust-add-private-mark"
                       className="h-11 rounded-sm disabled:bg-slate-100 disabled:text-slate-400" />
                <Select
                  value={form.bill_number_mode ? "bill" : "none"}
                  onValueChange={(v) => setForm((p) => ({ ...p, bill_number_mode: v === "bill", private_mark: v === "bill" ? "" : p.private_mark }))}
                >
                  <SelectTrigger data-testid="cust-add-billmode" className="h-11 rounded-sm">
                    <SelectValue placeholder="Bill Number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    <SelectItem value="bill">Bill Number</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Choose ONE: either a Private mark, or Bill Number mode (bill typed at dispatch).</p>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Price list</Label>
              <select
                value={form.price_list_id}
                onChange={(e) => setForm((p) => ({ ...p, price_list_id: e.target.value }))}
                data-testid="cust-add-pricelist"
                className="mt-1 w-full h-11 rounded-sm border border-slate-300 px-3 text-sm bg-white"
              >
                <option value="">— None —</option>
                {priceLists.map((pl) => (
                  <option key={pl.id} value={pl.id}>{pl.name}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={save} data-testid="cust-add-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Preferences Dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("customers.editTitle", { name: editing?.name })}</DialogTitle>
            <DialogDescription>{t("customers.editSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {Object.entries(PREF_OPTIONS).map(([key, opts]) => (
              <div key={key}>
                <Label className="text-xs font-bold uppercase">{t(`customers.pref.${key}`, key)}</Label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button type="button"
                          onClick={() => setEditPrefs((p) => { const n = { ...p }; delete n[key]; return n; })}
                          className={`px-3 h-9 text-xs rounded-sm border ${!editPrefs[key] ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:border-slate-400"}`}>
                    {t("common.none")}
                  </button>
                  {opts.map((opt) => (
                    <button key={opt} type="button"
                            onClick={() => setEditPrefs((p) => ({ ...p, [key]: opt }))}
                            data-testid={`pref-${key}-${opt}`}
                            className={`px-3 h-9 text-xs rounded-sm border ${editPrefs[key] === opt ? "bg-[#E65100] text-white border-[#E65100]" : "bg-white border-slate-200 hover:border-[#E65100]"}`}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} className="rounded-sm">
              <X className="w-4 h-4 mr-1" /> {t("common.cancel")}
            </Button>
            <Button onClick={savePrefs} data-testid="save-prefs"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              <Save className="w-4 h-4 mr-1" /> {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Edit Customer Details Dialog (admin) */}
      <Dialog open={!!editDetails} onOpenChange={(o) => !o && setEditDetails(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("customers.editDetailsTitle", { name: editDetails?.name })}</DialogTitle>
            <DialogDescription>{t("customers.editDetailsSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.name")}</Label>
              <Input value={detailsForm.name}
                     onChange={(e) => setDetailsForm((p) => ({ ...p, name: e.target.value }))}
                     data-testid="cust-edit-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.phone")}</Label>
              <Input value={detailsForm.phone}
                     onChange={(e) => setDetailsForm((p) => ({ ...p, phone: e.target.value }))}
                     data-testid="cust-edit-phone" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.address")}</Label>
              <Textarea value={detailsForm.address}
                        onChange={(e) => setDetailsForm((p) => ({ ...p, address: e.target.value }))}
                        data-testid="cust-edit-address" rows={2} className="rounded-sm mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">City</Label>
                <Input value={detailsForm.city}
                       onChange={(e) => setDetailsForm((p) => ({ ...p, city: e.target.value }))}
                       placeholder="e.g. Indore"
                       data-testid="cust-edit-city" className="h-11 rounded-sm mt-1" />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Location / Area</Label>
                <Input value={detailsForm.location}
                       onChange={(e) => setDetailsForm((p) => ({ ...p, location: e.target.value }))}
                       placeholder="e.g. Sapna Sangeeta"
                       data-testid="cust-edit-location" className="h-11 rounded-sm mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Transport (company name)</Label>
              <Input value={detailsForm.transport_name}
                     onChange={(e) => setDetailsForm((p) => ({ ...p, transport_name: e.target.value }))}
                     placeholder="e.g. DTDC, Self pickup, ABC Roadlines"
                     data-testid="cust-edit-transport" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Private mark / Bill Number</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                <Input value={detailsForm.private_mark}
                       disabled={detailsForm.bill_number_mode}
                       onChange={(e) => {
                         const v = e.target.value;
                         if (/[a-zA-Z]/.test(v)) {
                           setDetailsForm((p) => ({ ...p, private_mark: v, bill_number_mode: false }));
                         } else if (/^\d+$/.test(v.trim())) {
                           setDetailsForm((p) => ({ ...p, private_mark: "", bill_number_mode: true }));
                         } else {
                           setDetailsForm((p) => ({ ...p, private_mark: v, bill_number_mode: v ? p.bill_number_mode : false }));
                         }
                       }}
                       placeholder="Type mark (letters) — digits switch to Bill Number"
                       data-testid="cust-edit-private-mark"
                       className="h-11 rounded-sm disabled:bg-slate-100 disabled:text-slate-400" />
                <Select
                  value={detailsForm.bill_number_mode ? "bill" : "none"}
                  onValueChange={(v) => setDetailsForm((p) => ({ ...p, bill_number_mode: v === "bill", private_mark: v === "bill" ? "" : p.private_mark }))}
                >
                  <SelectTrigger data-testid="cust-edit-billmode" className="h-11 rounded-sm">
                    <SelectValue placeholder="Bill Number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    <SelectItem value="bill">Bill Number</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Choose ONE: either a Private mark, or Bill Number mode (bill typed at dispatch).</p>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">Price list</Label>
              <select
                value={detailsForm.price_list_id}
                onChange={(e) => setDetailsForm((p) => ({ ...p, price_list_id: e.target.value }))}
                data-testid="cust-edit-pricelist"
                className="mt-1 w-full h-11 rounded-sm border border-slate-300 px-3 text-sm bg-white"
              >
                <option value="">— None —</option>
                {priceLists.map((pl) => (
                  <option key={pl.id} value={pl.id}>{pl.name}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDetails(null)} className="rounded-sm">
              <X className="w-4 h-4 mr-1" /> {t("common.cancel")}
            </Button>
            <Button onClick={saveDetails} data-testid="cust-edit-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              <Save className="w-4 h-4 mr-1" /> {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />

      {/* Bulk import dialog */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!o) { setImportOpen(false); setImportFile(null); setImportResult(null); } }}>
        <DialogContent className="rounded-sm max-w-2xl" data-testid="import-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-[#E65100]" />
              {t("customerBulk.importTitle")}
            </DialogTitle>
            <DialogDescription>{t("customerBulk.importSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button onClick={downloadTemplate} variant="outline" size="sm"
                    data-testid="import-download-template"
                    className="rounded-sm border-slate-300 w-full sm:w-auto">
              <Download className="w-4 h-4 mr-1" /> {t("customerBulk.downloadTemplate")}
            </Button>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportResult(null); }}
                data-testid="import-file-input"
                className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-sm file:border-0 file:font-bold file:bg-[#E65100] file:text-white hover:file:bg-[#CC4800] file:cursor-pointer"
              />
              {importFile && (
                <div className="mt-2 text-xs text-slate-600" data-testid="import-file-name">
                  {importFile.name} · {(importFile.size / 1024).toFixed(1)} KB
                </div>
              )}
              {/* Quick heuristic: filename suggests this is a price-list /
                  vendor / product template, not the customer template.
                  Warn before the upload to avoid a confusing server error. */}
              {importFile && /price|vendor|product|item|raw/i.test(importFile.name) && !/customer|party/i.test(importFile.name) && (
                <div className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-sm px-3 py-2"
                     data-testid="import-wrong-template-warning">
                  This looks like a <b>price list / product</b> template, not the customer template.
                  Click <b>Download template</b> above to get the correct customer file (columns:
                  name, phone, address, city, location, transport_name, price_list).
                </div>
              )}
            </div>

            {/* Inline results panel — shows imported / skipped summary AND
                per-row skip reasons so the user can fix their sheet and
                re-upload. Surfaces whatever the backend returned in the
                response body (also for `error` keys when the upload fails). */}
            {importResult && (
              <div data-testid="import-result" className="border border-slate-200 rounded-sm overflow-hidden">
                <div className={`px-3 py-2 text-sm font-bold ${importResult.error
                  ? "bg-rose-50 text-rose-800 border-b border-rose-200"
                  : (importResult.imported > 0
                      ? "bg-emerald-50 text-emerald-800 border-b border-emerald-200"
                      : "bg-amber-50 text-amber-800 border-b border-amber-200")}`}>
                  {importResult.error
                    ? <>Upload failed: {importResult.error}</>
                    : <>Imported <span className="font-mono-num">{importResult.imported}</span>
                       {" · "}Skipped <span className="font-mono-num">{importResult.skipped}</span></>}
                </div>
                {Array.isArray(importResult.skipped_reasons) && importResult.skipped_reasons.length > 0 && (
                  <div className="max-h-56 overflow-y-auto bg-white">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600 font-bold sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-1.5">Excel row</th>
                          <th className="text-left px-3 py-1.5">Name</th>
                          <th className="text-left px-3 py-1.5">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importResult.skipped_reasons.map((s, i) => (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-3 py-1 text-slate-600 font-mono-num">{s.row}</td>
                            <td className="px-3 py-1 text-slate-900">{s.name}</td>
                            <td className="px-3 py-1 text-rose-700">{s.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setImportOpen(false); setImportFile(null); setImportResult(null); }}
                    className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={uploadImport} disabled={!importFile || importing}
                    data-testid="import-upload-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              <Upload className="w-4 h-4 mr-1" />
              {importing ? t("customerBulk.uploading") : t("customerBulk.uploadBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BlockedItemsDialog
        open={!!blockedCustomer}
        onOpenChange={(o) => { if (!o) setBlockedCustomer(null); }}
        customer={blockedCustomer}
        onSaved={load}
      />
    </div>
  );
}
