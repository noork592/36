"""Tests for orders status validation: Delivered removed, Pending/Dispatched/Cleared allowed."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback to frontend env file
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@factory.com", "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def sample_order(headers):
    """Pick or create an existing Pending order for status tests."""
    r = requests.get(f"{BASE_URL}/api/orders", headers=headers)
    assert r.status_code == 200
    orders = r.json()
    if orders:
        return orders[0]
    # Need to create one
    cr = requests.get(f"{BASE_URL}/api/customers", headers=headers)
    assert cr.status_code == 200 and cr.json(), "Need at least one customer"
    cust = cr.json()[0]
    ir = requests.get(f"{BASE_URL}/api/items/search", headers=headers, params={"q": "side", "limit": 1})
    assert ir.status_code == 200 and ir.json()
    item = ir.json()[0]
    payload = {
        "customer_id": cust["id"],
        "items": [{
            "product_name": item["product_name"],
            "item_id": item["id"],
            "item_name": item["name"],
            "quantity": 10,
        }],
    }
    res = requests.post(f"{BASE_URL}/api/orders", json=payload, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def test_status_delivered_rejected(headers, sample_order):
    """PATCH with Delivered must return 400."""
    oid = sample_order["id"]
    r = requests.patch(f"{BASE_URL}/api/orders/{oid}/status",
                       json={"status": "Delivered"}, headers=headers)
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


@pytest.mark.parametrize("status", ["Pending", "Dispatched", "Cleared"])
def test_status_valid_accepted(headers, sample_order, status):
    oid = sample_order["id"]
    r = requests.patch(f"{BASE_URL}/api/orders/{oid}/status",
                       json={"status": status}, headers=headers)
    assert r.status_code == 200, f"{status}: {r.text}"
    # GET to verify persistence
    g = requests.get(f"{BASE_URL}/api/orders", headers=headers, params={"status_filter": status})
    assert g.status_code == 200
    assert any(o["id"] == oid for o in g.json()), f"Order not found in {status} filter"


def test_no_orders_with_delivered_status(headers):
    """No order should currently carry 'Delivered' status (legacy migrated to Cleared)."""
    r = requests.get(f"{BASE_URL}/api/orders", headers=headers, params={"status_filter": "Delivered"})
    assert r.status_code == 200
    assert r.json() == [], "Found orders with Delivered status — migration failed"
