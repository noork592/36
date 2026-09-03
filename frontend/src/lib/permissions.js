// Centralised permission catalog. Must stay in sync with backend
// ALL_PERMISSION_KEYS and DEFAULT_USER_PERMISSIONS.

// Every nav key that can be granted / revoked.
export const ALL_PERMISSION_KEYS = [
  "dashboard", "orders", "newOrder", "dispatch", "purchaseCenter", "dispatchLedger", "vendorLedger", "dailyReport",
  "estimates",
  "customers", "products", "rawMaterials", "suppliers",
  "priceLists", "vendorPriceLists",
  "adminUsers", "adminSettings", "loginAudit",
];

// Default allowlist for non-admin users when `permissions` is unset (null).
export const DEFAULT_USER_PERMISSIONS = [
  "dashboard", "orders", "dispatch", "dispatchLedger", "dailyReport",
  "estimates",
  "customers", "products",
];

// Friendly labels for the Manage-access dialog.
export const PERMISSION_LABELS = {  dashboard: "Dashboard",
  orders: "Orders",
  newOrder: "Add New Order",
  dispatch: "Dispatch Center",
  dispatchLedger: "Customer Ledger",
  vendorLedger: "Vendor Ledger",
  dailyReport: "Dispatch Report",
  estimates: "Estimates",
  purchaseCenter: "Purchase Center",
  customers: "Customers (Party Directory)",
  products: "Products",
  rawMaterials: "Raw Materials",
  suppliers: "Vendors (master)",
  priceLists: "Customer Price Lists",
  vendorPriceLists: "Vendor Price Lists",
  adminUsers: "Users (admin)",
  adminSettings: "Workflow Rules (admin)",
  loginAudit: "Login Audit (admin)",
};

// ---- Fine-grained edit / delete action permissions ----
// SEPARATE toggles for edit vs delete, one pair per module. Stored in the same
// `permissions` array as nav keys; the distinct `edit:` / `delete:` prefixes
// keep them from clashing. Must stay in sync with backend ACTION_PERMISSION_KEYS.
export const ACTION_PERMISSION_KEYS = [
  "edit:customers", "delete:customers",
  "edit:products", "delete:products",
  "edit:rawMaterials", "delete:rawMaterials",
  "edit:suppliers", "delete:suppliers",
  "edit:vendorLedger", "delete:vendorLedger",
  "edit:customerLedger", "delete:customerLedger",
  "edit:orders", "delete:orders",
  "edit:dispatch", "delete:dispatch",
  "edit:priceLists", "delete:priceLists",
  "edit:vendorPriceLists", "delete:vendorPriceLists",
];

export const ACTION_PERMISSION_LABELS = {
  "edit:customers": "Edit customer list",
  "delete:customers": "Delete customer list",
  "edit:products": "Edit products list",
  "delete:products": "Delete products list",
  "edit:rawMaterials": "Edit raw material",
  "delete:rawMaterials": "Delete raw material",
  "edit:suppliers": "Edit vendor list",
  "delete:suppliers": "Delete vendor list",
  "edit:vendorLedger": "Edit vendor ledger",
  "delete:vendorLedger": "Delete vendor ledger",
  "edit:customerLedger": "Edit customer ledger",
  "delete:customerLedger": "Delete customer ledger",
  "edit:orders": "Edit all orders",
  "delete:orders": "Delete all orders",
  "edit:dispatch": "Edit dispatch report",
  "delete:dispatch": "Delete dispatch report",
  "edit:priceLists": "Edit customer price list",
  "delete:priceLists": "Delete customer price list",
  "edit:vendorPriceLists": "Edit vendor price list",
  "delete:vendorPriceLists": "Delete vendor price list",
};

// Resolve a user's effective set of allowed keys.
// - admin role  → null  (means "all"; callers should treat as a wildcard)
// - permissions field is an array → that exact set
// - otherwise → DEFAULT_USER_PERMISSIONS
export function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === "admin") return null;
  if (Array.isArray(user.permissions)) return user.permissions;
  return DEFAULT_USER_PERMISSIONS;
}

// Demo accounts that must be blocked from specific admin areas even though
// they carry the admin role. JK1 is a read-only demo login and must NOT be
// able to open the Users management page (where all users are listed).
export const DEMO_USERNAMES = ["JK1"];
export const DEMO_DENIED_KEYS = ["adminUsers"];

export function isDemoDenied(user, key) {
  if (!user) return false;
  const uname = String(user.username || "").trim().toUpperCase();
  return (
    DEMO_USERNAMES.map((u) => u.toUpperCase()).includes(uname) &&
    DEMO_DENIED_KEYS.includes(key)
  );
}

// True if the user can access the given nav key.
export function hasPermission(user, key) {
  if (!user) return false;
  // Hard denials (demo accounts) override the admin wildcard.
  if (isDemoDenied(user, key)) return false;
  if (user.role === "admin") return true;
  const perms = effectivePermissions(user);
  return Array.isArray(perms) && perms.includes(key);
}
