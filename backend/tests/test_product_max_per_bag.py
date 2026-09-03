"""Tests for product 'max per bag' simplification: UI now sends min=max for both
product and item endpoints. Validate backend continues to persist min_per_bag=max_per_bag."""
import os
import pytest
import requests
import uuid

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip()
                    break
    except FileNotFoundError:
        pass
BASE_URL = (BASE_URL or "http://localhost:8001").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "admin123"})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


class TestProductMaxPerBag:
    def test_list_products(self, headers):
        r = requests.get(f"{API}/products", headers=headers)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list) and len(data) > 0
        # Each product must have both fields
        for p in data:
            assert "min_per_bag" in p
            assert "max_per_bag" in p

    def test_update_product_min_equals_max(self, headers):
        # Find Side Stand
        r = requests.get(f"{API}/products", headers=headers)
        side_stand = next((p for p in r.json() if p["name"] == "Side Stand"), None)
        assert side_stand is not None, "Side Stand product not found"
        original_min = side_stand["min_per_bag"]
        original_max = side_stand["max_per_bag"]
        # UI now sends both min=max=150
        new_val = 150
        body = {"min_per_bag": new_val, "max_per_bag": new_val, "variants": side_stand.get("variants", [])}
        u = requests.patch(f"{API}/products/{side_stand['id']}", headers=headers, json=body)
        assert u.status_code == 200, f"PATCH failed: {u.status_code} {u.text}"
        # GET and verify persistence
        r2 = requests.get(f"{API}/products", headers=headers)
        updated = next(p for p in r2.json() if p["id"] == side_stand["id"])
        assert updated["min_per_bag"] == new_val
        assert updated["max_per_bag"] == new_val
        # Restore
        requests.patch(f"{API}/products/{side_stand['id']}", headers=headers,
                       json={"min_per_bag": original_min, "max_per_bag": original_max,
                             "variants": side_stand.get("variants", [])})

    def test_create_product_with_min_equals_max(self, headers):
        name = f"TEST_Product_{uuid.uuid4().hex[:6]}"
        body = {"name": name, "min_per_bag": 75, "max_per_bag": 75, "variants": [], "variant_field": None}
        r = requests.post(f"{API}/products", headers=headers, json=body)
        assert r.status_code in (200, 201), f"POST failed: {r.status_code} {r.text}"
        created = r.json()
        assert created["min_per_bag"] == 75
        assert created["max_per_bag"] == 75
        # cleanup
        requests.delete(f"{API}/products/{created['id']}", headers=headers)

    def test_item_bag_override_min_equals_max(self, headers):
        # Find an item for Side Stand
        items = requests.get(f"{API}/items", headers=headers).json()
        ss_item = next((it for it in items if it.get("product_name") == "Side Stand"), None)
        assert ss_item is not None
        # PATCH item with min=max=95
        u = requests.patch(f"{API}/items/{ss_item['id']}", headers=headers,
                           json={"min_per_bag": 95, "max_per_bag": 95})
        assert u.status_code == 200, f"PATCH item failed: {u.status_code} {u.text}"
        # Verify
        items2 = requests.get(f"{API}/items", headers=headers).json()
        updated = next(it for it in items2 if it["id"] == ss_item["id"])
        assert updated["min_per_bag"] == 95
        assert updated["max_per_bag"] == 95
        # Cleanup override
        requests.delete(f"{API}/items/{ss_item['id']}/bag-override", headers=headers)

    def test_create_order_bags_uses_max_per_bag(self, headers):
        # Get a customer and a product
        cs = requests.get(f"{API}/customers", headers=headers).json()
        if not cs:
            # create one
            c = requests.post(f"{API}/customers", headers=headers,
                              json={"name": "TEST_BagCust", "phone": "9990001111", "address": ""}).json()
            customer = c
        else:
            customer = cs[0]
        items = requests.get(f"{API}/items", headers=headers).json()
        ss_item = next(it for it in items if it.get("product_name") == "Side Stand")
        products = requests.get(f"{API}/products", headers=headers).json()
        ss_prod = next(p for p in products if p["name"] == "Side Stand")
        bag_size = ss_item.get("max_per_bag") or ss_prod["max_per_bag"]
        bags = 3
        expected_qty = bags * bag_size
        body = {
            "customer_id": customer["id"],
            "items": [{
                "product_name": "Side Stand",
                "item_id": ss_item["id"],
                "item_name": ss_item["name"],
                "quantity": expected_qty,
                "variant": None,
            }],
            "notes": "TEST_bags_order",
        }
        r = requests.post(f"{API}/orders", headers=headers, json=body)
        assert r.status_code in (200, 201), f"Order create failed: {r.status_code} {r.text}"
        created = r.json()
        assert created["items"][0]["quantity"] == expected_qty
        # PATCH status (regression)
        order_id = created["id"]
        s = requests.patch(f"{API}/orders/{order_id}/status", headers=headers,
                           json={"status": "Dispatched"})
        assert s.status_code == 200, f"Status PATCH failed: {s.status_code} {s.text}"
        # cleanup
        requests.delete(f"{API}/orders/{order_id}", headers=headers)
