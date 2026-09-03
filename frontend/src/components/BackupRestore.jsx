import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Cloud,
  Save,
  Play,
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Mail,
  Clock,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const fmtDateTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const fmtBytes = (n) => {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

export default function BackupRestore() {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const fileRef = useRef(null);

  // Editable form
  const [form, setForm] = useState({
    enabled: true,
    gmail_user: "",
    gmail_app_password: "",
    send_to: "",
    schedule_hour: "21",
    schedule_minute: "0",
  });

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/backup/settings");
      setS(data);
      setForm({
        enabled: !!data.enabled,
        gmail_user: data.gmail_user || "",
        gmail_app_password: "",
        send_to: data.send_to || "",
        schedule_hour: String(data.schedule_hour ?? 21),
        schedule_minute: String(data.schedule_minute ?? 0),
      });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load backup settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    const h = Number(form.schedule_hour);
    const m = Number(form.schedule_minute);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      toast.error("Hour must be 0–23");
      return;
    }
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      toast.error("Minute must be 0–59");
      return;
    }
    if (form.gmail_user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.gmail_user)) {
      toast.error("Gmail address looks invalid");
      return;
    }
    setSaving(true);
    try {
      const body = {
        enabled: form.enabled,
        gmail_user: form.gmail_user.trim(),
        send_to: form.send_to.trim() || form.gmail_user.trim(),
        schedule_hour: h,
        schedule_minute: m,
      };
      if (form.gmail_app_password.trim()) {
        body.gmail_app_password = form.gmail_app_password;
      }
      const { data } = await api.patch("/admin/backup/settings", body);
      setS(data);
      // Clear local password field after save so it isn't kept in memory
      setForm((f) => ({ ...f, gmail_app_password: "" }));
      toast.success("Backup settings saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    const tid = toast.loading("Building backup and emailing it…");
    try {
      const { data } = await api.post("/admin/backup/run");
      if (data.last_run_status === "success") {
        toast.success(
          `Backup sent (${fmtBytes(data.last_run_size_bytes)})`,
          { id: tid },
        );
      } else {
        toast.error(`Backup failed: ${data.last_run_message || "unknown error"}`, { id: tid });
      }
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Backup failed", { id: tid });
    } finally {
      setRunning(false);
    }
  };

  const onPickRestoreFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".zip")) {
      toast.error("Please select a .zip backup file");
      e.target.value = "";
      return;
    }
    setPendingFile(f);
    setRestoreConfirmOpen(true);
  };

  const doRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    const tid = toast.loading("Restoring from backup… do not close this window");
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const { data } = await api.post("/admin/backup/restore", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const total = data.total_collections || 0;
      toast.success(`Restore complete — ${total} collection(s) reloaded`, { id: tid });
      setRestoreConfirmOpen(false);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Restore failed", { id: tid });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-sm max-w-2xl">
      <div className="p-5 border-b border-slate-200 flex items-center gap-3">
        <div className="w-10 h-10 rounded-sm bg-sky-50 border border-sky-200 grid place-items-center text-sky-600">
          <Cloud className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <div className="font-bold text-slate-900">Backup &amp; Restore</div>
          <div className="text-xs text-slate-500">
            Daily auto-backup of the full database, emailed to your Gmail. Restore any time from a saved ZIP.
          </div>
        </div>
        {s?.last_run_status === "success" ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-sm bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3.5 h-3.5" /> OK
          </span>
        ) : s?.last_run_status === "failed" ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-sm bg-rose-50 text-rose-700 border border-rose-200">
            <XCircle className="w-3.5 h-3.5" /> Failed
          </span>
        ) : null}
      </div>

      <div className="p-5 space-y-5">
        {/* Status strip */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-sm border border-slate-200 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Last run</div>
            <div className="font-bold text-slate-900 mt-0.5">{fmtDateTime(s?.last_run_at)}</div>
            <div className="text-slate-500 mt-0.5">
              {s?.last_run_size_bytes ? fmtBytes(s.last_run_size_bytes) : "—"}
            </div>
          </div>
          <div className="rounded-sm border border-slate-200 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Next auto-run</div>
            <div className="font-bold text-slate-900 mt-0.5 inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {String(s?.schedule_hour ?? 21).padStart(2, "0")}:
              {String(s?.schedule_minute ?? 0).padStart(2, "0")} IST
            </div>
            <div className="text-slate-500 mt-0.5">{s?.enabled ? "Enabled" : "Disabled"}</div>
          </div>
        </div>

        {s?.last_run_status === "failed" && (
          <div className="flex items-start gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-sm p-2.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="break-words">
              <span className="font-bold">Last attempt failed:</span> {s.last_run_message}
            </div>
          </div>
        )}

        {/* Enable/disable toggle */}
        <div className="flex items-center justify-between py-1">
          <div>
            <div className="text-sm font-bold text-slate-900">Daily auto-backup</div>
            <div className="text-xs text-slate-500">When off, only manual “Backup Now” will run.</div>
          </div>
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            disabled={loading}
          />
        </div>

        {/* Gmail credentials */}
        <div className="border-t border-slate-100 pt-4 space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5" /> Gmail credentials
          </div>
          <div>
            <Label className="text-xs">Gmail address (sender)</Label>
            <Input
              value={form.gmail_user}
              onChange={(e) => setForm((f) => ({ ...f, gmail_user: e.target.value }))}
              placeholder="you@gmail.com"
              className="h-10 rounded-sm mt-1"
              disabled={loading}
            />
          </div>
          <div>
            <Label className="text-xs flex items-center gap-1">
              <KeyRound className="w-3 h-3" /> Gmail App Password
              {s?.gmail_app_password_set ? (
                <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-emerald-50 text-emerald-700 border border-emerald-200">
                  set
                </span>
              ) : (
                <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-amber-50 text-amber-700 border border-amber-200">
                  missing
                </span>
              )}
            </Label>
            <Input
              type="password"
              value={form.gmail_app_password}
              onChange={(e) => setForm((f) => ({ ...f, gmail_app_password: e.target.value }))}
              placeholder={
                s?.gmail_app_password_set
                  ? `Leave blank to keep current (••••${(s.gmail_app_password || "").slice(-4) || ""})`
                  : "16-char app password from Google Account"
              }
              className="h-10 rounded-sm mt-1 font-mono"
              disabled={loading}
              autoComplete="new-password"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Generate at <span className="font-mono">myaccount.google.com/apppasswords</span> (requires 2-Step Verification).
              Spaces are removed automatically.
            </p>
          </div>
          <div>
            <Label className="text-xs">Send backup to</Label>
            <Input
              value={form.send_to}
              onChange={(e) => setForm((f) => ({ ...f, send_to: e.target.value }))}
              placeholder="Same as sender if blank"
              className="h-10 rounded-sm mt-1"
              disabled={loading}
            />
          </div>
        </div>

        {/* Schedule */}
        <div className="border-t border-slate-100 pt-4">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" /> Daily schedule (IST)
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={23}
              value={form.schedule_hour}
              onChange={(e) =>
                setForm((f) => ({ ...f, schedule_hour: e.target.value.replace(/[^0-9]/g, "") }))
              }
              className="h-10 w-20 rounded-sm text-center font-mono"
              disabled={loading}
            />
            <span className="font-bold text-slate-500">:</span>
            <Input
              type="number"
              min={0}
              max={59}
              value={form.schedule_minute}
              onChange={(e) =>
                setForm((f) => ({ ...f, schedule_minute: e.target.value.replace(/[^0-9]/g, "") }))
              }
              className="h-10 w-20 rounded-sm text-center font-mono"
              disabled={loading}
            />
            <span className="text-xs text-slate-500 ml-2">24-hour, India Standard Time</span>
          </div>
        </div>

        {/* Save */}
        <div className="border-t border-slate-100 pt-4 flex flex-wrap justify-end gap-2">
          <Button
            onClick={save}
            disabled={saving || loading}
            className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold"
          >
            <Save className="w-4 h-4 mr-1.5" />
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>

        {/* Manual actions */}
        <div className="border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-sm border border-slate-200 p-3">
            <div className="text-sm font-bold text-slate-900 inline-flex items-center gap-1.5">
              <Play className="w-4 h-4 text-emerald-600" /> Backup now
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Build a fresh backup ZIP and email it immediately.
            </p>
            <Button
              onClick={runNow}
              disabled={running || loading || !s?.gmail_app_password_set}
              className="mt-3 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-sm h-9 font-bold"
            >
              {running ? "Running…" : "Backup now"}
            </Button>
          </div>

          <div className="rounded-sm border border-slate-200 p-3">
            <div className="text-sm font-bold text-slate-900 inline-flex items-center gap-1.5">
              <Upload className="w-4 h-4 text-amber-600" /> Restore from file
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Upload a previously emailed <span className="font-mono">.zip</span> backup. This <span className="font-bold text-rose-700">replaces all current data</span>.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              onChange={onPickRestoreFile}
              className="hidden"
            />
            <Button
              onClick={() => fileRef.current?.click()}
              disabled={restoring || loading}
              variant="outline"
              className="mt-3 w-full rounded-sm h-9 font-bold border-amber-300 text-amber-800 hover:bg-amber-50"
            >
              {restoring ? "Restoring…" : "Choose .zip and restore"}
            </Button>
          </div>
        </div>
      </div>

      {/* Confirm restore dialog */}
      <Dialog open={restoreConfirmOpen} onOpenChange={(open) => {
        if (!restoring) {
          setRestoreConfirmOpen(open);
          if (!open) {
            setPendingFile(null);
            if (fileRef.current) fileRef.current.value = "";
          }
        }
      }}>
        <DialogContent className="rounded-sm sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-700">
              <AlertTriangle className="w-5 h-5" />
              Replace all current data?
            </DialogTitle>
            <DialogDescription>
              Restoring will <span className="font-bold">delete every existing record</span> in this database
              and reload it from the backup file. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs bg-slate-50 border border-slate-200 rounded-sm p-2.5">
            <div><span className="font-bold">File:</span> {pendingFile?.name}</div>
            <div><span className="font-bold">Size:</span> {pendingFile ? fmtBytes(pendingFile.size) : "—"}</div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRestoreConfirmOpen(false);
                setPendingFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              disabled={restoring}
              className="rounded-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={doRestore}
              disabled={restoring}
              className="rounded-sm bg-rose-600 hover:bg-rose-700 text-white font-bold"
            >
              {restoring ? "Restoring…" : "Yes, replace everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
