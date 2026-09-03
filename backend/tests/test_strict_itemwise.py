"""Strict item-wise tests (Jan 2026):
- POST /api/orders must 422 when item_id/item_name is missing
- GET /api/dashboard/summary returns item-wise rows (item_id+item_name+product_name)
- POST /api/dispatch/match accepts {items: {item_id: qty}} and returns item-wise allocations
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
API = f"{BASE_URL.rstrip('/')}/api"


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "admin123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def some_customer(admin_headers):
    body = {"name": "TEST_StrictItemwise Cust", "phone": "777", "preferences": {}}
    r = requests.post(f"{API}/customers", json=body, headers=admin_headers)
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="module")
def side_stand_item(admin_headers):
    r = requests.get(f"{API}/items/search", params={"q": "side stand"}, headers=admin_headers)
    items = r.json()
    assert len(items) > 0
    return items[0]


class TestOrderStrictItemwise:
    def test_order_missing_item_id_returns_422(self, some_customer, admin_headers):
        # Pydantic rejects missing required item_id/item_name with 422
        body = {
            "customer_id": some_customer["id"],
            "items": [{"product_name": "Side Stand", "quantity": 50}],  # no item_id/item_name
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 422, f"Expected 422, got {r.status_code}: {r.text}"
        detail = r.text.lower()
        assert "item_id" in detail or "item_name" in detail, f"Detail should mention missing fields: {r.text}"

    def test_order_missing_only_item_name_returns_422(self, some_customer, side_stand_item, admin_headers):
        body = {
            "customer_id": some_customer["id"],
            "items": [{
                "product_name": side_stand_item["product_name"],
                "item_id": side_stand_item["id"],
                "quantity": 5,
            }],
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 422
        assert "item_name" in r.text.lower()

    def test_order_unknown_item_id_returns_400(self, some_customer, admin_headers):
        body = {
            "customer_id": some_customer["id"],
            "items": [{
                "product_name": "Side Stand",
                "item_id": "non-existent-uuid-xyz",
                "item_name": "FAKE ITEM",
                "quantity": 5,
            }],
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 400
        assert "unknown" in r.text.lower() or "item_id" in r.text.lower()

    def test_valid_order_succeeds(self, some_customer, side_stand_item, admin_headers):
        body = {
            "customer_id": some_customer["id"],
            "items": [{
                "product_name": side_stand_item["product_name"],
                "item_id": side_stand_item["id"],
                "item_name": side_stand_item["name"],
                "quantity": 25,
            }],
            "notes": "TEST_strict",
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200, r.text
        order = r.json()
        assert order["items"][0]["item_id"] == side_stand_item["id"]
        TestOrderStrictItemwise.created_order_id = order["id"]
        TestOrderStrictItemwise.created_item = side_stand_item


class TestDashboardItemwise:
    def test_dashboard_returns_item_totals(self, admin_headers):
        r = requests.get(f"{API}/dashboard/summary", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "item_totals" in data, "Missing item_totals key"
        assert "product_totals" in data, "Missing product_totals backward-compat key"
        assert "party_breakdown" in data
        # item_totals should be list of dicts with item_id, item_name, product_name, quantity
        if data["item_totals"]:
            row = data["item_totals"][0]
            for key in ("item_id", "item_name", "product_name", "quantity"):
                assert key in row, f"Missing {key} in item_totals row: {row}"
            # product_totals backward-compat: should mirror item_totals (item-wise)
            assert "item_id" in data["product_totals"][0]

    def test_dashboard_party_breakdown_has_item_chips(self, admin_headers):
        r = requests.get(f"{API}/dashboard/summary", headers=admin_headers)
        data = r.json()
        if data["party_breakdown"]:
            party = data["party_breakdown"][0]
            assert "customer_name" in party
            assert "items" in party
            if party["items"]:
                chip = party["items"][0]
                for key in ("item_id", "item_name", "product_name", "quantity"):
                    assert key in chip, f"Missing {key} in party chip: {chip}"


class TestDispatchItemwise:
    def test_dispatch_match_accepts_item_id_keys(self, admin_headers):
        # Pick a pending item that exists in dashboard
        r = requests.get(f"{API}/dashboard/summary", headers=admin_headers)
        data = r.json()
        assert data["item_totals"], "No pending items found to test dispatch"
        first_item = data["item_totals"][0]
        item_id = first_item["item_id"]
        qty_avail = max(first_item["quantity"], 50)

        body = {"items": {item_id: qty_avail}}
        r = requests.post(f"{API}/dispatch/match", json=body, headers=admin_headers)
        assert r.status_code == 200, r.text
        result = r.json()
        for key in ("suggestions", "bag_calculation", "leftover_stock", "per_item_allocated", "input_stock"):
            assert key in result, f"Missing {key} in dispatch response"

        # At least one suggestion expected
        assert len(result["suggestions"]) > 0
        sugg = result["suggestions"][0]
        assert "order_id" in sugg and "customer_name" in sugg and "allocations" in sugg
        alloc = sugg["allocations"][0]
        for key in ("item_id", "item_name", "product_name", "needed", "allocated", "shortfall"):
            assert key in alloc, f"Missing {key} in allocation: {alloc}"

        # per_item_allocated keyed item-wise
        if result["per_item_allocated"]:
            row = result["per_item_allocated"][0]
            for key in ("item_id", "item_name", "product_name", "allocated_qty"):
                assert key in row

        # bag_calculation grouped by master product
        if result["bag_calculation"]:
            bag = result["bag_calculation"][0]
            for key in ("product_name", "allocated_qty", "min_bags", "max_bags", "bag_range_label"):
                assert key in bag

    def test_dispatch_match_leftover_with_item_metadata(self, admin_headers):
        # Pick an item, supply MORE than needed → leftover should be reported with item meta
        r = requests.get(f"{API}/items/search", params={"q": "side stand"}, headers=admin_headers)
        items = r.json()
        # Pick an SKU that is NOT in pending orders to guarantee leftover
        target = items[-1]
        body = {"items": {target["id"]: 99999}}
        r = requests.post(f"{API}/dispatch/match", json=body, headers=admin_headers)
        assert r.status_code == 200
        result = r.json()
        leftover_ids = [lo["item_id"] for lo in result["leftover_stock"]]
        # Either the item is leftover OR it was allocated fully; if leftover present check structure
        if leftover_ids:
            lo = result["leftover_stock"][0]
            for key in ("item_id", "item_name", "product_name", "quantity"):
                assert key in lo
