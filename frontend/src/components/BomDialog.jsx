import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Save, X, Beaker } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Bill-of-Materials editor for ONE SKU (individual item).
 *
 * Props:
 *   item     — { id, name, product_name }
 *   open     — show/hide
 *   onClose  — () => void
 *
 * Loads `/items/{iid}/bom` on open, displays each component (raw
 * material + qty/unit), and lets the admin add new rows from the master
 * list of raw materials. Saving PUTs the whole BOM in one request.
 */
export default function BomDialog({ item, open, onClose }) {
  const [rawMaterials, setRawMaterials] = useState([]);
  const [components, setComponents] = useState([]);
  const [picker, setPicker] = useState("");
  const [pickerQty, setPickerQty] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !item?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [bomRes, rmRes] = await Promise.all([
          api.get(`/items/${item.id}/bom`),
          api.get(`/raw-materials`),
        ]);
        if (cancelled) return;
        setComponents(bomRes.data?.components || []);
        setRawMaterials(rmRes.data || []);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Failed to load BOM");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, item?.id]);

  const availableRMs = useMemo(() => {
    const used = new Set(components.map((c) => c.raw_material_id));
    return rawMaterials.filter((rm) => !used.has(rm.id));
  }, [rawMaterials, components]);

  const addRow = () => {
    if (!picker) { toast.error("Pick a raw material"); return null; }
    const qty = parseFloat(pickerQty);
    if (!qty || qty <= 0) { toast.error("Enter qty per unit > 0"); return null; }
    const rm = rawMaterials.find((r) => r.id === picker);
    if (!rm) return null;
    const newRow = {
      raw_material_id: rm.id,
      raw_material_name: rm.name,
      unit: rm.unit,
      qty_per_unit: qty,
      stock_on_hand: Number(rm.stock_on_hand || 0),
    };
    setComponents((cs) => [...cs, newRow]);
    setPicker("");
    setPickerQty("");
    return newRow;
  };

  const updateQty = (rid, val) => {
    const n = parseFloat(val);
    setComponents((cs) =>
      cs.map((c) =>
        c.raw_material_id === rid ? { ...c, qty_per_unit: Number.isFinite(n) ? n : val } : c,
      ),
    );
  };

  const removeRow = (rid) =>
    setComponents((cs) => cs.filter((c) => c.raw_material_id !== rid));

  const save = async () => {
    // Auto-fold the pending picker row (if filled) so users can't lose data
    // by clicking Save without first clicking the "+" button. The Save BOM
    // workflow should ALWAYS persist what's visible/selected in the dialog.
    let working = components;
    if (picker && pickerQty) {
      const qty = parseFloat(pickerQty);
      const rm = rawMaterials.find((r) => r.id === picker);
      if (rm && qty > 0 && !working.some((c) => c.raw_material_id === rm.id)) {
        working = [
          ...working,
          {
            raw_material_id: rm.id,
            raw_material_name: rm.name,
            unit: rm.unit,
            qty_per_unit: qty,
            stock_on_hand: Number(rm.stock_on_hand || 0),
          },
        ];
      }
    }
    for (const c of working) {
      const q = parseFloat(c.qty_per_unit);
      if (!q || q <= 0) {
        toast.error(`Qty must be > 0 for ${c.raw_material_name}`);
        return;
      }
    }
    setSaving(true);
    try {
      await api.put(`/items/${item.id}/bom`, {
        components: working.map((c) => ({
          raw_material_id: c.raw_material_id,
          qty_per_unit: parseFloat(c.qty_per_unit),
        })),
      });
      toast.success(
        working.length === 0
          ? "BOM cleared (no raw materials linked)"
          : `BOM saved (${working.length} raw material${working.length === 1 ? "" : "s"} linked)`,
      );
      onClose?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="rounded-sm max-w-2xl" data-testid="bom-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading flex items-center gap-2">
            <Beaker className="w-5 h-5 text-[#E65100]" />
            BOM — {item?.name}
          </DialogTitle>
          <DialogDescription>
            Define how much of each raw material is consumed to manufacture{" "}
            <b>one piece</b> of this SKU
            {item?.product_name ? <> (under <i>{item.product_name}</i>)</> : null}.
            Stock is automatically deducted when this SKU is dispatched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loading ? (
            <div className="text-sm text-slate-500 py-4 text-center">Loading…</div>
          ) : (
            <>
              <div className="border border-slate-200 rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-600 font-bold">
                    <tr>
                      <th className="text-left px-3 py-2">Raw material</th>
                      <th className="text-right px-3 py-2">Qty per unit</th>
                      <th className="text-right px-3 py-2">Unit</th>
                      <th className="text-right px-3 py-2">Stock now</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {components.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-slate-400 italic" data-testid="bom-empty">
                          No raw materials linked yet.
                        </td>
                      </tr>
                    )}
                    {components.map((c) => (
                      <tr key={c.raw_material_id} className="border-t border-slate-100" data-testid={`bom-row-${c.raw_material_id}`}>
                        <td className="px-3 py-2 font-bold text-slate-900">{c.raw_material_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <Input
                            type="number" min="0" step="0.001"
                            value={c.qty_per_unit}
                            onChange={(e) => updateQty(c.raw_material_id, e.target.value)}
                            onFocus={(e) => e.target.select()}
                            data-testid={`bom-qty-${c.raw_material_id}`}
                            className="h-8 rounded-sm w-24 ml-auto tabular-nums no-spinner text-right" />
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500">{c.unit || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                          {Number(c.stock_on_hand || 0).toLocaleString("en-IN")}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => removeRow(c.raw_material_id)}
                                  data-testid={`bom-remove-${c.raw_material_id}`}
                                  className="rounded-sm h-7 text-rose-700 hover:bg-rose-50 border-rose-200">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-sm p-3">
                <Label className="text-[10px] font-bold uppercase tracking-wider text-amber-800 mb-2 block">
                  Add raw material
                </Label>
                <div className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-6">
                    <select
                      value={picker}
                      onChange={(e) => setPicker(e.target.value)}
                      data-testid="bom-rm-select"
                      className="w-full h-10 rounded-sm border border-slate-300 bg-white px-2 text-sm">
                      <option value="">— Select raw material —</option>
                      {availableRMs.map((rm) => (
                        <option key={rm.id} value={rm.id}>
                          {rm.name} ({rm.unit})
                        </option>
                      ))}
                    </select>
                    {availableRMs.length === 0 && (
                      <div className="text-[11px] text-slate-500 mt-1">
                        All raw materials already added. Create more in <b>Raw Materials</b>.
                      </div>
                    )}
                  </div>
                  <div className="col-span-3">
                    <Input
                      type="number" min="0" step="0.001"
                      placeholder="Qty per unit"
                      value={pickerQty}
                      onChange={(e) => setPickerQty(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } }}
                      data-testid="bom-new-qty"
                      className="h-10 rounded-sm tabular-nums no-spinner" />
                  </div>
                  <div className="col-span-3">
                    <Button onClick={addRow} disabled={!picker || !pickerQty}
                            data-testid="bom-add-btn"
                            className="w-full h-10 rounded-sm bg-[#E65100] hover:bg-[#CC4800] text-white font-bold disabled:opacity-40">
                      <Plus className="w-4 h-4 mr-1" /> Add to BOM
                    </Button>
                  </div>
                </div>
                {picker && pickerQty && (
                  <div className="text-[11px] text-amber-800 mt-2 font-medium flex items-start gap-1.5" data-testid="bom-pending-hint">
                    <Plus className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>Click <b>Add to BOM</b> (or press Enter) to link this row. If you click <b>Save BOM</b> directly, this pending row will be auto-added.</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm">
            <X className="w-4 h-4 mr-1" /> Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading}
                  data-testid="bom-save-btn"
                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
            <Save className="w-4 h-4 mr-1" />
            {saving ? "Saving…" : "Save BOM"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
