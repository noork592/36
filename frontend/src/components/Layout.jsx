import React, { useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard, ClipboardList, Users, PackageCheck, Settings2, LogOut, Plus, Menu, X,
  ShieldCheck, Sliders, FileBarChart2, Tag, ChevronDown, ChevronRight, Cog,
  ScrollText, Building2, FileText, Boxes, Calculator,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import BrandMark from "@/components/BrandMark";
import VoiceAgent from "@/components/VoiceAgent";

// Top-level nav items always visible in the main sidebar.
const NAV = [
  { to: "/", key: "dashboard", icon: LayoutDashboard, end: true, testid: "nav-dashboard" },
  { to: "/orders/new", key: "newOrder", icon: Plus, testid: "nav-new-order", showKeys: ["newOrder", "orders"] },
  { to: "/orders", key: "orders", icon: ClipboardList, testid: "nav-orders" },
  { to: "/dispatch", key: "dispatch", icon: PackageCheck, testid: "nav-dispatch" },
  { to: "/purchase-center", key: "purchaseCenter", icon: FileText, testid: "nav-purchase-center", adminOnly: true },
  { to: "/dispatch-ledger", key: "dispatchLedger", icon: ScrollText, testid: "nav-dispatch-ledger" },
  { to: "/estimates", key: "estimates", icon: Calculator, testid: "nav-estimates" },
  { to: "/admin/suppliers", key: "vendorLedger", icon: Building2, testid: "nav-vendor-ledger", adminOnly: true },
  { to: "/reports/daily", key: "dailyReport", icon: FileBarChart2, testid: "nav-daily-report" },
];

// Items hidden under the collapsible "Settings" group. `adminOnly` items are
// not rendered for non-admin users.
const SETTINGS_NAV = [
  { to: "/customers", key: "customers", icon: Users, testid: "nav-customers", adminOnly: false },
  { to: "/products", key: "products", icon: Settings2, testid: "nav-products", adminOnly: false },
  { to: "/admin/raw-materials", key: "rawMaterials", icon: Boxes, testid: "nav-raw-materials", adminOnly: true },
  { to: "/admin/vendors", key: "suppliers", icon: Building2, testid: "nav-suppliers", adminOnly: true },
  { to: "/admin/price-lists", key: "priceLists", icon: Tag, testid: "nav-price-lists", adminOnly: true },
  { to: "/admin/vendor-price-lists", key: "vendorPriceLists", icon: Tag, testid: "nav-vendor-price-lists", adminOnly: true },
  { to: "/admin/users", key: "adminUsers", icon: ShieldCheck, testid: "nav-admin-users", adminOnly: true },
  { to: "/admin/settings", key: "adminSettings", icon: Sliders, testid: "nav-admin-settings", adminOnly: true },
  { to: "/admin/login-attestations", key: "loginAudit", icon: ScrollText, testid: "nav-login-audit", adminOnly: true },
];

export default function Layout() {
  const { user, logout, isAdmin, can } = useAuth();
  const { t } = useTranslation();
  const nav = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // Settings group expands automatically when user is on one of its child routes.
  const settingsActive = SETTINGS_NAV.some((n) => location.pathname.startsWith(n.to));
  const [settingsOpen, setSettingsOpen] = useState(settingsActive);
  // Re-sync when route changes
  React.useEffect(() => { if (settingsActive) setSettingsOpen(true); }, [settingsActive]);

  const handleLogout = () => { logout(); nav("/login"); };

  // Visibility:
  // - admins see everything (adminOnly flag is bypassed by `can`)
  // - non-admins see only items their effective permissions allow.
  // The adminOnly flag still drops things for legacy users without a custom
  // permission set, because DEFAULT_USER_PERMISSIONS excludes those keys.
  const visibleSettings = SETTINGS_NAV.filter((n) => can(n.key));
  const visibleNav = NAV.filter((n) => (n.showKeys ? n.showKeys.some((k) => can(k)) : can(n.key)));

  const renderNavLink = ({ to, key, icon: Icon, end, testid }, opts = {}) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={() => setOpen(false)}
      data-testid={testid}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 h-11 rounded-sm transition-colors text-sm ${
          isActive ? "bg-[#E65100] text-white font-bold" : "text-slate-300 hover:bg-slate-800 hover:text-white"
        } ${opts.nested ? "pl-9" : ""}`
      }
    >
      <Icon className="w-4 h-4" />
      <span>{t(`nav.${key}`)}</span>
    </NavLink>
  );

  const SidebarContent = (
    <>
      <div className="px-5 py-5 flex items-center gap-3 border-b border-slate-700">
        <BrandMark size={40} variant="dark" />
        <div>
          <div className="font-heading font-extrabold text-white tracking-wide leading-none">{t("nav.brand")}</div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 mt-0.5">{t("nav.brandSub")}</div>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {visibleNav.map((item) => renderNavLink(item))}

        {visibleSettings.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              data-testid="nav-settings-group"
              className={`w-full flex items-center gap-3 px-3 h-11 rounded-sm transition-colors text-sm ${
                settingsActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Cog className="w-4 h-4" />
              <span className="flex-1 text-left">{t("nav.settingsGroup")}</span>
              {settingsOpen ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {settingsOpen && (
              <div className="mt-1 space-y-1" data-testid="nav-settings-children">
                {visibleSettings.map((item) => renderNavLink(item, { nested: true }))}
              </div>
            )}
          </div>
        )}
      </nav>
      <div className="p-3 border-t border-slate-700">
        <div className="px-3 py-2">
          <div className="text-xs text-slate-400">{t("nav.signedInAs")}</div>
          <div className="text-sm text-white font-bold font-mono-num">{user?.username || user?.email}</div>
          <div className="mt-1 inline-block text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 bg-[#E65100] text-white font-bold rounded-sm">
            {user?.role}
          </div>
        </div>
        <Button onClick={handleLogout} data-testid="logout-btn"
                variant="ghost"
                className="w-full justify-start text-slate-300 hover:text-white hover:bg-slate-800 rounded-sm h-10">
          <LogOut className="w-4 h-4 mr-2" /> {t("nav.signOut")}
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-[100dvh] bg-[#F8FAFC] flex">
      {/* Desktop Sidebar */}
      <aside
        className="hidden md:flex w-64 bg-[#1E293B] text-white flex-col fixed inset-y-0 left-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      >
        {SidebarContent}
      </aside>

      {/* Mobile Sidebar Overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="bg-black/50 absolute inset-0" onClick={() => setOpen(false)} />
          <aside className="relative w-72 bg-[#1E293B] text-white flex-col flex z-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">{SidebarContent}</aside>
        </div>
      )}

      <div className="flex-1 md:ml-64 flex flex-col min-w-0">
        {/* Top bar — adds the iOS safe-area inset to its own padding so the
            controls inside stay below the dynamic island / notch, and the
            white bg fills the status-bar strip on iPhone PWA. */}
        <header
          className="sticky top-0 z-30 bg-white border-b border-slate-200 flex items-center gap-3 pt-[env(safe-area-inset-top)] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] sm:pl-[calc(1.5rem+env(safe-area-inset-left))] sm:pr-[calc(1.5rem+env(safe-area-inset-right))]"
          style={{ minHeight: "calc(3.5rem + env(safe-area-inset-top))" }}
        >
          <button data-testid="mobile-menu-btn" className="md:hidden p-2 -ml-2" onClick={() => setOpen(!open)}>
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="md:hidden">
            <BrandMark size={28} variant="brand" />
          </div>
          <div className="font-heading font-bold text-slate-900 truncate">{t("nav.appName")}</div>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
            <Button onClick={() => nav("/orders/new")} data-testid="topbar-new-order"
                    className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm h-10 px-4 font-bold active:scale-[0.98]">
              <Plus className="w-4 h-4 mr-1.5" /> <span className="hidden sm:inline">{t("nav.newOrder")}</span><span className="sm:hidden">{t("nav.new")}</span>
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 pb-[calc(15rem+env(safe-area-inset-bottom))] md:pb-[calc(10rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] sm:pl-[calc(1.5rem+env(safe-area-inset-left))] sm:pr-[calc(1.5rem+env(safe-area-inset-right))]">
          <Outlet />
        </main>
      </div>
      <VoiceAgent />
    </div>
  );
}
