"""Backend tests for the redesigned Dispatch Ledger feature (iteration_20).

Verifies:
- /api/admin/dispatch-ledger works for BOTH admin and operator users
- /api/admin/dispatch-ledger/{did}/slip works for operator
- PATCH /api/dispatches/{did}/gr persists and operator may update
- Seed data: customer TEST_ORDER_1781277210 with 3 dispatches on 2026-06-12
- Filters (start_date, end_date, customer_id) narrow results
"""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
SEED_CUSTOMER_ID = "c823afd1-8758-4d3e-a693-63a3a1c4738c"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "admin123")


@pytest.fixture(scope="module")
def operator_token():
    return _login("user", "user123")


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


# ---------------- /api/admin/dispatch-ledger ----------------
class TestDispatchLedgerAccess:
    def test_admin_can_access_ledger(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/admin/dispatch-ledger", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "items" in body and "total" in body
        assert "grand_total_value" in body
        assert "grand_total_pcs" in body
        assert isinstance(body["items"], list)

    def test_operator_can_access_ledger(self, operator_token):
        """KEY CHANGE: operator must now also be allowed."""
        r = requests.get(f"{BASE_URL}/api/admin/dispatch-ledger", headers=_h(operator_token), timeout=30)
        assert r.status_code == 200, f"Operator should get 200, got {r.status_code}: {r.text}"
        body = r.json()
        assert isinstance(body.get("items"), list)
        assert "_id" not in (body["items"][0] if body["items"] else {})

    def test_unauthenticated_blocked(self):
        r = requests.get(f"{BASE_URL}/api/admin/dispatch-ledger", timeout=30)
        assert r.status_code in (401, 403)

    def test_admin_and_operator_payloads_match(self, admin_token, operator_token):
        a = requests.get(f"{BASE_URL}/api/admin/dispatch-ledger", headers=_h(admin_token), timeout=30).json()
        b = requests.get(f"{BASE_URL}/api/admin/dispatch-ledger", headers=_h(operator_token), timeout=30).json()
        assert a.get("total") == b.get("total")
        assert len(a.get("items", [])) == len(b.get("items", []))


class TestDispatchLedgerSeedData:
    def test_seed_customer_has_dispatches(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"customer_id": SEED_CUSTOMER_ID, "limit": 500},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert len(items) >= 3, f"Expected >=3 dispatches for seed customer, got {len(items)}"
        # All items must belong to the requested customer
        for it in items:
            assert it.get("customer_id") == SEED_CUSTOMER_ID

    def test_date_filter_2026_06_12(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={
                "customer_id": SEED_CUSTOMER_ID,
                "start_date": "2026-06-12",
                "end_date": "2026-06-12",
            },
            timeout=30,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 3, f"Expected 3 dispatches on 2026-06-12, got {len(items)}"
        total_pcs = sum(int(it.get("total_pcs") or 0) for it in items)
        assert total_pcs >= 200, f"Expected total pcs >=200 on that day, got {total_pcs}"

    def test_bad_start_date_returns_400(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"start_date": "12-06-2026"},
            timeout=30,
        )
        assert r.status_code == 400


# ---------------- /api/admin/dispatch-ledger/{did}/slip ----------------
class TestDispatchSlip:
    @pytest.fixture(scope="class")
    def a_dispatch_id(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"customer_id": SEED_CUSTOMER_ID, "limit": 5},
            timeout=30,
        )
        items = r.json()["items"]
        assert items, "No dispatches available to test slip"
        return items[0]["id"]

    def test_slip_admin(self, admin_token, a_dispatch_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger/{a_dispatch_id}/slip",
            headers=_h(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "dispatch" in body and "customer" in body
        assert body["dispatch"]["id"] == a_dispatch_id

    def test_slip_operator(self, operator_token, a_dispatch_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger/{a_dispatch_id}/slip",
            headers=_h(operator_token),
            timeout=30,
        )
        assert r.status_code == 200, f"Operator should access slip, got {r.status_code}: {r.text}"
        assert r.json()["dispatch"]["id"] == a_dispatch_id

    def test_slip_404(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger/does-not-exist-xyz/slip",
            headers=_h(admin_token),
            timeout=30,
        )
        assert r.status_code == 404


# ---------------- PATCH /api/dispatches/{did}/gr ----------------
class TestGrUpdate:
    @pytest.fixture(scope="class")
    def a_dispatch_id(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"customer_id": SEED_CUSTOMER_ID, "limit": 5},
            timeout=30,
        )
        return r.json()["items"][0]["id"]

    def test_admin_can_set_gr(self, admin_token, a_dispatch_id):
        new_gr = "TEST_GR_ADMIN_1"
        r = requests.patch(
            f"{BASE_URL}/api/dispatches/{a_dispatch_id}/gr",
            headers=_h(admin_token),
            json={"gr_number": new_gr},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("gr_number") == new_gr
        # Verify persistence via GET
        r2 = requests.get(
            f"{BASE_URL}/api/admin/dispatch-ledger",
            headers=_h(admin_token),
            params={"customer_id": SEED_CUSTOMER_ID},
            timeout=30,
        )
        match = [it for it in r2.json()["items"] if it["id"] == a_dispatch_id]
        assert match and match[0].get("gr_number") == new_gr

    def test_operator_can_set_gr(self, operator_token, a_dispatch_id):
        new_gr = "TEST_GR_OPERATOR_1"
        r = requests.patch(
            f"{BASE_URL}/api/dispatches/{a_dispatch_id}/gr",
            headers=_h(operator_token),
            json={"gr_number": new_gr},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("gr_number") == new_gr

    def test_gr_404(self, admin_token):
        r = requests.patch(
            f"{BASE_URL}/api/dispatches/nope/gr",
            headers=_h(admin_token),
            json={"gr_number": "X"},
            timeout=30,
        )
        assert r.status_code == 404


# ---------------- Smoke: existing endpoints still work (no regression) ----------------
class TestNoRegression:
    @pytest.mark.parametrize("path", [
        "/api/dashboard/summary",
        "/api/orders",
        "/api/customers",
        "/api/products",
        "/api/items",
    ])
    def test_endpoint_ok_admin(self, admin_token, path):
        r = requests.get(f"{BASE_URL}{path}", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200, f"{path} -> {r.status_code}"
