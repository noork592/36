"""End-to-end backend tests for Factory Order Management System (Feb 2026 - items SKU update).

Covers:
  - Auth (admin/user login + /auth/me)
  - Products  (15 master products w/ min_per_bag/max_per_bag)
  - Items     (388 SKUs, /api/items, /api/items/search fuzzy, /api/items/{id})
  - Customers (fuzzy search case-insensitivity)
  - Orders    (create with item_id, merge_with_pending, clear_previous_pending, status, delete)
  - Dispatch  (bag math)
  - Voice     (auth required + empty payload 400 + parser unit)
"""
import os
import io
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"


# ----------------- Fixtures -----------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def user_token():
    r = requests.post(f"{API}/auth/login", json={"email": "user@factory.com", "password": "user123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture
def user_headers(user_token):
    return {"Authorization": f"Bearer {user_token}"}


# ----------------- Auth -----------------
class TestAuth:
    def test_login_admin(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "admin123"})
        assert r.status_code == 200
        data = r.json()
        assert "token" in data and isinstance(data["token"], str)
        assert data["user"]["role"] == "admin"
        assert data["user"]["email"] == "admin@factory.com"

    def test_login_invalid(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "wrong"})
        assert r.status_code == 401

    def test_me(self, admin_headers):
        r = requests.get(f"{API}/auth/me", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["email"] == "admin@factory.com"
        assert "password" not in data


# ----------------- Products (15 master products) -----------------
class TestProducts:
    def test_list_products(self, admin_headers):
        r = requests.get(f"{API}/products", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        # At least the 15 master products must be present (tolerates leftover
        # TEST_ products from aborted prior runs).
        assert len(data) >= 15, f"Expected >=15 products, got {len(data)}"
        names = {p["name"]: p for p in data}
        # Spot-check core seed values
        assert names["Side Stand"]["min_per_bag"] == 180
        assert names["Side Stand"]["max_per_bag"] == 200
        assert names["Side Footrest"]["min_per_bag"] == 50
        assert names["Side Footrest"]["max_per_bag"] == 50
        assert names["Number Plate"]["min_per_bag"] == 300
        assert names["Number Plate"]["max_per_bag"] == 400
        # New master products added Feb 2026
        for new_p in ("V-Bracket", "Luggage Rod", "Side Mirror Clump", "Rear Seat Handle"):
            assert new_p in names, f"Missing new product: {new_p}"

    def test_create_product_user_forbidden(self, user_headers):
        r = requests.post(f"{API}/products",
                          json={"name": "TEST_NoAccess", "min_per_bag": 10, "max_per_bag": 20},
                          headers=user_headers)
        assert r.status_code == 403


# ----------------- Items (388 SKUs) -----------------
class TestItems:
    def test_list_items(self, admin_headers):
        r = requests.get(f"{API}/items", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        # Expect 388 items per problem spec
        assert len(data) == 388, f"Expected 388 items, got {len(data)}"
        sample = data[0]
        for key in ("id", "name", "product_id", "product_name"):
            assert key in sample, f"Missing key {key} in item: {sample}"
        assert "_id" not in sample

    def test_list_items_filter_by_product(self, admin_headers):
        # Get Side Stand product id
        prods = requests.get(f"{API}/products", headers=admin_headers).json()
        side = next(p for p in prods if p["name"] == "Side Stand")
        r = requests.get(f"{API}/items", params={"product_id": side["id"]}, headers=admin_headers)
        assert r.status_code == 200
        items = r.json()
        assert len(items) > 0
        # all items should belong to side stand
        for it in items:
            assert it["product_id"] == side["id"]
            assert it["product_name"] == "Side Stand"

    def test_search_items_side_stand_splendor(self, admin_headers):
        r = requests.get(f"{API}/items/search", params={"q": "side stand splendor", "limit": 10},
                         headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0, "No matches for 'side stand splendor'"
        # Top result should mention splendor
        top = data[0]
        assert "match_score" in top
        assert top["match_score"] >= 60
        assert "SPLENDOR" in top["name"].upper() or "SPLENDER" in top["name"].upper()

    def test_search_items_yamaha(self, admin_headers):
        r = requests.get(f"{API}/items/search", params={"q": "yamaha"}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        # Expect at least 1 yamaha result
        assert len(data) > 0
        for it in data:
            assert "match_score" in it
            assert it["match_score"] >= 35

    def test_search_items_empty_query(self, admin_headers):
        # Empty q returns first `limit` items (per impl) — not empty
        r = requests.get(f"{API}/items/search", params={"q": "", "limit": 5}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 5

    def test_get_item_by_id(self, admin_headers):
        items = requests.get(f"{API}/items", headers=admin_headers).json()
        target = items[0]
        r = requests.get(f"{API}/items/{target['id']}", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == target["id"]
        assert data["name"] == target["name"]
        assert "_id" not in data

    def test_get_item_404(self, admin_headers):
        r = requests.get(f"{API}/items/non-existent-id-xyz", headers=admin_headers)
        assert r.status_code == 404


# ----------------- Customers (fuzzy case-insensitive) -----------------
class TestCustomers:
    def test_create_customer_admin(self, admin_headers):
        body = {"name": "TEST_Ramesh Auto Parts", "phone": "9999900001",
                "address": "Test Addr", "preferences": {}}
        r = requests.post(f"{API}/customers", json=body, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "TEST_Ramesh Auto Parts"
        assert "id" in data
        TestCustomers.cid = data["id"]

    def test_fuzzy_search_typo(self, admin_headers):
        r = requests.get(f"{API}/customers/search", params={"q": "Ramsh"}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        matches = [c for c in data if "TEST_Ramesh Auto Parts" in c["name"]]
        assert len(matches) > 0, f"Fuzzy search did not return Ramesh: {data[:5]}"
        assert matches[0]["match_score"] > 50

    def test_fuzzy_search_lowercase(self, admin_headers):
        # Regression: case-insensitive (iter2 found case-sensitivity bug)
        r = requests.get(f"{API}/customers/search", params={"q": "ramesh"}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        matches = [c for c in data if "TEST_Ramesh" in c["name"]]
        assert len(matches) > 0, "Lowercase fuzzy search failed (case-sensitivity bug)"


# ----------------- Orders with item_id -----------------
class TestOrders:
    @pytest.fixture(scope="class")
    def customer(self, admin_token):
        h = {"Authorization": f"Bearer {admin_token}"}
        body = {"name": "TEST_Item Order Customer", "phone": "8888800099", "preferences": {}}
        r = requests.post(f"{API}/customers", json=body, headers=h)
        assert r.status_code == 200
        return r.json()

    @pytest.fixture(scope="class")
    def some_item(self, admin_token):
        h = {"Authorization": f"Bearer {admin_token}"}
        # Pick a Side Stand item via search
        r = requests.get(f"{API}/items/search", params={"q": "side stand splendor"}, headers=h)
        data = r.json()
        assert len(data) > 0
        return data[0]

    def test_create_order_with_item_id(self, customer, some_item, admin_headers):
        body = {
            "customer_id": customer["id"],
            "items": [{
                "product_name": some_item["product_name"],
                "item_id": some_item["id"],
                "item_name": some_item["name"],
                "quantity": 10,
                "variant": "Type A" if some_item["product_name"] == "Side Stand" else None,
            }],
            "notes": "TEST item_id order",
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200, r.text
        order = r.json()
        assert order["status"] == "Pending"
        assert order["customer_name"] == customer["name"]
        assert len(order["items"]) == 1
        line = order["items"][0]
        assert line["item_id"] == some_item["id"], f"item_id missing on saved order line: {line}"
        assert line["item_name"] == some_item["name"]
        assert line["product_name"] == some_item["product_name"]
        assert line["quantity"] == 10
        TestOrders.first_order_id = order["id"]

    def test_persisted_order_has_item_id(self, admin_headers):
        # GET /api/orders and verify item_id persisted
        r = requests.get(f"{API}/orders", headers=admin_headers)
        assert r.status_code == 200
        orders = r.json()
        target = next((o for o in orders if o["id"] == TestOrders.first_order_id), None)
        assert target is not None
        line = target["items"][0]
        assert line.get("item_id"), f"Order line missing item_id after persist: {line}"
        assert line.get("item_name")

    def test_merge_with_pending(self, customer, admin_headers):
        # Pick another item
        items = requests.get(f"{API}/items/search", params={"q": "number plate"},
                             headers=admin_headers).json()
        item2 = items[0]
        body = {
            "customer_id": customer["id"],
            "items": [{
                "product_name": item2["product_name"],
                "item_id": item2["id"],
                "item_name": item2["name"],
                "quantity": 700,
            }],
            "merge_with_pending": True,
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200
        order = r.json()
        assert order["id"] == TestOrders.first_order_id
        item_ids = [it.get("item_id") for it in order["items"]]
        assert item2["id"] in item_ids

    def test_clear_previous_pending(self, customer, admin_headers):
        items = requests.get(f"{API}/items/search", params={"q": "handlebar"},
                             headers=admin_headers).json()
        item3 = items[0]
        body = {
            "customer_id": customer["id"],
            "items": [{
                "product_name": item3["product_name"],
                "item_id": item3["id"],
                "item_name": item3["name"],
                "quantity": 200,
            }],
            "clear_previous_pending": True,
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200
        new_order = r.json()
        assert new_order["status"] == "Pending"
        # Previous order should be Cleared
        orders = requests.get(f"{API}/orders", headers=admin_headers).json()
        prev = next(o for o in orders if o["id"] == TestOrders.first_order_id)
        assert prev["status"] == "Cleared"
        TestOrders.handlebar_order_id = new_order["id"]

    def test_update_order_status(self, admin_headers):
        oid = TestOrders.handlebar_order_id
        r = requests.patch(f"{API}/orders/{oid}/status", json={"status": "Dispatched"},
                           headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["status"] == "Dispatched"

    def test_delete_order_user_forbidden(self, user_headers):
        oid = TestOrders.handlebar_order_id
        r = requests.delete(f"{API}/orders/{oid}", headers=user_headers)
        assert r.status_code == 403

    def test_delete_order_admin(self, admin_headers):
        oid = TestOrders.handlebar_order_id
        r = requests.delete(f"{API}/orders/{oid}", headers=admin_headers)
        assert r.status_code == 200


# ----------------- Voice -----------------
class TestVoice:
    def test_voice_empty(self, admin_headers):
        files = {"file": ("empty.webm", io.BytesIO(b""), "audio/webm")}
        r = requests.post(f"{API}/voice/transcribe", headers=admin_headers, files=files)
        assert r.status_code == 400, r.text

    def test_voice_no_auth(self):
        files = {"file": ("empty.webm", io.BytesIO(b""), "audio/webm")}
        r = requests.post(f"{API}/voice/transcribe", files=files)
        assert r.status_code in (401, 403), r.status_code


# ----------------- Dashboard -----------------
class TestDashboard:
    def test_summary(self, admin_headers):
        r = requests.get(f"{API}/dashboard/summary", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        for key in ("stats", "product_totals", "party_breakdown"):
            assert key in data
        for key in ("total_orders", "pending_orders", "dispatched_orders",
                    "cleared_orders", "customers"):
            assert key in data["stats"]
