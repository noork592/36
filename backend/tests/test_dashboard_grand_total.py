"""Dashboard grand total aggregation (Feb 2026):

When multiple pending orders contain the same SKU, the dashboard summary must:
- Sum all matching quantities into a single grand total per SKU
- Report order_count (how many orders contributed)
- Return a breakdown list with per-order {customer_name, quantity, order_id, order_date}
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
    body = {"name": "TEST_GrandTotal Cust", "phone": "778", "preferences": {}}
    r = requests.post(f"{API}/customers", json=body, headers=admin_headers)
    assert r.status_code in (200, 201, 409)
    if r.status_code == 409:
        all_c = requests.get(f"{API}/customers", headers=admin_headers).json()
        return next(c for c in all_c if c["name"] == body["name"])
    return r.json()


@pytest.fixture(scope="module")
def some_item(admin_headers):
    items = requests.get(f"{API}/items", headers=admin_headers).json()
    assert items
    return items[0]


def _make_order(headers, customer_id, item, qty):
    r = requests.post(
        f"{API}/orders",
        json={
            "customer_id": customer_id,
            "items": [{
                "product_name": item.get("product_name") or item["name"],
                "item_id": item["id"],
                "item_name": item["name"],
                "quantity": qty,
            }],
        },
        headers=headers,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_grand_total_aggregates_across_orders(admin_headers, some_customer, some_item):
    # Snapshot the SKU's current grand total before we add anything
    before = requests.get(f"{API}/dashboard/summary", headers=admin_headers).json()
    before_row = next(
        (r for r in before["item_totals"] if r["item_id"] == some_item["id"]),
        {"quantity": 0, "order_count": 0},
    )
    base_qty = before_row["quantity"]
    base_count = before_row["order_count"]

    # Create three pending orders for the SAME SKU with distinct quantities
    qtys = [323, 222, 100]
    created = [_make_order(admin_headers, some_customer["id"], some_item, q) for q in qtys]

    try:
        summary = requests.get(f"{API}/dashboard/summary", headers=admin_headers).json()
        row = next(r for r in summary["item_totals"] if r["item_id"] == some_item["id"])

        # 1) grand total = previous total + sum of the new orders
        assert row["quantity"] == base_qty + sum(qtys), (
            f"expected grand total {base_qty + sum(qtys)}, got {row['quantity']}"
        )
        # 2) order_count incremented by 3
        assert row["order_count"] == base_count + 3
        # 3) breakdown contains all three new orders with correct qty
        new_order_ids = {o["id"] for o in created}
        breakdown_for_new = [b for b in row["breakdown"] if b["order_id"] in new_order_ids]
        assert len(breakdown_for_new) == 3
        assert sorted(b["quantity"] for b in breakdown_for_new) == sorted(qtys)
        # 4) every breakdown row has the customer name we used
        for b in breakdown_for_new:
            assert b["customer_name"] == some_customer["name"]
    finally:
        # cleanup so reruns are stable
        for o in created:
            requests.delete(f"{API}/orders/{o['id']}", headers=admin_headers)


def test_single_order_shows_count_one(admin_headers, some_customer, some_item):
    before = requests.get(f"{API}/dashboard/summary", headers=admin_headers).json()
    before_row = next(
        (r for r in before["item_totals"] if r["item_id"] == some_item["id"]),
        {"quantity": 0, "order_count": 0, "breakdown": []},
    )

    order = _make_order(admin_headers, some_customer["id"], some_item, 545)
    try:
        summary = requests.get(f"{API}/dashboard/summary", headers=admin_headers).json()
        row = next(r for r in summary["item_totals"] if r["item_id"] == some_item["id"])
        assert row["quantity"] == before_row["quantity"] + 545
        assert row["order_count"] == before_row["order_count"] + 1
        # Our just-created order should be present exactly once
        ours = [b for b in row["breakdown"] if b["order_id"] == order["id"]]
        assert len(ours) == 1
        assert ours[0]["quantity"] == 545
    finally:
        requests.delete(f"{API}/orders/{order['id']}", headers=admin_headers)
