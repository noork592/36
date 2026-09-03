import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Save, AlertTriangle, Clock, Lock, Info } from "lucide-react";
import PwaHealth from "@/components/PwaHealth";
import BackupRestore from "@/components/BackupRestore";

// Software release version — surfaced in Admin Settings so operators can
// quickly confirm which build they are running when reporting issues.
const APP_VERSION = "1.0.1";

export default function AdminSettings() {
  const { t } = useTranslation();
  const [overdueDays, setOverdueDays] = useState("15");
  const [editWindowDays, setEditWindowDays] = useState("3");
  const [loading, setLoading] = useState(true);
  const [savingOverdue, setSavingOverdue] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/settings");
      setOverdueDays(String(data.overdue_days ?? 15));
      setEditWindowDays(String(data.edit_window_days ?? 3));
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("common.failed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const saveOverdue = async () => {
    const n = Number(overdueDays);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      toast.error(t("settings.errors.invalidDays"));
      return;
    }
    setSavingOverdue(true);
    try {
      await api.patch("/settings", { overdue_days: n });
      toast.success(t("settings.saved"));
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("common.failed"));
    } finally {
      setSavingOverdue(false);
    }
  };

  const saveEditWindow = async () => {
    const n = Number(editWindowDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      toast.error("Enter a whole number between 0 and 365");
      return;
    }
    setSavingEdit(true);
    try {
      await api.patch("/settings", { edit_window_days: n });
      toast.success("Edit window saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || t("common.failed"));
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="admin-settings-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("settings.overline")}</div>
        <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("settings.title")}</h1>
        <p className="text-slate-500 text-sm mt-1">{t("settings.subtitle")}</p>
      </div>

      {/* Overdue threshold */}
      <div className="bg-white border border-slate-200 rounded-sm max-w-2xl">
        <div className="p-5 border-b border-slate-200 flex items-center gap-3">
          <div className="w-10 h-10 rounded-sm bg-rose-50 border border-rose-200 grid place-items-center text-rose-600">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <div className="font-bold text-slate-900">{t("settings.overdueTitle")}</div>
            <div className="text-xs text-slate-500">{t("settings.overdueSub")}</div>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">{t("settings.overdueDaysLabel")}</Label>
            <div className="mt-1.5 flex items-center gap-3">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={overdueDays}
                onChange={(e) => setOverdueDays(e.target.value.replace(/[^0-9]/g, ""))}
                onFocus={(e) => e.target.select()}
                data-testid="overdue-days-input"
                disabled={loading}
                className="h-11 w-32 rounded-sm font-mono-num text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-sm text-slate-500">{t("settings.daysSuffix")}</span>
            </div>
            <div className="mt-2 flex items-start gap-2 text-xs text-slate-500">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-rose-500 shrink-0" />
              <span>{t("settings.overdueHint")}</span>
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex justify-end">
            <Button
              onClick={saveOverdue}
              disabled={savingOverdue || loading}
              data-testid="overdue-days-save"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold"
            >
              <Save className="w-4 h-4 mr-1.5" />
              {savingOverdue ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      {/* Dispatch edit window — admin-configurable */}
      <div className="bg-white border border-slate-200 rounded-sm max-w-2xl">
        <div className="p-5 border-b border-slate-200 flex items-center gap-3">
          <div className="w-10 h-10 rounded-sm bg-amber-50 border border-amber-200 grid place-items-center text-amber-600">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <div className="font-bold text-slate-900">Dispatch edit window</div>
            <div className="text-xs text-slate-500">
              How many days after a dispatch is punched can operators (non-admin users) still edit it. Admins are never restricted.
            </div>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-700">User edit window</Label>
            <div className="mt-1.5 flex items-center gap-3">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                value={editWindowDays}
                onChange={(e) => setEditWindowDays(e.target.value.replace(/[^0-9]/g, ""))}
                onFocus={(e) => e.target.select()}
                data-testid="edit-window-days-input"
                disabled={loading}
                className="h-11 w-32 rounded-sm font-mono-num text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-sm text-slate-500">day(s)</span>
            </div>
            <div className="mt-2 flex items-start gap-2 text-xs text-slate-500">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
              <span>
                Set to <span className="font-mono font-bold">0</span> to lock dispatch edits entirely for users (admin-only edits).
                Default is <span className="font-mono font-bold">3</span> days.
              </span>
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex justify-end">
            <Button
              onClick={saveEditWindow}
              disabled={savingEdit || loading}
              data-testid="edit-window-days-save"
              className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold"
            >
              <Save className="w-4 h-4 mr-1.5" />
              {savingEdit ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      {/* PWA & Security health */}
      <div className="max-w-2xl">
        <PwaHealth />
      </div>

      {/* Backup & Restore */}
      <BackupRestore />

      {/* Software version card — quick reference for support / release tracking */}
      <div className="bg-white border border-slate-200 rounded-sm max-w-2xl">
        <div className="p-5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-sm bg-slate-50 border border-slate-200 grid place-items-center text-slate-600">
            <Info className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <div className="font-bold text-slate-900">Software version</div>
            <div className="text-xs text-slate-500">Current build running on this device.</div>
          </div>
          <div
            data-testid="app-version-badge"
            className="font-mono-num text-base font-extrabold text-[#E65100] bg-orange-50 border border-orange-200 rounded-sm px-3 py-1.5"
          >
            v{APP_VERSION}
          </div>
        </div>
      </div>
    </div>
  );
}
