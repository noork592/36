import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Edit3, Save, X, Plus, PackageOpen, Trash2, ChevronRight, ChevronDown,
  RotateCcw, Beaker, Search,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";
import BomDialog from "@/components/BomDialog";

function groupItemsByProduct(items) {
  return items.reduce((acc, it) => {
    const pid = it.product_id || "_unassigned";
    if (!acc[pid]) acc[pid] = [];
    acc[pid].push(it);
    return acc;
  }, {});
}

export default function Products() {
  const { isAdmin, canAct } = useAuth();
  const canEditProducts = canAct("edit:products");
  const canDeleteProducts = canAct("delete:products");
  const { t } = useTranslation();
  const [products, setProducts] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({}); // product_id -> bool
  const [itemDrafts, setItemDrafts] = useState({}); // item_id -> {max}
  const [savingItem, setSavingItem] = useState(null); // item_id

  const [editing, setEditing] = useState(null);
  const [editVals, setEditVals] = useState({ max_per_bag: 0, variants: "" });
  const [showAdd, setShowAdd] = useState(false);
  const [addVals, setAddVals] = useState({ name: "", max_per_bag: "", variants: "" });
  // Admin: add-SKU dialog (per master product)
  const [addSkuFor, setAddSkuFor] = useState(null); // master product
  const [addSkuVals, setAddSkuVals] = useState({ name: "", max_per_bag: "", prices: {} });
  // All price lists — loaded once so the Add-SKU dialog can render an input row per list.
  const [priceLists, setPriceLists] = useState([]);
  // Admin: edit-SKU-name dialog
  const [editSku, setEditSku] = useState(null);
  const [editSkuName, setEditSkuName] = useState("");
  // Admin: BOM editor dialog
  const [bomFor, setBomFor] = useState(null);
  // Search query - filters both master products and their SKUs by name
  const [search, setSearch] = useState("");
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const load = async () => {
    const [pRes, iRes, plRes] = await Promise.all([
      api.get("/products"),
      api.get("/items"),
      api.get("/price-lists").catch(() => ({ data: [] })),
    ]);
    setProducts(pRes.data);
    setItems(iRes.data);
    setPriceLists(Array.isArray(plRes.data) ? plRes.data : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const itemsByProduct = groupItemsByProduct(items);

  // Filter products (and their SKUs) by search query. A product row is shown when either
  // its own name matches, or when at least one of its SKUs matches. When only SKUs match,
  // the product is auto-expanded and the SKU list is limited to the matches only.
  const q = search.trim().toLowerCase();
  const filteredProducts = !q ? products : products.filter((p) => {
    if ((p.name || "").toLowerCase().includes(q)) return true;
    const skus = itemsByProduct[p.id] || [];
    return skus.some((it) => (it.name || "").toLowerCase().includes(q));
  });
  const productMatched = (p) => !q ? false : (p.name || "").toLowerCase().includes(q);
  const filteredSkusFor = (p) => {
    const list = itemsByProduct[p.id] || [];
    if (!q) return list;
    if (productMatched(p)) return list; // whole product matched → show all SKUs
    return list.filter((it) => (it.name || "").toLowerCase().includes(q));
  };

  const toggleExpand = (pid) => setExpanded((e) => ({ ...e, [pid]: !e[pid] }));

  const draftFor = (it) => itemDrafts[it.id] || {
    max: it.max_per_bag != null ? String(it.max_per_bag) : "",
  };

  const setDraft = (it, patch) => {
    const current = draftFor(it);
    setItemDrafts((d) => ({ ...d, [it.id]: { ...current, ...patch } }));
  };

  const saveItemBag = async (it) => {
    const d = draftFor(it);
    const mx = Number(d.max);
    if (!mx || mx <= 0) {
      toast.error(t("products.errors.validMax")); return;
    }
    setSavingItem(it.id);
    try {
      // Schema retains min/max for backward compat; UI now drives a single value.
      await api.patch(`/items/${it.id}`, { min_per_bag: mx, max_per_bag: mx });
      toast.success(t("products.success.skuSaved", { name: it.name }));
      setItemDrafts((d2) => { const { [it.id]: _, ...rest } = d2; return rest; });
      await load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
    finally { setSavingItem(null); }
  };

  const resetItemBag = async (it) => {
    if (it.max_per_bag == null) {
      // just clear local draft
      setItemDrafts((d) => { const { [it.id]: _, ...rest } = d; return rest; });
      return;
    }
    confirm({
      title: t("products.resetTitle"),
      description: t("products.resetConfirm", { name: it.name }),
      confirmLabel: t("common.reset"),
      cancelLabel: t("common.cancel"),
      destructive: false,
      onConfirm: async () => {
        closeConfirm();
        setSavingItem(it.id);
        try {
          await api.delete(`/items/${it.id}/bag-override`);
          toast.success(t("products.success.overrideCleared"));
          setItemDrafts((d2) => { const { [it.id]: _, ...rest } = d2; return rest; });
          await load();
        } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
        finally { setSavingItem(null); }
      },
    });
  };

  const openEdit = (p) => {
    setEditing(p);
    setEditVals({
      max_per_bag: p.max_per_bag,
      variants: (p.variants || []).join(", "),
    });
  };

  const saveEdit = async () => {
    try {
      const mx = Number(editVals.max_per_bag);
      if (mx <= 0) { toast.error(t("products.errors.invalidBag")); return; }
      const body = {
        min_per_bag: mx,
        max_per_bag: mx,
        variants: editVals.variants.split(",").map((s) => s.trim()).filter(Boolean),
      };
      await api.patch(`/products/${editing.id}`, body);
      toast.success(t("products.success.updated"));
      setEditing(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const saveAdd = async () => {
    if (!addVals.name.trim()) { toast.error(t("products.errors.nameRequired")); return; }
    const mx = Number(addVals.max_per_bag) || 1;
    try {
      await api.post("/products", {
        name: addVals.name,
        min_per_bag: mx,
        max_per_bag: mx,
        variants: addVals.variants.split(",").map((s) => s.trim()).filter(Boolean),
        variant_field: null,
      });
      toast.success(t("products.success.added"));
      setShowAdd(false); setAddVals({ name: "", max_per_bag: "", variants: "" });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const removeProduct = async (p) => {
    confirm({
      title: t("products.deleteProductTitle"),
      description: t("products.deleteConfirm", { name: p.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/products/${p.id}`);
          toast.success(t("products.success.deleted"));
          load();
        } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
      },
    });
  };

  const openAddSku = (p) => {
    setAddSkuFor(p);
    // Initialise a blank price row for every existing price list so the admin
    // can fill them all in one shot when creating a new SKU.
    const blankPrices = {};
    for (const pl of priceLists) blankPrices[pl.id] = "";
    setAddSkuVals({ name: "", max_per_bag: "", prices: blankPrices });
  };

  const saveAddSku = async () => {
    if (!addSkuVals.name.trim()) { toast.error(t("products.errors.nameRequired")); return; }
    const body = { name: addSkuVals.name.trim(), product_id: addSkuFor.id };
    if (addSkuVals.max_per_bag !== "") {
      const mx = Number(addSkuVals.max_per_bag);
      if (mx <= 0) { toast.error(t("products.errors.validMax")); return; }
      body.min_per_bag = mx;
      body.max_per_bag = mx;
    }
    try {
      // Create the SKU first — server returns the new item so we can grab its ID.
      const created = await api.post("/items", body);
      const newItemId = created?.data?.id;
      // Persist every non-blank per-price-list price entered in the dialog.
      // We fire the writes in parallel and swallow individual failures so a
      // single bad list does not block the rest. Any failure will be
      // surfaced via a toast at the end.
      const priceEntries = Object.entries(addSkuVals.prices || {})
        .filter(([, v]) => String(v).trim() !== "" && !Number.isNaN(Number(v)));
      if (newItemId && priceEntries.length) {
        const results = await Promise.allSettled(priceEntries.map(([plid, price]) =>
          api.post(`/price-lists/${plid}/items`, { item_id: newItemId, price: Number(price) })
        ));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          toast.error(`SKU added, but ${failed} price(s) failed to save`);
        } else {
          toast.success(`${t("products.success.skuAdded")}${priceEntries.length ? ` · ${priceEntries.length} price(s) set` : ""}`);
        }
      } else {
        toast.success(t("products.success.skuAdded"));
      }
      setAddSkuFor(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const openEditSku = (it) => {
    setEditSku(it);
    setEditSkuName(it.name);
  };

  const saveEditSku = async () => {
    if (!editSkuName.trim()) { toast.error(t("products.errors.nameRequired")); return; }
    try {
      await api.patch(`/items/${editSku.id}`, { name: editSkuName.trim() });
      toast.success(t("products.success.skuRenamed"));
      setEditSku(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const deleteSku = async (it) => {
    confirm({
      title: t("products.deleteSkuTitle"),
      description: t("products.deleteSkuConfirm", { name: it.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/items/${it.id}`);
          toast.success(t("products.success.skuDeleted"));
          load();
        } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
      },
    });
  };

  return (
    <div className="space-y-5" data-testid="products-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("products.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("products.title")}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {t("products.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products or SKUs…"
              data-testid="products-search"
              className="h-10 rounded-sm pl-9 pr-8 w-64 border-slate-300"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                data-testid="products-search-clear"
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 rounded-sm">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {isAdmin && (
            <Button onClick={() => setShowAdd(true)} data-testid="add-product-btn"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold">
              <Plus className="w-4 h-4 mr-1.5" /> {t("products.newProduct")}
            </Button>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        {loading ? <div className="p-10 text-center text-slate-400">{t("common.loading")}</div> :
         <div className="divide-y divide-slate-100">
           {filteredProducts.length === 0 ? (
             <div className="p-10 text-center text-slate-400" data-testid="no-search-results">
               No products found matching &ldquo;{search}&rdquo;
             </div>
           ) : filteredProducts.map((p) => {
             // Auto-expand when a search query is active so matching SKUs are visible.
             const isOpen = q ? true : !!expanded[p.id];
             const skuList = filteredSkusFor(p).slice().sort((a, b) => a.name.localeCompare(b.name));
             const overrideCount = skuList.filter((it) => it.max_per_bag != null).length;
             return (
               <div key={p.id} data-testid={`product-row-${p.name}`}>
                 <div
                   role="button"
                   tabIndex={0}
                   onClick={() => toggleExpand(p.id)}
                   onKeyDown={(e) => {
                     if (e.key === "Enter" || e.key === " ") {
                       e.preventDefault();
                       toggleExpand(p.id);
                     }
                   }}
                   data-testid={`expand-product-${p.name}`}
                   className="w-full p-4 sm:p-5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors text-left cursor-pointer">
                   <div className="flex items-center gap-3 flex-1 min-w-0">
                     <div className="w-6 h-6 grid place-items-center text-slate-400 shrink-0">
                       {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                     </div>
                     <div className="w-10 h-10 bg-orange-50 border border-orange-200 rounded-sm grid place-items-center shrink-0">
                       <PackageOpen className="w-5 h-5 text-[#E65100]" />
                     </div>
                     <div className="min-w-0">
                       <div className="font-bold text-slate-900 truncate">{p.name}</div>
                       <div className="text-xs text-slate-500 font-mono-num">
                         {`${p.max_per_bag} ${t("products.pcsPerBag")}`}
                         <> · {t("products.skuCount", { count: skuList.length })}</>
                         {overrideCount > 0 && (
                           <> · <span className="text-[#E65100] font-bold">{t("products.overrideCount", { count: overrideCount })}</span></>
                         )}
                         {p.variants?.length > 0 && <> · {t("products.variantsLabel")} {p.variants.join(", ")}</>}
                       </div>
                     </div>
                   </div>
                   {(canEditProducts || canDeleteProducts) && (
                     <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                       {canEditProducts && (
                       <Button size="sm" variant="outline" onClick={() => openEdit(p)}
                               data-testid={`edit-product-${p.name}`}
                               className="rounded-sm border-slate-300">
                         <Edit3 className="w-3.5 h-3.5 mr-1" /> {t("common.edit")}
                       </Button>
                       )}
                       {canDeleteProducts && (
                       <Button size="sm" variant="outline" onClick={() => removeProduct(p)}
                               data-testid={`delete-product-${p.name}`}
                               className="rounded-sm border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                         <Trash2 className="w-3.5 h-3.5" />
                       </Button>
                       )}
                     </div>
                   )}
                 </div>

                 {isOpen && (
                   <div className="bg-slate-50/60 border-t border-slate-100 px-4 sm:px-6 py-4"
                        data-testid={`sku-list-${p.name}`}>
                     {isAdmin && (
                       <div className="flex justify-end mb-3">
                         <Button size="sm" variant="outline" onClick={() => openAddSku(p)}
                                 data-testid={`add-sku-${p.name}`}
                                 className="rounded-sm border-orange-200 text-[#E65100] hover:bg-orange-50 h-8 text-xs">
                           <Plus className="w-3 h-3 mr-1" /> {t("products.addSku")}
                         </Button>
                       </div>
                     )}
                     {skuList.length === 0 ? (
                       <div className="text-sm text-slate-400 italic">{t("products.noSkus")}</div>
                     ) : (
                       <div className="space-y-2">
                         <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider font-bold text-slate-500 px-3 pb-1">
                           <div className="col-span-12 sm:col-span-6">{t("products.skuName")}</div>
                           <div className="col-span-6 sm:col-span-3">{t("products.maxBag")}</div>
                           <div className="col-span-12 sm:col-span-3 text-right">{t("common.actions")}</div>
                         </div>
                         {skuList.map((it) => {
                           const d = draftFor(it);
                           const hasOverride = it.max_per_bag != null;
                           const isDirty = String(d.max || "") !== String(it.max_per_bag ?? "");
                           return (
                             <div key={it.id}
                                  className="grid grid-cols-12 gap-2 items-center bg-white border border-slate-200 rounded-sm px-3 py-2"
                                  data-testid={`sku-row-${it.id}`}>
                               <div className="col-span-12 sm:col-span-6 min-w-0">
                                 <div className="text-sm font-bold text-slate-900 truncate flex items-center gap-2">
                                   {it.name}
                                   {hasOverride && (
                                     <span className="text-[9px] uppercase tracking-wider font-bold text-[#E65100] bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-sm">
                                       {t("products.override")}
                                     </span>
                                   )}
                                 </div>
                                 <div className="text-[11px] text-slate-500 font-mono-num">
                                   {hasOverride
                                     ? t("products.customMax", { max: it.max_per_bag })
                                     : t("products.usesDefaultMax", { max: p.max_per_bag })}
                                 </div>
                               </div>
                               <div className="col-span-6 sm:col-span-3">
                                 <Input
                                   type="number"
                                   min="1"
                                   value={d.max}
                                   placeholder={String(p.max_per_bag)}
                                   onChange={(e) => setDraft(it, { max: e.target.value })}
                                   onFocus={(e) => e.target.select()}
                                   data-testid={`sku-max-${it.id}`}
                                   className="h-9 rounded-sm font-mono-num text-sm no-spinner" />
                               </div>
                               <div className="col-span-12 sm:col-span-3 flex items-center justify-end gap-1.5 flex-wrap">
                                 <Button
                                   size="sm"
                                   onClick={() => saveItemBag(it)}
                                   disabled={savingItem === it.id || !isDirty || !canEditProducts}
                                   data-testid={`sku-save-${it.id}`}
                                   className="h-8 rounded-sm bg-[#E65100] hover:bg-[#CC4800] text-white text-xs px-3 disabled:opacity-40">
                                   <Save className="w-3.5 h-3.5 mr-1" />
                                   {t("common.save")}
                                 </Button>
                                 {canEditProducts && (hasOverride || isDirty) && (
                                   <Button
                                     size="sm"
                                     variant="outline"
                                     onClick={() => resetItemBag(it)}
                                     disabled={savingItem === it.id}
                                     data-testid={`sku-reset-${it.id}`}
                                     title={t("products.resetTitle")}
                                     className="h-8 rounded-sm border-slate-300 text-xs px-2">
                                     <RotateCcw className="w-3.5 h-3.5" />
                                   </Button>
                                 )}
                                 {(canEditProducts || canDeleteProducts) && (
                                   <>
                                     {canEditProducts && (
                                     <Button
                                       size="sm"
                                       variant="outline"
                                       onClick={() => setBomFor(it)}
                                       data-testid={`sku-bom-${it.id}`}
                                       title="Edit Bill of Materials"
                                       className="h-8 rounded-sm border-orange-200 text-[#E65100] hover:bg-orange-50 text-xs px-2">
                                       <Beaker className="w-3.5 h-3.5 mr-1" /> BOM
                                     </Button>
                                     )}
                                     {canEditProducts && (
                                     <Button
                                       size="sm"
                                       variant="outline"
                                       onClick={() => openEditSku(it)}
                                       data-testid={`sku-edit-${it.id}`}
                                       title={t("products.renameSku")}
                                       className="h-8 rounded-sm border-slate-300 text-xs px-2">
                                       <Edit3 className="w-3.5 h-3.5" />
                                     </Button>
                                     )}
                                     {canDeleteProducts && (
                                     <Button
                                       size="sm"
                                       variant="outline"
                                       onClick={() => deleteSku(it)}
                                       data-testid={`sku-delete-${it.id}`}
                                       title={t("products.deleteSku")}
                                       className="h-8 rounded-sm border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 text-xs px-2">
                                       <Trash2 className="w-3.5 h-3.5" />
                                     </Button>
                                     )}
                                   </>
                                 )}
                               </div>
                             </div>
                           );
                         })}
                       </div>
                     )}
                   </div>
                 )}
               </div>
             );
           })}
         </div>}
      </div>

      {/* Edit Product Dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{editing?.name}</DialogTitle>
            <DialogDescription>{t("products.editSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.maxPerBag")}</Label>
              <Input type="number" min="1" value={editVals.max_per_bag}
                     onChange={(e) => setEditVals((p) => ({ ...p, max_per_bag: e.target.value }))}
                     onFocus={(e) => e.target.select()}
                     data-testid="edit-max" className="h-11 rounded-sm mt-1 font-mono-num no-spinner" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.variantsCsv")}</Label>
              <Input value={editVals.variants}
                     onChange={(e) => setEditVals((p) => ({ ...p, variants: e.target.value }))}
                     data-testid="edit-variants" className="h-11 rounded-sm mt-1"
                     placeholder={t("products.variantsPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} className="rounded-sm">
              <X className="w-4 h-4 mr-1" /> {t("common.cancel")}
            </Button>
            <Button onClick={saveEdit} data-testid="edit-product-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              <Save className="w-4 h-4 mr-1" /> {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Product Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("products.addTitle")}</DialogTitle>
            <DialogDescription>{t("products.addSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.name")}</Label>
              <Input value={addVals.name}
                     onChange={(e) => setAddVals((p) => ({ ...p, name: e.target.value }))}
                     data-testid="add-product-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.maxBag")}</Label>
              <Input type="number" min="1" value={addVals.max_per_bag}
                     onChange={(e) => setAddVals((p) => ({ ...p, max_per_bag: e.target.value }))}
                     onFocus={(e) => e.target.select()}
                     data-testid="add-product-max" className="h-11 rounded-sm mt-1 font-mono-num no-spinner" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.addVariantsOptional")}</Label>
              <Input value={addVals.variants}
                     onChange={(e) => setAddVals((p) => ({ ...p, variants: e.target.value }))}
                     data-testid="add-product-variants" className="h-11 rounded-sm mt-1"
                     placeholder={t("products.addVariantsPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={saveAdd} data-testid="add-product-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add SKU Dialog (admin) */}
      <Dialog open={!!addSkuFor} onOpenChange={(o) => !o && setAddSkuFor(null)}>
        <DialogContent className="rounded-sm max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("products.addSkuTitle", { product: addSkuFor?.name })}</DialogTitle>
            <DialogDescription>{t("products.addSkuSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.skuName")}</Label>
              <Input value={addSkuVals.name}
                     onChange={(e) => setAddSkuVals((p) => ({ ...p, name: e.target.value }))}
                     data-testid="add-sku-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.addSkuMaxOptional", { def: addSkuFor?.max_per_bag })}</Label>
              <Input type="number" min="1" value={addSkuVals.max_per_bag}
                     onChange={(e) => setAddSkuVals((p) => ({ ...p, max_per_bag: e.target.value }))}
                     onFocus={(e) => e.target.select()}
                     placeholder={String(addSkuFor?.max_per_bag ?? "")}
                     data-testid="add-sku-max" className="h-11 rounded-sm mt-1 font-mono-num no-spinner" />
            </div>

            {/* Per-price-list prices — filled in the same step as creating the SKU */}
            {priceLists.length > 0 && (
              <div className="pt-2 border-t border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs font-bold uppercase text-[#E65100]">
                    Prices per price list
                  </Label>
                  <span className="text-[10px] text-slate-500 font-semibold">
                    Optional · leave blank to skip
                  </span>
                </div>
                <div className="space-y-2" data-testid="add-sku-prices">
                  {priceLists.map((pl) => (
                    <div key={pl.id} className="grid grid-cols-5 gap-2 items-center">
                      <div className="col-span-3 min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate" title={pl.name}>
                          {pl.name}
                        </div>
                        {pl.description && (
                          <div className="text-[11px] text-slate-500 truncate">{pl.description}</div>
                        )}
                      </div>
                      <div className="col-span-2 relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold pointer-events-none">₹</span>
                        <Input
                          type="number" min="0" step="0.01"
                          value={addSkuVals.prices?.[pl.id] ?? ""}
                          onChange={(e) => setAddSkuVals((p) => ({
                            ...p,
                            prices: { ...(p.prices || {}), [pl.id]: e.target.value },
                          }))}
                          onFocus={(e) => e.target.select()}
                          placeholder="0.00"
                          data-testid={`add-sku-price-${pl.id}`}
                          className="h-9 rounded-sm pl-6 font-mono-num text-right no-spinner"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddSkuFor(null)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={saveAddSku} data-testid="add-sku-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename SKU Dialog (admin) */}
      <Dialog open={!!editSku} onOpenChange={(o) => !o && setEditSku(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("products.renameSkuTitle")}</DialogTitle>
            <DialogDescription>{t("products.renameSkuSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("products.skuName")}</Label>
              <Input value={editSkuName}
                     onChange={(e) => setEditSkuName(e.target.value)}
                     data-testid="edit-sku-name" className="h-11 rounded-sm mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSku(null)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={saveEditSku} data-testid="edit-sku-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />
      <BomDialog item={bomFor} open={!!bomFor} onClose={() => { setBomFor(null); load(); }} />
    </div>
  );
}
