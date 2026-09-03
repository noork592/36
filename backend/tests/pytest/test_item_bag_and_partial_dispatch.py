"""Pytest suite for the two NEWLY ADDED features (Feb 2026):

  (1) Item-Level Bag Limit overrides
      - PATCH /api/items/{id} (admin) sets per-SKU min/max bag size
      - GET /api/items/{id} returns those values
      - DELETE /api/items/{id}/bag-override clears the override
      - Non-admin gets 403; invalid bodies 400; unknown id 404
      - POST /api/dispatch/match uses the override in bag_calculation for
        that SKU (scope='item') and the master product limits otherwise.

  (2) Partial / Lot-wise Dispatching
      - POST /api/dispatch/execute happy path reduces order qty by allocation
      - Exhausting the order flips status to Dispatched and preserves
        original_items.
      - 404 unknown order, 400 already-dispatched, 400 empty allocations,
        400 overshoot, 400 unknown item_id, 400 all-zero allocations.
      - GET /api/dispatches?order_id=... returns history in reverse-chrono
        with total_pcs + order_fully_dispatched flags.
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


# ---------- shared fixtures ----------
@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login",
                      json={"email": "admin@factory.com", "password": "admin123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def user_headers():
    r = requests.post(f"{API}/auth/login",
                      json={"email": "user@factory.com", "password": "user123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def side_stand_item(admin_headers):
    r = requests.get(f"{API}/items/search",
                     params={"q": "side stand splendor"}, headers=admin_headers)
    assert r.status_code == 200 and r.json()
    return r.json()[0]


@pytest.fixture(scope="module")
def test_customer(admin_headers):
    body = {"name": "TEST_PartialDispatch Cust", "phone": "7000000777", "preferences": {}}
    r = requests.post(f"{API}/customers", json=body, headers=admin_headers)
    assert r.status_code == 200
    return r.json()


# ============================================================
# (1) Item-Level Bag Limit overrides
# ============================================================
class TestItemBagOverride:
    def test_patch_item_admin_sets_override(self, side_stand_item, admin_headers):
        iid = side_stand_item["id"]
        r = requests.patch(f"{API}/items/{iid}",
                           json={"min_per_bag": 120, "max_per_bag": 150},
                           headers=admin_headers)
        assert r.status_code == 200, r.text
        # GET returns the override
        g = requests.get(f"{API}/items/{iid}", headers=admin_headers).json()
        assert g["min_per_bag"] == 120
        assert g["max_per_bag"] == 150

    def test_patch_item_user_forbidden(self, side_stand_item, user_headers):
        r = requests.patch(f"{API}/items/{side_stand_item['id']}",
                           json={"min_per_bag": 10, "max_per_bag": 20},
                           headers=user_headers)
        assert r.status_code == 403

    def test_patch_item_invalid_bodies(self, side_stand_item, admin_headers):
        iid = side_stand_item["id"]
        # min <= 0
        r = requests.patch(f"{API}/items/{iid}",
                           json={"min_per_bag": 0, "max_per_bag": 10}, headers=admin_headers)
        assert r.status_code == 400
        # max <= 0
        r = requests.patch(f"{API}/items/{iid}",
                           json={"min_per_bag": 5, "max_per_bag": 0}, headers=admin_headers)
        assert r.status_code == 400
        # min > max
        r = requests.patch(f"{API}/items/{iid}",
                           json={"min_per_bag": 200, "max_per_bag": 100}, headers=admin_headers)
        assert r.status_code == 400

    def test_patch_item_unknown_404(self, admin_headers):
        r = requests.patch(f"{API}/items/non-existent-xyz-123",
                           json={"min_per_bag": 10, "max_per_bag": 20}, headers=admin_headers)
        assert r.status_code == 404

    def test_dispatch_match_uses_item_override(self, side_stand_item, test_customer, admin_headers):
        # Re-apply override (in case previous test cleared it)
        iid = side_stand_item["id"]
        requests.patch(f"{API}/items/{iid}",
                       json={"min_per_bag": 100, "max_per_bag": 100},
                       headers=admin_headers)
        # Create a pending order for 500 pcs of this SKU
        body = {
            "customer_id": test_customer["id"],
            "items": [{
                "product_name": side_stand_item["product_name"],
                "item_id": iid,
                "item_name": side_stand_item["name"],
                "quantity": 500,
                "variant": "Type A",
            }],
            "clear_previous_pending": True,
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200
        # call /dispatch/match with 500 stock for the SKU
        r = requests.post(f"{API}/dispatch/match",
                          json={"items": {iid: 500}}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        bag_calc = data["bag_calculation"]
        item_scoped = [b for b in bag_calc if b.get("scope") == "item" and b.get("item_id") == iid]
        assert item_scoped, f"Expected scope=item bag entry for {iid}, got {bag_calc}"
        entry = item_scoped[0]
        assert entry["min_per_bag"] == 100
        assert entry["max_per_bag"] == 100
        # 500 / 100 = 5 bags exactly
        assert entry["min_bags"] == 5
        assert entry["max_bags"] == 5

    def test_delete_bag_override_admin(self, side_stand_item, admin_headers):
        iid = side_stand_item["id"]
        # Ensure override is set first
        requests.patch(f"{API}/items/{iid}",
                       json={"min_per_bag": 99, "max_per_bag": 99}, headers=admin_headers)
        r = requests.delete(f"{API}/items/{iid}/bag-override", headers=admin_headers)
        assert r.status_code == 200
        g = requests.get(f"{API}/items/{iid}", headers=admin_headers).json()
        assert "min_per_bag" not in g
        assert "max_per_bag" not in g

    def test_delete_bag_override_user_forbidden(self, side_stand_item, user_headers):
        r = requests.delete(f"{API}/items/{side_stand_item['id']}/bag-override",
                            headers=user_headers)
        assert r.status_code == 403

    def test_dispatch_match_falls_back_to_product_after_clear(self, side_stand_item,
                                                              test_customer, admin_headers):
        iid = side_stand_item["id"]
        # Override is cleared. Match should now group by master product.
        # Clear/create a fresh 360 pcs order.
        body = {
            "customer_id": test_customer["id"],
            "items": [{
                "product_name": side_stand_item["product_name"],
                "item_id": iid,
                "item_name": side_stand_item["name"],
                "quantity": 360,
                "variant": "Type A",
            }],
            "clear_previous_pending": True,
        }
        requests.post(f"{API}/orders", json=body, headers=admin_headers)
        r = requests.post(f"{API}/dispatch/match",
                          json={"items": {iid: 360}}, headers=admin_headers)
        data = r.json()
        prod_scoped = [b for b in data["bag_calculation"]
                       if b.get("scope") == "product" and b.get("product_name") == "Side Stand"]
        assert prod_scoped, f"Expected scope=product Side Stand entry: {data['bag_calculation']}"
        # Side Stand defaults: 180/200 → 360/200=2 min, 360/180=2 max
        e = prod_scoped[0]
        assert e["min_per_bag"] == 180
        assert e["max_per_bag"] == 200


# ============================================================
# (2) Partial / Lot-wise Dispatching
# ============================================================
class TestPartialDispatch:
    @pytest.fixture(scope="class")
    def order_1000(self, admin_headers, test_customer, side_stand_item):
        body = {
            "customer_id": test_customer["id"],
            "items": [{
                "product_name": side_stand_item["product_name"],
                "item_id": side_stand_item["id"],
                "item_name": side_stand_item["name"],
                "quantity": 1000,
                "variant": "Type A",
            }],
            "clear_previous_pending": True,
        }
        r = requests.post(f"{API}/orders", json=body, headers=admin_headers)
        assert r.status_code == 200
        return r.json()

    def test_execute_partial_300(self, order_1000, side_stand_item, admin_headers):
        oid = order_1000["id"]
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": oid,
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 300}],
            "notes": "TEST partial 300",
        }, headers=admin_headers)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["fully_dispatched"] is False
        assert data["order"]["status"] == "Pending"
        assert data["order"]["items"][0]["quantity"] == 700
        # original_items preserved
        assert data["order"].get("original_items"), "original_items must be preserved"
        assert data["order"]["original_items"][0]["quantity"] == 1000
        # dispatch record
        d = data["dispatch"]
        assert d["total_pcs"] == 300
        assert d["order_fully_dispatched"] is False
        assert d["items"][0]["quantity"] == 300
        TestPartialDispatch.first_dispatch_id = d["id"]

    def test_execute_overshoot_400(self, order_1000, side_stand_item, admin_headers):
        # only 700 remaining
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 9999}],
        }, headers=admin_headers)
        assert r.status_code == 400

    def test_execute_unknown_item_400(self, order_1000, admin_headers):
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [{"item_id": "no-such-item-xyz", "quantity": 1}],
        }, headers=admin_headers)
        assert r.status_code == 400

    def test_execute_empty_allocations_400(self, order_1000, admin_headers):
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [],
        }, headers=admin_headers)
        assert r.status_code == 400

    def test_execute_all_zero_400(self, order_1000, side_stand_item, admin_headers):
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 0}],
        }, headers=admin_headers)
        assert r.status_code == 400

    def test_execute_unknown_order_404(self, side_stand_item, admin_headers):
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": "no-such-order-xyz",
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 1}],
        }, headers=admin_headers)
        assert r.status_code == 404

    def test_execute_exhaust_to_dispatched(self, order_1000, side_stand_item, admin_headers):
        # remaining 700 → ship all
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 700}],
            "notes": "TEST final 700",
        }, headers=admin_headers)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["fully_dispatched"] is True
        assert data["order"]["status"] == "Dispatched"
        assert data["order"]["items"] == []
        # original_items still preserved
        assert data["order"].get("original_items")
        assert data["order"]["original_items"][0]["quantity"] == 1000

    def test_execute_on_already_dispatched_400(self, order_1000, side_stand_item, admin_headers):
        r = requests.post(f"{API}/dispatch/execute", json={
            "order_id": order_1000["id"],
            "allocations": [{"item_id": side_stand_item["id"], "quantity": 1}],
        }, headers=admin_headers)
        assert r.status_code == 400

    def test_get_dispatches_history(self, order_1000, admin_headers):
        r = requests.get(f"{API}/dispatches",
                         params={"order_id": order_1000["id"]},
                         headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 2, f"Expected 2 dispatch records, got {len(data)}"
        # reverse chronological: newest (700, fully) first
        assert data[0]["total_pcs"] == 700
        assert data[0]["order_fully_dispatched"] is True
        assert data[1]["total_pcs"] == 300
        assert data[1]["order_fully_dispatched"] is False
        # no _id leak
        for d in data:
            assert "_id" not in d
