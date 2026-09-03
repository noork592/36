import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, FileText, Building2, Search, Calendar, Trash2, Boxes, X, Image as ImageIcon, Upload, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import IstBadge from "@/components/IstBadge";

const todayIso = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const fmt = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-GB") : "—";

const EMPTY_LINE = { raw_material_id: "", name: "", unit: "", quantity: "", rate: "" };

// Convert a File to a base64 data URL (used to attach bill photos)
const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export default function PurchaseCenter() {
  const { isAdmin } = useAuth();
  const [suppliers, setSuppliers] = useState([]);
  const [rawMaterials, setRawMaterials] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ supplier_id: "", q: "", start: "", end: "" });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    supplier_id: "", bill_number: "", purchased_at: todayIso(), notes: "",
    items: [{ ...EMPTY_LINE }],
    bill_images: [],
  });
  const [saving, setSaving] = useState(false);
  const [previewImg, setPreviewImg] = useState(null); // open image lightbox
  const billFileRef = useRef(null);

  /**
   * Vendor price-list catalog for the currently selected vendor.
   * Operators must NOT manually price a purchase line — the rate must come
   * from the vendor's approved price list. Only admins can override / set a
   * price when no vendor-list entry exists yet.
   *
   * Shape: lower-cased raw-material name → { price, unit, source_list }
   */
  const [vendorPrices, setVendorPrices] = useState({});
  const [vendorPricesLoading, setVendorPricesLoading] = useState(false);

  // Vendor (supplier) search — same UX as Dispatch Center customer picker
  const [vendorQuery, setVendorQuery] = useState("");
  const [showVendorSuggest, setShowVendorSuggest] = useState(false);
  const vendorPickerRef = useRef(null);

  // Close the vendor suggestion dropdown when the user clicks outside it
  useEffect(() => {
    const onDoc = (e) => {
      if (vendorPickerRef.current && !vendorPickerRef.current.contains(e.target)) {
        setShowVendorSuggest(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return suppliers.slice(0, 12);
    return suppliers.filter((s) =>
      [s.name, s.phone, s.material_category, s.contact_person, s.address]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
    ).slice(0, 12);
  }, [suppliers, vendorQuery]);

  const selectedVendor = useMemo(
    () => suppliers.find((s) => s.id === form.supplier_id) || null,
    [suppliers, form.supplier_id],
  );

  /**
   * When a vendor is picked, pull every price list that vendor owns and
   * flatten them into a single name→price map. We dedupe by lowercased
   * item name (last write wins for now; the latest list usually carries
   * the freshest negotiated price).
   */
  useEffect(() => {
    let alive = true;
    const fetchVendorPrices = async () => {
      if (!form.supplier_id) { setVendorPrices({}); return; }
      setVendorPricesLoading(true);
      try {
        const { data: lists } = await api.get("/vendor-price-lists");
        const mine = (lists || []).filter((pl) => pl.vendor_id === form.supplier_id);
        const map = {};
        for (const pl of mine) {
          try {
            const { data } = await api.get(`/vendor-price-lists/${pl.id}`);
            for (const it of (data?.items || [])) {
              const key = String(it.name || "").trim().toLowerCase();
              if (!key) continue;
              const price = Number(it.price || 0);
              if (price <= 0) continue;
              map[key] = { price, unit: it.unit || "", source_list: pl.name };
            }
          } catch { /* ignore individual list errors */ }
        }
        if (alive) setVendorPrices(map);
      } catch (e) {
        if (alive) setVendorPrices({});
      } finally {
        if (alive) setVendorPricesLoading(false);
      }
    };
    fetchVendorPrices();
    return () => { alive = false; };
  }, [form.supplier_id]);

  // Lookup helper: returns { price, unit, source_list } or null.
  const lookupVendorPrice = (name) => {
    const k = String(name || "").trim().toLowerCase();
    return k ? (vendorPrices[k] || null) : null;
  };

  /**
   * Whenever the vendor price-list map refreshes (vendor switched, list
   * edited), re-price every existing line so operators always see the
   * latest agreed rate. Admin-entered overrides are preserved only when
   * no vendor-list entry exists for that material.
   */
  useEffect(() => {
    if (!form.supplier_id) return;
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => {
        if (!it.name) return it;
        const vp = vendorPrices[String(it.name).trim().toLowerCase()];
        if (vp) {
          return { ...it, rate: String(vp.price), unit: it.unit || vp.unit || "" };
        }
        // No vendor price for this material on the new vendor — clear the
        // rate so the operator/admin sees the locked or admin-editable
        // empty input instead of stale data.
        return { ...it, rate: "" };
      }),
    }));
  }, [vendorPrices, form.supplier_id]);

  const pickVendor = (v) => {
    setForm((f) => ({ ...f, supplier_id: v.id }));
    setVendorQuery("");
    setShowVendorSuggest(false);
  };
  const clearVendor = () => {
    setForm((f) => ({ ...f, supplier_id: "" }));
    setVendorQuery("");
    setShowVendorSuggest(true);
  };

  const load = async () => {
    setLoading(true);
    try {
      // Load suppliers + raw materials in parallel
      const [supRes, rmRes] = await Promise.all([
        api.get("/suppliers"),
        api.get("/raw-materials"),
      ]);
      const supList = supRes.data || [];
      setSuppliers(supList);
      setRawMaterials(rmRes.data || []);
      // Aggregate every supplier's ledger to get all purchase rows.
      const all = [];
      for (const s of supList) {
        try {
          const led = await api.get(`/supplier-ledger/${s.id}`);
          for (const row of (led.data?.rows || [])) {
            if (row.kind === "purchase") {
              all.push({ ...row.raw, supplier_id: s.id, supplier_name: s.name });
            }
          }
        } catch { /* skip individual failures */ }
      }
      all.sort((a, b) => (b.purchased_at || "").localeCompare(a.purchased_at || ""));
      setPurchases(all);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load purchases");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = purchases.filter((p) => {
    if (filter.supplier_id && p.supplier_id !== filter.supplier_id) return false;
    if (filter.start && (p.purchased_at || "") < filter.start) return false;
    if (filter.end && (p.purchased_at || "") > filter.end + "T23:59:59") return false;
    const q = filter.q.trim().toLowerCase();
    if (q) {
      const hay = [p.supplier_name, p.material, p.bill_number, p.notes].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalAmount = filtered.reduce((s, p) => s + Number(p.amount || 0), 0);

  // Auto-computed totals for the in-dialog form
  const formAmount = useMemo(() => form.items.reduce((sum, it) => {
    const q = Number(it.quantity || 0); const r = Number(it.rate || 0);
    return sum + (q > 0 && r >= 0 ? q * r : 0);
  }, 0), [form.items]);

  // Save is allowed as soon as we have ≥1 line with a material name + qty.
  // Rate is OPTIONAL (operators never set it; admins may set it when the
  // material is missing from the vendor price list).
  const hasValidLine = useMemo(
    () => form.items.some(
      (it) => (it.name || "").trim() && Number(it.quantity || 0) > 0,
    ),
    [form.items],
  );

  const openCreate = () => {
    setForm({
      supplier_id: "",
      bill_number: "", purchased_at: todayIso(), notes: "",
      items: [{ ...EMPTY_LINE }],
      bill_images: [],
    });
    setVendorQuery("");
    setShowVendorSuggest(false);
    if (billFileRef.current) billFileRef.current.value = "";
    setOpen(true);
  };

  // Bill image upload (Task 2): convert selected files to base64 data URLs.
  const onPickBillFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const tooLarge = files.find((f) => f.size > 5 * 1024 * 1024);
    if (tooLarge) {
      toast.error(`${tooLarge.name} is over 5 MB — please use a smaller image`);
      e.target.value = "";
      return;
    }
    try {
      const urls = await Promise.all(files.map(fileToDataUrl));
      setForm((f) => ({ ...f, bill_images: [...(f.bill_images || []), ...urls] }));
    } catch {
      toast.error("Could not read image file(s)");
    } finally {
      e.target.value = "";
    }
  };
  const removeBillImage = (idx) =>
    setForm((f) => ({ ...f, bill_images: (f.bill_images || []).filter((_, i) => i !== idx) }));

  const updateLine = (idx, patch) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, ...patch } : it) }));

  const onPickRawMaterial = (idx, rmId) => {
    const rm = rawMaterials.find((r) => r.id === rmId);
    if (!rm) { updateLine(idx, { raw_material_id: "", name: "", unit: "", rate: "" }); return; }
    // Vendor price list is the single source of truth for the rate.
    // Operators can NEVER edit the rate — admins may override only when no
    // vendor-list entry exists for the material.
    const vp = lookupVendorPrice(rm.name);
    updateLine(idx, {
      raw_material_id: rm.id,
      name: rm.name,
      unit: rm.unit || vp?.unit || "",
      rate: vp ? String(vp.price) : "",
    });
  };

  const addLine = () => setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_LINE }] }));
  const removeLine = (idx) => setForm((f) => ({
    ...f,
    items: f.items.length === 1 ? [{ ...EMPTY_LINE }] : f.items.filter((_, i) => i !== idx),
  }));

  const save = async () => {
    if (!form.supplier_id) { toast.error("Pick a vendor"); return; }
    const lines = form.items
      .map((it) => ({
        raw_material_id: it.raw_material_id || null,
        name: (it.name || "").trim(),
        unit: (it.unit || "").trim(),
        quantity: Number(it.quantity || 0),
        rate: Number(it.rate || 0),
      }))
      .filter((it) => it.name && it.quantity > 0);
    if (lines.length === 0) { toast.error("Add at least one raw material line"); return; }
    // Rate is OPTIONAL — purchases without a price are allowed (price can be
    // entered later by an admin via Vendor Ledger ⇒ edit).
    const amount = lines.reduce((s, it) => s + it.quantity * it.rate, 0);
    setSaving(true);
    try {
      await api.post("/supplier-purchases", {
        supplier_id: form.supplier_id,
        amount,
        bill_number: form.bill_number,
        purchased_at: form.purchased_at,
        notes: form.notes,
        items: lines,
        bill_images: form.bill_images || [],
      });
      toast.success(amount > 0 ? "Purchase recorded" : "Purchase saved without price — admin can add it later from Vendor Ledger");
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4" data-testid="purchase-center-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">
            Inbound · Vendor Material
          </div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900 mt-1">
            Purchase Center
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Record material received from suppliers — each entry adds a debit to that supplier&apos;s ledger.
          </p>
        </div>
        <Button onClick={openCreate}
                data-testid="purchase-center-record-btn"
                className="bg-slate-900 hover:bg-slate-800 text-white rounded-sm h-10">
          <FileText className="w-4 h-4 mr-1" /> Record purchase
        </Button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end bg-orange-50/40 border border-orange-100 rounded-sm p-3">
        <div className="sm:col-span-4">
          <Label className="text-[10px] uppercase font-bold text-slate-500">Search</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
                   placeholder="Vendor, material, bill #"
                   data-testid="purchase-center-search"
                   className="pl-9 h-10 rounded-sm mt-1" />
          </div>
        </div>
        <div className="sm:col-span-3">
          <Label className="text-[10px] uppercase font-bold text-slate-500">Vendor</Label>
          <select value={filter.supplier_id}
                  onChange={(e) => setFilter((f) => ({ ...f, supplier_id: e.target.value }))}
                  data-testid="purchase-center-supplier-filter"
                  className="mt-1 w-full h-10 rounded-sm border border-slate-300 px-3 text-sm bg-white">
            <option value="">All vendors</option>
            {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] uppercase font-bold text-slate-500">From</Label>
            <IstBadge />
          </div>
          <Input type="date" value={filter.start}
                 onChange={(e) => setFilter((f) => ({ ...f, start: e.target.value }))}
                 className="h-10 rounded-sm mt-1" />
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] uppercase font-bold text-slate-500">To</Label>
            <IstBadge />
          </div>
          <Input type="date" value={filter.end}
                 onChange={(e) => setFilter((f) => ({ ...f, end: e.target.value }))}
                 className="h-10 rounded-sm mt-1" />
        </div>
        <div className="sm:col-span-1 text-right">
          <div className="text-[10px] uppercase font-bold text-slate-500">Total</div>
          <div className="text-sm font-extrabold text-slate-900 tabular-nums">{fmt(totalAmount)}</div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-sm overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
            <tr>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Vendor</th>
              <th className="text-left px-3 py-2">Material</th>
              <th className="text-left px-3 py-2">Bill #</th>
              <th className="text-right px-3 py-2">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Loading…</td></tr>)}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500" data-testid="purchases-empty">
                {suppliers.length === 0
                  ? "Add a vendor first from Vendors, then record a purchase."
                  : "No purchases match the current filters."}
              </td></tr>
            )}
            {!loading && filtered.map((p) => (
              <tr key={p.id} className="border-t border-slate-100 hover:bg-orange-50/30" data-testid={`purchase-row-${p.id}`}>
                <td className="px-3 py-2 text-slate-600">
                  <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3 text-slate-400" />{fmtDate(p.purchased_at)}</span>
                </td>
                <td className="px-3 py-2">
                  <Link to={`/admin/suppliers/${p.supplier_id}`} className="font-bold text-slate-900 hover:text-[#E65100] inline-flex items-center gap-1">
                    <Building2 className="w-3.5 h-3.5 text-slate-400" /> {p.supplier_name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {p.material || "—"}
                  {Array.isArray(p.items) && p.items.length > 0 && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {p.items.map((it, i) => (
                        <div key={i} className="tabular-nums">
                          • {it.quantity} {it.unit} {it.name} @ {fmt(it.rate)} = <span className="font-bold">{fmt(it.line_value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {Array.isArray(p.bill_images) && p.bill_images.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1" data-testid={`purchase-row-${p.id}-bills`}>
                      {p.bill_images.map((src, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setPreviewImg(src)}
                          data-testid={`purchase-row-${p.id}-bill-${i}`}
                          className="w-9 h-9 border border-slate-200 rounded-sm overflow-hidden bg-slate-50 hover:ring-2 hover:ring-[#E65100]"
                          title={`Bill photo ${i + 1}`}
                        >
                          <img src={src} alt={`bill ${i + 1}`} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                  {p.notes && <div className="text-[11px] italic text-slate-500 mt-0.5">{p.notes}</div>}
                </td>
                <td className="px-3 py-2 text-slate-500 font-mono text-xs">{p.bill_number || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">{fmt(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Record purchase dialog — line-item entry like a sale */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-sm max-w-3xl" data-testid="purchase-center-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading">Record purchase</DialogTitle>
            <DialogDescription>
              Pick raw materials, enter quantity & rate per line — the total amount is computed automatically (just like a sale).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2" ref={vendorPickerRef}>
                <Label className="text-xs font-bold uppercase">Vendor *</Label>
                {!selectedVendor ? (
                  <div className="relative mt-1">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      data-testid="purchase-vendor-input"
                      value={vendorQuery}
                      onChange={(e) => { setVendorQuery(e.target.value); setShowVendorSuggest(true); }}
                      onFocus={() => setShowVendorSuggest(true)}
                      placeholder="Type vendor name, phone, material…"
                      className="pl-9 h-11 rounded-sm"
                    />
                    {showVendorSuggest && (
                      <div
                        className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-60 overflow-y-auto"
                        data-testid="purchase-vendor-suggestions"
                      >
                        {filteredVendors.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-slate-500">
                            {suppliers.length === 0
                              ? "No vendors yet. Add one from the Vendors tab first."
                              : "No vendors match your search."}
                          </div>
                        ) : (
                          filteredVendors.map((v) => (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => pickVendor(v)}
                              data-testid={`purchase-vendor-suggestion-${v.id}`}
                              className="w-full text-left px-3 py-2 hover:bg-orange-50 border-b border-slate-100 last:border-b-0"
                            >
                              <div className="font-bold text-sm text-slate-900">{v.name}</div>
                              <div className="text-[11px] text-slate-500">
                                {v.material_category || "—"}{v.phone ? ` · ${v.phone}` : ""}{v.contact_person ? ` · ${v.contact_person}` : ""}
                              </div>
                              {v.address && (
                                <div className="text-[11px] text-slate-400 italic mt-0.5 truncate">
                                  {v.address}
                                </div>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className="mt-1 flex items-center justify-between bg-slate-50 border border-slate-200 rounded-sm px-3 py-2"
                    data-testid="purchase-vendor-selected"
                  >
                    <div>
                      <div className="font-bold text-slate-900 text-sm inline-flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" /> {selectedVendor.name}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {selectedVendor.material_category || "—"}
                        {selectedVendor.phone ? ` · ${selectedVendor.phone}` : ""}
                        {selectedVendor.contact_person ? ` · ${selectedVendor.contact_person}` : ""}
                      </div>
                      {selectedVendor.address && (
                        <div className="text-[11px] text-slate-400 italic mt-0.5">
                          {selectedVendor.address}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={clearVendor}
                      data-testid="purchase-vendor-clear"
                      className="text-slate-400 hover:text-slate-700"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Date</Label>
                <Input type="date" value={form.purchased_at}
                       onChange={(e) => setForm((f) => ({ ...f, purchased_at: e.target.value }))}
                       className="h-11 rounded-sm mt-1" />
              </div>
            </div>

            {/* Line items */}
            <div className="border border-slate-200 rounded-sm overflow-hidden">
              <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wider font-bold text-slate-600 inline-flex items-center gap-2">
                  <Boxes className="w-3.5 h-3.5" /> Raw material line items
                </div>
                {rawMaterials.length === 0 && (
                  <Link to="/admin/raw-materials" className="text-[11px] text-[#E65100] underline">Add raw materials first</Link>
                )}
              </div>
              <table className="w-full text-sm">
                <thead className="bg-white border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                  <tr>
                    <th className="text-left px-3 py-2 w-[42%]">Raw material *</th>
                    <th className="text-left px-3 py-2 w-[14%]">Qty *</th>
                    <th className="text-left px-3 py-2 w-[14%]">Unit</th>
                    <th className="text-left px-3 py-2 w-[16%]">Rate (₹) *</th>
                    <th className="text-right px-3 py-2 w-[12%]">Line ₹</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((it, idx) => {
                    const lineVal = Number(it.quantity || 0) * Number(it.rate || 0);
                    // FINAL rate-gating rule:
                    //  • OPERATOR (any non-admin) ⇒ rate is ALWAYS read-only.
                    //    - With vendor-list match: shows the auto-filled price.
                    //    - Without: stays blank; purchase saves at ₹0.
                    //  • ADMIN ⇒ rate is ALWAYS editable, even when a
                    //    vendor-list price was auto-filled — admin can
                    //    override on a per-purchase basis.
                    //  • No vendor selected ⇒ disabled for everyone.
                    const vp = it.name ? lookupVendorPrice(it.name) : null;
                    const noVendor = !form.supplier_id;
                    const rateLocked = noVendor || !isAdmin;
                    const lockTitle = noVendor
                      ? "Pick a vendor first"
                      : (isAdmin
                        ? (vp
                            ? `Auto-filled from "${vp.source_list}" — you may override`
                            : "Optional — leave blank or enter a rate")
                        : (vp
                            ? `From vendor price list "${vp.source_list}" — only admin can edit`
                            : "Only admin can set the rate"));
                    return (
                      <tr key={idx} className="border-t border-slate-100 align-top" data-testid={`purchase-line-${idx}`}>
                        <td className="px-2 py-1.5">
                          <RawMaterialPicker
                            rawMaterials={rawMaterials}
                            value={it.raw_material_id}
                            selectedName={it.name}
                            onPick={(rmId) => onPickRawMaterial(idx, rmId)}
                            testidPrefix={`purchase-line-${idx}`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" step="0.01" value={it.quantity}
                                 onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                                 data-testid={`purchase-line-${idx}-qty`}
                                 className="no-spinner h-10 rounded-sm tabular-nums" />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input value={it.unit}
                                 onChange={(e) => updateLine(idx, { unit: e.target.value })}
                                 placeholder="kg / pcs"
                                 data-testid={`purchase-line-${idx}-unit`}
                                 className="h-10 rounded-sm" />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="relative">
                            <Input
                              type="number" min="0" step="0.01"
                              value={it.rate}
                              onChange={(e) => updateLine(idx, { rate: e.target.value })}
                              disabled={rateLocked}
                              readOnly={rateLocked}
                              title={lockTitle}
                              placeholder={vp ? "" : (isAdmin ? "Optional" : "—")}
                              data-testid={`purchase-line-${idx}-rate`}
                              className={`no-spinner h-10 rounded-sm tabular-nums pr-7 ${rateLocked ? "bg-slate-50 cursor-not-allowed" : ""}`}
                            />
                            {rateLocked && (
                              <Lock
                                className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                aria-hidden="true"
                              />
                            )}
                          </div>
                          {it.name && !vp && form.supplier_id && (
                            <div
                              className="text-[10px] text-slate-500 mt-0.5"
                              data-testid={`purchase-line-${idx}-no-vendor-price`}
                            >
                              {isAdmin
                                ? "Not in vendor list — rate optional"
                                : "Not in vendor list — admin can add price later"}
                            </div>
                          )}
                          {vp && (
                            <div
                              className="text-[10px] text-emerald-700 mt-0.5 truncate"
                              data-testid={`purchase-line-${idx}-vendor-price`}
                              title={`From: ${vp.source_list}`}
                            >
                              From: {vp.source_list}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-bold text-slate-900">
                          {fmt(lineVal)}
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          <Button variant="ghost" size="icon"
                                  onClick={() => removeLine(idx)}
                                  data-testid={`purchase-line-${idx}-remove`}
                                  className="h-8 w-8 text-red-600 hover:bg-red-50 rounded-sm">
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
                              data-testid="purchase-add-line"
                              className="rounded-sm h-8">
                        <Plus className="w-3.5 h-3.5 mr-1" /> Add line
                      </Button>
                    </td>
                    <td className="px-3 py-2 text-right text-[11px] uppercase font-bold text-slate-600">Total</td>
                    <td className="px-3 py-2 text-right tabular-nums font-extrabold text-slate-900" data-testid="purchase-form-total">
                      {fmt(formAmount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-bold uppercase">Bill number</Label>
                <Input value={form.bill_number}
                       onChange={(e) => setForm((f) => ({ ...f, bill_number: e.target.value }))}
                       placeholder="e.g. INV-2026-001"
                       data-testid="purchase-bill"
                       className="h-11 rounded-sm mt-1 font-mono" />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase">Notes</Label>
                <Input value={form.notes}
                       onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                       data-testid="purchase-notes"
                       className="h-11 rounded-sm mt-1" />
              </div>
            </div>

            {/* Bill photos (Task 2) */}
            <div>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <Label className="text-xs font-bold uppercase inline-flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-[#E65100]" /> Bill photos
                  <span className="text-[10px] font-medium text-slate-400 normal-case">(optional · max 5 MB each)</span>
                </Label>
                <input
                  ref={billFileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onPickBillFiles}
                  data-testid="purchase-bill-image-input"
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => billFileRef.current?.click()}
                  data-testid="purchase-bill-image-pick-btn"
                  className="rounded-sm border-slate-300"
                >
                  <Upload className="w-3.5 h-3.5 mr-1.5" /> Upload bill photo
                </Button>
              </div>
              {form.bill_images && form.bill_images.length > 0 ? (
                <div
                  className="mt-2 grid grid-cols-3 sm:grid-cols-5 gap-2"
                  data-testid="purchase-bill-image-thumbs"
                >
                  {form.bill_images.map((src, idx) => (
                    <div key={idx} className="relative group border border-slate-200 rounded-sm overflow-hidden bg-slate-50">
                      <button
                        type="button"
                        onClick={() => setPreviewImg(src)}
                        className="block w-full aspect-square overflow-hidden"
                        data-testid={`purchase-bill-image-${idx}`}
                      >
                        <img src={src} alt={`bill ${idx + 1}`} className="w-full h-full object-cover" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeBillImage(idx)}
                        data-testid={`purchase-bill-image-remove-${idx}`}
                        className="absolute top-1 right-1 bg-white/90 hover:bg-white text-rose-600 rounded-sm p-0.5 shadow"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-slate-400 italic">
                  No photos attached. Click <span className="font-bold">Upload bill photo</span> to attach one or more pictures of the bill.
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-sm">Cancel</Button>
            <Button onClick={save}
                    disabled={saving || !form.supplier_id || !hasValidLine}
                    data-testid="purchase-center-save"
                    className="bg-slate-900 hover:bg-slate-800 text-white rounded-sm">
              {saving ? "Saving…" : (<><Plus className="w-4 h-4 mr-1" /> Save purchase · {fmt(formAmount)}</>)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bill image preview lightbox */}
      <Dialog open={!!previewImg} onOpenChange={(o) => { if (!o) setPreviewImg(null); }}>
        <DialogContent className="rounded-sm max-w-3xl bg-slate-900 border-slate-800" data-testid="purchase-bill-preview-dialog">
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

// =========================================================================
// Inline fuzzy-search raw-material picker for the purchase line-item table.
// Mirrors the vendor-picker UX: a search input that opens a suggestion
// dropdown; once picked, shows a compact pill with name + unit + a clear (X).
// =========================================================================
function RawMaterialPicker({ rawMaterials, value, selectedName, onPick, testidPrefix }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selected = useMemo(
    () => rawMaterials.find((r) => r.id === value) || null,
    [rawMaterials, value],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rawMaterials.slice(0, 20);
    return rawMaterials.filter((r) =>
      [r.name, r.unit, r.notes].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
    ).slice(0, 20);
  }, [rawMaterials, query]);

  if (selected) {
    return (
      <div
        className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-sm px-2.5 py-2"
        data-testid={`${testidPrefix}-rm-selected`}
      >
        <div className="min-w-0">
          <div className="font-bold text-sm text-slate-900 truncate">{selected.name}</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            {selected.unit || "—"}{Number(selected.default_rate) > 0 ? ` · default ₹${selected.default_rate}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { onPick(""); setQuery(""); setOpen(true); }}
          data-testid={`${testidPrefix}-rm-clear`}
          className="text-slate-400 hover:text-slate-700 shrink-0 ml-2"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      <Input
        value={query || selectedName || ""}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search raw material…"
        data-testid={`${testidPrefix}-rm-input`}
        className="h-10 pl-8 rounded-sm"
      />
      {open && (
        <div
          className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-60 overflow-y-auto"
          data-testid={`${testidPrefix}-rm-suggestions`}
        >
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              {rawMaterials.length === 0
                ? "No raw materials yet. Add some from the Raw Material tab."
                : "No raw materials match your search."}
            </div>
          ) : (
            matches.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => { onPick(r.id); setQuery(""); setOpen(false); }}
                data-testid={`${testidPrefix}-rm-suggestion-${r.id}`}
                className="w-full text-left px-3 py-2 hover:bg-orange-50 border-b border-slate-100 last:border-b-0"
              >
                <div className="font-bold text-sm text-slate-900">{r.name}</div>
                <div className="text-[11px] text-slate-500">
                  {r.unit || "—"}
                  {Number(r.default_rate) > 0 ? ` · default ₹${r.default_rate}` : ""}
                  {r.notes ? ` · ${r.notes}` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
