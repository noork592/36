"""Backend tests for iteration_21 — Party Ledger redesign / private_mark on Customer.

Verifies:
- Customer model accepts/persists `private_mark` via POST and PATCH.
- GET /api/customers returns `private_mark`.
- Seed customer c823afd1-... has private_mark='JKM-NAGPUR' and transport_name='DTDC Couriers'.
- GET /api/admin/dispatch-ledger/{did}/slip exposes customer.private_mark.
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
SEED_CUSTOMER_ID = "c823afd1-8758-4d3e-a693-63a3a1c4738c"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"Login failed {email}: {r.status_code} {r.text}"
    return r.json()["token"]


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "admin123")


@pytest.fixture(scope="module")
def operator_token():
    return _login("user", "user123")


# ---------------- Seed customer has private_mark + transport_name ----------------
class TestSeedCustomerPrivateMark:
    def test_seed_customer_private_mark_and_transport(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/customers", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        customers = r.json()
        assert isinstance(customers, list)
        match = [c for c in customers if c.get("id") == SEED_CUSTOMER_ID]
        assert match, f"Seed customer {SEED_CUSTOMER_ID} not found"
        c = match[0]
        assert c.get("private_mark") == "JKM-NAGPUR", f"private_mark={c.get('private_mark')!r}"
        assert c.get("transport_name") == "DTDC Couriers", f"transport_name={c.get('transport_name')!r}"
        # Ensure no Mongo _id leaks
        assert "_id" not in c


# ---------------- POST / PATCH /api/customers with private_mark ----------------
class TestCustomerCrudPrivateMark:
    @pytest.fixture(scope="class")
    def created(self, admin_token):
        ts = int(time.time())
        payload = {
            "name": f"TEST_PMARK_{ts}",
            "phone": "9999999999",
            "address": "Test address",
            "transport_name": "Test Trans",
            "private_mark": "TEST-PMARK-A",
        }
        r = requests.post(f"{BASE_URL}/api/customers", headers=_h(admin_token), json=payload, timeout=30)
        assert r.status_code in (200, 201), f"create failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("private_mark") == "TEST-PMARK-A"
        assert body.get("transport_name") == "Test Trans"
        assert "id" in body
        yield body
        # cleanup
        requests.delete(f"{BASE_URL}/api/customers/{body['id']}", headers=_h(admin_token), timeout=30)

    def test_get_returns_private_mark(self, admin_token, created):
        r = requests.get(f"{BASE_URL}/api/customers", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200
        match = [c for c in r.json() if c.get("id") == created["id"]]
        assert match
        assert match[0].get("private_mark") == "TEST-PMARK-A"

    def test_patch_updates_private_mark(self, admin_token, created):
        r = requests.patch(
            f"{BASE_URL}/api/customers/{created['id']}",
            headers=_h(admin_token),
            json={"private_mark": "TEST-PMARK-B"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("private_mark") == "TEST-PMARK-B"
        # verify via GET
        r2 = requests.get(f"{BASE_URL}/api/customers", headers=_h(admin_token), timeout=30)
        match = [c for c in r2.json() if c.get("id") == created["id"]]
        assert match and match[0].get("private_mark") == "TEST-PMARK-B"


# ---------------- Slip endpoint exposes customer.private_mark ----------------
class TestSlipIncludesPrivateMark:
    @pytest.fixture(scope="class")
    def a_dispatch_id(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"customer_id": SEED_CUSTOMER_ID, "limit": 5},
            timeout=30,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert items, "No dispatches available"
        return items[0]["id"]

    def test_slip_admin_has_private_mark(self, admin_token, a_dispatch_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger/{a_dispatch_id}/slip",
            headers=_h(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "customer" in body
        assert body["customer"].get("private_mark") == "JKM-NAGPUR", (
            f"slip customer.private_mark={body['customer'].get('private_mark')!r}"
        )
        assert body["customer"].get("transport_name") == "DTDC Couriers"

    def test_slip_operator_has_private_mark(self, operator_token, a_dispatch_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger/{a_dispatch_id}/slip",
            headers=_h(operator_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["customer"].get("private_mark") == "JKM-NAGPUR"
