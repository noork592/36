import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Mail,
  MessageCircle,
  Loader2,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Reusable Email + WhatsApp share buttons for any document PDF.
 *
 * Props:
 *   endpointBase: "/ledger" | "/slip" — backend prefix. Endpoints hit
 *     will be `${endpointBase}/email` and `${endpointBase}/whatsapp`.
 *   payload: object — sent under `payload` key to the backend.
 *   partyName: string — human name shown in the dialog copy.
 *   defaultEmail: string — prefilled email (falls back to "").
 *   defaultPhone: string — prefilled phone (falls back to "").
 *   documentLabel: short label used in toasts, e.g. "Ledger PDF" | "Slip PDF".
 *   testIdPrefix: unique prefix for data-testids to avoid collisions
 *     when multiple share components are on the same page.
 */
export default function ShareDocumentButtons({
  endpointBase,
  payload,
  partyName = "this party",
  defaultEmail = "",
  defaultPhone = "",
  documentLabel = "PDF",
  testIdPrefix = "share",
}) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [sending, setSending] = useState(false);

  const openEmail = () => {
    setRecipientEmail((defaultEmail || "").trim());
    setEmailOpen(true);
  };
  const openWa = () => {
    setRecipientPhone((defaultPhone || "").trim());
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
      const { data } = await api.post(`${endpointBase}/email`, {
        recipient_email: email,
        payload,
      });
      toast.success(`${documentLabel} emailed to ${data.sent_to}`);
      setEmailOpen(false);
    } catch (e) {
      const detail =
        e?.response?.data?.detail || e?.message || "Email failed";
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
      const { data } = await api.post(`${endpointBase}/whatsapp`, {
        recipient_phone: phone,
        payload,
      });
      toast.success(`${documentLabel} sent on WhatsApp to +${data.sent_to}`);
      setWaOpen(false);
    } catch (e) {
      const detail =
        e?.response?.data?.detail || e?.message || "WhatsApp send failed";
      toast.error(String(detail));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={openEmail}
        data-testid={`${testIdPrefix}-email-open-btn`}
        className="rounded-sm border-slate-300"
      >
        <Mail className="w-4 h-4 mr-1.5" /> Email
      </Button>
      <Button
        variant="outline"
        onClick={openWa}
        data-testid={`${testIdPrefix}-whatsapp-open-btn`}
        className="rounded-sm border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
      >
        <MessageCircle className="w-4 h-4 mr-1.5" /> WhatsApp
      </Button>

      {/* Email dialog */}
      <Dialog
        open={emailOpen}
        onOpenChange={(o) => {
          if (!o && !sending) setEmailOpen(false);
        }}
      >
        <DialogContent
          className="rounded-sm max-w-md"
          data-testid={`${testIdPrefix}-email-dialog`}
        >
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Mail className="w-5 h-5 text-[#E65100]" /> Email {documentLabel}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              The {documentLabel.toLowerCase()} for <b>{partyName}</b> will be
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
                data-testid={`${testIdPrefix}-email-input`}
                className="mt-1 rounded-sm border-slate-300 focus:border-[#E65100] focus:ring-[#E65100]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendEmail();
                }}
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
              data-testid={`${testIdPrefix}-email-cancel-btn`}
            >
              Cancel
            </Button>
            <Button
              onClick={sendEmail}
              disabled={sending}
              data-testid={`${testIdPrefix}-email-send-btn`}
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
            >
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-1.5" /> Send Email
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp dialog */}
      <Dialog
        open={waOpen}
        onOpenChange={(o) => {
          if (!o && !sending) setWaOpen(false);
        }}
      >
        <DialogContent
          className="rounded-sm max-w-md"
          data-testid={`${testIdPrefix}-whatsapp-dialog`}
        >
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-emerald-600" /> Send{" "}
              {documentLabel} on WhatsApp
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              The {documentLabel.toLowerCase()} for <b>{partyName}</b> will be
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
                data-testid={`${testIdPrefix}-whatsapp-input`}
                className="mt-1 rounded-sm border-slate-300 focus:border-emerald-600 focus:ring-emerald-600"
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendWhatsApp();
                }}
                autoFocus
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Include country code. 10-digit Indian numbers auto-prefix with{" "}
                <b>+91</b>.
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => setWaOpen(false)}
              disabled={sending}
              className="rounded-sm"
              data-testid={`${testIdPrefix}-whatsapp-cancel-btn`}
            >
              Cancel
            </Button>
            <Button
              onClick={sendWhatsApp}
              disabled={sending}
              data-testid={`${testIdPrefix}-whatsapp-send-btn`}
              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-sm"
            >
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-1.5" /> Send WhatsApp
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
