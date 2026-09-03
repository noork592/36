import React, { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import ItemSearchInput from "@/components/ItemSearchInput";
import { toast } from "sonner";
import { Save, X, Plus, Trash2 } from "lucide-react";

const STATUSES = ["Pending", "Dispatched", "Cleared"];

// Admin-only full-order editor. Loads products + customers up front so the
// editor can replicate NewOrder's bag-size & variant behaviour.
export default function OrderEditDialog({ open, order, onOpenChange, onSaved }) {
  const { t } = useTranslation();
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (!open) return;
    Promise.all([api.get("/products"), api.get("/customers"), api.get("/items")])
      .then(([p, c, i]) => { setProducts(p.data); setCustomers(c.data); setItems(i.data || []); })
      .catch(() => toast.error(t("common.failed")));
  }, [open, t]);

  useEffect(() => {
    if (!order) { setForm(null); return; }
    setForm({
      customer_id: order.customer_id,
      delivery_date: (order.delivery_date || "").slice(0, 10),
      notes: order.notes || "",
      status: order.status || "Pending",
      items: (order.items || []).map((it) => ({
        item_id: it.item_id,
        item_name: it.item_name,
        product_name: it.product_name,
        quantity: String(it.quantity ?? ""),
        bags: "",
        variant: it.variant || "",
        item_min_per_bag: it.item_min_per_bag ?? null,
        item_max_per_bag: it.item_max_per_bag ?? null,
      })),
    });
  }, [order]);

  const productByName = useMemo(() => {
    const m = {}; products.forEach((p) => { m[p.name] = p; }); return m;
  }, [products]);

  const itemById = useMemo(() => {
    const m = {}; items.forEach((it) => { if (it.id) m[it.id] = it; }); return m;
  }, [items]);

  if (!form) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="rounded-sm">
          <DialogHeader><DialogTitle>{t("common.loading")}</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const getBagSizeFor = (row) => {
    // 1) Prefer the SKU's CURRENT per-bag override from the items master, so
    //    the live bag→pcs calculation always matches how the admin configured
    //    the SKU (e.g. 180). This fixes older order rows that never captured
    //    the override and were wrongly falling back to the product default (200).
    const masterItem = row.item_id ? itemById[row.item_id] : null;
    if (masterItem && masterItem.max_per_bag && Number(masterItem.max_per_bag) > 0) {
      return Number(masterItem.max_per_bag);
    }
    // 2) Otherwise use the per-SKU value captured on the order row (if any).
    if (row.item_max_per_bag && Number(row.item_max_per_bag) > 0) return Number(row.item_max_per_bag);
    // 3) Finally fall back to the product-level default.
    const prod = productByName[row.product_name];
    return prod?.max_per_bag ? Number(prod.max_per_bag) : null;
  };

  const updateRow = (idx, key, val) => {
    setForm((prev) => {
      const items = prev.items.map((it, i) => {
        if (i !== idx) return it;
        const next = { ...it, [key]: val };
        if (key === "bags") {
          const bagSize = getBagSizeFor(next);
          const bagsNum = Number(val);
          if (val !== "" && !isNaN(bagsNum) && bagsNum > 0 && bagSize) {
            next.quantity = String(bagsNum * bagSize);
          }
        }
        if (key === "quantity") next.bags = "";
        return next;
      });
      return { ...prev, items };
    });
  };

  const setRowItem = (idx, picked) => {
    setForm((prev) => {
      const items = prev.items.map((it, i) => {
        if (i !== idx) return it;
        if (!picked) {
          return { ...it, item_id: "", item_name: "", product_name: "", variant: "", item_min_per_bag: null, item_max_per_bag: null };
        }
        const next = {
          ...it,
          item_id: picked.item_id,
          item_name: picked.item_name,
          product_name: picked.product_name,
          item_min_per_bag: picked.min_per_bag ?? null,
          item_max_per_bag: picked.max_per_bag ?? null,
        };
        if (next.bags && Number(next.bags) > 0) {
          const bagSize = (next.item_max_per_bag && Number(next.item_max_per_bag) > 0)
            ? Number(next.item_max_per_bag)
            : (productByName[next.product_name]?.max_per_bag || null);
          if (bagSize) next.quantity = String(Number(next.bags) * bagSize);
        }
        return next;
      });
      return { ...prev, items };
    });
  };

  const addRow = () => setForm((p) => ({
    ...p,
    items: [...p.items, { item_id: "", item_name: "", product_name: "", quantity: "", bags: "", variant: "", item_min_per_bag: null, item_max_per_bag: null }],
  }));

  const removeRow = (idx) => setForm((p) => ({
    ...p,
    items: p.items.filter((_, i) => i !== idx),
  }));

  const submit = async () => {
    if (form.items.length === 0) { toast.error(t("orderEdit.errors.noItems")); return; }
    for (const it of form.items) {
      if (!it.item_id) { toast.error(t("orderEdit.errors.pickItem")); return; }
      const qty = Number(it.quantity);
      if (!qty || qty <= 0) { toast.error(t("orderEdit.errors.invalidQty")); return; }
    }
    const body = {
      customer_id: form.customer_id,
      delivery_date: form.delivery_date || null,
      notes: form.notes,
      status: form.status,
      items: form.items.map((it) => ({
        item_id: it.item_id,
        item_name: it.item_name,
        product_name: it.product_name,
        quantity: Number(it.quantity),
        variant: it.variant || null,
      })),
    };
    try {
      await api.patch(`/orders/${order.id}`, body);
      toast.success(t("orderEdit.saved"));
      onOpenChange(false);
      onSaved?.(order.id);
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-sm max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-heading">{t("orderEdit.title", { id: order?.id?.slice(0, 8) })}</DialogTitle>
          <DialogDescription>{t("orderEdit.sub")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Customer + Status + Delivery */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.customer")}</Label>
              <Select value={form.customer_id}
                      onValueChange={(v) => setForm((p) => ({ ...p, customer_id: v }))}>
                <SelectTrigger className="h-11 rounded-sm mt-1" data-testid="edit-order-customer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => {
                    const loc = [c.city, c.location, c.address].map((x) => (x || "").trim()).find(Boolean) || "";
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{loc ? ` · ${loc}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.status")}</Label>
              <Select value={form.status}
                      onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger className="h-11 rounded-sm mt-1" data-testid="edit-order-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`orders.status.${s}`, s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("orderEdit.deliveryDate")}</Label>
              <Input type="date" value={form.delivery_date}
                     onChange={(e) => setForm((p) => ({ ...p, delivery_date: e.target.value }))}
                     data-testid="edit-order-delivery"
                     className="h-11 rounded-sm mt-1 no-spinner" />
            </div>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-bold uppercase">{t("orderEdit.items")}</Label>
              <Button size="sm" onClick={addRow} variant="outline" data-testid="edit-order-add-row"
                      className="rounded-sm border-slate-300 h-8 text-xs">
                <Plus className="w-3 h-3 mr-1" /> {t("orderEdit.addRow")}
              </Button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, idx) => {
                const prod = productByName[it.product_name];
                const variants = prod?.variants || [];
                const bagSize = getBagSizeFor(it);
                return (
                  <div key={idx} className="border border-slate-200 rounded-sm p-2 bg-slate-50/40"
                       data-testid={`edit-order-row-${idx}`}>
                    <div className="grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-12 sm:col-span-5">
                        <ItemSearchInput
                          testIdPrefix={`edit-order-search-${idx}`}
                          value={it.item_id ? { item_id: it.item_id, item_name: it.item_name } : null}
                          onChange={(picked) => setRowItem(idx, picked)}
                          previouslyOrdered={[]}
                          customerId={form?.customer_id || null}
                        />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Input type="number" min="1" placeholder={t("common.bags")}
                               value={it.bags}
                               onChange={(e) => updateRow(idx, "bags", e.target.value)}
                               onFocus={(e) => e.target.select()}
                               data-testid={`edit-order-bags-${idx}`}
                               className="h-11 rounded-sm font-mono-num no-spinner" />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Input type="number" min="1" placeholder={t("common.qty")}
                               value={it.quantity}
                               onChange={(e) => updateRow(idx, "quantity", e.target.value)}
                               onFocus={(e) => e.target.select()}
                               data-testid={`edit-order-qty-${idx}`}
                               className="h-11 rounded-sm font-mono-num no-spinner" />
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        {variants.length > 0 ? (
                          <Select value={it.variant || ""} onValueChange={(v) => updateRow(idx, "variant", v)}>
                            <SelectTrigger className="h-11 rounded-sm">
                              <SelectValue placeholder={t("common.variant")} />
                            </SelectTrigger>
                            <SelectContent>
                              {variants.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="h-11 grid place-items-center text-xs text-slate-300 border border-dashed border-slate-200 rounded-sm">—</div>
                        )}
                      </div>
                      <div className="col-span-1">
                        <Button size="sm" variant="ghost" onClick={() => removeRow(idx)}
                                data-testid={`edit-order-remove-${idx}`}
                                className="h-11 w-full text-slate-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {bagSize && it.bags && Number(it.bags) > 0 && (
                      <div className="mt-1.5 text-[11px] text-orange-700 font-semibold">
                        {t("newOrder.bagsCalc", { bags: it.bags, size: bagSize, total: Number(it.bags) * bagSize })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <Label className="text-xs font-bold uppercase">{t("common.notes")}</Label>
            <Textarea value={form.notes} rows={2}
                      onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                      data-testid="edit-order-notes"
                      className="rounded-sm mt-1" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-sm">
            <X className="w-4 h-4 mr-1" /> {t("common.cancel")}
          </Button>
          <Button onClick={submit} data-testid="edit-order-save"
                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
            <Save className="w-4 h-4 mr-1" /> {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
