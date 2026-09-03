"""
Iteration 4 — Vendor Price Lists CRUD + items CRUD.
Tests:
 - POST/GET/PATCH/DELETE /api/vendor-price-lists
 - POST/PATCH/DELETE /api/vendor-price-lists/{vpl_id}/items/{vpi_id}
 - Role gating: operator forbidden from mutations, allowed to read
 - Cascade delete of items when parent list deleted
 - Regression: /api/price-lists and /api/suppliers still respond OK
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"


# ---------------- Fixtures ----------------

@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": "admin", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def operator_token():
    r = requests.post(f"{API}/auth/login", json={"email": "user", "password": "user123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def operator_headers(operator_token):
    return {"Authorization": f"Bearer {operator_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def test_vendor(admin_headers):
    """Create a TEST_ vendor (supplier) for the entire session."""
    name = f"TEST_VPL_VENDOR_{uuid.uuid4().hex[:6]}"
    r = requests.post(f"{API}/suppliers", json={"name": name, "phone": "9999999999"}, headers=admin_headers, timeout=30)
    assert r.status_code in (200, 201), r.text
    sup = r.json()
    yield sup
    # Teardown
    requests.delete(f"{API}/suppliers/{sup['id']}", headers=admin_headers, timeout=30)


@pytest.fixture(scope="session", autouse=True)
def session_cleanup(admin_headers):
    yield
    # End of session: nuke any leftover TEST_VPL_ price lists
    r = requests.get(f"{API}/vendor-price-lists", headers=admin_headers, timeout=30)
    if r.status_code == 200:
        for pl in r.json():
            if str(pl.get("name", "")).startswith("TEST_VPL_"):
                requests.delete(f"{API}/vendor-price-lists/{pl['id']}", headers=admin_headers, timeout=30)


# ---------------- CRUD parent list ----------------

class TestVendorPriceListCRUD:
    def test_create_requires_name(self, admin_headers, test_vendor):
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": "", "vendor_id": test_vendor["id"]},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_create_requires_vendor(self, admin_headers):
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": "TEST_VPL_X", "vendor_id": "does-not-exist-xyz"},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 404, r.text

    def test_create_success_and_get(self, admin_headers, test_vendor):
        name = f"TEST_VPL_{uuid.uuid4().hex[:6]}"
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": name, "vendor_id": test_vendor["id"], "description": "session list"},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert data["name"] == name
        assert data["vendor_id"] == test_vendor["id"]
        assert data["vendor_name"] == test_vendor["name"]
        assert data["items_count"] == 0
        assert "id" in data
        vpl_id = data["id"]

        # GET list
        g = requests.get(f"{API}/vendor-price-lists", headers=admin_headers, timeout=30).json()
        found = [p for p in g if p["id"] == vpl_id]
        assert len(found) == 1
        assert found[0]["items_count"] == 0
        assert found[0]["vendor_name"] == test_vendor["name"]

        # GET by id
        d = requests.get(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30)
        assert d.status_code == 200
        body = d.json()
        assert body["id"] == vpl_id
        assert isinstance(body.get("items"), list)
        assert body["items"] == []

        # PATCH name + description
        new_name = name + "_upd"
        p = requests.patch(
            f"{API}/vendor-price-lists/{vpl_id}",
            json={"name": new_name, "description": "edited"},
            headers=admin_headers, timeout=30,
        )
        assert p.status_code == 200, p.text
        assert p.json()["name"] == new_name

        # Verify persisted via GET
        d2 = requests.get(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30).json()
        assert d2["name"] == new_name
        assert d2["description"] == "edited"

        # PATCH vendor_id to non-existent => 404
        bad = requests.patch(
            f"{API}/vendor-price-lists/{vpl_id}",
            json={"vendor_id": "ghost-id"},
            headers=admin_headers, timeout=30,
        )
        assert bad.status_code == 404

        # DELETE
        dl = requests.delete(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30)
        assert dl.status_code == 200
        # Confirm gone
        g2 = requests.get(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30)
        assert g2.status_code == 404


# ---------------- Items CRUD + cascade ----------------

class TestVendorPriceListItems:
    @pytest.fixture()
    def vpl(self, admin_headers, test_vendor):
        name = f"TEST_VPL_ITEMS_{uuid.uuid4().hex[:6]}"
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": name, "vendor_id": test_vendor["id"]},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code in (200, 201)
        vpl = r.json()
        yield vpl
        requests.delete(f"{API}/vendor-price-lists/{vpl['id']}", headers=admin_headers, timeout=30)

    def test_add_item_requires_name(self, admin_headers, vpl):
        r = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "", "unit": "kg", "price": 12.5},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_add_item_non_existent_vpl(self, admin_headers):
        r = requests.post(
            f"{API}/vendor-price-lists/ghost-vpl-id/items",
            json={"name": "Foo", "unit": "kg", "price": 1.0},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 404

    def test_full_item_lifecycle(self, admin_headers, vpl):
        # Add
        r = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "Cement Bag", "unit": "bag", "price": 350.75, "notes": "OPC53"},
            headers=admin_headers, timeout=30,
        )
        assert r.status_code in (200, 201), r.text
        item = r.json()
        assert item["name"] == "Cement Bag"
        assert item["unit"] == "bag"
        assert item["price"] == 350.75
        assert item["notes"] == "OPC53"
        vpi_id = item["id"]

        # items_count must reflect 1
        lst = requests.get(f"{API}/vendor-price-lists", headers=admin_headers, timeout=30).json()
        for pl in lst:
            if pl["id"] == vpl["id"]:
                assert pl["items_count"] == 1

        # GET detail returns items array
        det = requests.get(f"{API}/vendor-price-lists/{vpl['id']}", headers=admin_headers, timeout=30).json()
        assert len(det["items"]) == 1
        assert det["items"][0]["id"] == vpi_id

        # PATCH item
        p = requests.patch(
            f"{API}/vendor-price-lists/{vpl['id']}/items/{vpi_id}",
            json={"name": "Cement", "price": 400.0, "unit": "bag", "notes": "updated"},
            headers=admin_headers, timeout=30,
        )
        assert p.status_code == 200, p.text
        upd = p.json()
        assert upd["name"] == "Cement"
        assert upd["price"] == 400.0
        assert upd["notes"] == "updated"

        # Add 2nd item then delete only 1st
        r2 = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "Sand", "unit": "ton", "price": 1200},
            headers=admin_headers, timeout=30,
        )
        assert r2.status_code in (200, 201)
        vpi2 = r2.json()["id"]

        dl = requests.delete(
            f"{API}/vendor-price-lists/{vpl['id']}/items/{vpi_id}",
            headers=admin_headers, timeout=30,
        )
        assert dl.status_code == 200

        det2 = requests.get(f"{API}/vendor-price-lists/{vpl['id']}", headers=admin_headers, timeout=30).json()
        ids = [i["id"] for i in det2["items"]]
        assert vpi_id not in ids
        assert vpi2 in ids

    def test_cascade_delete_removes_items(self, admin_headers, test_vendor):
        # Create a list + 2 items, delete list, ensure items are removed
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": f"TEST_VPL_CASCADE_{uuid.uuid4().hex[:6]}", "vendor_id": test_vendor["id"]},
            headers=admin_headers, timeout=30,
        )
        vpl_id = r.json()["id"]
        for i in range(2):
            requests.post(
                f"{API}/vendor-price-lists/{vpl_id}/items",
                json={"name": f"Item{i}", "unit": "ea", "price": i + 1.0},
                headers=admin_headers, timeout=30,
            )
        det = requests.get(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30).json()
        assert len(det["items"]) == 2

        dl = requests.delete(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30)
        assert dl.status_code == 200

        # Parent gone => GET 404
        g = requests.get(f"{API}/vendor-price-lists/{vpl_id}", headers=admin_headers, timeout=30)
        assert g.status_code == 404


# ---------------- Role gating ----------------

class TestRoleGating:
    @pytest.fixture()
    def vpl(self, admin_headers, test_vendor):
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": f"TEST_VPL_ROLE_{uuid.uuid4().hex[:6]}", "vendor_id": test_vendor["id"]},
            headers=admin_headers, timeout=30,
        )
        vpl = r.json()
        yield vpl
        requests.delete(f"{API}/vendor-price-lists/{vpl['id']}", headers=admin_headers, timeout=30)

    def test_operator_can_get(self, operator_headers, vpl):
        r = requests.get(f"{API}/vendor-price-lists", headers=operator_headers, timeout=30)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/vendor-price-lists/{vpl['id']}", headers=operator_headers, timeout=30)
        assert r2.status_code == 200

    def test_operator_cannot_create(self, operator_headers, test_vendor):
        r = requests.post(
            f"{API}/vendor-price-lists",
            json={"name": "TEST_VPL_OP_DENY", "vendor_id": test_vendor["id"]},
            headers=operator_headers, timeout=30,
        )
        assert r.status_code in (401, 403), r.text

    def test_operator_cannot_patch(self, operator_headers, vpl):
        r = requests.patch(
            f"{API}/vendor-price-lists/{vpl['id']}",
            json={"name": "hacked"},
            headers=operator_headers, timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_operator_cannot_delete(self, operator_headers, vpl):
        r = requests.delete(f"{API}/vendor-price-lists/{vpl['id']}", headers=operator_headers, timeout=30)
        assert r.status_code in (401, 403)

    def test_operator_cannot_add_item(self, operator_headers, vpl):
        r = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "x", "unit": "ea", "price": 1.0},
            headers=operator_headers, timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_operator_cannot_patch_item(self, operator_headers, admin_headers, vpl):
        # Admin creates an item, operator attempts patch
        ar = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "Wire", "unit": "m", "price": 5.0},
            headers=admin_headers, timeout=30,
        )
        vpi_id = ar.json()["id"]
        r = requests.patch(
            f"{API}/vendor-price-lists/{vpl['id']}/items/{vpi_id}",
            json={"price": 999.0},
            headers=operator_headers, timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_operator_cannot_delete_item(self, operator_headers, admin_headers, vpl):
        ar = requests.post(
            f"{API}/vendor-price-lists/{vpl['id']}/items",
            json={"name": "Pipe", "unit": "m", "price": 5.0},
            headers=admin_headers, timeout=30,
        )
        vpi_id = ar.json()["id"]
        r = requests.delete(
            f"{API}/vendor-price-lists/{vpl['id']}/items/{vpi_id}",
            headers=operator_headers, timeout=30,
        )
        assert r.status_code in (401, 403)


# ---------------- Regression: existing endpoints untouched ----------------

class TestRegression:
    def test_price_lists_still_works(self, admin_headers):
        r = requests.get(f"{API}/price-lists", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_suppliers_still_works(self, admin_headers):
        r = requests.get(f"{API}/suppliers", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
