import React, { useEffect, useMemo, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Mic, Square, Trash2, Plus, UserPlus, Save, RotateCcw, Info, AlertTriangle, MapPin, Building2, Home, CalendarDays, StickyNote } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import ItemSearchInput from "@/components/ItemSearchInput";
import DatePicker from "@/components/DatePicker";

function todayISO() {
  // IST (UTC+5:30) — keeps the picker on the factory's calendar day even
  // when the browser is past midnight UTC but still on the previous IST day.
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const EMPTY_ROW = { item_id: "", item_name: "", product_name: "", quantity: "", bags: "", variant: "", item_min_per_bag: null, item_max_per_bag: null };

export default function NewOrder() {
  const { isAdmin } = useAuth();
  const { t } = useTranslation();
  const nav = useNavigate();
  const [products, setProducts] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showSuggest, setShowSuggest] = useState(false);
  const [items, setItems] = useState([{ ...EMPTY_ROW }]);
  const [orderDate, setOrderDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // For new customer dialog
  const [showNewCust, setShowNewCust] = useState(false);
  const [newCust, setNewCust] = useState({ name: "", phone: "", address: "" });

  // For existing pending orders detection
  const [pendingForCustomer, setPendingForCustomer] = useState([]);
  const [pendingChoice, setPendingChoice] = useState("none"); // none | merge | clear
  const [pendingDialogOpen, setPendingDialogOpen] = useState(false);

  // Voice
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);

  useEffect(() => {
    api.get("/products").then((r) => setProducts(r.data));
    api.get("/customers").then((r) => setAllCustomers(r.data));
  }, []);

  // ── Voice agent prefill: ?customer_id=&items=[...] ──
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (allCustomers.length === 0) return;
    const cid = searchParams.get("customer_id");
    const itemsJson = searchParams.get("items");
    let touched = false;
    if (cid) {
      const c = allCustomers.find((x) => x.id === cid);
      if (c && !selectedCustomer) {
        setSelectedCustomer(c);
        setCustomerQuery(c.name);
        setShowSuggest(false);
        touched = true;
      }
    }
    if (itemsJson) {
      try {
        const arr = JSON.parse(itemsJson);
        if (Array.isArray(arr) && arr.length > 0) {
          const rows = arr
            .filter((it) => it && it.item_id)
            .map((it) => ({
              item_id: it.item_id,
              item_name: it.item_name || "",
              product_name: it.product_name || "",
              quantity: String(it.quantity || ""),
              bags: "",
              variant: "",
              item_min_per_bag: null,
              item_max_per_bag: null,
            }));
          if (rows.length) {
            setItems(rows);
            touched = true;
          }
        }
      } catch (_e) {
        // ignore malformed prefill
      }
    }
    if (touched) {
      toast.success("Voice prefill applied — review and save.");
      // Clear the prefill query string so refresh doesn't re-apply
      const next = new URLSearchParams(searchParams);
      next.delete("customer_id");
      next.delete("items");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCustomers]);

  // Search customers
  useEffect(() => {
    if (selectedCustomer) return;
    if (!customerQuery.trim()) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      api.get("/customers/search", { params: { q: customerQuery } })
         .then((r) => { setSuggestions(r.data); setShowSuggest(true); });
    }, 200);
    return () => clearTimeout(t);
  }, [customerQuery, selectedCustomer]);

  // When customer changes, get pending orders + recent history (for previously-ordered hints)
  const [customerOrderHistory, setCustomerOrderHistory] = useState([]);
  useEffect(() => {
    if (!selectedCustomer) {
      setPendingForCustomer([]);
      setCustomerOrderHistory([]);
      setPendingChoice("none");
      setPendingDialogOpen(false);
      return;
    }
    api.get("/orders", { params: { status_filter: "Pending" } }).then((r) => {
      const list = r.data.filter((o) => o.customer_id === selectedCustomer.id);
      setPendingForCustomer(list);
      // Auto-open the choice dialog when the picked party already has
      // pending orders so the operator deliberately picks merge / clear /
      // keep-separate before keying in the new order's items.
      if (list.length > 0) {
        setPendingChoice("none");
        setPendingDialogOpen(true);
      }
    });
    api.get("/orders").then((r) => {
      setCustomerOrderHistory(r.data.filter((o) => o.customer_id === selectedCustomer.id));
    });
  }, [selectedCustomer]);

  // Build per-product list of previously-ordered items (unique, most-recent first)
  const previouslyByProduct = useMemo(() => {
    const out = {};
    customerOrderHistory.forEach((o) => {
      (o.items || []).forEach((it) => {
        if (!it.item_id || !it.item_name) return;
        const key = it.product_name;
        if (!out[key]) out[key] = [];
        if (!out[key].find((x) => x.item_id === it.item_id)) {
          out[key].push({ id: it.item_id, name: it.item_name, product_name: it.product_name });
        }
      });
    });
    return out;
  }, [customerOrderHistory]);

  // Flat list across all products for the search dropdown's empty-state hint
  const previouslyAll = useMemo(() => {
    const seen = new Set(); const out = [];
    customerOrderHistory.forEach((o) => {
      (o.items || []).forEach((it) => {
        if (!it.item_id || !it.item_name) return;
        if (seen.has(it.item_id)) return;
        seen.add(it.item_id);
        out.push({ id: it.item_id, name: it.item_name, product_name: it.product_name });
      });
    });
    return out;
  }, [customerOrderHistory]);

  const productByName = useMemo(() => {
    const m = {}; products.forEach((p) => { m[p.name] = p; }); return m;
  }, [products]);

  const pickCustomer = (c) => {
    setSelectedCustomer(c);
    setCustomerQuery(c.name);
    setShowSuggest(false);
  };

  const clearCustomer = () => {
    setSelectedCustomer(null);
    setCustomerQuery("");
    setSuggestions([]);
    setPendingForCustomer([]);
    setPendingChoice("none");
  };

  const updateItem = (idx, key, val) => {
    setItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const next = { ...it, [key]: val };
      // If product changed, prefill variant from customer preference
      if (key === "product_name" && selectedCustomer) {
        const prod = productByName[val];
        const prefs = selectedCustomer.preferences || {};
        if (prod?.variant_field === "side_stand_type" && prefs.side_stand_type) {
          next.variant = prefs.side_stand_type;
        } else if (prod?.variant_field === "seat_kunda_type" && prefs.seat_kunda_type) {
          next.variant = prefs.seat_kunda_type;
        } else if (prod?.variant_field === "center_stand_kit") {
          next.variant = "";
        } else {
          next.variant = "";
        }
      }
      // Bags → auto-compute quantity using bag size (item override > product default)
      if (key === "bags") {
        const bagSize = getBagSizeFor(next);
        const bagsNum = Number(val);
        if (val !== "" && !isNaN(bagsNum) && bagsNum > 0 && bagSize) {
          next.quantity = String(bagsNum * bagSize);
        }
      }
      // Manual qty edit clears the bags field to avoid stale inconsistency
      if (key === "quantity") {
        next.bags = "";
      }
      return next;
    }));
  };

  // Resolve bag size (pieces per full bag) for a row.
  // Prefers item-level override; falls back to master product's max_per_bag.
  const getBagSizeFor = (row) => {
    if (row.item_max_per_bag && Number(row.item_max_per_bag) > 0) {
      return Number(row.item_max_per_bag);
    }
    const prod = productByName[row.product_name];
    if (prod?.max_per_bag) return Number(prod.max_per_bag);
    return null;
  };

  // Set item SKU on a row from the search picker (or clear it)
  const setRowItem = (idx, picked) => {
    setItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      if (!picked) {
        return { ...it, item_id: "", item_name: "", product_name: "", variant: "", item_min_per_bag: null, item_max_per_bag: null };
      }
      const prod = productByName[picked.product_name];
      let variant = "";
      const prefs = selectedCustomer?.preferences || {};
      if (prod?.variant_field === "side_stand_type") variant = prefs.side_stand_type || "";
      else if (prod?.variant_field === "seat_kunda_type") variant = prefs.seat_kunda_type || "";
      const next = {
        ...it,
        item_id: picked.item_id,
        item_name: picked.item_name,
        product_name: picked.product_name,
        variant,
        item_min_per_bag: picked.min_per_bag ?? null,
        item_max_per_bag: picked.max_per_bag ?? null,
      };
      // If bags were set, recompute quantity now that bag size is known
      if (next.bags && Number(next.bags) > 0) {
        const bagSize = (next.item_max_per_bag && Number(next.item_max_per_bag) > 0)
          ? Number(next.item_max_per_bag)
          : (prod?.max_per_bag ? Number(prod.max_per_bag) : null);
        if (bagSize) next.quantity = String(Number(next.bags) * bagSize);
      }
      return next;
    }));
  };

  const addItem = () => setItems((p) => [...p, { ...EMPTY_ROW }]);
  const removeItem = (idx) => setItems((p) => p.filter((_, i) => i !== idx));

  const createCustomer = async () => {
    if (!newCust.name.trim()) { toast.error(t("newOrder.errors.nameRequired")); return; }
    try {
      const { data } = await api.post("/customers", newCust);
      toast.success(t("newOrder.success.customerCreated"));
      setAllCustomers((p) => [...p, data]);
      pickCustomer(data);
      setShowNewCust(false);
      setNewCust({ name: "", phone: "", address: "" });
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("common.failed"));
    }
  };

  const submit = async () => {
    if (!selectedCustomer) { toast.error(t("newOrder.errors.selectCustomer")); return; }
    const validRows = items.filter((it) => it.product_name && Number(it.quantity) > 0);
    const missingItemRow = validRows.find((it) => !it.item_id);
    if (missingItemRow) {
      toast.error(t("newOrder.errors.pickItem"));
      return;
    }
    const cleanItems = validRows.map((it) => ({
      product_name: it.product_name,
      item_id: it.item_id,
      item_name: it.item_name,
      quantity: Number(it.quantity),
      variant: it.variant || null,
    }));
    if (cleanItems.length === 0) { toast.error(t("newOrder.errors.addAtLeastOne")); return; }

    setBusy(true);
    try {
      await api.post("/orders", {
        customer_id: selectedCustomer.id,
        items: cleanItems,
        order_date: orderDate ? new Date(orderDate).toISOString() : null,
        delivery_date: null,
        notes,
        merge_with_pending: pendingChoice === "merge",
        clear_previous_pending: pendingChoice === "clear",
      });
      toast.success(pendingChoice === "merge" ? t("newOrder.success.merged") : t("newOrder.success.created"));
      nav("/orders");
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("newOrder.errors.saveFailed"));
    } finally { setBusy(false); }
  };

  // ============ Voice Recording ============
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        await sendAudio(blob);
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch (e) {
      toast.error(t("newOrder.errors.micDenied"));
    }
  };

  const stopRec = () => {
    if (mediaRef.current && mediaRef.current.state !== "inactive") {
      mediaRef.current.stop();
    }
    setRecording(false);
  };

  const sendAudio = async (blob) => {
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice.webm");
      const { data } = await api.post("/voice/transcribe", fd, { headers: { "Content-Type": "multipart/form-data" } });
      setTranscript(data.text || "");

      // ── Customer auto-pick from voice (fuzzy match) ──
      // Only auto-fill when no customer has been picked yet, to respect a
      // deliberate manual choice. Threshold matches backend (>= 70 = confident).
      const pc = data.parsed_customer;
      if (pc && pc.id && !selectedCustomer) {
        const found = allCustomers.find((c) => c.id === pc.id);
        if (found) {
          setSelectedCustomer(found);
          setCustomerQuery(found.name);
          setShowSuggest(false);
          toast.success(t("newOrder.success.voiceCustomerMatched", { name: found.name, score: pc.score }));
        }
      } else if (pc && pc.id && selectedCustomer && pc.id !== selectedCustomer.id) {
        // Heads-up — voice mentioned a *different* party than the one picked.
        toast.message(t("newOrder.success.voiceCustomerMismatch", { name: pc.name }));
      }

      const parsed = (data.parsed_items || []).filter((x) => x.product_name);
      if (parsed.length === 0) {
        toast.warning(t("newOrder.errors.noItemsParsed"));
      } else {
        let needsItemPick = 0;
        // Replace empty first row, then append
        setItems((prev) => {
          const list = prev.filter((it) => it.product_name);
          parsed.forEach((p) => {
            const prod = productByName[p.product_name];
            let variant = "";
            if (selectedCustomer) {
              const prefs = selectedCustomer.preferences || {};
              if (prod?.variant_field === "side_stand_type") variant = prefs.side_stand_type || "";
              if (prod?.variant_field === "seat_kunda_type") variant = prefs.seat_kunda_type || "";
            }
            if (!p.item_id) needsItemPick += 1;
            list.push({
              product_name: p.product_name,
              item_id: p.item_id || "",
              item_name: p.item_name || "",
              quantity: String(p.quantity || ""),
              variant,
            });
          });
          return list.length ? list : [{ ...EMPTY_ROW }];
        });
        if (needsItemPick > 0) {
          toast.warning(t("newOrder.success.voicePartial", { count: parsed.length, needs: needsItemPick }));
        } else {
          toast.success(t("newOrder.success.voiceAdded", { count: parsed.length }));
        }
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("newOrder.errors.transcribeFailed"));
    } finally {
      setTranscribing(false);
    }
  };

  // Highlights existing customer preferences
  const prefsView = selectedCustomer ? Object.entries(selectedCustomer.preferences || {}) : [];

  return (
    <div className="space-y-5" data-testid="new-order-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("newOrder.overline")}</div>
        <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("newOrder.title")}</h1>
      </div>

      {/* Order date + Notes — sits ABOVE the customer selection panel.
          Notes is placed in front of the date so quick scribbles can be
          captured before the party is even chosen (e.g. phone-in orders). */}
      <div className="bg-white border border-slate-200 rounded-sm p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-12 gap-4 items-start" data-testid="new-order-top-row">
        <div className="sm:col-span-4">
          <Label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-[#E65100]" />
            {t("newOrder.orderDate")}
          </Label>
          <div className="mt-1.5">
            <DatePicker
              value={orderDate}
              onChange={setOrderDate}
              testId="order-date"
              buttonClassName="h-11 text-sm"
            />
          </div>
        </div>
        <div className="sm:col-span-8">
          <Label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <StickyNote className="w-3.5 h-3.5 text-[#E65100]" />
            {t("common.notes")}
          </Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="order-notes"
            rows={2}
            className="rounded-sm mt-1.5"
            placeholder={t("newOrder.notesPlaceholder")}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Customer block */}
        <div className="lg:col-span-12 bg-white border border-slate-200 rounded-sm p-5 space-y-4">
          <div>
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">{t("newOrder.customerLabel")}</Label>
            <div className="relative mt-1.5">
              <Input
                data-testid="customer-search"
                placeholder={t("newOrder.customerPlaceholder")}
                value={customerQuery}
                onChange={(e) => { setCustomerQuery(e.target.value); setSelectedCustomer(null); }}
                onFocus={() => setShowSuggest(true)}
                className="h-11 rounded-sm pr-24"
              />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                {selectedCustomer && (
                  <Button size="sm" variant="ghost" onClick={clearCustomer} data-testid="customer-clear"
                          className="h-9 px-2 text-xs">{t("newOrder.change")}</Button>
                )}
                {isAdmin && (
                  <Button size="sm" type="button" onClick={() => setShowNewCust(true)} data-testid="add-customer-btn"
                          className="h-9 bg-slate-900 text-white hover:bg-black rounded-sm">
                    <UserPlus className="w-3.5 h-3.5 mr-1" /> {t("common.new")}
                  </Button>
                )}
              </div>
              {showSuggest && customerQuery && !selectedCustomer && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-72 overflow-auto">
                  {suggestions.length === 0 && (
                    <div className="p-3 text-sm text-slate-500">
                      {isAdmin ? t("newOrder.noMatchAdmin") : t("newOrder.noMatchUser")}
                    </div>
                  )}
                  {suggestions.map((c) => (
                    <button key={c.id} type="button" onClick={() => pickCustomer(c)}
                            data-testid={`customer-suggest-${c.id}`}
                            className="w-full text-left px-3 py-2.5 hover:bg-orange-50 border-b border-slate-100 last:border-0">
                      <div className="font-bold text-slate-900 text-sm leading-tight">{c.name}</div>
                      <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5 flex-wrap">
                        {c.phone && <span>{c.phone}</span>}
                        <span className="font-mono-num">{t("common.match")} {c.match_score}%</span>
                      </div>
                      {(c.city || c.location || c.address) && (
                        <div className="mt-1 text-[11px] text-slate-600 leading-snug">
                          {(c.city || c.location) && (
                            <span className="font-semibold text-slate-700">
                              {[c.city, c.location].filter(Boolean).join(", ")}
                            </span>
                          )}
                          {(c.city || c.location) && c.address && <span className="mx-1 text-slate-300">·</span>}
                          {c.address && <span className="text-slate-500">{c.address}</span>}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedCustomer && (
              <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded-sm" data-testid="selected-customer-card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-slate-900">{selectedCustomer.name}</div>
                    <div className="text-xs text-slate-600">{selectedCustomer.phone}</div>
                  </div>
                  {prefsView.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 justify-end">
                      {prefsView.map(([k, v]) => (
                        <span key={k} className="text-[10px] uppercase tracking-wider font-bold bg-white border border-orange-300 text-orange-900 px-2 py-1 rounded-sm">
                          {t(`customers.pref.${k}`, k.replace(/_/g, " "))}: {v}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {(selectedCustomer.city || selectedCustomer.location || selectedCustomer.address) && (
                  <div className="mt-2 pt-2 border-t border-orange-200 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
                    {selectedCustomer.city && (
                      <span className="flex items-center gap-1.5" data-testid="selected-customer-city">
                        <Building2 className="w-3 h-3 text-orange-700" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">City:</span>
                        <span className="font-bold">{selectedCustomer.city}</span>
                      </span>
                    )}
                    {selectedCustomer.location && (
                      <span className="flex items-center gap-1.5" data-testid="selected-customer-location">
                        <MapPin className="w-3 h-3 text-orange-700" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Location:</span>
                        <span className="font-bold">{selectedCustomer.location}</span>
                      </span>
                    )}
                    {selectedCustomer.address && (
                      <span className="flex items-start gap-1.5 w-full" data-testid="selected-customer-address">
                        <Home className="w-3 h-3 text-orange-700 mt-0.5 shrink-0" />
                        <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px] shrink-0">Address:</span>
                        <span className="font-bold break-words">{selectedCustomer.address}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Voice block */}
          <div className="border border-dashed border-slate-300 rounded-sm p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.1em] font-bold text-slate-600">{t("newOrder.voiceOverline")}</div>
                <div className="text-sm text-slate-500 mt-0.5">
                  {recording ? t("newOrder.voiceRecording") :
                   transcribing ? t("newOrder.voiceTranscribing") :
                   t("newOrder.voiceIdle")}
                </div>
              </div>
              <button
                type="button"
                onClick={recording ? stopRec : startRec}
                disabled={transcribing}
                data-testid="voice-record-btn"
                className={`w-14 h-14 rounded-full grid place-items-center transition active:scale-95 ${
                  recording ? "bg-red-600 text-white pulse-ring" : "bg-[#E65100] text-white hover:bg-[#CC4800]"
                }`}
              >
                {recording ? <Square className="w-5 h-5" /> : <Mic className="w-6 h-6" />}
              </button>
            </div>
            {transcript && (
              <div className="mt-3 p-2 bg-slate-50 border border-slate-200 rounded-sm text-xs text-slate-700">
                <span className="font-bold">{t("newOrder.heard")}</span> &ldquo;{transcript}&rdquo;
              </div>
            )}
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">{t("newOrder.items")}</Label>
              <Button size="sm" type="button" variant="outline" onClick={addItem} data-testid="add-item-btn"
                      className="h-8 rounded-sm border-slate-300">
                <Plus className="w-3.5 h-3.5 mr-1" /> {t("newOrder.addRow")}
              </Button>
            </div>
            <div className="space-y-2">
              {items.map((it, idx) => {
                const prod = productByName[it.product_name];
                const variants = prod?.variants || [];
                const prevForProduct = it.product_name ? (previouslyByProduct[it.product_name] || []) : previouslyAll;
                const needsPick = it.product_name && !it.item_id;
                const bagSize = getBagSizeFor(it);
                const usingItemOverride = !!(it.item_max_per_bag && Number(it.item_max_per_bag) > 0);
                return (
                  <div key={idx} className="border border-slate-200 rounded-sm p-2 bg-slate-50/40" data-testid={`item-row-${idx}`}>
                    <div className="grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-12 sm:col-span-5">
                        <ItemSearchInput
                          testIdPrefix={`item-search-${idx}`}
                          value={it.item_id ? {
                            item_id: it.item_id,
                            item_name: it.item_name,
                            product_name: it.product_name,
                            min_per_bag: it.item_min_per_bag,
                            max_per_bag: it.item_max_per_bag,
                          } : null}
                          onChange={(picked) => setRowItem(idx, picked)}
                          previouslyOrdered={prevForProduct}
                          customerId={selectedCustomer?.id || null}
                        />
                      </div>
                      <div className="col-span-8 sm:col-span-4">
                        <div className="flex items-stretch gap-1.5">
                          <Input
                            type="number"
                            min="1"
                            placeholder={t("common.qty")}
                            value={it.quantity}
                            onChange={(e) => updateItem(idx, "quantity", e.target.value)}
                            onFocus={(e) => e.target.select()}
                            disabled={!!(it.bags && Number(it.bags) > 0)}
                            data-testid={`item-qty-${idx}`}
                            title={it.bags && Number(it.bags) > 0 ? t("newOrder.qtyLockedByBags") : ""}
                            className="h-11 rounded-sm font-mono-num no-spinner text-center flex-1 disabled:bg-slate-50 disabled:text-slate-700 disabled:font-bold disabled:cursor-not-allowed"
                          />
                          <span className="self-center text-[10px] uppercase font-extrabold tracking-[0.1em] text-slate-400 px-0.5 select-none"
                                data-testid={`qty-or-bags-${idx}`}>
                            {t("common.or")}
                          </span>
                          <Input
                            type="number"
                            min="1"
                            placeholder={t("common.bags")}
                            value={it.bags}
                            onChange={(e) => updateItem(idx, "bags", e.target.value)}
                            onFocus={(e) => e.target.select()}
                            data-testid={`item-bags-${idx}`}
                            title={bagSize ? t("newOrder.bagsHint", { size: bagSize }) : t("newOrder.bagsHintNoItem")}
                            className="h-11 rounded-sm font-mono-num no-spinner text-center flex-1"
                          />
                        </div>
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        {variants.length > 0 ? (
                          <Select value={it.variant || ""} onValueChange={(v) => updateItem(idx, "variant", v)}>
                            <SelectTrigger className="h-11 rounded-sm" data-testid={`item-variant-${idx}`}>
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
                        <Button size="sm" variant="ghost" onClick={() => removeItem(idx)}
                                data-testid={`item-remove-${idx}`}
                                className="h-11 w-full text-slate-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {it.product_name && (
                      <div className="mt-1.5 flex items-center justify-between text-[11px] flex-wrap gap-1">
                        <span className="text-slate-500">
                          {t("newOrder.masterProduct")} <span className="font-semibold text-slate-700">{it.product_name}</span>
                          {prod && (
                            <span className="text-slate-400 ml-2">
                              {t("newOrder.perBagFixed", { qty: prod.max_per_bag })}
                            </span>
                          )}
                          {bagSize && it.bags && Number(it.bags) > 0 && (
                            <span className="ml-2 text-orange-700 font-semibold" data-testid={`item-bag-calc-${idx}`}>
                              {t("newOrder.bagsCalc", { bags: it.bags, size: bagSize, total: Number(it.bags) * bagSize })}
                              {usingItemOverride && <span className="ml-1 text-[10px] uppercase tracking-wider text-orange-500">({t("newOrder.skuBag")})</span>}
                            </span>
                          )}
                        </span>
                        {needsPick && (
                          <span className="flex items-center gap-1 text-amber-700 font-semibold" data-testid={`item-needs-pick-${idx}`}>
                            <AlertTriangle className="w-3 h-3" /> {t("newOrder.pickSpecific")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="lg:col-span-12 space-y-4">
          {pendingForCustomer.length > 0 && (
            <button
              type="button"
              onClick={() => setPendingDialogOpen(true)}
              data-testid="pending-prompt"
              className="w-full text-left bg-amber-50 border border-amber-200 rounded-sm p-3 hover:bg-amber-100/70 transition"
            >
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-amber-700 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-amber-900 text-sm">
                    {t("newOrder.pendingPrompt", { name: selectedCustomer.name, count: pendingForCustomer.length })}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">
                    {pendingChoice === "merge"
                      ? t("newOrder.choiceMerge")
                      : pendingChoice === "clear"
                      ? t("newOrder.choiceClear")
                      : t("newOrder.choiceNone")}
                    {" · "}
                    <span className="underline">{t("newOrder.changeChoice", "change")}</span>
                  </div>
                </div>
              </div>
            </button>
          )}

          <Dialog open={pendingDialogOpen} onOpenChange={setPendingDialogOpen}>
            <DialogContent data-testid="pending-choice-dialog" className="max-w-md">
              <DialogHeader>
                <DialogTitle className="font-heading flex items-start gap-2 text-amber-900">
                  <Info className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
                  <span>
                    {selectedCustomer
                      ? t("newOrder.pendingPrompt", { name: selectedCustomer.name, count: pendingForCustomer.length })
                      : ""}
                  </span>
                </DialogTitle>
                <DialogDescription className="text-xs pl-7">{t("newOrder.pendingAsk")}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-1 gap-2 pt-1">
                {[
                  { v: "none", label: t("newOrder.choiceNone") },
                  { v: "merge", label: t("newOrder.choiceMerge") },
                  { v: "clear", label: t("newOrder.choiceClear") },
                ].map((opt) => (
                  <label
                    key={opt.v}
                    className={`flex items-center gap-2 p-3 border rounded-sm cursor-pointer text-sm ${
                      pendingChoice === opt.v
                        ? "bg-amber-50 border-amber-500 ring-1 ring-amber-500"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="pendchoice"
                      value={opt.v}
                      checked={pendingChoice === opt.v}
                      onChange={() => setPendingChoice(opt.v)}
                      data-testid={`pending-choice-${opt.v}`}
                    />
                    <span className="text-slate-800">{opt.label}</span>
                  </label>
                ))}
              </div>
              <DialogFooter>
                <Button
                  onClick={() => setPendingDialogOpen(false)}
                  data-testid="pending-choice-continue"
                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm font-bold"
                >
                  {t("newOrder.continue", "Continue")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Reset / Save Order — sits BELOW the customer (party) panel so
          submission lives at the bottom of the form, full width. */}
      <div className="flex gap-2 sticky bottom-0 bg-[#F8FAFC]/95 backdrop-blur-sm py-2 -mx-1 px-1 z-10 lg:static lg:bg-transparent lg:backdrop-blur-none lg:py-0 lg:mx-0 lg:px-0 border-t border-slate-200 lg:border-0">
        <Button onClick={() => { clearCustomer(); setItems([{ ...EMPTY_ROW }]); }}
                variant="outline" className="h-12 rounded-sm flex-1" data-testid="reset-form">
          <RotateCcw className="w-4 h-4 mr-2" /> {t("common.reset")}
        </Button>
        <Button onClick={submit} disabled={busy} data-testid="submit-order"
                className="h-12 rounded-sm flex-[2] bg-[#E65100] hover:bg-[#CC4800] text-white font-bold active:scale-[0.98] shadow-sm">
          <Save className="w-4 h-4 mr-2" /> {busy ? t("common.saving") : t("newOrder.saveOrder")}
        </Button>
      </div>

      {/* New Customer Dialog */}
      <Dialog open={showNewCust} onOpenChange={setShowNewCust}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("newOrder.addNewCustomer")}</DialogTitle>
            <DialogDescription>{t("newOrder.newCustomerSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase tracking-wider">{t("common.name")}</Label>
              <Input value={newCust.name} onChange={(e) => setNewCust((p) => ({ ...p, name: e.target.value }))}
                     data-testid="new-cust-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase tracking-wider">{t("common.phone")}</Label>
              <Input value={newCust.phone} onChange={(e) => setNewCust((p) => ({ ...p, phone: e.target.value }))}
                     data-testid="new-cust-phone" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase tracking-wider">{t("common.address")}</Label>
              <Textarea value={newCust.address} onChange={(e) => setNewCust((p) => ({ ...p, address: e.target.value }))}
                        data-testid="new-cust-address" className="rounded-sm mt-1" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewCust(false)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={createCustomer} data-testid="new-cust-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("newOrder.saveCustomer")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
