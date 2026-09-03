import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth";
import Login from "@/pages/Login";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Orders from "@/pages/Orders";
import NewOrder from "@/pages/NewOrder";
import Customers from "@/pages/Customers";
import Dispatch from "@/pages/Dispatch";
import Products from "@/pages/Products";
import AdminUsers from "@/pages/AdminUsers";
import AdminSettings from "@/pages/AdminSettings";
import PriceLists from "@/pages/PriceLists";
import DailyReport from "@/pages/DailyReport";
import Estimates from "@/pages/Estimates";
import LoginAttestations from "@/pages/LoginAttestations";
import DispatchLedger from "@/pages/DispatchLedger";
import Suppliers from "@/pages/Suppliers";
import SupplierLedger from "@/pages/SupplierLedger";
import PurchaseCenter from "@/pages/PurchaseCenter";
import RawMaterials from "@/pages/RawMaterials";
import VendorPriceLists from "@/pages/VendorPriceLists";
import VendorLedger from "@/pages/VendorLedger";
import InstallPrompt from "@/components/InstallPrompt";
import ErrorBoundary from "@/components/ErrorBoundary";
import "@/App.css";

function Protected({ children, adminOnly = false, permKey = null, permKeys = null }) {
  const { user, loading, isAdmin, can } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-10 text-center text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  const keys = permKeys || (permKey ? [permKey] : []);
  // Admins bypass everything EXCEPT explicit hard-denials (e.g. the JK1 demo
  // account is blocked from the Users page). When a route declares keys and
  // the user is denied ALL of them, redirect even for admins.
  if (isAdmin) {
    if (keys.length && !keys.some((k) => can(k))) return <Navigate to="/" replace />;
    return children;
  }
  // Accept access if ANY of the supplied keys is granted (permKeys) or the
  // single permKey is granted. An explicit grant OVERRIDES the route's
  // `adminOnly` default — otherwise the admin's grant has no visible effect.
  if (keys.length && keys.some((k) => can(k))) return children;
  if (adminOnly) return <Navigate to="/" replace />;
  if (keys.length) return <Navigate to="/" replace />;
  return children;
}

// Landing route ("/"): admins and users with dashboard access see the
// Dashboard. A restricted user (e.g. "Add New Order" only) is sent straight
// to the page they can actually use so they never hit an empty dashboard.
function Landing() {
  const { isAdmin, can } = useAuth();
  if (isAdmin || can("dashboard")) return <Dashboard />;
  if (can("newOrder") || can("orders")) return <Navigate to="/orders/new" replace />;
  return <Dashboard />;
}

// Reads the current location so the ErrorBoundary can reset itself whenever
// the route changes (navigating away from a broken page recovers the UI).
function RoutedBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

export default function App() {
  React.useEffect(() => {
    // Global guard: stop the mouse wheel from changing the value of any
    // <input type="number"> anywhere in the app. When a number field is
    // focused and the pointer scrolls over it, the browser would otherwise
    // increment/decrement the quantity. Blurring on wheel lets the page
    // scroll normally and leaves the entered quantity untouched.
    const onWheel = (e) => {
      const el = document.activeElement;
      if (
        el &&
        el.tagName === "INPUT" &&
        el.type === "number" &&
        (el === e.target || el.contains?.(e.target))
      ) {
        el.blur();
      }
    };
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <RoutedBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route index element={<Landing />} />
              <Route path="orders" element={<Protected permKey="orders"><Orders /></Protected>} />
              <Route path="orders/new" element={<Protected permKeys={["orders", "newOrder"]}><NewOrder /></Protected>} />
              <Route path="customers" element={<Protected permKey="customers"><Customers /></Protected>} />
              <Route path="dispatch" element={<Protected permKey="dispatch"><Dispatch /></Protected>} />
              <Route path="purchase-center" element={<Protected adminOnly permKey="purchaseCenter"><PurchaseCenter /></Protected>} />
              <Route path="dispatch-ledger" element={<Protected permKey="dispatchLedger"><DispatchLedger /></Protected>} />
              <Route path="products" element={<Protected permKey="products"><Products /></Protected>} />
              <Route path="admin/raw-materials" element={<Protected adminOnly permKey="rawMaterials"><RawMaterials /></Protected>} />
              <Route path="reports/daily" element={<Protected permKey="dailyReport"><DailyReport /></Protected>} />
              <Route path="estimates" element={<Protected permKey="estimates"><Estimates /></Protected>} />
              <Route path="admin/users" element={<Protected adminOnly permKey="adminUsers"><AdminUsers /></Protected>} />
              <Route path="admin/price-lists" element={<Protected adminOnly permKey="priceLists"><PriceLists /></Protected>} />
              <Route path="admin/vendor-price-lists" element={<Protected adminOnly permKey="vendorPriceLists"><VendorPriceLists /></Protected>} />
              <Route path="admin/settings" element={<Protected adminOnly permKey="adminSettings"><AdminSettings /></Protected>} />
              <Route path="admin/login-attestations" element={<Protected adminOnly permKey="loginAudit"><LoginAttestations /></Protected>} />
              <Route path="admin/suppliers" element={<Protected adminOnly permKey="vendorLedger"><VendorLedger /></Protected>} />
              <Route path="admin/vendors" element={<Protected adminOnly permKey="suppliers"><Suppliers /></Protected>} />
              <Route path="admin/suppliers/:id" element={<Protected adminOnly permKey="vendorLedger"><SupplierLedger /></Protected>} />
              <Route path="admin/dispatch-ledger" element={<Navigate to="/dispatch-ledger" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RoutedBoundary>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
      <InstallPrompt />
    </AuthProvider>
  );
}
