"""Iteration 12 — Test short-username login, /api/settings get/patch, DELETE /api/customers/{cid}."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # fallback to read frontend/.env
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

API = f"{BASE_URL}/api"


def _login(ident, password):
    return requests.post(
        f"{API}/auth/login",
        json={"email": ident, "password": password},
        timeout=15,
    )


@pytest.fixture(scope="module")
def admin_token():
    r = _login("admin", "admin123")
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- Auth: short username login ----------
class TestLogin:
    def test_login_with_short_admin_username(self):
        r = _login("admin", "admin123")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "token" in data
        assert data["user"]["role"] == "admin"
        assert data["user"]["email"] == "admin@factory.com"
        # username field should be exposed
        assert data["user"].get("username") == "admin"

    def test_login_with_short_user_username(self):
        r = _login("user", "user123")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["user"]["role"] == "user"
        assert data["user"].get("username") == "user"

    def test_login_with_legacy_email_admin(self):
        r = _login("admin@factory.com", "admin123")
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"

    def test_login_with_legacy_email_user(self):
        r = _login("user@factory.com", "user123")
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "user"

    def test_login_invalid_credentials(self):
        r = _login("admin", "wrongpass")
        assert r.status_code == 401

    def test_login_unknown_user(self):
        r = _login("nonexistent_user", "whatever")
        assert r.status_code == 401


# ---------- Admin Settings ----------
class TestSettings:
    def test_get_settings_default(self, admin_headers):
        r = requests.get(f"{API}/settings", headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "overdue_days" in data
        assert isinstance(data["overdue_days"], int)

    def test_get_settings_requires_auth(self):
        r = requests.get(f"{API}/settings", timeout=10)
        assert r.status_code in (401, 403)

    def test_get_settings_as_user_allowed(self):
        tok = _login("user", "user123").json()["token"]
        r = requests.get(f"{API}/settings", headers={"Authorization": f"Bearer {tok}"}, timeout=10)
        assert r.status_code == 200

    def test_patch_settings_requires_admin(self):
        tok = _login("user", "user123").json()["token"]
        r = requests.patch(
            f"{API}/settings",
            json={"overdue_days": 20},
            headers={"Authorization": f"Bearer {tok}"},
            timeout=10,
        )
        assert r.status_code == 403

    def test_patch_settings_valid_and_persist(self, admin_headers):
        # Sanity check existing settings shape (no assertion on value — could be anything)
        requests.get(f"{API}/settings", headers=admin_headers).json()["overdue_days"]
        try:
            r = requests.patch(
                f"{API}/settings", json={"overdue_days": 7}, headers=admin_headers, timeout=10
            )
            assert r.status_code == 200, r.text
            assert r.json()["overdue_days"] == 7
            # Verify persistence with fresh GET
            r2 = requests.get(f"{API}/settings", headers=admin_headers, timeout=10)
            assert r2.json()["overdue_days"] == 7
        finally:
            # Restore to 15 (per request)
            requests.patch(
                f"{API}/settings", json={"overdue_days": 15}, headers=admin_headers, timeout=10
            )

    def test_patch_settings_invalid_zero(self, admin_headers):
        r = requests.patch(
            f"{API}/settings", json={"overdue_days": 0}, headers=admin_headers, timeout=10
        )
        assert r.status_code in (400, 422)

    def test_patch_settings_invalid_negative(self, admin_headers):
        r = requests.patch(
            f"{API}/settings", json={"overdue_days": -5}, headers=admin_headers, timeout=10
        )
        assert r.status_code in (400, 422)

    def test_patch_settings_invalid_too_large(self, admin_headers):
        r = requests.patch(
            f"{API}/settings", json={"overdue_days": 500}, headers=admin_headers, timeout=10
        )
        assert r.status_code in (400, 422)

    def test_patch_settings_non_integer(self, admin_headers):
        r = requests.patch(
            f"{API}/settings", json={"overdue_days": "abc"}, headers=admin_headers, timeout=10
        )
        assert r.status_code in (400, 422)


# ---------- Customer DELETE ----------
class TestCustomerDelete:
    def test_delete_nonexistent_customer_returns_404(self, admin_headers):
        r = requests.delete(
            f"{API}/customers/nonexistent-id-xyz-12345",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 404

    def test_delete_customer_requires_admin(self, admin_headers):
        # Create a customer as admin
        c = requests.post(
            f"{API}/customers",
            json={"name": f"TEST_DEL_{int(time.time())}", "phone": "9999999999"},
            headers=admin_headers,
            timeout=10,
        )
        assert c.status_code == 200, c.text
        cid = c.json()["id"]
        try:
            tok = _login("user", "user123").json()["token"]
            r = requests.delete(
                f"{API}/customers/{cid}",
                headers={"Authorization": f"Bearer {tok}"},
                timeout=10,
            )
            assert r.status_code == 403
        finally:
            requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=10)

    def test_delete_customer_with_orders_blocked_400(self, admin_headers):
        # Create customer
        c = requests.post(
            f"{API}/customers",
            json={"name": f"TEST_DEL_ORD_{int(time.time())}", "phone": "8888888888"},
            headers=admin_headers,
            timeout=10,
        )
        assert c.status_code == 200, c.text
        cid = c.json()["id"]
        # Need a real item to create an order
        items = requests.get(f"{API}/items", headers=admin_headers).json()
        assert items, "no items in DB to build order"
        item = items[0]
        order_body = {
            "customer_id": cid,
            "items": [
                {
                    "item_id": item["id"],
                    "item_name": item["name"],
                    "product_name": item.get("product_name", ""),
                    "bags": 1,
                    "quantity": 1,
                }
            ],
        }
        o = requests.post(f"{API}/orders", json=order_body, headers=admin_headers, timeout=10)
        assert o.status_code == 200, o.text
        oid = o.json()["id"]
        try:
            r = requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=10)
            assert r.status_code == 400, r.text
            assert "order" in r.json().get("detail", "").lower()
        finally:
            requests.delete(f"{API}/orders/{oid}", headers=admin_headers, timeout=10)
            requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=10)

    def test_delete_customer_success_and_404_after(self, admin_headers):
        c = requests.post(
            f"{API}/customers",
            json={"name": f"TEST_DEL_OK_{int(time.time())}", "phone": "7777777777"},
            headers=admin_headers,
            timeout=10,
        )
        assert c.status_code == 200
        cid = c.json()["id"]
        r = requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json().get("deleted") == cid
        # verify it's gone — list and ensure absence
        all_c = requests.get(f"{API}/customers", headers=admin_headers, timeout=10).json()
        assert all(x["id"] != cid for x in all_c)
        # second delete returns 404
        r2 = requests.delete(f"{API}/customers/{cid}", headers=admin_headers, timeout=10)
        assert r2.status_code == 404
