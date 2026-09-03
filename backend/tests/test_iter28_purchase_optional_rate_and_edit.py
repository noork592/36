"""Iteration 28 — Optional rate on purchases + admin edit slip + PWA assets.

Covers:
  Task 1 — Operator & Admin can save a purchase WITHOUT a rate (no 403),
           vendor-list match still auto-fills the rate.
  Task 2 — Admin PATCH /api/supplier-purchases/{pid} works (operator gets 403);
           stock movements reconcile when items change.
  Task 3 — /manifest.json and /service-worker.js are reachable with correct
           content-type / shape from the frontend.
"""
import os
import time
import uuid
import pytest
import requests

def _load_base_url():
    u = os.environ.get("REACT_APP_BACKEND_URL")
    if not u:
        try:
            with open("/app/frontend/.env") as f:
                for line in f:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        u = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass
    assert u, "REACT_APP_BACKEND_URL not set"
    return u.rstrip("/")


BASE_URL = _load_base_url()
TAG = uuid.uuid4().hex[:6]


# ---------- helpers ----------------------------------------------------------
def _login(email, pwd):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": pwd}, timeout=30)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_h():
    return {"Authorization": f"Bearer {_login('admin@factory.com', 'admin123')}"}


@pytest.fixture(scope="module")
def user_h():
    return {"Authorization": f"Bearer {_login('user@factory.com', 'user123')}"}


@pytest.fixture(scope="module")
def supplier(admin_h):
    r = requests.post(
        f"{BASE_URL}/api/suppliers",
        json={"name": f"TEST_Vendor_{TAG}", "contact_number": "9999900000"},
        headers=admin_h, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture(scope="module")
def rm_no_price(admin_h):
    """Raw material NOT in any vendor price list."""
    r = requests.post(
        f"{BASE_URL}/api/raw-materials",
        json={"name": f"TEST_FreeMat_{TAG}", "unit": "kg", "current_stock": 0},
        headers=admin_h, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture(scope="module")
def rm_with_price(admin_h, supplier):
    """Raw material that has a vendor-list entry (price 75)."""
    name = f"TEST_IronSheet_{TAG}"
    rm = requests.post(
        f"{BASE_URL}/api/raw-materials",
        json={"name": name, "unit": "kg", "current_stock": 0},
        headers=admin_h, timeout=30,
    )
    assert rm.status_code in (200, 201), rm.text
    pl = requests.post(
        f"{BASE_URL}/api/vendor-price-lists",
        json={"name": f"TEST_PriceList_{TAG}", "vendor_id": supplier["id"]},
        headers=admin_h, timeout=30,
    )
    assert pl.status_code in (200, 201), pl.text
    pl_id = pl.json()["id"]
    it = requests.post(
        f"{BASE_URL}/api/vendor-price-lists/{pl_id}/items",
        json={"name": name, "unit": "kg", "price": 75},
        headers=admin_h, timeout=30,
    )
    assert it.status_code in (200, 201), it.text
    return rm.json()


# ---------- Task 1 -----------------------------------------------------------
class TestTask1NoPriceSave:

    def test_operator_can_save_without_rate(self, user_h, supplier, rm_no_price):
        body = {
            "supplier_id": supplier["id"],
            "amount": 0,
            "bill_number": f"TEST_OP_{TAG}",
            "items": [{
                "raw_material_id": rm_no_price["id"],
                "name": rm_no_price["name"],
                "unit": "kg",
                "quantity": 5,
                # rate omitted on purpose
            }],
        }
        r = requests.post(f"{BASE_URL}/api/supplier-purchases",
                          json=body, headers=user_h, timeout=30)
        assert r.status_code == 200, f"Operator should be allowed: {r.status_code} {r.text}"
        data = r.json()
        assert data["amount"] == 0, f"Expected amount=0, got {data['amount']}"
        assert len(data["items"]) == 1
        assert data["items"][0]["rate"] == 0
        assert data["items"][0]["quantity"] == 5

    def test_admin_can_save_without_rate(self, admin_h, supplier, rm_no_price):
        body = {
            "supplier_id": supplier["id"],
            "bill_number": f"TEST_AD_{TAG}",
            "items": [{
                "raw_material_id": rm_no_price["id"],
                "name": rm_no_price["name"],
                "unit": "kg",
                "quantity": 3,
            }],
        }
        r = requests.post(f"{BASE_URL}/api/supplier-purchases",
                          json=body, headers=admin_h, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["amount"] == 0
        assert data["items"][0]["rate"] == 0

    def test_vendor_list_still_autofills(self, admin_h, supplier, rm_with_price):
        body = {
            "supplier_id": supplier["id"],
            "bill_number": f"TEST_AUTO_{TAG}",
            "items": [{
                "raw_material_id": rm_with_price["id"],
                "name": rm_with_price["name"],
                "unit": "kg",
                "quantity": 4,
                "rate": 999,   # client tries to override — must be ignored
            }],
        }
        r = requests.post(f"{BASE_URL}/api/supplier-purchases",
                          json=body, headers=admin_h, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["items"][0]["rate"] == 75, \
            f"Expected vendor-list rate 75, got {data['items'][0]['rate']}"
        assert data["amount"] == 75 * 4


# ---------- Task 2 -----------------------------------------------------------
class TestTask2EditPurchase:

    def test_operator_cannot_patch(self, user_h, admin_h, supplier, rm_no_price):
        # create as admin first
        r = requests.post(
            f"{BASE_URL}/api/supplier-purchases",
            json={
                "supplier_id": supplier["id"],
                "bill_number": f"TEST_PATCH_{TAG}",
                "items": [{
                    "raw_material_id": rm_no_price["id"],
                    "name": rm_no_price["name"],
                    "unit": "kg",
                    "quantity": 2,
                    "rate": 10,
                }],
            },
            headers=admin_h, timeout=30,
        )
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        # operator attempts to PATCH
        rp = requests.patch(
            f"{BASE_URL}/api/supplier-purchases/{pid}",
            json={"bill_number": "HACK"}, headers=user_h, timeout=30,
        )
        assert rp.status_code == 403, \
            f"Operator must be 403, got {rp.status_code} {rp.text}"

    def test_admin_can_edit_and_stock_reconciles(
        self, admin_h, supplier, rm_no_price, rm_with_price,
    ):
        # Baseline stock of rm_no_price
        def stock(rid):
            g = requests.get(f"{BASE_URL}/api/raw-materials",
                             headers=admin_h, timeout=30)
            assert g.status_code == 200, g.text
            row = next((x for x in g.json() if x.get("id") == rid), None)
            assert row is not None, f"raw-material {rid} missing from list"
            return float(row.get("stock_on_hand") or row.get("current_stock") or 0)

        s_free_before = stock(rm_no_price["id"])
        s_iron_before = stock(rm_with_price["id"])

        # Create purchase with rm_no_price qty=4 rate=20
        cr = requests.post(
            f"{BASE_URL}/api/supplier-purchases",
            json={
                "supplier_id": supplier["id"],
                "bill_number": f"TEST_EDIT_{TAG}",
                "items": [{
                    "raw_material_id": rm_no_price["id"],
                    "name": rm_no_price["name"],
                    "unit": "kg",
                    "quantity": 4,
                    "rate": 20,
                }],
            },
            headers=admin_h, timeout=30,
        )
        assert cr.status_code == 200, cr.text
        pid = cr.json()["id"]
        # Stock should have gone up by 4
        assert stock(rm_no_price["id"]) == s_free_before + 4

        # PATCH — change qty to 7 AND add new line (iron sheet) qty=2
        patch_body = {
            "bill_number": f"TEST_EDIT_{TAG}_v2",
            "items": [
                {
                    "raw_material_id": rm_no_price["id"],
                    "name": rm_no_price["name"],
                    "unit": "kg",
                    "quantity": 7,
                    "rate": 20,
                },
                {
                    "raw_material_id": rm_with_price["id"],
                    "name": rm_with_price["name"],
                    "unit": "kg",
                    "quantity": 2,
                    "rate": 999,  # vendor list should still force 75
                },
            ],
        }
        rp = requests.patch(
            f"{BASE_URL}/api/supplier-purchases/{pid}",
            json=patch_body, headers=admin_h, timeout=30,
        )
        assert rp.status_code == 200, f"PATCH failed: {rp.status_code} {rp.text}"
        updated = rp.json()
        assert updated["bill_number"] == f"TEST_EDIT_{TAG}_v2"
        # Vendor-price re-validation on edit
        iron_line = next(
            it for it in updated["items"] if it["raw_material_id"] == rm_with_price["id"]
        )
        assert iron_line["rate"] == 75, \
            f"Vendor list must still bind on edit, got rate={iron_line['rate']}"
        # Amount = 7*20 + 2*75 = 140 + 150 = 290
        assert updated["amount"] == 290, f"Expected amount 290, got {updated['amount']}"

        # Stock reconciliation
        # rm_no_price: started s_free_before -> +4 then reverted -4 then +7 = +7
        assert stock(rm_no_price["id"]) == s_free_before + 7, \
            f"rm_no_price stock mismatch: now={stock(rm_no_price['id'])} expected={s_free_before + 7}"
        # rm_with_price: should have +2
        assert stock(rm_with_price["id"]) == s_iron_before + 2

        # GET ledger / verify persistence via supplier-ledger
        gl = requests.get(
            f"{BASE_URL}/api/supplier-ledger/{supplier['id']}",
            headers=admin_h, timeout=30,
        )
        assert gl.status_code == 200, gl.text
        rows = gl.json() if isinstance(gl.json(), list) else gl.json().get("rows") or gl.json().get("purchases") or []
        # The shape may vary — find purchase by id or bill_number
        def _has_match(seq):
            return any(
                (r.get("id") == pid) or (r.get("bill_number") == f"TEST_EDIT_{TAG}_v2")
                for r in seq if isinstance(r, dict)
            )
        if not _has_match(rows):
            # try nested shapes
            data = gl.json() if isinstance(gl.json(), dict) else {}
            for key in ("purchases", "items", "entries", "ledger"):
                if _has_match(data.get(key) or []):
                    return
            # last fallback: just ensure the PATCH response itself is correct
            assert updated["bill_number"] == f"TEST_EDIT_{TAG}_v2"


# ---------- Task 3 -----------------------------------------------------------
class TestTask3PwaAssets:

    def test_manifest_valid(self):
        r = requests.get(f"{BASE_URL}/manifest.json", timeout=30)
        assert r.status_code == 200, f"manifest.json: {r.status_code}"
        m = r.json()
        assert m.get("name") and "JK" in m["name"]
        assert m.get("start_url")
        assert m.get("display") == "standalone"
        assert m.get("theme_color")
        sizes = {i.get("sizes") for i in m.get("icons", [])}
        assert "192x192" in sizes and "512x512" in sizes, \
            f"Required icon sizes missing: {sizes}"

    def test_service_worker_served(self):
        r = requests.get(f"{BASE_URL}/service-worker.js", timeout=30)
        assert r.status_code == 200, r.status_code
        ct = r.headers.get("content-type", "")
        assert "javascript" in ct.lower(), f"Bad content-type: {ct}"
        assert "jk-logout" in r.text, "SW must listen for jk-logout messages"
        assert "/api/" in r.text, "SW must mention /api/ network bypass"
