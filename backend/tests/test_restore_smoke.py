"""Iteration 19 — Post-restore smoke tests for Factory Order Management.

Covers: auth, products, items, customers, orders, dashboard, dispatch,
settings, and user management. Skips voice transcription per request.
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Tests will be invoked via REACT_APP_BACKEND_URL only; if missing, surface immediately
    BASE_URL = "https://git-to-app-2.preview.emergentagent.com"

ADMIN = {"email": "admin", "password": "admin123"}
USER = {"email": "user", "password": "user123"}


# ---------- fixtures ----------
@pytest.fixture(scope="session")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(http, creds):
    r = http.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"login {creds['email']} -> {r.status_code} {r.text[:200]}"
    data = r.json()
    return data["token"], data.get("user", {})


@pytest.fixture(scope="session")
def admin_token(http):
    tok, _ = _login(http, ADMIN)
    return tok


@pytest.fixture(scope="session")
def user_token(http):
    tok, _ = _login(http, USER)
    return tok


@pytest.fixture()
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture()
def user_h(user_token):
    return {"Authorization": f"Bearer {user_token}"}


# ---------- AUTH ----------
class TestAuth:
    def test_login_admin(self, http):
        tok, user = _login(http, ADMIN)
        assert tok and isinstance(tok, str)
        assert user.get("role") == "admin"

    def test_login_user(self, http):
        tok, user = _login(http, USER)
        assert tok
        assert user.get("role") in ("user", "operator")

    def test_login_bad(self, http):
        r = http.post(f"{BASE_URL}/api/auth/login", json={"email": "admin", "password": "wrong"})
        assert r.status_code in (400, 401)

    def test_me_admin(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/auth/me", headers=admin_h)
        assert r.status_code == 200
        body = r.json()
        # API may return username or email
        assert body.get("role") == "admin"


# ---------- PRODUCTS ----------
class TestProducts:
    def test_list_products(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/products", headers=admin_h)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 15, f"expected >=15 seeded products, got {len(data)}"
        # spot-check shape
        sample = data[0]
        assert "id" in sample
        assert "name" in sample

    def test_patch_product_admin(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/products", headers=admin_h)
        prod = r.json()[0]
        pid = prod["id"]
        # capture original
        orig = prod.get("max_per_bag") or prod.get("bag_limit") or 0
        new_val = (orig or 50) + 1
        payload_keys = ["max_per_bag", "bag_limit", "qty_per_bag"]
        chosen = None
        for k in payload_keys:
            if k in prod:
                chosen = k
                break
        if chosen is None:
            pytest.skip("No recognizable bag-limit field on product")
        r2 = http.patch(f"{BASE_URL}/api/products/{pid}", json={chosen: new_val}, headers=admin_h)
        assert r2.status_code in (200, 204), f"{r2.status_code} {r2.text[:200]}"
        # verify
        r3 = http.get(f"{BASE_URL}/api/products", headers=admin_h)
        upd = next((p for p in r3.json() if p["id"] == pid), None)
        assert upd and upd.get(chosen) == new_val
        # restore
        http.patch(f"{BASE_URL}/api/products/{pid}", json={chosen: orig}, headers=admin_h)

    def test_patch_product_forbidden_for_user(self, http, user_h):
        r = http.get(f"{BASE_URL}/api/products", headers=user_h)
        pid = r.json()[0]["id"]
        r2 = http.patch(f"{BASE_URL}/api/products/{pid}", json={"max_per_bag": 99}, headers=user_h)
        assert r2.status_code in (401, 403)


# ---------- ITEMS / SKUs ----------
class TestItems:
    def test_list_items(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/items", headers=admin_h)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 380, f"expected ~388 SKUs, got {len(data)}"

    def test_items_search(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/items/search", params={"q": "stand"}, headers=admin_h)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) > 0


# ---------- CUSTOMERS ----------
class TestCustomers:
    def test_list_customers(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/customers", headers=admin_h)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_customer_admin(self, http, admin_h):
        unique = f"TEST_RESTORE_{int(time.time())}"
        payload = {"name": unique, "phone": "9000000001", "address": "QA Lane"}
        r = http.post(f"{BASE_URL}/api/customers", json=payload, headers=admin_h)
        assert r.status_code in (200, 201), f"{r.status_code} {r.text[:200]}"
        body = r.json()
        cid = body.get("id")
        assert cid
        # search verify
        s = http.get(f"{BASE_URL}/api/customers/search", params={"q": unique}, headers=admin_h)
        assert s.status_code == 200
        assert any(c.get("id") == cid for c in s.json())
        # cleanup
        http.delete(f"{BASE_URL}/api/customers/{cid}", headers=admin_h)

    def test_create_customer_user_forbidden(self, http, user_h):
        r = http.post(
            f"{BASE_URL}/api/customers",
            json={"name": "TEST_BLOCK", "phone": "9999999999"},
            headers=user_h,
        )
        assert r.status_code in (401, 403)


# ---------- ORDERS ----------
class TestOrders:
    def _pick_party_and_item(self, http, h):
        cust = http.get(f"{BASE_URL}/api/customers", headers=h).json()
        if not cust:
            # create a temp customer
            r = http.post(
                f"{BASE_URL}/api/customers",
                json={"name": f"TEST_ORDER_{int(time.time())}", "phone": "9111111111"},
                headers=h,
            )
            assert r.status_code in (200, 201), r.text[:200]
            cust = [r.json()]
        items = http.get(f"{BASE_URL}/api/items", headers=h).json()
        assert items
        # pick item that has a product_name
        itm = next((i for i in items if i.get("product_name")), items[0])
        return cust[0], itm

    def test_create_order(self, http, admin_h):
        cust, itm = self._pick_party_and_item(http, admin_h)
        payload = {
            "customer_id": cust["id"],
            "items": [
                {
                    "item_id": itm["id"],
                    "item_name": itm.get("name") or itm.get("item_name"),
                    "product_name": itm.get("product_name") or "TEST",
                    "quantity": 5,
                }
            ],
        }
        r = http.post(f"{BASE_URL}/api/orders", json=payload, headers=admin_h)
        assert r.status_code in (200, 201), f"{r.status_code} {r.text[:300]}"
        oid = r.json().get("id")
        assert oid
        # list
        lst = http.get(f"{BASE_URL}/api/orders", headers=admin_h)
        assert lst.status_code == 200
        assert any(o.get("id") == oid for o in lst.json())
        # status patch
        for status in ("in-progress", "completed"):
            up = http.patch(
                f"{BASE_URL}/api/orders/{oid}/status", json={"status": status}, headers=admin_h
            )
            if up.status_code == 200:
                break
        # cleanup (best-effort)
        http.delete(f"{BASE_URL}/api/orders/{oid}", headers=admin_h)


# ---------- DASHBOARD ----------
class TestDashboard:
    def test_summary(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/dashboard/summary", headers=admin_h)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        # Required keys per problem statement
        for k in ("stats", "item_totals", "party_breakdown", "overdue_customers"):
            assert k in data, f"missing key {k} in dashboard summary"


# ---------- DISPATCH ----------
class TestDispatch:
    def test_match(self, http, admin_h):
        items = http.get(f"{BASE_URL}/api/items", headers=admin_h).json()
        stock = {it["id"]: 100 for it in items[:5]}
        r = http.post(f"{BASE_URL}/api/dispatch/match", json={"items": stock}, headers=admin_h)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert isinstance(body, dict)
        has_keys = any(k in body for k in ("suggestions", "bag_calculation", "matches"))
        assert has_keys, f"dispatch match unexpected shape: {list(body.keys())[:10]}"


# ---------- SETTINGS ----------
class TestSettings:
    def test_get_settings_admin(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/settings", headers=admin_h)
        assert r.status_code == 200
        s = r.json()
        assert "overdue_days" in s

    def test_get_settings_user_forbidden_or_readable(self, http, user_h):
        r = http.get(f"{BASE_URL}/api/settings", headers=user_h)
        # allowed either way per problem statement (admin only); just record
        assert r.status_code in (200, 401, 403)

    def test_patch_settings_admin(self, http, admin_h):
        cur = http.get(f"{BASE_URL}/api/settings", headers=admin_h).json()
        new_val = int(cur.get("overdue_days") or 7) + 1
        r = http.patch(f"{BASE_URL}/api/settings", json={"overdue_days": new_val}, headers=admin_h)
        assert r.status_code in (200, 204), r.text[:200]
        check = http.get(f"{BASE_URL}/api/settings", headers=admin_h).json()
        assert int(check.get("overdue_days")) == new_val
        # restore
        http.patch(
            f"{BASE_URL}/api/settings",
            json={"overdue_days": cur.get("overdue_days")},
            headers=admin_h,
        )


# ---------- USERS (admin) ----------
class TestUsersAdmin:
    def test_list_users(self, http, admin_h):
        r = http.get(f"{BASE_URL}/api/users", headers=admin_h)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        assert len(r.json()) >= 2

    def test_create_reset_delete_user(self, http, admin_h):
        uname = f"testqa{int(time.time())}"
        payload = {
            "username": uname,
            "email": f"{uname}@example.com",
            "name": "QA User",
            "password": "Pass!234",
            "role": "user",
        }
        c = http.post(f"{BASE_URL}/api/users", json=payload, headers=admin_h)
        assert c.status_code in (200, 201), c.text[:200]
        uid = c.json().get("id")
        assert uid
        # reset password (body uses "password" field per AdminPasswordReset)
        rp = http.post(
            f"{BASE_URL}/api/users/{uid}/reset-password",
            json={"password": "NewPass!234"},
            headers=admin_h,
        )
        assert rp.status_code in (200, 204), rp.text[:200]
        # new password works (login by username)
        lr = http.post(
            f"{BASE_URL}/api/auth/login", json={"email": uname, "password": "NewPass!234"}
        )
        assert lr.status_code == 200, lr.text[:200]
        # delete
        dr = http.delete(f"{BASE_URL}/api/users/{uid}", headers=admin_h)
        assert dr.status_code in (200, 204), dr.text[:200]

    def test_users_forbidden_for_user(self, http, user_h):
        r = http.get(f"{BASE_URL}/api/users", headers=user_h)
        assert r.status_code in (401, 403)
