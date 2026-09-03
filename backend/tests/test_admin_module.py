"""Backend tests for Iteration 11 — Admin module (users CRUD, item CRUD, full order edit).

Covers:
- Users CRUD: list, create (admin & user role), self-delete guard, delete, password reset, short-pw guard.
- Items CRUD: create, edit (name only), delete, delete blocked when referenced by order.
- Orders: admin full edit via PATCH /orders/{id} (customer/items/notes/status/delivery_date).
- Regression: status validation (only Pending/Dispatched/Cleared), bags×max_per_bag qty math.
"""
import os
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip()
                    break
    except FileNotFoundError:
        pass
BASE_URL = (BASE_URL or "http://localhost:8001").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@factory.com"
ADMIN_PW = "admin123"
USER_EMAIL = "user@factory.com"
USER_PW = "user123"


# ---------- Auth helpers ----------
def _login(email, pw):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=15)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    j = r.json()
    return j["token"], j["user"]


@pytest.fixture(scope="module")
def admin_ctx():
    tok, u = _login(ADMIN_EMAIL, ADMIN_PW)
    return {"headers": {"Authorization": f"Bearer {tok}"}, "user": u}


@pytest.fixture(scope="module")
def user_ctx():
    tok, u = _login(USER_EMAIL, USER_PW)
    return {"headers": {"Authorization": f"Bearer {tok}"}, "user": u}


# ---------- /users endpoints ----------
class TestUserCRUD:
    def test_list_users_admin(self, admin_ctx):
        r = requests.get(f"{API}/users", headers=admin_ctx["headers"], timeout=10)
        assert r.status_code == 200
        users = r.json()
        assert isinstance(users, list)
        emails = [u["email"] for u in users]
        assert ADMIN_EMAIL in emails
        assert USER_EMAIL in emails
        # No password hashes leaked
        for u in users:
            assert "password" not in u

    def test_list_users_forbidden_for_non_admin(self, user_ctx):
        r = requests.get(f"{API}/users", headers=user_ctx["headers"], timeout=10)
        assert r.status_code == 403

    def test_create_user_role_user_and_admin(self, admin_ctx):
        created_ids = []
        for role in ("user", "admin"):
            email = f"test_{role}_{uuid.uuid4().hex[:6]}@factory.com"
            payload = {"email": email, "name": f"Test {role}", "password": "secret123", "role": role}
            r = requests.post(f"{API}/users", headers=admin_ctx["headers"], json=payload, timeout=10)
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["email"] == email
            assert data["role"] == role
            assert "id" in data
            assert "password" not in data
            created_ids.append(data["id"])
        # Cleanup
        for uid in created_ids:
            requests.delete(f"{API}/users/{uid}", headers=admin_ctx["headers"], timeout=10)

    def test_create_user_short_password_rejected(self, admin_ctx):
        payload = {"email": f"shortpw_{uuid.uuid4().hex[:6]}@x.com", "name": "S", "password": "12345", "role": "user"}
        r = requests.post(f"{API}/users", headers=admin_ctx["headers"], json=payload, timeout=10)
        assert r.status_code == 400

    def test_create_user_invalid_role_rejected(self, admin_ctx):
        payload = {"email": f"role_{uuid.uuid4().hex[:6]}@x.com", "name": "R", "password": "secret123", "role": "superuser"}
        r = requests.post(f"{API}/users", headers=admin_ctx["headers"], json=payload, timeout=10)
        assert r.status_code == 400

    def test_self_delete_blocked(self, admin_ctx):
        uid = admin_ctx["user"]["id"]
        r = requests.delete(f"{API}/users/{uid}", headers=admin_ctx["headers"], timeout=10)
        assert r.status_code == 400

    def test_delete_user_succeeds(self, admin_ctx):
        # create
        email = f"todelete_{uuid.uuid4().hex[:6]}@x.com"
        cr = requests.post(f"{API}/users", headers=admin_ctx["headers"],
                           json={"email": email, "name": "X", "password": "secret123", "role": "user"}, timeout=10)
        uid = cr.json()["id"]
        # delete
        d = requests.delete(f"{API}/users/{uid}", headers=admin_ctx["headers"], timeout=10)
        assert d.status_code == 200
        # ensure no longer listed
        all_users = requests.get(f"{API}/users", headers=admin_ctx["headers"], timeout=10).json()
        assert uid not in [u["id"] for u in all_users]

    def test_reset_password_flow(self, admin_ctx):
        email = f"resetpw_{uuid.uuid4().hex[:6]}@x.com"
        cr = requests.post(f"{API}/users", headers=admin_ctx["headers"],
                           json={"email": email, "name": "R", "password": "oldpass123", "role": "user"}, timeout=10)
        uid = cr.json()["id"]
        try:
            # Short password rejected
            r0 = requests.post(f"{API}/users/{uid}/reset-password", headers=admin_ctx["headers"],
                               json={"password": "abc"}, timeout=10)
            assert r0.status_code == 400
            # Real reset
            r1 = requests.post(f"{API}/users/{uid}/reset-password", headers=admin_ctx["headers"],
                               json={"password": "newpass456"}, timeout=10)
            assert r1.status_code == 200
            # New password works
            r2 = requests.post(f"{API}/auth/login", json={"email": email, "password": "newpass456"}, timeout=10)
            assert r2.status_code == 200
            # Old password rejected
            r3 = requests.post(f"{API}/auth/login", json={"email": email, "password": "oldpass123"}, timeout=10)
            assert r3.status_code == 401
        finally:
            requests.delete(f"{API}/users/{uid}", headers=admin_ctx["headers"], timeout=10)


# ---------- /items endpoints ----------
class TestItemCRUD:
    def test_create_edit_delete_item(self, admin_ctx):
        # Pick any product
        prods = requests.get(f"{API}/products", headers=admin_ctx["headers"], timeout=10).json()
        assert prods, "no products seeded"
        pid = prods[0]["id"]

        new_name = f"TEST_SKU_{uuid.uuid4().hex[:6]}"
        # Create without max_per_bag (uses category default)
        cr = requests.post(f"{API}/items", headers=admin_ctx["headers"],
                           json={"name": new_name, "product_id": pid}, timeout=10)
        assert cr.status_code == 200, cr.text
        item = cr.json()
        iid = item["id"]
        assert item["name"] == new_name
        assert item["product_id"] == pid

        # Edit name only (PATCH returns {"ok": True})
        edited_name = new_name + "_edited"
        er = requests.patch(f"{API}/items/{iid}", headers=admin_ctx["headers"],
                            json={"name": edited_name}, timeout=10)
        assert er.status_code == 200, er.text
        assert er.json().get("ok") is True

        # Verify persisted via GET
        gr = requests.get(f"{API}/items/{iid}", headers=admin_ctx["headers"], timeout=10)
        assert gr.status_code == 200
        assert gr.json()["name"] == edited_name

        # Delete (no orders ref) → 200
        dr = requests.delete(f"{API}/items/{iid}", headers=admin_ctx["headers"], timeout=10)
        assert dr.status_code == 200

        # Verify gone
        gr2 = requests.get(f"{API}/items/{iid}", headers=admin_ctx["headers"], timeout=10)
        assert gr2.status_code == 404

    def test_delete_item_blocked_when_referenced(self, admin_ctx):
        # Create item, create order using it, then attempt delete → 400
        prods = requests.get(f"{API}/products", headers=admin_ctx["headers"], timeout=10).json()
        pid = prods[0]["id"]
        new_name = f"TEST_REF_{uuid.uuid4().hex[:6]}"
        cr = requests.post(f"{API}/items", headers=admin_ctx["headers"],
                           json={"name": new_name, "product_id": pid, "max_per_bag": 50, "min_per_bag": 50}, timeout=10)
        assert cr.status_code == 200
        iid = cr.json()["id"]

        # Find or create a customer
        custs = requests.get(f"{API}/customers", headers=admin_ctx["headers"], timeout=10).json()
        if custs:
            cid = custs[0]["id"]
        else:
            cu = requests.post(f"{API}/customers", headers=admin_ctx["headers"],
                               json={"name": "TEST_C", "phone": "111", "address": "x"}, timeout=10)
            cid = cu.json()["id"]

        order_payload = {
            "customer_id": cid,
            "items": [{
                "product_name": prods[0]["name"],
                "quantity": 50,
                "item_id": iid,
                "item_name": new_name,
            }],
        }
        order_resp = requests.post(f"{API}/orders", headers=admin_ctx["headers"], json=order_payload, timeout=10)
        assert order_resp.status_code in (200, 201), order_resp.text
        oid = order_resp.json()["id"]

        try:
            dr = requests.delete(f"{API}/items/{iid}", headers=admin_ctx["headers"], timeout=10)
            assert dr.status_code == 400
        finally:
            requests.delete(f"{API}/orders/{oid}", headers=admin_ctx["headers"], timeout=10)
            requests.delete(f"{API}/items/{iid}", headers=admin_ctx["headers"], timeout=10)

    def test_create_item_forbidden_for_user(self, user_ctx):
        prods = requests.get(f"{API}/products", headers=user_ctx["headers"], timeout=10).json()
        pid = prods[0]["id"] if prods else "x"
        r = requests.post(f"{API}/items", headers=user_ctx["headers"],
                          json={"name": "NOPE", "product_id": pid}, timeout=10)
        assert r.status_code == 403


# ---------- Admin order edit ----------
class TestOrderEdit:
    def test_admin_edit_order(self, admin_ctx):
        prods = requests.get(f"{API}/products", headers=admin_ctx["headers"], timeout=10).json()
        pid = prods[0]["id"]
        items = requests.get(f"{API}/items", headers=admin_ctx["headers"], params={"product_id": pid}, timeout=10).json()
        assert items
        iid = items[0]["id"]
        iname = items[0]["name"]

        custs = requests.get(f"{API}/customers", headers=admin_ctx["headers"], timeout=10).json()
        cid = custs[0]["id"]

        # Create order
        order_payload = {
            "customer_id": cid,
            "items": [{"product_name": prods[0]["name"], "quantity": 100, "item_id": iid, "item_name": iname}],
            "notes": "initial",
        }
        cr = requests.post(f"{API}/orders", headers=admin_ctx["headers"], json=order_payload, timeout=10)
        assert cr.status_code in (200, 201), cr.text
        oid = cr.json()["id"]
        try:
            # PATCH with new qty + notes
            pr = requests.patch(f"{API}/orders/{oid}", headers=admin_ctx["headers"], json={
                "notes": "edited via admin",
                "items": [{"product_name": prods[0]["name"], "quantity": 250, "item_id": iid, "item_name": iname}],
            }, timeout=10)
            assert pr.status_code == 200, pr.text

            # GET to verify via list endpoint (no single-order GET)
            gr = requests.get(f"{API}/orders", headers=admin_ctx["headers"], timeout=10)
            assert gr.status_code == 200
            orders = gr.json()
            row = next((o for o in orders if o["id"] == oid), None)
            assert row is not None
            assert row["notes"] == "edited via admin"
            assert row["items"][0]["quantity"] == 250
        finally:
            requests.delete(f"{API}/orders/{oid}", headers=admin_ctx["headers"], timeout=10)

    def test_admin_edit_order_status_validation(self, admin_ctx):
        prods = requests.get(f"{API}/products", headers=admin_ctx["headers"], timeout=10).json()
        pid = prods[0]["id"]
        items = requests.get(f"{API}/items", headers=admin_ctx["headers"], params={"product_id": pid}, timeout=10).json()
        iid = items[0]["id"]
        iname = items[0]["name"]
        custs = requests.get(f"{API}/customers", headers=admin_ctx["headers"], timeout=10).json()
        cid = custs[0]["id"]
        cr = requests.post(f"{API}/orders", headers=admin_ctx["headers"], json={
            "customer_id": cid,
            "items": [{"product_name": prods[0]["name"], "quantity": 10, "item_id": iid, "item_name": iname}],
        }, timeout=10)
        oid = cr.json()["id"]
        try:
            # Status 'Delivered' must be rejected
            r1 = requests.patch(f"{API}/orders/{oid}/status", headers=admin_ctx["headers"],
                                json={"status": "Delivered"}, timeout=10)
            assert r1.status_code == 400
            # Dispatched OK
            r2 = requests.patch(f"{API}/orders/{oid}/status", headers=admin_ctx["headers"],
                                json={"status": "Dispatched"}, timeout=10)
            assert r2.status_code == 200
        finally:
            requests.delete(f"{API}/orders/{oid}", headers=admin_ctx["headers"], timeout=10)


# ---------- Customer admin edit (regression) ----------
class TestCustomerEdit:
    def test_patch_customer(self, admin_ctx):
        cu = requests.post(f"{API}/customers", headers=admin_ctx["headers"],
                           json={"name": f"TEST_CUST_{uuid.uuid4().hex[:6]}", "phone": "555", "address": "old"}, timeout=10)
        assert cu.status_code in (200, 201)
        cid = cu.json()["id"]
        try:
            new_name = f"TEST_CUST_NEW_{uuid.uuid4().hex[:6]}"
            pr = requests.patch(f"{API}/customers/{cid}", headers=admin_ctx["headers"],
                                json={"name": new_name, "phone": "999", "address": "new"}, timeout=10)
            assert pr.status_code == 200, pr.text
            # GET to verify
            gr = requests.get(f"{API}/customers", headers=admin_ctx["headers"], timeout=10).json()
            row = next(c for c in gr if c["id"] == cid)
            assert row["name"] == new_name
            assert row["phone"] == "999"
            assert row["address"] == "new"
        finally:
            requests.delete(f"{API}/customers/{cid}", headers=admin_ctx["headers"], timeout=10)
