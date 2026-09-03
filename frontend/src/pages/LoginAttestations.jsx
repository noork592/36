import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ShieldCheck, MapPin, RefreshCcw, X, Camera, CheckCircle2, AlertTriangle } from "lucide-react";

const PAGE = 50;
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mapsLink(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export default function LoginAttestations() {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterConsent, setFilterConsent] = useState("all"); // all | yes | no
  const [active, setActive] = useState(null); // record being viewed in modal
  const [token, setToken] = useState(localStorage.getItem("foms_token") || "");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: PAGE, skip };
      if (filterConsent === "yes") params.consent = true;
      if (filterConsent === "no") params.consent = false;
      const { data } = await api.get("/admin/login-attestations", { params });
      setItems(data.items || []);
      setTotal(data.total || 0);
      setToken(localStorage.getItem("foms_token") || "");
    } finally {
      setLoading(false);
    }
  }, [skip, filterConsent]);

  useEffect(() => { load(); }, [load]);

  const photoUrl = (id) => `${BACKEND}/api/admin/login-attestations/${id}/photo${token ? `?_t=${encodeURIComponent(token).slice(0, 8)}` : ""}`;

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const currentPage = Math.floor(skip / PAGE) + 1;

  return (
    <div className="space-y-5" data-testid="login-attestations-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#E65100] font-bold">{t("loginAudit.overline")}</div>
          <h1 className="font-heading text-2xl sm:text-3xl font-extrabold text-slate-900">{t("loginAudit.title")}</h1>
          <p className="text-slate-500 text-sm mt-1">{t("loginAudit.subtitle")}</p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={filterConsent}
            onChange={(e) => { setFilterConsent(e.target.value); setSkip(0); }}
            data-testid="filter-consent"
            className="h-10 rounded-sm border border-slate-300 px-3 text-sm bg-white"
          >
            <option value="all">{t("loginAudit.filterAll")}</option>
            <option value="yes">{t("loginAudit.filterConsented")}</option>
            <option value="no">{t("loginAudit.filterDeclined")}</option>
          </select>
          <Button onClick={load} variant="outline" className="rounded-sm h-10" data-testid="refresh-btn">
            <RefreshCcw className="w-4 h-4 mr-1" /> {t("loginAudit.refresh")}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colWhen")}</th>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colUser")}</th>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colIp")}</th>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colLocation")}</th>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colConsent")}</th>
              <th className="text-left px-4 py-2 font-bold">{t("loginAudit.colPhoto")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8">{t("loginAudit.loading")}</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8">{t("loginAudit.empty")}</td></tr>
            )}
            {!loading && items.map((r) => (
              <tr
                key={r.id}
                onClick={() => setActive(r)}
                className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                data-testid={`attestation-row-${r.id}`}
              >
                <td className="px-4 py-2 font-mono-num text-xs whitespace-nowrap">{fmtDate(r.created_at)}</td>
                <td className="px-4 py-2">
                  <div className="font-bold text-slate-800">{r.user_name || r.username}</div>
                  <div className="text-[11px] text-slate-500">{r.user_email}</div>
                </td>
                <td className="px-4 py-2 font-mono-num text-xs text-slate-600">{r.ip || "—"}</td>
                <td className="px-4 py-2 text-xs">
                  {r.latitude != null && r.longitude != null ? (
                    <a href={mapsLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer"
                       onClick={(e) => e.stopPropagation()}
                       className="text-[#E65100] hover:underline inline-flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
                    </a>
                  ) : (
                    <span className="text-slate-400">{t("loginAudit.locUnavailable")}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.consent ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5" /> {t("loginAudit.yes")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700">
                      <AlertTriangle className="w-3.5 h-3.5" /> {t("loginAudit.no")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.has_photo ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-700">
                      <Camera className="w-3.5 h-3.5" /> {t("loginAudit.yes")}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <div>{t("loginAudit.totalLabel")}: <span className="font-bold font-mono-num text-slate-700">{total}</span></div>
        <div className="flex gap-1 items-center">
          <Button variant="outline" size="sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>«</Button>
          <span className="px-2 font-mono-num">{currentPage} / {pages}</span>
          <Button variant="outline" size="sm" disabled={skip + PAGE >= total} onClick={() => setSkip(skip + PAGE)}>»</Button>
        </div>
      </div>

      {/* Detail modal */}
      {active && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/70 px-4" onClick={() => setActive(null)}>
          <div className="bg-white rounded-md shadow-2xl max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#E65100]" />
                <h3 className="font-heading font-extrabold text-slate-900">{active.user_name || active.username}</h3>
              </div>
              <button onClick={() => setActive(null)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                {active.has_photo ? (
                  // Authenticated photo fetch — use Img component with token header would need to be a Blob;
                  // simplest approach: render with token in URL via fetch+blob URL
                  <PhotoLoader id={active.id} alt={`Login photo ${active.id}`} />
                ) : (
                  <div className="w-full aspect-[4/3] bg-slate-100 border border-slate-200 rounded-sm flex items-center justify-center text-slate-400 text-sm">
                    {t("loginAudit.noPhoto")}
                  </div>
                )}
              </div>
              <div className="space-y-2 text-xs">
                <DetailRow label={t("loginAudit.colWhen")} value={fmtDate(active.created_at)} mono />
                <DetailRow label={t("loginAudit.colUser")} value={`${active.user_name || active.username} (${active.user_email})`} />
                <DetailRow label={t("loginAudit.role")} value={active.role || "—"} />
                <DetailRow label={t("loginAudit.colIp")} value={active.ip || "—"} mono />
                <DetailRow label={t("loginAudit.colConsent")} value={active.consent ? t("loginAudit.yes") : t("loginAudit.no")} />
                <DetailRow
                  label={t("loginAudit.colLocation")}
                  value={
                    active.latitude != null && active.longitude != null ? (
                      <a href={mapsLink(active.latitude, active.longitude)} target="_blank" rel="noreferrer" className="text-[#E65100] hover:underline">
                        {active.latitude}, {active.longitude}
                        {active.accuracy_meters ? <span className="text-slate-400"> (±{Math.round(active.accuracy_meters)}m)</span> : null}
                      </a>
                    ) : t("loginAudit.locUnavailable")
                  }
                />
                <DetailRow label={t("loginAudit.userAgent")} value={<span className="break-all">{active.user_agent || "—"}</span>} small />
                {active.error && <DetailRow label={t("loginAudit.errors")} value={<span className="text-amber-700">{active.error}</span>} small />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono, small }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{label}</div>
      <div className={`text-slate-800 ${mono ? "font-mono-num" : ""} ${small ? "text-[11px]" : ""}`}>{value}</div>
    </div>
  );
}

function PhotoLoader({ id, alt }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let revoke = null;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get(`/admin/login-attestations/${id}/photo`, { responseType: "blob" });
        if (cancelled) return;
        const url = URL.createObjectURL(resp.data);
        revoke = url;
        setSrc(url);
      } catch (e) {
        if (!cancelled) setErr(e?.response?.status === 404 ? "not found" : "load failed");
      }
    })();
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [id]);
  if (err) return <div className="w-full aspect-[4/3] bg-slate-100 border border-slate-200 rounded-sm flex items-center justify-center text-slate-400 text-sm">{err}</div>;
  if (!src) return <div className="w-full aspect-[4/3] bg-slate-100 border border-slate-200 rounded-sm flex items-center justify-center text-slate-400 text-sm">Loading…</div>;
  return <img src={src} alt={alt} className="w-full rounded-sm border border-slate-200" />;
}
