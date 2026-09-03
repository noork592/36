import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Printer, X, FileText, Mail, MessageCircle, Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const fmt = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

/**
 * Generic Print/Preview dialog for a ledger statement (vendor or customer).
 * Props:
 *   open, onClose, title, party, period, opening, closing,
 *   total_debit, total_credit, rows, pcsTotal
 */
export default function LedgerPrintDialog({
  open,
  onClose,
  title,
  party,
  period,
  opening = 0,
  closing = 0,
  total_debit = 0,
  total_credit = 0,
  rows = [],
  pcsTotal = null,
}) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState("");

  const buildPayload = () => ({
    title,
    party: party ? {
      name: party.name || null,
      phone: party.phone || null,
      city: party.city || null,
      location: party.location || null,
      address: party.address || null,
      gst_number: party.gst_number || null,
      material_category: party.material_category || null,
    } : null,
    period: period ? {
      startDate: period.startDate || null,
      endDate: period.endDate || null,
    } : null,
    opening: Number(opening) || 0,
    closing: Number(closing) || 0,
    total_debit: Number(total_debit) || 0,
    total_credit: Number(total_credit) || 0,
    rows: (rows || []).map((r) => ({
      id: r.id != null ? String(r.id) : null,
      when: r.when != null ? String(r.when) : null,
      particulars: r.particulars != null ? String(r.particulars) : null,
      reference: r.reference != null && r.reference !== "" ? String(r.reference) : null,
      debit: Number(r.debit) || 0,
      credit: Number(r.credit) || 0,
      balance: Number(r.balance) || 0,
      notes: r.notes != null && r.notes !== "" ? String(r.notes) : null,
    })),
    pcs_total: pcsTotal !== null && pcsTotal !== undefined ? Number(pcsTotal) : null,
  });

  const doPrint = () => {
    document.body.classList.add("printing-ledger");
    const cleanup = () => {
      document.body.classList.remove("printing-ledger");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);
  };

  const openEmail = () => {
    setRecipientEmail((party?.email || "").trim());
    setEmailOpen(true);
  };

  const openWa = () => {
    setRecipientPhone((party?.phone || "").trim());
    setWaOpen(true);
  };

  const sendEmail = async () => {
    const email = recipientEmail.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      toast.error("Please enter a valid email address");
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post("/ledger/email", {
        recipient_email: email,
        payload: buildPayload(),
      });
      toast.success(`Ledger PDF emailed to ${data.sent_to}`);
      setEmailOpen(false);
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Email failed";
      toast.error(String(detail));
    } finally {
      setSending(false);
    }
  };

  const sendWhatsApp = async () => {
    const phone = recipientPhone.trim();
    if (!phone || phone.replace(/\D/g, "").length < 10) {
      toast.error("Please enter a valid phone number (with country code)");
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post("/ledger/whatsapp", {
        recipient_phone: phone,
        payload: buildPayload(),
      });
      toast.success(`Ledger PDF sent on WhatsApp to +${data.sent_to}`);
      setWaOpen(false);
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "WhatsApp send failed";
      toast.error(String(detail));
    } finally {
      setSending(false);
    }
  };

  const summarize = async () => {
    if (summarizing) return;
    setSummarizing(true);
    setAiSummary("");
    try {
      const { data } = await api.post("/ai/summary/ledger", {
        payload: buildPayload(),
      });
      setAiSummary(data.summary || "No summary returned.");
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Summary failed";
      toast.error(String(detail));
    } finally {
      setSummarizing(false);
    }
  };

  const partyLines = party
    ? [
        party.phone && `Phone: ${party.phone}`,
        [party.city, party.location, party.address].filter(Boolean).join(", "),
        party.gst_number && `GST: ${party.gst_number}`,
        party.material_category && `Category: ${party.material_category}`,
      ].filter(Boolean)
    : [];

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
        <DialogContent
          className="rounded-sm max-w-4xl p-0 overflow-hidden"
          data-testid="ledger-print-dialog"
        >
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-200 no-print">
            <DialogTitle className="font-heading flex items-center gap-2">
              <FileText className="w-5 h-5 text-[#E65100]" />
              {title} · Print / Preview
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500 mt-1">
              Review the statement below. Tap{" "}
              <span className="font-bold">Print</span> to save as PDF,{" "}
              <span className="font-bold">Email</span> to send by email, or{" "}
              <span className="font-bold">WhatsApp</span> to send as PDF on WhatsApp.
            </DialogDescription>
          </DialogHeader>

          {aiSummary && (
            <div
              className="mx-5 mt-3 mb-1 rounded-sm border border-purple-200 bg-purple-50 px-3 py-2 no-print"
              data-testid="ledger-ai-summary"
            >
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-purple-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-purple-700">
                    AI Summary
                  </div>
                  <p className="text-xs text-slate-800 mt-0.5 whitespace-pre-wrap leading-relaxed">
                    {aiSummary}
                  </p>
                </div>
                <button
                  onClick={() => setAiSummary("")}
                  className="text-purple-500 hover:text-purple-800 p-1"
                  aria-label="Dismiss summary"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div
            id="ledger-print-area"
            className="px-6 py-5 print-target bg-white max-h-[70vh] overflow-y-auto"
            data-testid="ledger-print-area"
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b-2 border-slate-900 pb-3 mb-4">
              <div className="text-right text-xs text-slate-700 ml-auto">
                <div className="font-extrabold text-base text-slate-900">{title}</div>
                {period && (period.startDate || period.endDate) && (
                  <div className="mt-0.5">
                    Period:{" "}
                    <span className="font-bold tabular-nums">
                      {fmtDate(period.startDate)} → {fmtDate(period.endDate)}
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Printed: {fmtDate(new Date().toISOString())}
                </div>
              </div>
            </div>

            {/* Party */}
            {party && (
              <div className="mb-4 border border-slate-300 rounded-sm bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider font-bold text-slate-600">
                  Account of
                </div>
                <div className="font-bold text-slate-900 text-base">{party.name || "—"}</div>
                {partyLines.length > 0 && (
                  <div className="text-[11px] text-slate-600 mt-0.5">
                    {partyLines.join(" · ")}
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[
                ["Opening", `₹${fmt(opening)} ${opening >= 0 ? "Dr" : "Cr"}`],
                ["Total Debit", `₹${fmt(total_debit)}`],
                ["Total Credit", `₹${fmt(total_credit)}`],
                ["Closing", `₹${fmt(closing)} ${closing >= 0 ? "Dr" : "Cr"}`],
              ].map(([k, v], i) => (
                <div
                  key={i}
                  className="border border-slate-300 rounded-sm p-2"
                >
                  <div className="text-[9px] uppercase tracking-wider font-bold text-slate-600">
                    {k}
                  </div>
                  <div className="text-sm font-extrabold tabular-nums text-slate-900 mt-0.5">
                    {v}
                  </div>
                </div>
              ))}
            </div>

            {/* Table */}
            <table className="w-full text-xs border border-slate-400 border-collapse">
              <thead>
                <tr className="bg-slate-100 text-[10px] uppercase tracking-wider text-slate-700 font-bold">
                  <th className="border border-slate-400 px-2 py-1.5 text-left w-24">Date</th>
                  <th className="border border-slate-400 px-2 py-1.5 text-left">Particulars</th>
                  <th className="border border-slate-400 px-2 py-1.5 text-left w-28">Reference</th>
                  <th className="border border-slate-400 px-2 py-1.5 text-right w-24">Debit ₹</th>
                  <th className="border border-slate-400 px-2 py-1.5 text-right w-24">Credit ₹</th>
                  <th className="border border-slate-400 px-2 py-1.5 text-right w-28">Balance ₹</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-slate-400 px-2 py-1.5 italic text-slate-500">—</td>
                  <td className="border border-slate-400 px-2 py-1.5 italic text-slate-600">
                    Opening balance
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5" colSpan={3}></td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums font-bold">
                    {fmt(opening)} {opening >= 0 ? "Dr" : "Cr"}
                  </td>
                </tr>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="border border-slate-400 px-2 py-6 text-center text-slate-500"
                    >
                      No transactions in this period.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={r.id || i}>
                      <td className="border border-slate-400 px-2 py-1.5 text-slate-700 tabular-nums">
                        {fmtDate(r.when)}
                      </td>
                      <td className="border border-slate-400 px-2 py-1.5 text-slate-900">
                        {r.particulars || "—"}
                        {r.notes && (
                          <div className="text-[10px] text-slate-500 italic mt-0.5">
                            {r.notes}
                          </div>
                        )}
                      </td>
                      <td className="border border-slate-400 px-2 py-1.5 text-slate-600 font-mono text-[10px]">
                        {r.reference || "—"}
                      </td>
                      <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                        {Number(r.debit || 0) > 0 ? fmt(r.debit) : "—"}
                      </td>
                      <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums">
                        {Number(r.credit || 0) > 0 ? fmt(r.credit) : "—"}
                      </td>
                      <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums font-bold">
                        {fmt(r.balance)}{" "}
                        <span className="text-[9px] font-bold ml-0.5">
                          {Number(r.balance) >= 0 ? "Dr" : "Cr"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 text-[10px] uppercase tracking-wider font-bold">
                  <td
                    colSpan={3}
                    className="border border-slate-400 px-2 py-1.5 text-right text-slate-700"
                  >
                    Period totals
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums font-extrabold text-slate-900">
                    ₹{fmt(total_debit)}
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums font-extrabold text-slate-900">
                    ₹{fmt(total_credit)}
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right tabular-nums font-extrabold">
                    ₹{fmt(closing)} {closing >= 0 ? "Dr" : "Cr"}
                  </td>
                </tr>
              </tfoot>
            </table>

            {pcsTotal !== null && pcsTotal !== undefined && (
              <div className="mt-3 text-[11px] text-slate-700">
                Total pieces dispatched:{" "}
                <span className="font-bold tabular-nums">{pcsTotal}</span>
              </div>
            )}

            <div className="mt-8 pt-3 border-t border-dashed border-slate-400 grid grid-cols-2 gap-8 text-[11px] text-slate-700">
              <div>
                <div className="border-t border-slate-700 mt-10 pt-1 text-center">
                  Authorised signature
                </div>
              </div>
              <div>
                <div className="border-t border-slate-700 mt-10 pt-1 text-center">
                  Receiver signature
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="px-5 py-3 border-t border-slate-200 bg-slate-50 no-print gap-2 flex-wrap sm:flex-nowrap">
            <Button
              variant="outline"
              onClick={() => onClose?.()}
              className="rounded-sm"
              data-testid="ledger-print-close-btn"
            >
              <X className="w-4 h-4 mr-1" /> Close
            </Button>
            <Button
              variant="outline"
              onClick={summarize}
              disabled={summarizing}
              data-testid="ledger-summarize-btn"
              className="rounded-sm border-purple-300 text-purple-700 hover:bg-purple-50 hover:text-purple-800"
            >
              {summarizing ? (
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Summarizing…</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-1.5" /> AI Summary</>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={openEmail}
              data-testid="ledger-email-open-btn"
              className="rounded-sm border-slate-300"
            >
              <Mail className="w-4 h-4 mr-1.5" /> Email
            </Button>
            <Button
              variant="outline"
              onClick={openWa}
              data-testid="ledger-whatsapp-open-btn"
              className="rounded-sm border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            >
              <MessageCircle className="w-4 h-4 mr-1.5" /> WhatsApp
            </Button>
            <Button
              onClick={doPrint}
              data-testid="ledger-print-btn"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
            >
              <Printer className="w-4 h-4 mr-1.5" /> Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email recipient dialog */}
      <Dialog open={emailOpen} onOpenChange={(o) => { if (!o && !sending) setEmailOpen(false); }}>
        <DialogContent className="rounded-sm max-w-md" data-testid="ledger-email-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Mail className="w-5 h-5 text-[#E65100]" /> Email Ledger PDF
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              The ledger PDF for <b>{party?.name || "this party"}</b> will be
              rendered on the server and emailed as an attachment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label className="text-xs uppercase font-bold tracking-wider text-slate-700">
                Recipient email
              </Label>
              <Input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                disabled={sending}
                placeholder="name@example.com"
                data-testid="ledger-email-input"
                className="mt-1 rounded-sm border-slate-300 focus:border-[#E65100] focus:ring-[#E65100]"
                onKeyDown={(e) => { if (e.key === "Enter") sendEmail(); }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter className="gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => setEmailOpen(false)}
              disabled={sending}
              className="rounded-sm"
              data-testid="ledger-email-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              onClick={sendEmail}
              disabled={sending}
              data-testid="ledger-email-send-btn"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
            >
              {sending ? (
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…</>
              ) : (
                <><Send className="w-4 h-4 mr-1.5" /> Send Email</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp recipient dialog */}
      <Dialog open={waOpen} onOpenChange={(o) => { if (!o && !sending) setWaOpen(false); }}>
        <DialogContent className="rounded-sm max-w-md" data-testid="ledger-whatsapp-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-emerald-600" /> Send Ledger on WhatsApp
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              The ledger PDF for <b>{party?.name || "this party"}</b> will be
              delivered via WhatsApp Business as a document.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label className="text-xs uppercase font-bold tracking-wider text-slate-700">
                Recipient WhatsApp number
              </Label>
              <Input
                type="tel"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                disabled={sending}
                placeholder="+91 98765 43210"
                data-testid="ledger-whatsapp-input"
                className="mt-1 rounded-sm border-slate-300 focus:border-emerald-600 focus:ring-emerald-600"
                onKeyDown={(e) => { if (e.key === "Enter") sendWhatsApp(); }}
                autoFocus
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Include country code. 10-digit Indian numbers auto-prefix
                with <b>+91</b>.
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => setWaOpen(false)}
              disabled={sending}
              className="rounded-sm"
              data-testid="ledger-whatsapp-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              onClick={sendWhatsApp}
              disabled={sending}
              data-testid="ledger-whatsapp-send-btn"
              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-sm"
            >
              {sending ? (
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…</>
              ) : (
                <><Send className="w-4 h-4 mr-1.5" /> Send WhatsApp</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
