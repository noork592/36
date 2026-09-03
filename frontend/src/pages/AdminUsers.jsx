import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { UserPlus, KeyRound, Trash2, Shield, User as UserIcon, Lock, RotateCcw, CheckCircle2, Bell, ClipboardList, Check, X } from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useConfirm } from "@/lib/useConfirm";
import { ALL_PERMISSION_KEYS, DEFAULT_USER_PERMISSIONS, PERMISSION_LABELS, ACTION_PERMISSION_KEYS, ACTION_PERMISSION_LABELS } from "@/lib/permissions";

export default function AdminUsers() {
  const { user: me } = useAuth();
  const { t } = useTranslation();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "user", username: "", otp_login: false, newOrderOnly: false });
  const [resetTarget, setResetTarget] = useState(null);
  const [newPwd, setNewPwd] = useState("");
  // Permissions dialog
  const [permTarget, setPermTarget] = useState(null);
  const [permSet, setPermSet] = useState(new Set());
  const [permSaving, setPermSaving] = useState(false);
  const [permAudit, setPermAudit] = useState([]);
  const [permAuditLoading, setPermAuditLoading] = useState(false);
  // Access report (matrix of every user's edit/delete grants)
  const [showReport, setShowReport] = useState(false);
  // Change alerts (global feed of who changed whose access)
  const [globalAudit, setGlobalAudit] = useState([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const [lastSeenAudit, setLastSeenAudit] = useState(
    () => localStorage.getItem("foms_access_audit_seen") || "",
  );
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/users");
      setUsers(data);
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Global access-change feed (who changed whose edit/delete access).
  const loadGlobalAudit = async () => {
    try {
      const { data } = await api.get("/permissions/audit", { params: { limit: 100 } });
      setGlobalAudit(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) { setGlobalAudit([]); }
  };
  useEffect(() => { loadGlobalAudit(); }, []);

  // Friendly label for any nav or action permission key.
  const labelFor = (k) => PERMISSION_LABELS[k] || ACTION_PERMISSION_LABELS[k] || k;

  // Modules for the access report matrix: [baseKey, short title].
  const REPORT_MODULES = [
    ["customers", "Customer list"],
    ["products", "Products"],
    ["rawMaterials", "Raw material"],
    ["suppliers", "Vendor list"],
    ["vendorLedger", "Vendor ledger"],
    ["customerLedger", "Customer ledger"],
    ["orders", "Orders"],
    ["dispatch", "Dispatch report"],
    ["priceLists", "Cust. price list"],
    ["vendorPriceLists", "Vend. price list"],
  ];
  // Resolve a user's grant for one module: { edit, delete }. Admins → both.
  const grantFor = (u, base) => {
    if (u.role === "admin") return { edit: true, delete: true, admin: true };
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return { edit: perms.includes(`edit:${base}`), delete: perms.includes(`delete:${base}`) };
  };

  // Unread access-change count = entries newer than the last time the admin
  // opened the alerts panel.
  const unreadAlerts = globalAudit.filter((r) => (r.when || "") > (lastSeenAudit || "")).length;
  const openAlerts = () => {
    setShowAlerts(true);
    const newest = globalAudit[0]?.when || new Date().toISOString();
    setLastSeenAudit(newest);
    localStorage.setItem("foms_access_audit_seen", newest);
  };

  const submitAdd = async () => {
    if (!form.email.trim() || !form.password.trim() || !form.name.trim()) {
      toast.error(t("adminUsers.errors.allFields")); return;
    }
    if (form.password.length < 6) {
      toast.error(t("adminUsers.errors.passwordShort")); return;
    }
    try {
      const payload = {
        email: form.email,
        name: form.name,
        password: form.password,
        role: form.role,
        username: form.username,
        otp_login: form.otp_login,
      };
      // "Add New Order only" → restrict this user to just the New Order page.
      if (form.role === "user" && form.newOrderOnly) {
        payload.permissions = ["newOrder"];
      }
      await api.post("/users", payload);
      toast.success(t("adminUsers.added", { email: form.username || form.email }));
      setShowAdd(false);
      setForm({ email: "", name: "", password: "", role: "user", username: "", otp_login: false, newOrderOnly: false });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const toggleOtp = async (u, next) => {
    try {
      await api.patch(`/users/${u.id}/otp`, { otp_login: next });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, otp_login: next } : x)));
      toast.success(next ? `OTP login enabled for ${u.username || u.email}` : `OTP login disabled for ${u.username || u.email}`);
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  const del = (u) => {
    if (u.id === me?.id) { toast.error(t("adminUsers.errors.selfDelete")); return; }
    confirm({
      title: t("adminUsers.confirmDeleteTitle"),
      description: t("adminUsers.confirmDelete", { email: u.username || u.email }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        closeConfirm();
        try {
          await api.delete(`/users/${u.id}`);
          toast.success(t("adminUsers.deleted"));
          load();
        } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
      },
    });
  };

  const submitReset = async () => {
    if (!newPwd || newPwd.length < 6) { toast.error(t("adminUsers.errors.passwordShort")); return; }
    try {
      await api.post(`/users/${resetTarget.id}/reset-password`, { password: newPwd });
      toast.success(t("adminUsers.passwordReset", { email: resetTarget.email }));
      setResetTarget(null); setNewPwd("");
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
  };

  // ---- Granular permissions ----
  const loadPermAudit = async (userId) => {
    setPermAuditLoading(true);
    try {
      const { data } = await api.get(`/users/${userId}/permissions/audit`, { params: { limit: 10 } });
      setPermAudit(data?.rows || []);
    } catch (e) { setPermAudit([]); }
    finally { setPermAuditLoading(false); }
  };
  const openPermDialog = (u) => {
    const seed = Array.isArray(u.permissions)
      ? u.permissions
      : (u.role === "admin" ? ALL_PERMISSION_KEYS : DEFAULT_USER_PERMISSIONS);
    setPermSet(new Set(seed));
    setPermTarget(u);
    loadPermAudit(u.id);
  };
  const togglePerm = (key) =>
    setPermSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const setPermAll = (on) => setPermSet(new Set(on ? ALL_PERMISSION_KEYS : []));
  const setActionAll = (on) =>
    setPermSet((prev) => {
      const next = new Set(prev);
      ACTION_PERMISSION_KEYS.forEach((k) => { if (on) next.add(k); else next.delete(k); });
      return next;
    });
  const resetPermsToDefault = () => setPermSet(new Set(DEFAULT_USER_PERMISSIONS));
  const clearPermsOverride = async () => {
    if (!permTarget) return;
    setPermSaving(true);
    try {
      await api.patch(`/users/${permTarget.id}/permissions`, { permissions: null });
      toast.success("Permissions reset to role defaults");
      // Refresh audit while leaving dialog open so admin can see the entry
      loadPermAudit(permTarget.id);
      loadGlobalAudit();
      setPermSet(new Set(DEFAULT_USER_PERMISSIONS));
      setPermTarget((u) => u ? { ...u, permissions: null } : u);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
    finally { setPermSaving(false); }
  };
  const savePerms = async () => {
    if (!permTarget) return;
    setPermSaving(true);
    try {
      const list = [...ALL_PERMISSION_KEYS, ...ACTION_PERMISSION_KEYS].filter((k) => permSet.has(k));
      const { data: updated } = await api.patch(`/users/${permTarget.id}/permissions`, { permissions: list });
      toast.success(`Access updated for ${permTarget.username || permTarget.email}`);
      loadPermAudit(permTarget.id);
      loadGlobalAudit();
      setPermTarget(updated);
      setPermSet(new Set(updated.permissions || []));
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || t("common.failed")); }
    finally { setPermSaving(false); }
  };

  return (
    <div className="space-y-5" data-testid="admin-users-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("adminUsers.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("adminUsers.title")}</h1>
          <p className="text-slate-500 text-sm mt-1">{t("adminUsers.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={openAlerts} variant="outline" data-testid="access-alerts-btn"
                  className="relative rounded-sm h-10 px-3 border-slate-300 font-bold">
            <Bell className="w-4 h-4 mr-1.5" /> Access changes
            {unreadAlerts > 0 && (
              <span data-testid="access-alerts-badge"
                    className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1.5 grid place-items-center rounded-full bg-[#E65100] text-white text-[11px] font-extrabold">
                {unreadAlerts > 99 ? "99+" : unreadAlerts}
              </span>
            )}
          </Button>
          <Button onClick={() => setShowReport(true)} variant="outline" data-testid="access-report-btn"
                  className="rounded-sm h-10 px-3 border-slate-300 font-bold">
            <ClipboardList className="w-4 h-4 mr-1.5" /> Access report
          </Button>
          <Button onClick={() => setShowAdd(true)} data-testid="add-user-btn"
                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold">
            <UserPlus className="w-4 h-4 mr-1.5" /> {t("adminUsers.newUser")}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        {loading ? <div className="p-10 text-center text-slate-400">{t("common.loading")}</div> :
         users.length === 0 ? <div className="p-10 text-center text-slate-400">{t("adminUsers.empty")}</div> :
         <div className="divide-y divide-slate-100">
           {users.map((u) => (
             <div key={u.id} data-testid={`user-row-${u.id}`}
                  className="p-4 sm:p-5 flex items-center justify-between gap-3 hover:bg-slate-50">
               <div className="flex items-center gap-3 min-w-0">
                 <div className={`w-10 h-10 rounded-sm grid place-items-center ${u.role === "admin" ? "bg-orange-50 border border-orange-200 text-[#E65100]" : "bg-slate-100 border border-slate-200 text-slate-600"}`}>
                   {u.role === "admin" ? <Shield className="w-5 h-5" /> : <UserIcon className="w-5 h-5" />}
                 </div>
                 <div className="min-w-0">
                   <div className="font-bold text-slate-900 flex items-center gap-2">
                     <span className="font-mono-num">{u.username || (u.email || "").split("@")[0]}</span>
                     {u.id === me?.id && (
                       <span className="text-[10px] uppercase tracking-wider font-bold bg-slate-900 text-white px-1.5 py-0.5 rounded-sm">
                         {t("adminUsers.you")}
                       </span>
                     )}
                   </div>
                   <div className="text-xs text-slate-500">{u.name || u.email}</div>
                   <div className="text-[10px] uppercase tracking-wider mt-1 inline-flex flex-wrap gap-1 items-center">
                     <span className="px-1.5 py-0.5 rounded-sm font-bold bg-slate-100 text-slate-700">{u.role}</span>
                     {u.role !== "admin" && Array.isArray(u.permissions) && (
                       <span
                         className="px-1.5 py-0.5 rounded-sm font-bold bg-orange-50 border border-orange-200 text-orange-900 inline-flex items-center gap-1"
                         data-testid={`user-row-${u.id}-custom-access`}
                         title={`${u.permissions.length} tab(s) allowed`}
                       >
                         <Lock className="w-2.5 h-2.5" /> Custom access · {u.permissions.length}
                       </span>
                     )}
                   </div>
                 </div>
               </div>
               <div className="flex items-center gap-2">
                 <div className="hidden sm:flex items-center gap-2 mr-1 px-2 py-1 rounded-sm border border-slate-200 bg-slate-50"
                      title="Require an email OTP as a second login step">
                   <span className="text-[10px] uppercase tracking-wider font-bold text-slate-600">OTP login</span>
                   <Switch
                     checked={!!u.otp_login}
                     onCheckedChange={(v) => toggleOtp(u, v)}
                     data-testid={`otp-toggle-${u.id}`}
                     className="data-[state=checked]:bg-[#E65100]"
                   />
                 </div>
                 {u.role !== "admin" && (
                   <Button size="sm" variant="outline"
                           data-testid={`manage-access-${u.id}`}
                           onClick={() => openPermDialog(u)}
                           className="rounded-sm border-slate-300">
                     <Lock className="w-3.5 h-3.5 mr-1" /> Access
                   </Button>
                 )}
                 <Button size="sm" variant="outline"
                         data-testid={`reset-password-${u.id}`}
                         onClick={() => { setResetTarget(u); setNewPwd(""); }}
                         className="rounded-sm border-slate-300">
                   <KeyRound className="w-3.5 h-3.5 mr-1" /> {t("adminUsers.resetBtn")}
                 </Button>
                 <Button size="sm" variant="outline"
                         data-testid={`delete-user-${u.id}`}
                         disabled={u.id === me?.id}
                         onClick={() => del(u)}
                         className="rounded-sm border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40">
                   <Trash2 className="w-3.5 h-3.5" />
                 </Button>
               </div>
             </div>
           ))}
         </div>}
      </div>

      {/* Add User Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("adminUsers.addTitle")}</DialogTitle>
            <DialogDescription>{t("adminUsers.addSub")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("adminUsers.username")}</Label>
              <Input value={form.username}
                     onChange={(e) => setForm((p) => ({ ...p, username: e.target.value.toLowerCase().replace(/\s/g, "") }))}
                     data-testid="add-user-username" className="h-11 rounded-sm mt-1 font-mono-num"
                     placeholder={t("adminUsers.usernamePlaceholder")} />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.name")}</Label>
              <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                     data-testid="add-user-name" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("common.email")}</Label>
              <Input type="email" value={form.email}
                     onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                     data-testid="add-user-email" className="h-11 rounded-sm mt-1" />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("adminUsers.password")}</Label>
              <Input type="text" value={form.password}
                     onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                     data-testid="add-user-password" className="h-11 rounded-sm mt-1 font-mono-num"
                     placeholder={t("adminUsers.passwordHint")} />
            </div>
            <div>
              <Label className="text-xs font-bold uppercase">{t("adminUsers.role")}</Label>
              <Select value={form.role} onValueChange={(v) => setForm((p) => ({ ...p, role: v }))}>
                <SelectTrigger data-testid="add-user-role" className="h-11 rounded-sm mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("adminUsers.roles.user")}</SelectItem>
                  <SelectItem value="admin">{t("adminUsers.roles.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Email OTP two-step login toggle */}
            <label className="flex items-center justify-between gap-3 border border-slate-200 rounded-sm px-3 py-2.5 cursor-pointer">
              <span>
                <span className="block text-xs font-bold uppercase text-slate-800">Require OTP on login</span>
                <span className="block text-[11px] text-slate-500 mt-0.5">Emails a 6-digit code as a second step at sign-in.</span>
              </span>
              <Switch
                checked={form.otp_login}
                onCheckedChange={(v) => setForm((p) => ({ ...p, otp_login: v }))}
                data-testid="add-user-otp"
                className="data-[state=checked]:bg-[#E65100]"
              />
            </label>
            {/* Restrict a normal user to only creating new orders */}
            {form.role === "user" && (
              <label className="flex items-center justify-between gap-3 border border-slate-200 rounded-sm px-3 py-2.5 cursor-pointer">
                <span>
                  <span className="block text-xs font-bold uppercase text-slate-800">Add New Order only</span>
                  <span className="block text-[11px] text-slate-500 mt-0.5">This user can only open the New Order page — nothing else.</span>
                </span>
                <Switch
                  checked={form.newOrderOnly}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, newOrderOnly: v }))}
                  data-testid="add-user-neworder-only"
                  className="data-[state=checked]:bg-[#E65100]"
                />
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={submitAdd} data-testid="add-user-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle className="font-heading">{t("adminUsers.resetTitle")}</DialogTitle>
            <DialogDescription>{t("adminUsers.resetSub", { email: resetTarget?.email })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-bold uppercase">{t("adminUsers.newPassword")}</Label>
              <Input type="text" value={newPwd}
                     onChange={(e) => setNewPwd(e.target.value)}
                     data-testid="reset-password-input" className="h-11 rounded-sm mt-1 font-mono-num"
                     placeholder={t("adminUsers.passwordHint")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)} className="rounded-sm">{t("common.cancel")}</Button>
            <Button onClick={submitReset} data-testid="reset-password-save"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
              <KeyRound className="w-4 h-4 mr-1" /> {t("adminUsers.resetBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) closeConfirm(); }}
        {...(confirmState || {})}
      />

      {/* Manage Access Dialog */}
      <Dialog open={!!permTarget} onOpenChange={(o) => { if (!o) setPermTarget(null); }}>
        <DialogContent className="rounded-sm max-w-xl" data-testid="manage-access-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Lock className="w-4 h-4 text-[#E65100]" />
              Manage access · {permTarget?.username || permTarget?.email}
            </DialogTitle>
            <DialogDescription>
              Tick a tab to allow this user to see and open it; untick to revoke. Admins always see everything regardless of this list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[11px] text-slate-500">
                {ALL_PERMISSION_KEYS.filter((k) => permSet.has(k)).length} of {ALL_PERMISSION_KEYS.length} tabs allowed
                {Array.isArray(permTarget?.permissions)
                  ? <span className="ml-2 inline-flex items-center gap-1 text-orange-900 font-bold uppercase tracking-wider"><Lock className="w-3 h-3" /> custom</span>
                  : <span className="ml-2 inline-flex items-center gap-1 text-slate-500 font-bold uppercase tracking-wider">default</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline"
                        onClick={() => setPermAll(true)}
                        data-testid="perm-select-all"
                        className="rounded-sm h-7">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Select all
                </Button>
                <Button type="button" size="sm" variant="outline"
                        onClick={() => setPermAll(false)}
                        data-testid="perm-clear-all"
                        className="rounded-sm h-7">
                  None
                </Button>
                <Button type="button" size="sm" variant="outline"
                        onClick={resetPermsToDefault}
                        data-testid="perm-defaults"
                        className="rounded-sm h-7">
                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Operator default
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 border border-slate-200 rounded-sm p-2">
              {ALL_PERMISSION_KEYS.map((key) => (
                <label key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-orange-50 cursor-pointer"
                       data-testid={`perm-row-${key}`}>
                  <input type="checkbox"
                         checked={permSet.has(key)}
                         onChange={() => togglePerm(key)}
                         data-testid={`perm-cb-${key}`}
                         className="accent-[#E65100]" />
                  <span className="text-sm font-bold text-slate-800 truncate">{PERMISSION_LABELS[key] || key}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{key}</span>
                </label>
              ))}
            </div>

            {/* Fine-grained edit / delete permissions */}
            <div className="border border-slate-200 rounded-sm" data-testid="action-perms-section">
              <div className="px-3 py-2 bg-orange-50 border-b border-orange-200 flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[11px] uppercase tracking-wider font-bold text-orange-900 inline-flex items-center gap-1.5">
                  <Lock className="w-3 h-3" /> Edit / Delete permissions
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline"
                          onClick={() => setActionAll(true)}
                          data-testid="action-grant-all"
                          className="rounded-sm h-7">
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Grant all
                  </Button>
                  <Button type="button" size="sm" variant="outline"
                          onClick={() => setActionAll(false)}
                          data-testid="action-revoke-all"
                          className="rounded-sm h-7">
                    Revoke all
                  </Button>
                </div>
              </div>
              <div className="px-3 py-2 text-[11px] text-slate-500">
                Grant Edit and Delete separately per module. When OFF for both, the user can only view.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-2 pt-0">
                {ACTION_PERMISSION_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-2 px-2 py-2 rounded-sm border border-slate-100 hover:bg-orange-50 cursor-pointer"
                         data-testid={`action-row-${key}`}>
                    <input type="checkbox"
                           checked={permSet.has(key)}
                           onChange={() => togglePerm(key)}
                           data-testid={`action-cb-${key}`}
                           className="accent-[#E65100]" />
                    <span className="text-sm font-semibold text-slate-800 truncate">{ACTION_PERMISSION_LABELS[key] || key}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Recent permission changes (audit trail) */}
            <div className="border border-slate-200 rounded-sm" data-testid="perm-audit-section">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider font-bold text-slate-600">Recent access changes</div>
                <div className="text-[10px] text-slate-400">{permAuditLoading ? "Loading…" : `${permAudit.length} entries`}</div>
              </div>
              {!permAuditLoading && permAudit.length === 0 ? (
                <div className="px-3 py-4 text-xs text-slate-400 italic text-center">No changes yet — saving below will log the first entry.</div>
              ) : (
                <div className="divide-y divide-slate-100 max-h-44 overflow-y-auto">
                  {permAudit.map((row) => (
                    <div key={row.id} className="px-3 py-2 text-xs" data-testid={`perm-audit-${row.id}`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="font-bold text-slate-800">
                          {row.kind === "clear" ? "Reset to defaults" : "Updated"} <span className="text-slate-400 font-normal">by</span> <span className="font-mono-num text-[#E65100]">{row.actor_username}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono-num">
                          {new Date(row.when).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                        </div>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {(row.added || []).map((k) => (
                          <span key={"a"+k} className="text-[10px] uppercase tracking-wider font-bold bg-emerald-50 border border-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded-sm">
                            + {PERMISSION_LABELS[k] || ACTION_PERMISSION_LABELS[k] || k}
                          </span>
                        ))}
                        {(row.removed || []).map((k) => (
                          <span key={"r"+k} className="text-[10px] uppercase tracking-wider font-bold bg-rose-50 border border-rose-200 text-rose-800 px-1.5 py-0.5 rounded-sm">
                            − {PERMISSION_LABELS[k] || ACTION_PERMISSION_LABELS[k] || k}
                          </span>
                        ))}
                        {(row.added || []).length === 0 && (row.removed || []).length === 0 && (
                          <span className="text-[10px] uppercase tracking-wider text-slate-400">No effective change</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="!justify-between flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={clearPermsOverride}
                    disabled={!Array.isArray(permTarget?.permissions) || permSaving}
                    data-testid="perm-clear-override"
                    className="rounded-sm">
              <RotateCcw className="w-4 h-4 mr-1" /> Clear custom (use role default)
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setPermTarget(null)} className="rounded-sm">Cancel</Button>
              <Button onClick={savePerms} disabled={permSaving}
                      data-testid="perm-save"
                      className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm">
                <CheckCircle2 className="w-4 h-4 mr-1" /> {permSaving ? "Saving…" : "Save access"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Access Report — matrix of every user's edit/delete grants */}
      <Dialog open={showReport} onOpenChange={setShowReport}>
        <DialogContent className="rounded-sm max-w-5xl" data-testid="access-report-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-[#E65100]" /> Access report
            </DialogTitle>
            <DialogDescription>
              Exactly which modules each user can Edit (E) or Delete (D). Admins have full access to everything.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto max-h-[65vh] border border-slate-200 rounded-sm">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-50 min-w-[140px]">User</th>
                  {REPORT_MODULES.map(([base, title]) => (
                    <th key={base} className="px-2 py-2 text-center text-[10px] uppercase tracking-wider font-bold text-slate-600 min-w-[92px] border-l border-slate-200">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`report-row-${u.id}`}>
                    <td className="px-3 py-2 sticky left-0 bg-white">
                      <div className="font-bold text-slate-900 font-mono-num">{u.username || (u.email || "").split("@")[0]}</div>
                      <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-sm ${u.role === "admin" ? "bg-orange-50 border border-orange-200 text-[#E65100]" : "bg-slate-100 text-slate-600"}`}>{u.role}</span>
                    </td>
                    {REPORT_MODULES.map(([base]) => {
                      const g = grantFor(u, base);
                      const Chip = ({ on, letter, tone }) => (
                        <span
                          title={`${letter === "E" ? "Edit" : "Delete"} ${on ? "allowed" : "blocked"}`}
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-sm text-[11px] font-extrabold border ${
                            on
                              ? (tone === "del" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700")
                              : "bg-slate-50 border-slate-200 text-slate-300"
                          }`}
                        >
                          {on ? letter : "–"}
                        </span>
                      );
                      return (
                        <td key={base} className="px-2 py-2 text-center border-l border-slate-100" data-testid={`report-cell-${u.id}-${base}`}>
                          <div className="inline-flex items-center gap-1">
                            <Chip on={g.edit} letter="E" tone="edit" />
                            <Chip on={g.delete} letter="D" tone="del" />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-500 pt-1">
            <span className="inline-flex items-center gap-1"><span className="inline-grid place-items-center w-5 h-5 rounded-sm bg-emerald-50 border border-emerald-200 text-emerald-700 font-extrabold text-[10px]">E</span> Edit allowed</span>
            <span className="inline-flex items-center gap-1"><span className="inline-grid place-items-center w-5 h-5 rounded-sm bg-rose-50 border border-rose-200 text-rose-700 font-extrabold text-[10px]">D</span> Delete allowed</span>
            <span className="inline-flex items-center gap-1"><span className="inline-grid place-items-center w-5 h-5 rounded-sm bg-slate-50 border border-slate-200 text-slate-300 font-extrabold text-[10px]">–</span> Not allowed</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReport(false)} className="rounded-sm">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Alerts — global feed of who changed whose access */}
      <Dialog open={showAlerts} onOpenChange={setShowAlerts}>
        <DialogContent className="rounded-sm max-w-xl" data-testid="access-alerts-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#E65100]" /> Access changes
            </DialogTitle>
            <DialogDescription>
              Every edit/delete access change, newest first — who changed it and for whom.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-sm">
            {globalAudit.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400 italic">No access changes yet.</div>
            ) : globalAudit.map((row) => (
              <div key={row.id} className="p-3" data-testid={`alert-row-${row.id}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-sm text-slate-800">
                    <span className="font-mono-num font-bold text-[#E65100]">{row.actor_username}</span>
                    <span className="text-slate-400"> {row.kind === "clear" ? "reset access for" : "changed access for"} </span>
                    <span className="font-mono-num font-bold text-slate-900">{row.target_username}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono-num">
                    {new Date(row.when).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(row.added || []).map((k) => (
                    <span key={"a" + k} className="text-[10px] uppercase tracking-wider font-bold bg-emerald-50 border border-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded-sm">
                      <Check className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />{labelFor(k)}
                    </span>
                  ))}
                  {(row.removed || []).map((k) => (
                    <span key={"r" + k} className="text-[10px] uppercase tracking-wider font-bold bg-rose-50 border border-rose-200 text-rose-800 px-1.5 py-0.5 rounded-sm">
                      <X className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />{labelFor(k)}
                    </span>
                  ))}
                  {(row.added || []).length === 0 && (row.removed || []).length === 0 && (
                    <span className="text-[10px] uppercase tracking-wider text-slate-400">No effective change</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAlerts(false)} className="rounded-sm">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
