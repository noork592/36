import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Mic, Square, Loader2, Send, Bot, X, MicOff, MessageSquare, Globe, CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Floating, always-on voice command agent. Captures audio via the browser
 * MediaRecorder, ships it to `/api/voice/agent`, and dispatches the
 * resulting intent into the React Router.
 *
 * Supports English + Hindi + Hinglish (handled by whisper-1 + LLM
 * classifier on the backend).
 */
const INTENT_TO_ROUTE = {
  dashboard: "/",
  orders: "/orders",
  new_order: "/orders/new",
  dispatch: "/dispatch",
  dispatch_ledger: "/dispatch-ledger",
  customers: "/customers",
  products: "/products",
  raw_materials: "/admin/raw-materials",
  vendor_ledger: "/admin/suppliers",
  vendor_price_lists: "/admin/vendor-price-lists",
  price_lists: "/admin/price-lists",
  daily_report: "/reports/daily",
  admin_users: "/admin/users",
  admin_settings: "/admin/settings",
  login_attestations: "/admin/login-attestations",
  purchase_center: "/purchase-center",
  suppliers: "/admin/vendors",
};

function speak(text, langHint) {
  try {
    if (!text || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    // Heuristic: if Devanagari is present, switch to hi-IN
    if (/[\u0900-\u097F]/.test(text) || langHint === "hi") {
      u.lang = "hi-IN";
    } else {
      u.lang = "en-IN";
    }
    u.rate = 1.0;
    u.volume = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (_e) {
    // Speech synthesis unsupported; silently ignore
  }
}

export default function VoiceAgent() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [lastIntent, setLastIntent] = useState(null);
  const [textCmd, setTextCmd] = useState("");
  const [supported, setSupported] = useState(true);
  const [history, setHistory] = useState([]); // { transcript, reply, intent }
  const [pendingMutation, setPendingMutation] = useState(null);
  const [executingMutation, setExecutingMutation] = useState(false);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setSupported(false);
    }
  }, []);

  const closeAll = () => {
    try {
      if (mediaRef.current && mediaRef.current.state !== "inactive") mediaRef.current.stop();
    } catch (_) {}
    try {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch (_) {}
    streamRef.current = null;
    mediaRef.current = null;
    setRecording(false);
    setOpen(false);
  };

  const dispatchIntent = (data) => {
    const { intent, params = {}, resolved = {} } = data || {};
    setLastIntent({ intent, params, resolved });

    // Mutation intents → show confirmation card instead of executing
    const MUTATION_INTENTS = new Set([
      "record_customer_payment", "record_supplier_purchase", "record_supplier_payment",
      "update_order_status", "set_private_mark", "add_customer", "add_supplier",
      "update_price", "delete_dispatch", "delete_payment",
    ]);
    if (MUTATION_INTENTS.has(intent)) {
      setPendingMutation({ intent, params, resolved });
      return "pending";
    }

    // Prefill intents → navigate with structured query, leaving form work to the page
    if (intent === "prefill_stock_match") {
      const items = (resolved.items || []).filter((it) => it.item_id && it.quantity > 0);
      if (items.length === 0) {
        toast.warning("Couldn't match any items for the dispatch.");
        return false;
      }
      const encoded = encodeURIComponent(JSON.stringify(items.map((it) => ({
        item_id: it.item_id, item_name: it.item_name || it.name, product_name: it.product_name || "", qty: it.quantity,
      }))));
      navigate(`/dispatch?prefill=${encoded}`);
      return true;
    }
    if (intent === "prefill_new_order") {
      const items = (resolved.items || []).filter((it) => it.item_id && it.quantity > 0);
      const q = new URLSearchParams();
      if (resolved.customer_id) q.set("customer_id", resolved.customer_id);
      if (items.length) {
        q.set("items", JSON.stringify(items.map((it) => ({
          item_id: it.item_id, item_name: it.item_name || it.name, product_name: it.product_name || "", quantity: it.quantity,
        }))));
      }
      navigate(`/orders/new?${q.toString()}`);
      return true;
    }

    if (intent === "navigate") {
      const route = INTENT_TO_ROUTE[params.page];
      if (route) {
        navigate(route);
        return true;
      }
      toast.warning(`Unknown page: ${params.page}`);
      return false;
    }
    if (intent === "filter_orders") {
      const s = params.status || "All";
      navigate(`/orders?status=${encodeURIComponent(s)}`);
      return true;
    }
    if (intent === "search_customer") {
      const q = resolved.customer_name || params.query || "";
      navigate(`/customers?q=${encodeURIComponent(q)}`);
      return true;
    }
    if (intent === "search_product") {
      const q = params.query || "";
      navigate(`/products?q=${encodeURIComponent(q)}`);
      return true;
    }
    if (intent === "show_customer_ledger") {
      if (resolved.customer_id) {
        navigate(`/dispatch-ledger?customer_id=${encodeURIComponent(resolved.customer_id)}`);
      } else {
        navigate(`/dispatch-ledger`);
        toast.message(`Couldn't auto-pick customer "${params.customer || ""}". Please select manually.`);
      }
      return true;
    }
    if (intent === "show_vendor_ledger") {
      if (resolved.vendor_id) {
        navigate(`/admin/suppliers?vendor_id=${encodeURIComponent(resolved.vendor_id)}`);
      } else {
        navigate(`/admin/suppliers`);
        toast.message(`Couldn't auto-pick vendor "${params.vendor || ""}". Please select manually.`);
      }
      return true;
    }
    if (intent === "create_order") {
      if (resolved.customer_id) {
        navigate(`/orders/new?customer_id=${encodeURIComponent(resolved.customer_id)}`);
      } else {
        navigate(`/orders/new`);
      }
      return true;
    }
    // Read-aloud / Q&A intents — just stay open so the user can see the
    // resolved details; the spoken_reply already has the answer.
    const QA_INTENTS = new Set([
      "query_closing_balance", "query_vendor_balance", "query_stock",
      "query_daily_summary", "query_pending_count", "help",
    ]);
    if (QA_INTENTS.has(intent)) {
      return "qa";
    }
    return false;
  };

  const handleResponse = (data) => {
    setTranscript(data.transcript || "");
    setReply(data.spoken_reply || "");
    setHistory((h) =>
      [{ transcript: data.transcript, reply: data.spoken_reply, intent: data.intent, ts: Date.now() }, ...h].slice(0, 8)
    );
    speak(data.spoken_reply || "");
    const result = dispatchIntent(data);
    if (result === true && data.intent !== "help") {
      // Auto-close after a brief delay so the user sees the result
      setTimeout(() => setOpen(false), 1200);
    } else if (result === false) {
      toast.warning("Sorry, I couldn't act on that command.");
    }
    // result === "pending"  → confirmation card stays in dialog
    // result === "qa"        → spoken reply already has the answer, keep dialog open
  };

  const executeMutation = async () => {
    if (!pendingMutation) return;
    const { intent, params, resolved } = pendingMutation;
    setExecutingMutation(true);
    try {
      if (intent === "record_customer_payment") {
        if (!resolved.customer_id) throw new Error(`Customer "${params.customer}" not found`);
        const body = {
          customer_id: resolved.customer_id,
          amount: Number(params.amount),
          source: params.source || "cash",
          reference: params.reference || "",
          notes: "Voice-recorded payment",
          payment_mode: "cash",
        };
        await api.post("/payments", body);
        toast.success(`₹${body.amount} payment recorded for ${resolved.customer_name}.`);
        speak(`Payment of ${body.amount} rupees from ${resolved.customer_name} saved.`);
      } else if (intent === "record_supplier_purchase") {
        if (!resolved.vendor_id) throw new Error(`Vendor "${params.vendor}" not found`);
        const body = {
          supplier_id: resolved.vendor_id,
          amount: Number(params.amount),
          bill_number: params.bill_number || "",
          material: params.material || "",
          notes: params.notes || "Voice-recorded purchase",
        };
        await api.post("/supplier-purchases", body);
        toast.success(`₹${body.amount} purchase from ${resolved.vendor_name} recorded.`);
        speak(`Purchase of ${body.amount} from ${resolved.vendor_name} saved.`);
      } else if (intent === "record_supplier_payment") {
        if (!resolved.vendor_id) throw new Error(`Vendor "${params.vendor}" not found`);
        const body = {
          supplier_id: resolved.vendor_id,
          amount: Number(params.amount),
          source: params.source || "cash",
          reference: params.reference || "",
          notes: "Voice-recorded payment",
        };
        await api.post("/supplier-payments", body);
        toast.success(`₹${body.amount} paid to ${resolved.vendor_name}.`);
        speak(`Payment of ${body.amount} to ${resolved.vendor_name} saved.`);
      } else if (intent === "update_order_status") {
        if (!resolved.order_id) throw new Error(`Order "${params.order_ref}" not found`);
        await api.patch(`/orders/${resolved.order_id}/status`, { status: params.new_status });
        toast.success(`Order marked ${params.new_status}.`);
        speak(`Order updated to ${params.new_status}.`);
      } else if (intent === "set_private_mark") {
        if (!resolved.customer_id) throw new Error(`Customer "${params.customer}" not found`);
        await api.patch(`/customers/${resolved.customer_id}`, { private_mark: params.private_mark });
        toast.success(`Private mark set to "${params.private_mark}".`);
        speak(`Private mark ${params.private_mark} updated.`);
      } else if (intent === "add_customer") {
        const body = {
          name: params.name || "",
          phone: params.phone || "",
          city: params.city || "",
          address: params.address || "",
        };
        if (!body.name) throw new Error("Customer name missing");
        await api.post("/customers", body);
        toast.success(`Customer ${body.name} added.`);
        speak(`Customer ${body.name} added.`);
      } else if (intent === "add_supplier") {
        const body = {
          name: params.name || "",
          phone: params.phone || "",
          city: params.city || "",
          material_category: params.material_category || "",
        };
        if (!body.name) throw new Error("Supplier name missing");
        await api.post("/suppliers", body);
        toast.success(`Supplier ${body.name} added.`);
        speak(`Supplier ${body.name} added.`);
      } else if (intent === "update_price") {
        // We need a default price list; redirect the user to the price-lists page with prefill
        navigate(`/admin/price-lists?item_id=${encodeURIComponent(resolved.item_id || "")}&new_price=${encodeURIComponent(params.new_price)}`);
        toast.message("Open the price list and apply the change there.");
      } else if (intent === "delete_dispatch") {
        if (!resolved.dispatch_id) throw new Error("Dispatch not found");
        await api.delete(`/dispatches/${resolved.dispatch_id}`);
        toast.success("Dispatch deleted.");
        speak("Dispatch deleted.");
      } else if (intent === "delete_payment") {
        if (!resolved.payment_id) throw new Error("Payment not found");
        await api.delete(`/payments/${resolved.payment_id}`);
        toast.success("Payment deleted.");
        speak("Payment deleted.");
      } else {
        toast.warning(`Mutation "${intent}" not implemented`);
      }
      setPendingMutation(null);
      setTimeout(() => setOpen(false), 1000);
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || "Action failed.";
      toast.error(msg);
      speak("Sorry, something went wrong. " + msg);
    } finally {
      setExecutingMutation(false);
    }
  };

  const startRecording = async () => {
    if (!supported) {
      toast.error("Microphone not supported on this device.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        if (!blob.size) {
          setRecording(false);
          return;
        }
        await sendAudio(blob);
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch (e) {
      toast.error("Microphone permission denied.");
      setSupported(false);
    }
  };

  const stopRecording = () => {
    if (mediaRef.current && mediaRef.current.state !== "inactive") {
      mediaRef.current.stop();
    }
    setRecording(false);
  };

  const sendAudio = async (blob) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice-agent.webm");
      const { data } = await api.post("/voice/agent", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      handleResponse(data);
    } catch (e) {
      const msg = e?.response?.data?.detail || "Voice command failed.";
      toast.error(msg);
      setReply(msg);
    } finally {
      setBusy(false);
    }
  };

  const sendText = async () => {
    const cmd = textCmd.trim();
    if (!cmd) return;
    setBusy(true);
    setTextCmd("");
    try {
      const { data } = await api.post("/voice/agent/text", { text: cmd });
      handleResponse(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Command failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Floating action button — clearly labelled AI voice command */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="voice-agent-fab"
        aria-label="Open AI voice assistant"
        title="AI Voice Assistant — bolkar command dein (English / हिंदी)"
        className="fixed z-[60] bottom-[calc(6rem+env(safe-area-inset-bottom))] right-[calc(1.25rem+env(safe-area-inset-right))] sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:right-[calc(1.5rem+env(safe-area-inset-right))] h-14 pl-4 pr-5 rounded-full bg-[#E65100] hover:bg-[#CC4800] text-white shadow-lg flex items-center gap-2 transition-transform active:scale-95 group"
      >
        <Mic className="w-6 h-6" />
        <span className="flex flex-col items-start leading-none">
          <span className="text-sm font-bold">AI Voice</span>
          <span className="text-[10px] font-semibold opacity-90">EN · हिं</span>
        </span>
        <span className="absolute -top-1 -right-1 bg-emerald-500 w-3 h-3 rounded-full border-2 border-white"></span>
      </button>

      <Dialog open={open} onOpenChange={(o) => { if (!o) closeAll(); else setOpen(true); }}>
        <DialogContent
          className="rounded-sm max-w-md p-0 overflow-hidden border-slate-200"
          data-testid="voice-agent-dialog"
        >
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-200 bg-gradient-to-br from-slate-900 to-slate-800 text-white">
            <DialogTitle className="font-heading flex items-center gap-2 text-white">
              <Bot className="w-5 h-5 text-[#FFA152]" />
              Voice Assistant
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded-sm ml-1">
                <Globe className="w-3 h-3" /> EN · हिं
              </span>
            </DialogTitle>
            <DialogDescription className="text-slate-300 text-xs">
              Bolo ya likho — "Open dispatch", "Naya order banao", "Customer A M Auto ka ledger dikhao".
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 py-4 space-y-3 bg-white">
            {/* Mic state visualisation */}
            <div className="flex items-center justify-center py-3">
              {!supported ? (
                <div className="flex flex-col items-center gap-2 text-slate-500 text-sm">
                  <MicOff className="w-10 h-10 text-slate-300" />
                  <span>Microphone unavailable — type your command below.</span>
                </div>
              ) : recording ? (
                <button
                  onClick={stopRecording}
                  data-testid="voice-agent-stop-btn"
                  className="relative w-20 h-20 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg"
                >
                  <Square className="w-7 h-7 fill-white" />
                  <span className="absolute inset-0 rounded-full border-4 border-red-300 animate-ping" />
                </button>
              ) : busy ? (
                <div className="w-20 h-20 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
                  <Loader2 className="w-7 h-7 animate-spin" />
                </div>
              ) : (
                <button
                  onClick={startRecording}
                  data-testid="voice-agent-mic-btn"
                  className="w-20 h-20 rounded-full bg-[#E65100] hover:bg-[#CC4800] text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform"
                >
                  <Mic className="w-8 h-8" />
                </button>
              )}
            </div>
            <div className="text-center text-[11px] uppercase tracking-wider font-bold text-slate-500">
              {recording ? "Listening… tap to stop" : busy ? "Processing…" : "Tap mic & speak"}
            </div>

            {/* Transcript + reply */}
            {(transcript || reply) && (
              <div className="space-y-2 bg-slate-50 border border-slate-200 rounded-sm p-3">
                {transcript && (
                  <div data-testid="voice-agent-transcript">
                    <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                      You said
                    </div>
                    <div className="text-sm text-slate-900 mt-0.5">"{transcript}"</div>
                  </div>
                )}
                {reply && (
                  <div data-testid="voice-agent-reply">
                    <div className="text-[10px] uppercase tracking-wider font-bold text-[#E65100]">
                      Assistant
                    </div>
                    <div className="text-sm text-slate-800 mt-0.5">{reply}</div>
                  </div>
                )}
                {lastIntent && (
                  <div className="text-[10px] text-slate-400 font-mono">
                    intent: {lastIntent.intent}
                    {lastIntent.resolved?.customer_name && ` · ${lastIntent.resolved.customer_name}`}
                    {lastIntent.resolved?.vendor_name && ` · ${lastIntent.resolved.vendor_name}`}
                  </div>
                )}
              </div>
            )}

            {/* Mutation confirmation card */}
            {pendingMutation && (
              <MutationConfirmCard
                pending={pendingMutation}
                busy={executingMutation}
                onConfirm={executeMutation}
                onCancel={() => setPendingMutation(null)}
              />
            )}

            {/* Q&A details (for read-aloud intents) */}
            {lastIntent && !pendingMutation && (
              <QAResultCard intent={lastIntent.intent} resolved={lastIntent.resolved || {}} />
            )}

            {/* Typed fallback */}
            <div className="pt-1">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">
                <MessageSquare className="w-3 h-3 inline mr-1" /> Or type a command
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); sendText(); }}
                className="flex items-center gap-2"
              >
                <Input
                  value={textCmd}
                  onChange={(e) => setTextCmd(e.target.value)}
                  placeholder='e.g. "Open dispatch ledger"'
                  data-testid="voice-agent-text-input"
                  className="h-10 rounded-sm"
                  disabled={busy}
                />
                <Button
                  type="submit"
                  disabled={busy || !textCmd.trim()}
                  data-testid="voice-agent-text-send"
                  className="bg-slate-900 hover:bg-black text-white rounded-sm h-10"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </form>
            </div>

            {/* Help / examples */}
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-bold uppercase tracking-wider text-[10px] text-slate-500">
                Try saying…
              </summary>
              <ul className="mt-2 space-y-1 list-disc pl-4">
                <li>Navigation: "Open dispatch", "Naya order banao", "Daily report kholo"</li>
                <li>Search: "Find customer Sharma Auto"</li>
                <li>Q&amp;A: "A M Auto ka closing balance kya hai", "Side stand kitna stock hai", "Aaj ka summary sunao"</li>
                <li>Payments: "Sharma Auto se das hazaar cash mila"</li>
                <li>Purchases: "Steel Traders ka 12000 ka purchase, bill 234"</li>
                <li>Orders: "Order ABC123 ko dispatched mark karo", "A M Auto ke liye center stand do sau"</li>
                <li>Customer/vendor: "Add new customer Test Auto Ludhiana phone 98xxxx"</li>
              </ul>
            </details>
          </div>

          <DialogFooter className="px-5 py-3 border-t border-slate-200 bg-slate-50 gap-2">
            <Button
              variant="outline"
              onClick={closeAll}
              className="rounded-sm"
              data-testid="voice-agent-close-btn"
            >
              <X className="w-4 h-4 mr-1" /> Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Sub-component: confirmation card for mutation intents ───
function MutationConfirmCard({ pending, busy, onConfirm, onCancel }) {
  const { intent, params = {}, resolved = {} } = pending || {};

  const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  const titleByIntent = {
    record_customer_payment: "Record customer payment",
    record_supplier_purchase: "Record vendor purchase",
    record_supplier_payment: "Record vendor payment",
    update_order_status: "Update order status",
    set_private_mark: "Set private mark",
    add_customer: "Add new customer",
    add_supplier: "Add new supplier",
    update_price: "Update item price",
    delete_dispatch: "Delete dispatch",
    delete_payment: "Delete payment",
  };

  const isResolved = (() => {
    if (intent === "record_customer_payment") return !!resolved.customer_id;
    if (intent === "record_supplier_purchase" || intent === "record_supplier_payment") return !!resolved.vendor_id;
    if (intent === "update_order_status") return !!resolved.order_id;
    if (intent === "set_private_mark") return !!resolved.customer_id;
    if (intent === "delete_dispatch") return !!resolved.dispatch_id;
    if (intent === "delete_payment") return !!resolved.payment_id;
    if (intent === "update_price") return !!resolved.item_id;
    if (intent === "add_customer") return !!params.name;
    if (intent === "add_supplier") return !!params.name;
    return false;
  })();

  const isDestructive = intent === "delete_dispatch" || intent === "delete_payment";

  return (
    <div
      className={`border-2 rounded-sm p-3 ${
        isResolved ? (isDestructive ? "border-red-500 bg-red-50" : "border-[#E65100] bg-orange-50") : "border-amber-400 bg-amber-50"
      }`}
      data-testid="voice-agent-confirm-card"
    >
      <div className="flex items-center gap-2 mb-2">
        {isResolved ? (
          <CheckCircle2 className={`w-4 h-4 ${isDestructive ? "text-red-600" : "text-[#E65100]"}`} />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-600" />
        )}
        <div className="text-[10px] uppercase tracking-wider font-extrabold text-slate-700">
          {titleByIntent[intent] || "Confirm action"}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-800">
        {intent === "record_customer_payment" && (
          <>
            <dt className="text-slate-500">Customer</dt>
            <dd className="font-bold">{resolved.customer_name || params.customer || "—"}</dd>
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-extrabold tabular-nums">₹{fmt(params.amount)}</dd>
            <dt className="text-slate-500">Mode</dt>
            <dd>{(params.source || "cash").replace(/_/g, " ")}</dd>
            {params.reference && (<><dt className="text-slate-500">Ref</dt><dd>{params.reference}</dd></>)}
          </>
        )}
        {intent === "record_supplier_purchase" && (
          <>
            <dt className="text-slate-500">Vendor</dt>
            <dd className="font-bold">{resolved.vendor_name || params.vendor || "—"}</dd>
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-extrabold tabular-nums">₹{fmt(params.amount)}</dd>
            {params.bill_number && (<><dt className="text-slate-500">Bill #</dt><dd>{params.bill_number}</dd></>)}
            {params.material && (<><dt className="text-slate-500">Material</dt><dd>{params.material}</dd></>)}
          </>
        )}
        {intent === "record_supplier_payment" && (
          <>
            <dt className="text-slate-500">Vendor</dt>
            <dd className="font-bold">{resolved.vendor_name || params.vendor || "—"}</dd>
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-extrabold tabular-nums">₹{fmt(params.amount)}</dd>
            <dt className="text-slate-500">Mode</dt>
            <dd>{(params.source || "cash").replace(/_/g, " ")}</dd>
          </>
        )}
        {intent === "update_order_status" && (
          <>
            <dt className="text-slate-500">Order</dt>
            <dd className="font-bold font-mono">{params.order_ref || "—"} {resolved.order_customer_name ? `· ${resolved.order_customer_name}` : ""}</dd>
            <dt className="text-slate-500">New status</dt>
            <dd className="font-extrabold">{params.new_status}</dd>
          </>
        )}
        {intent === "set_private_mark" && (
          <>
            <dt className="text-slate-500">Customer</dt>
            <dd className="font-bold">{resolved.customer_name || params.customer || "—"}</dd>
            <dt className="text-slate-500">Private mark</dt>
            <dd className="font-extrabold">{params.private_mark || "—"}</dd>
          </>
        )}
        {intent === "add_customer" && (
          <>
            <dt className="text-slate-500">Name</dt>
            <dd className="font-bold">{params.name}</dd>
            {params.phone && (<><dt className="text-slate-500">Phone</dt><dd>{params.phone}</dd></>)}
            {params.city && (<><dt className="text-slate-500">City</dt><dd>{params.city}</dd></>)}
            {params.address && (<><dt className="text-slate-500">Address</dt><dd>{params.address}</dd></>)}
          </>
        )}
        {intent === "add_supplier" && (
          <>
            <dt className="text-slate-500">Name</dt>
            <dd className="font-bold">{params.name}</dd>
            {params.phone && (<><dt className="text-slate-500">Phone</dt><dd>{params.phone}</dd></>)}
            {params.city && (<><dt className="text-slate-500">City</dt><dd>{params.city}</dd></>)}
            {params.material_category && (<><dt className="text-slate-500">Category</dt><dd>{params.material_category}</dd></>)}
          </>
        )}
        {intent === "update_price" && (
          <>
            <dt className="text-slate-500">Item</dt>
            <dd className="font-bold">{resolved.item_name || resolved.product_name || params.item}</dd>
            <dt className="text-slate-500">New price</dt>
            <dd className="font-extrabold tabular-nums">₹{fmt(params.new_price)}</dd>
          </>
        )}
        {intent === "delete_dispatch" && (
          <>
            <dt className="text-slate-500">Dispatch</dt>
            <dd className="font-bold font-mono">{resolved.dispatch_slip_no ? `#${resolved.dispatch_slip_no}` : params.dispatch_ref}</dd>
            {resolved.dispatch_customer_name && (<><dt className="text-slate-500">Customer</dt><dd>{resolved.dispatch_customer_name}</dd></>)}
          </>
        )}
        {intent === "delete_payment" && (
          <>
            <dt className="text-slate-500">Payment</dt>
            <dd className="font-bold font-mono">{params.payment_ref}</dd>
            {resolved.payment_customer_name && (<><dt className="text-slate-500">Customer</dt><dd>{resolved.payment_customer_name}</dd></>)}
          </>
        )}
      </dl>

      {!isResolved && (
        <div className="mt-2 text-[11px] text-amber-800 italic">
          ⚠ Couldn't auto-match — please verify the spelling and try again.
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
          className="rounded-sm h-8"
          data-testid="voice-agent-cancel-mutation"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={busy || !isResolved}
          data-testid="voice-agent-confirm-mutation"
          className={`rounded-sm h-8 ${isDestructive ? "bg-red-700 hover:bg-red-800" : "bg-[#E65100] hover:bg-[#CC4800]"} text-white`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
          {isDestructive ? "Delete" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}

// ─── Sub-component: read-aloud Q&A result card ───
function QAResultCard({ intent, resolved }) {
  const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (intent === "query_closing_balance" && resolved.customer_id) {
    const cb = Number(resolved.closing_balance || 0);
    return (
      <div className="border border-slate-200 rounded-sm p-3 bg-white" data-testid="voice-agent-qa-card">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Closing balance · {resolved.customer_name}</div>
        <div className={`mt-1 text-2xl font-extrabold tabular-nums ${cb >= 0 ? "text-[#E65100]" : "text-emerald-700"}`}>
          ₹{fmt(Math.abs(cb))} <span className="text-xs opacity-70">{cb >= 0 ? "Due" : "Advance"}</span>
        </div>
        <div className="text-[10px] text-slate-500 tabular-nums mt-1">
          Debit ₹{fmt(resolved.total_debit)} · Credit ₹{fmt(resolved.total_credit)}
        </div>
      </div>
    );
  }
  if (intent === "query_vendor_balance" && resolved.vendor_id) {
    const cb = Number(resolved.closing_balance || 0);
    return (
      <div className="border border-slate-200 rounded-sm p-3 bg-white" data-testid="voice-agent-qa-card">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Vendor balance · {resolved.vendor_name}</div>
        <div className={`mt-1 text-2xl font-extrabold tabular-nums ${cb >= 0 ? "text-[#E65100]" : "text-emerald-700"}`}>
          ₹{fmt(Math.abs(cb))} <span className="text-xs opacity-70">{cb >= 0 ? "Payable" : "Advance"}</span>
        </div>
      </div>
    );
  }
  if (intent === "query_stock" && resolved.item_id) {
    return (
      <div className="border border-slate-200 rounded-sm p-3 bg-white" data-testid="voice-agent-qa-card">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{resolved.item_name || resolved.product_name}</div>
        <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-[10px] text-slate-500">Stock</div>
            <div className="font-extrabold tabular-nums text-slate-900">{resolved.stock_qty}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">Pending demand</div>
            <div className="font-extrabold tabular-nums text-[#E65100]">{resolved.open_demand}</div>
          </div>
        </div>
      </div>
    );
  }
  if (intent === "query_daily_summary") {
    return (
      <div className="border border-slate-200 rounded-sm p-3 bg-white" data-testid="voice-agent-qa-card">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Today</div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <div className="text-slate-500 text-xs">Dispatches</div>
          <div className="text-right font-bold tabular-nums">{resolved.dispatch_count} · {resolved.dispatch_pcs} pcs</div>
          <div className="text-slate-500 text-xs">Dispatch value</div>
          <div className="text-right font-bold tabular-nums">₹{fmt(resolved.dispatch_value)}</div>
          <div className="text-slate-500 text-xs">Payments</div>
          <div className="text-right font-bold tabular-nums text-emerald-700">{resolved.payment_count} · ₹{fmt(resolved.payment_amount)}</div>
        </div>
      </div>
    );
  }
  if (intent === "query_pending_count") {
    return (
      <div className="border border-slate-200 rounded-sm p-3 bg-white" data-testid="voice-agent-qa-card">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Pending orders</div>
        <div className="mt-1 text-2xl font-extrabold text-[#E65100] tabular-nums">{resolved.pending_count}</div>
      </div>
    );
  }
  return null;
}
