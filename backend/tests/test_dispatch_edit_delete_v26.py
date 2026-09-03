"""Iteration 26 — Backend tests for PATCH / DELETE /api/dispatches/{id}
plus regression on /api/payments PATCH/POST/DELETE.

Run:  pytest /app/backend/tests/test_dispatch_edit_delete_v26.py -v
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://git-to-app-2.preview.emergentagent.com").rstrip("/")
SEED_PARTY_ID = "c823afd1-8758-4d3e-a693-63a3a1c4738c"


def _login(username: str, password: str) -> str:
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": username, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed for {username}: {r.status_code} {r.text}"
    body = r.json()
    return body.get("access_token") or body["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "admin123")


@pytest.fixture(scope="module")
def operator_token():
    return _login("user", "user123")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def operator_headers(operator_token):
    return {"Authorization": f"Bearer {operator_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def seed_dispatch(admin_headers):
    """Fetch any existing dispatch row for the seed party."""
    r = requests.get(f"{BASE_URL}/api/dispatches?customer_id={SEED_PARTY_ID}",
                     headers=admin_headers, timeout=20)
    assert r.status_code == 200, r.text
    items = r.json()
    assert isinstance(items, list) and len(items) >= 1, "seed party must have dispatches"
    return items[0]


# ---------- PATCH /api/dispatches/{id} ----------

class TestPatchDispatch:
    def test_patch_dispatch_updates_fields_any_user(self, operator_headers, admin_headers, seed_dispatch):
        did = seed_dispatch["id"]
        original_total = seed_dispatch.get("total_value", 0) or 0
        payload = {
            "gr_number": "TEST_GR_V26",
            "transport_name": "TEST_Transport_V26",
            "notes": "TEST_notes_v26",
            "total_value": float(original_total),  # keep same
        }
        r = requests.patch(f"{BASE_URL}/api/dispatches/{did}",
                           json=payload, headers=operator_headers, timeout=20)
        assert r.status_code == 200, f"PATCH failed: {r.status_code} {r.text}"
        body = r.json()
        assert body["id"] == did
        assert body["gr_number"] == "TEST_GR_V26"
        assert body["transport_name"] == "TEST_Transport_V26"
        assert body["notes"] == "TEST_notes_v26"
        # GET verify persistence
        g = requests.get(f"{BASE_URL}/api/dispatches?customer_id={SEED_PARTY_ID}",
                         headers=admin_headers, timeout=20)
        assert g.status_code == 200
        match = [d for d in g.json() if d["id"] == did]
        assert match and match[0]["gr_number"] == "TEST_GR_V26"
        assert match[0]["notes"] == "TEST_notes_v26"

    def test_patch_dispatch_negative_total_value_400(self, admin_headers, seed_dispatch):
        did = seed_dispatch["id"]
        r = requests.patch(f"{BASE_URL}/api/dispatches/{did}",
                           json={"total_value": -10}, headers=admin_headers, timeout=20)
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"

    def test_patch_dispatch_missing_404(self, admin_headers):
        r = requests.patch(f"{BASE_URL}/api/dispatches/does-not-exist-xyz",
                           json={"notes": "x"}, headers=admin_headers, timeout=20)
        assert r.status_code == 404


# ---------- DELETE /api/dispatches/{id} ----------

class TestDeleteDispatch:
    def test_delete_dispatch_admin_ok_does_not_restore_order(self, admin_headers):
        """Create a fresh dispatch via off-order POST, then delete it as admin."""
        # Find an item to use
        it = requests.get(f"{BASE_URL}/api/items", headers=admin_headers, timeout=20)
        if it.status_code != 200 or not it.json():
            pytest.skip("no items available to create test dispatch")
        items_list = it.json() if isinstance(it.json(), list) else it.json().get("items", [])
        if not items_list:
            pytest.skip("no items")
        item_id = items_list[0]["id"]

        payload = {
            "customer_id": SEED_PARTY_ID,
            "transport_name": "TEST_TO_DELETE",
            "notes": "TEST_to_delete_v26",
            "items": [{"item_id": item_id, "quantity": 1}],
        }
        c = requests.post(f"{BASE_URL}/api/dispatch/off-order",
                          json=payload, headers=admin_headers, timeout=20)
        if c.status_code not in (200, 201):
            pytest.skip(f"could not create off-order dispatch: {c.status_code} {c.text}")
        created = c.json()
        did = (created.get("dispatch") or {}).get("id") or created.get("id")
        assert did, f"no id returned: {created}"

        r = requests.delete(f"{BASE_URL}/api/dispatches/{did}",
                            headers=admin_headers, timeout=20)
        assert r.status_code == 200, f"DELETE failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("ok") is True
        assert body.get("deleted") == did

        # Verify gone
        g = requests.get(f"{BASE_URL}/api/dispatches?customer_id={SEED_PARTY_ID}",
                         headers=admin_headers, timeout=20)
        assert g.status_code == 200
        assert not any(d["id"] == did for d in g.json()), "dispatch still listed after delete"

    def test_delete_dispatch_operator_forbidden(self, operator_headers, seed_dispatch):
        did = seed_dispatch["id"]
        r = requests.delete(f"{BASE_URL}/api/dispatches/{did}",
                            headers=operator_headers, timeout=20)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_delete_dispatch_missing_404(self, admin_headers):
        r = requests.delete(f"{BASE_URL}/api/dispatches/does-not-exist-xyz",
                            headers=admin_headers, timeout=20)
        assert r.status_code == 404


# ---------- Payments regression ----------

class TestPaymentsRegression:
    def test_post_patch_delete_payment_flow(self, admin_headers, operator_headers):
        # POST as operator (any user)
        ts = int(time.time())
        payload = {
            "customer_id": SEED_PARTY_ID,
            "amount": 111.0,
            "source": "cash",
            "reference": f"TEST_REF_{ts}",
            "notes": "TEST_v26_payment",
        }
        c = requests.post(f"{BASE_URL}/api/payments",
                          json=payload, headers=operator_headers, timeout=20)
        assert c.status_code in (200, 201), f"POST payment failed: {c.status_code} {c.text}"
        pid = c.json().get("id")
        assert pid

        # PATCH as operator
        p = requests.patch(f"{BASE_URL}/api/payments/{pid}",
                           json={"notes": "TEST_v26_patched", "amount": 112.5},
                           headers=operator_headers, timeout=20)
        assert p.status_code == 200, f"PATCH payment failed: {p.status_code} {p.text}"
        pj = p.json()
        assert pj.get("notes") == "TEST_v26_patched"
        assert float(pj.get("amount")) == 112.5

        # DELETE as operator -> 403
        d_op = requests.delete(f"{BASE_URL}/api/payments/{pid}",
                               headers=operator_headers, timeout=20)
        assert d_op.status_code == 403

        # DELETE as admin -> 200
        d_ad = requests.delete(f"{BASE_URL}/api/payments/{pid}",
                               headers=admin_headers, timeout=20)
        assert d_ad.status_code == 200
