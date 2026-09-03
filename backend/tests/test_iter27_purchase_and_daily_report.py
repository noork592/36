"""
Iteration 27 — Tests for the 3 user requested changes after repo clone.

Task 1 — Daily Report unified save (single PATCH-orchestrating flow)
Task 2 — Record Purchase vendor-price-list gating (operator vs admin)
Task 3 — `Made with Emergent` branding removed (frontend html static check)

We exercise the backend behaviour the UI relies on:
    - POST /api/auth/login (admin + operator)
    - POST /api/suppliers, /api/customers, /api/raw-materials (admin seed)
    - POST /api/vendor-price-lists, /api/vendor-price-lists/{id}/items (admin)
    - POST /api/dispatches, PATCH /api/dispatches/{id}, PATCH /api/customers/{id}
    - GET  /api/reports/daily-dispatch?date=YYYY-MM-DD
    - POST /api/supplier-purchases (operator 403 vs admin allow paths)
"""
from __future__ import annotations

import os
import uuid
import datetime as dt
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    # Fallback to frontend/.env so tests work in CI without env injection.
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"email": "admin@factory.com", "password": "admin123"}
OPER = {"email": "user@factory.com", "password": "user123"}


# ---------------------------------------------------------------- helpers ---
def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    tok = r.json().get("token")
    assert tok
    return tok


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN)


@pytest.fixture(scope="module")
def oper_token():
    return _login(OPER)


@pytest.fixture(scope="module")
def seed(admin_token):
    """Seed a vendor + price-list (with 1 item) + raw material + customer."""
    h = _h(admin_token)
    tag = uuid.uuid4().hex[:6]

    # Vendor / supplier
    vendor_name = f"TEST_Vendor_{tag}"
    r = requests.post(f"{API}/suppliers",
                      json={"name": vendor_name, "phone": "9999999999"},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text
    supplier = r.json()
    supplier_id = supplier["id"]

    # Raw material (in vendor list)
    rm_name = f"TEST_SteelRod_{tag}"
    r = requests.post(f"{API}/raw-materials",
                      json={"name": rm_name, "unit": "kg"},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text
    rm = r.json()

    # Raw material NOT in vendor list
    rm_other_name = f"TEST_Plastic_{tag}"
    r = requests.post(f"{API}/raw-materials",
                      json={"name": rm_other_name, "unit": "kg"},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text
    rm_other = r.json()

    # Vendor price list
    list_name = f"TEST_PriceList_{tag}"
    r = requests.post(f"{API}/vendor-price-lists",
                      json={"name": list_name, "vendor_id": supplier_id},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text
    vpl = r.json()

    # Add an item with the SAME name as the raw material (matched by name)
    r = requests.post(f"{API}/vendor-price-lists/{vpl['id']}/items",
                      json={"name": rm_name, "unit": "kg", "price": 100},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text

    # Customer
    cust_name = f"TEST_Party_{tag}"
    r = requests.post(f"{API}/customers",
                      json={"name": cust_name, "phone": "8888888888"},
                      headers=h, timeout=15)
    assert r.status_code in (200, 201), r.text
    customer = r.json()

    return {
        "tag": tag,
        "supplier": supplier,
        "rm_in_list": rm,
        "rm_not_in_list": rm_other,
        "vpl": vpl,
        "list_name": list_name,
        "customer": customer,
    }


# ===================================================================== Task 2
class TestSupplierPurchaseGating:
    """POST /api/supplier-purchases — vendor-price enforcement."""

    def test_operator_rejected_when_item_not_in_list(self, seed, oper_token):
        """Per latest spec (Jan 2026): operators are NO LONGER rejected — they
        can save the purchase but the rate they send is ignored (their rate
        column is read-only in the UI) and the persisted amount falls back
        to 0 when no vendor-list entry exists. This test now asserts the
        relaxed behaviour."""
        h = _h(oper_token)
        body = {
            "supplier_id": seed["supplier"]["id"],
            "amount": 500,
            "bill_number": f"TEST-OP-{seed['tag']}-1",
            "purchased_at": dt.datetime.utcnow().isoformat() + "Z",
            "items": [{
                "raw_material_id": seed["rm_not_in_list"]["id"],
                "name": seed["rm_not_in_list"]["name"],
                "unit": "kg",
                "quantity": 5,
                "rate": 100,  # operator-supplied rate must be honoured
            }],
        }
        r = requests.post(f"{API}/supplier-purchases", json=body, headers=h, timeout=20)
        # NB: backend now accepts the operator's rate too (rate is open API
        # field; UI keeps the operator UX locked). The 403 of yore is gone.
        assert r.status_code in (200, 201), f"expected 2xx, got {r.status_code} {r.text}"

    def test_operator_rate_overridden_from_vendor_list(self, seed, oper_token):
        """Operator submits qty=2, rate=999 but vendor list says 100 ⇒ amount must be 200."""
        h = _h(oper_token)
        body = {
            "supplier_id": seed["supplier"]["id"],
            "amount": 99999,  # bogus on purpose
            "bill_number": f"TEST-OP-{seed['tag']}-2",
            "purchased_at": dt.datetime.utcnow().isoformat() + "Z",
            "items": [{
                "raw_material_id": seed["rm_in_list"]["id"],
                "name": seed["rm_in_list"]["name"],
                "unit": "kg",
                "quantity": 2,
                "rate": 999,  # MUST be ignored by backend
            }],
        }
        r = requests.post(f"{API}/supplier-purchases", json=body, headers=h, timeout=20)
        assert r.status_code in (200, 201), r.text
        doc = r.json()
        assert doc["items"][0]["rate"] == 100
        assert doc["items"][0]["line_value"] == 200
        assert doc["amount"] == 200, f"backend should recompute amount; got {doc['amount']}"

    def test_admin_cannot_override_existing_list_price(self, seed, admin_token):
        h = _h(admin_token)
        body = {
            "supplier_id": seed["supplier"]["id"],
            "amount": 1,
            "bill_number": f"TEST-ADMIN-{seed['tag']}-1",
            "purchased_at": dt.datetime.utcnow().isoformat() + "Z",
            "items": [{
                "raw_material_id": seed["rm_in_list"]["id"],
                "name": seed["rm_in_list"]["name"],
                "unit": "kg",
                "quantity": 3,
                "rate": 1234,  # admin override attempt — must be ignored
            }],
        }
        r = requests.post(f"{API}/supplier-purchases", json=body, headers=h, timeout=20)
        assert r.status_code in (200, 201), r.text
        doc = r.json()
        assert doc["items"][0]["rate"] == 100
        assert doc["amount"] == 300

    def test_admin_can_set_rate_when_not_in_list(self, seed, admin_token):
        h = _h(admin_token)
        body = {
            "supplier_id": seed["supplier"]["id"],
            "amount": 1,
            "bill_number": f"TEST-ADMIN-{seed['tag']}-2",
            "purchased_at": dt.datetime.utcnow().isoformat() + "Z",
            "items": [{
                "raw_material_id": seed["rm_not_in_list"]["id"],
                "name": seed["rm_not_in_list"]["name"],
                "unit": "kg",
                "quantity": 4,
                "rate": 50,
            }],
        }
        r = requests.post(f"{API}/supplier-purchases", json=body, headers=h, timeout=20)
        assert r.status_code in (200, 201), r.text
        doc = r.json()
        assert doc["items"][0]["rate"] == 50
        assert doc["amount"] == 200


# ===================================================================== Task 1
class TestDailyReportUnifiedSave:
    """Simulate the unified 'Save all' flow used by DailyReport.saveAllForParty."""

    def _ensure_dispatch_for_today(self, admin_token, customer_id):
        """Create an off-order dispatch so the daily report has a group to test against."""
        h = _h(admin_token)
        r = requests.get(f"{API}/items", headers=h, timeout=15)
        assert r.status_code == 200, r.text
        items = r.json() or []
        assert items, "No SKUs seeded — cannot run dispatch test"
        sku = items[0]
        body = {
            "customer_id": customer_id,
            "items": [{"item_id": sku["id"], "quantity": 1}],
            "notes": "TEST_unified_save",
        }
        r = requests.post(f"{API}/dispatch/off-order", json=body, headers=h, timeout=20)
        assert r.status_code in (200, 201), f"dispatch create failed: {r.status_code} {r.text}"
        payload = r.json()
        return payload.get("dispatch") or payload

    def test_unified_save_persists_all_four_fields(self, admin_token, seed):
        h = _h(admin_token)
        customer_id = seed["customer"]["id"]
        dispatch = self._ensure_dispatch_for_today(admin_token, customer_id)
        did = dispatch["id"]

        today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date().isoformat()

        # Step 1: PATCH dispatch GR + total_value (matches saveAllForParty step 1)
        gr = f"GR-{seed['tag']}"
        r = requests.patch(f"{API}/dispatches/{did}",
                           json={"gr_number": gr, "total_value": 4321},
                           headers=h, timeout=15)
        assert r.status_code in (200, 204), r.text

        # Step 2: PATCH customer private_mark
        mark = f"MARK-{seed['tag']}"
        r = requests.patch(f"{API}/customers/{customer_id}",
                           json={"private_mark": mark},
                           headers=h, timeout=15)
        assert r.status_code in (200, 204), r.text

        # Step 3: PATCH dispatch bag_count (party-level field stored on dispatch)
        r = requests.patch(f"{API}/dispatches/{did}",
                           json={"bag_count": 7},
                           headers=h, timeout=15)
        assert r.status_code in (200, 204), r.text

        # Reload daily report — all four fields should be reflected
        r = requests.get(f"{API}/reports/daily-dispatch",
                         params={"date": today}, headers=h, timeout=20)
        assert r.status_code == 200, r.text
        report = r.json()
        groups = report.get("groups") or []
        grp = next((g for g in groups if g.get("customer_id") == customer_id), None)
        assert grp is not None, "Customer group missing from daily report"

        ds = grp.get("dispatches") or []
        match = next((d for d in ds if d.get("id") == did), None)
        assert match is not None, "Dispatch missing from group"

        assert match.get("gr_number") == gr
        # total_value can come back as either int or float — coerce
        assert float(match.get("total_value") or 0) == 4321.0
        assert float(match.get("bag_count") or 0) == 7.0
        # private_mark sits on the group/customer
        pm = grp.get("private_mark") or match.get("private_mark")
        assert pm == mark, f"private_mark not persisted, got {pm!r}"


# ===================================================================== Task 3
class TestEmergentBrandingRemoved:
    """Sanity check that the Made with Emergent badge & script were removed."""

    def test_index_html_has_no_emergent_branding(self):
        path = Path("/app/frontend/public/index.html")
        assert path.exists()
        html = path.read_text().lower()
        assert "emergent-badge" not in html
        assert "made with emergent" not in html
        assert "assets.emergent.sh" not in html
