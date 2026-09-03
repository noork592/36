"""Iteration 3 backend tests — Raw Materials CRUD + supplier-purchase line items.

Covers:
- Raw materials CRUD (admin) + role gating (operator read-only)
- Validation (empty name -> 400)
- supplier-purchases with items[] line totals + auto-built material
- supplier-ledger preserves items[]
- Backward compat: no items + amount > 0 works
- amount <= 0 -> 400
- invalid raw_material_id is stored as-is
"""
import os
import uuid
import pytest
import requests
from pathlib import Path


def _read_backend_url() -> str:
    val = os.environ.get("REACT_APP_BACKEND_URL")
    if val:
        return val.rstrip("/")
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not found")


BASE_URL = _read_backend_url()
API = f"{BASE_URL}/api"


# ---------- helpers ----------
def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in login response: {r.text}"
    return tok


@pytest.fixture(scope="module")
def admin_headers():
    return {"Authorization": f"Bearer {_login('admin', 'admin123')}"}


@pytest.fixture(scope="module")
def operator_headers():
    return {"Authorization": f"Bearer {_login('user', 'user123')}"}


@pytest.fixture(scope="module")
def created_ids():
    """Track ids for teardown across tests."""
    return {"raw_materials": [], "suppliers": [], "purchases": []}


@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_headers, created_ids):
    yield
    # Teardown — order matters: purchases -> suppliers -> raw_materials
    for pid in created_ids["purchases"]:
        try:
            requests.delete(f"{API}/supplier-purchases/{pid}", headers=admin_headers, timeout=10)
        except Exception:
            pass
    for sid in created_ids["suppliers"]:
        try:
            requests.delete(f"{API}/suppliers/{sid}", headers=admin_headers, timeout=10)
        except Exception:
            pass
    for rid in created_ids["raw_materials"]:
        try:
            requests.delete(f"{API}/raw-materials/{rid}", headers=admin_headers, timeout=10)
        except Exception:
            pass


# ====================== Raw Materials CRUD ======================
class TestRawMaterialsCRUD:
    def test_create_raw_material_admin(self, admin_headers, created_ids):
        payload = {"name": f"TEST_RM_{uuid.uuid4().hex[:6]}", "unit": "kg",
                   "default_rate": 150.5, "notes": "TEST iter3"}
        r = requests.post(f"{API}/raw-materials", json=payload, headers=admin_headers, timeout=20)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert data["name"] == payload["name"]
        assert data["unit"] == "kg"
        assert data["default_rate"] == 150.5
        assert data["notes"] == "TEST iter3"
        assert "id" in data and isinstance(data["id"], str)
        assert "_id" not in data
        created_ids["raw_materials"].append(data["id"])

    def test_list_raw_materials_contains_created(self, admin_headers, created_ids):
        r = requests.get(f"{API}/raw-materials", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        # no _id leak
        for it in items:
            assert "_id" not in it
        ids = [it["id"] for it in items]
        assert created_ids["raw_materials"][0] in ids

    def test_update_raw_material(self, admin_headers, created_ids):
        rid = created_ids["raw_materials"][0]
        upd = {"name": f"TEST_RM_UPD_{uuid.uuid4().hex[:4]}", "default_rate": 200,
               "unit": "pcs", "notes": "updated"}
        r = requests.patch(f"{API}/raw-materials/{rid}", json=upd, headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["name"] == upd["name"]
        assert data["default_rate"] == 200.0
        assert data["unit"] == "pcs"
        assert data["notes"] == "updated"

    def test_empty_name_returns_400(self, admin_headers):
        r = requests.post(f"{API}/raw-materials", json={"name": "  ", "unit": "kg"},
                          headers=admin_headers, timeout=20)
        assert r.status_code == 400, r.text

    def test_operator_can_list(self, operator_headers):
        r = requests.get(f"{API}/raw-materials", headers=operator_headers, timeout=20)
        assert r.status_code == 200

    def test_operator_cannot_post(self, operator_headers):
        r = requests.post(f"{API}/raw-materials",
                          json={"name": "TEST_OP_DENY", "unit": "kg"},
                          headers=operator_headers, timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_operator_cannot_patch(self, operator_headers, created_ids):
        rid = created_ids["raw_materials"][0]
        r = requests.patch(f"{API}/raw-materials/{rid}", json={"name": "x"},
                           headers=operator_headers, timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_operator_cannot_delete(self, operator_headers, created_ids):
        rid = created_ids["raw_materials"][0]
        r = requests.delete(f"{API}/raw-materials/{rid}", headers=operator_headers, timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_delete_raw_material(self, admin_headers, created_ids):
        # Create a throwaway then delete
        payload = {"name": f"TEST_RM_DEL_{uuid.uuid4().hex[:6]}", "unit": "pcs"}
        c = requests.post(f"{API}/raw-materials", json=payload, headers=admin_headers, timeout=20)
        assert c.status_code in (200, 201)
        rid = c.json()["id"]
        d = requests.delete(f"{API}/raw-materials/{rid}", headers=admin_headers, timeout=20)
        assert d.status_code == 200
        assert d.json().get("ok") is True
        # Verify removed
        lst = requests.get(f"{API}/raw-materials", headers=admin_headers, timeout=20).json()
        assert rid not in [it["id"] for it in lst]


# ====================== Supplier Purchase line items ======================
class TestSupplierPurchaseLineItems:
    @pytest.fixture(scope="class")
    def supplier_and_materials(self, admin_headers, created_ids):
        # Supplier
        sup = requests.post(f"{API}/suppliers",
                            json={"name": f"TEST_SUP_{uuid.uuid4().hex[:6]}",
                                  "phone": "9999999999", "city": "TEST"},
                            headers=admin_headers, timeout=20)
        assert sup.status_code in (200, 201), sup.text
        supplier_id = sup.json()["id"]
        created_ids["suppliers"].append(supplier_id)
        # 2 raw materials
        rm_ids = []
        for nm, unit, rate in [("Iron Sheet", "kg", 80), ("Bolts", "pcs", 5)]:
            rr = requests.post(f"{API}/raw-materials",
                               json={"name": f"TEST_{nm}_{uuid.uuid4().hex[:4]}",
                                     "unit": unit, "default_rate": rate},
                               headers=admin_headers, timeout=20)
            assert rr.status_code in (200, 201), rr.text
            rm_ids.append(rr.json()["id"])
            created_ids["raw_materials"].append(rr.json()["id"])
        return supplier_id, rm_ids

    def test_create_purchase_with_items(self, admin_headers, supplier_and_materials, created_ids):
        supplier_id, rm_ids = supplier_and_materials
        items = [
            {"raw_material_id": rm_ids[0], "name": "Iron Sheet", "unit": "kg",
             "quantity": 10, "rate": 80},
            {"raw_material_id": rm_ids[1], "name": "Bolts", "unit": "pcs",
             "quantity": 50, "rate": 5},
        ]
        computed_total = 10 * 80 + 50 * 5  # 1050
        payload = {
            "supplier_id": supplier_id,
            "amount": computed_total,
            "bill_number": "TEST-BILL-001",
            "purchased_at": "2026-01-10",
            "notes": "iter3 line-item test",
            "items": items,
        }
        r = requests.post(f"{API}/supplier-purchases", json=payload,
                          headers=admin_headers, timeout=20)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert "_id" not in data
        assert data["amount"] == 1050.0
        assert data["supplier_id"] == supplier_id
        assert isinstance(data["items"], list) and len(data["items"]) == 2
        # Verify line_value
        assert data["items"][0]["line_value"] == 800.0
        assert data["items"][1]["line_value"] == 250.0
        assert data["items"][0]["raw_material_id"] == rm_ids[0]
        # auto-built material summary
        assert data["material"]
        assert "Iron Sheet" in data["material"]
        assert "Bolts" in data["material"]
        created_ids["purchases"].append(data["id"])

    def test_supplier_ledger_preserves_items(self, admin_headers, supplier_and_materials):
        supplier_id, _ = supplier_and_materials
        r = requests.get(f"{API}/supplier-ledger/{supplier_id}", headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        rows = body.get("rows", [])
        purchase_rows = [row for row in rows if row.get("kind") == "purchase"]
        assert len(purchase_rows) >= 1
        # The first/only purchase from this test
        target = purchase_rows[-1]
        assert "raw" in target
        items = target["raw"].get("items") or []
        assert len(items) == 2
        assert items[0]["line_value"] == 800.0

    def test_purchase_no_items_amount_positive(self, admin_headers, supplier_and_materials,
                                               created_ids):
        supplier_id, _ = supplier_and_materials
        payload = {"supplier_id": supplier_id, "amount": 500, "bill_number": "TEST-NOITEMS",
                   "material": "Misc", "notes": "no items"}
        r = requests.post(f"{API}/supplier-purchases", json=payload,
                          headers=admin_headers, timeout=20)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert data["amount"] == 500.0
        assert data["items"] == []
        created_ids["purchases"].append(data["id"])

    def test_purchase_zero_amount_rejected(self, admin_headers, supplier_and_materials):
        supplier_id, _ = supplier_and_materials
        r = requests.post(f"{API}/supplier-purchases",
                          json={"supplier_id": supplier_id, "amount": 0,
                                "items": [{"name": "x", "quantity": 1, "rate": 0}]},
                          headers=admin_headers, timeout=20)
        assert r.status_code == 400, r.text

    def test_purchase_negative_amount_rejected(self, admin_headers, supplier_and_materials):
        supplier_id, _ = supplier_and_materials
        r = requests.post(f"{API}/supplier-purchases",
                          json={"supplier_id": supplier_id, "amount": -10},
                          headers=admin_headers, timeout=20)
        assert r.status_code == 400, r.text

    def test_purchase_with_invalid_raw_material_id_stored_as_is(self, admin_headers,
                                                                supplier_and_materials,
                                                                created_ids):
        supplier_id, _ = supplier_and_materials
        bogus_rmid = str(uuid.uuid4())
        items = [{"raw_material_id": bogus_rmid, "name": "Phantom", "unit": "kg",
                  "quantity": 2, "rate": 100}]
        r = requests.post(f"{API}/supplier-purchases",
                          json={"supplier_id": supplier_id, "amount": 200, "items": items,
                                "bill_number": "TEST-PHANTOM"},
                          headers=admin_headers, timeout=20)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert data["items"][0]["raw_material_id"] == bogus_rmid
        assert data["items"][0]["line_value"] == 200.0
        created_ids["purchases"].append(data["id"])
