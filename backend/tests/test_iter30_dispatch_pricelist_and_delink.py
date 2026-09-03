"""Iteration 30 — Dispatch price-list-per-customer + Bill Amount never auto +
Price-list bulk de-link.

Tests cover:
  Task 1 — POST /api/dispatch/execute accepts price_list_id; persists on customer.
           /dispatch/match returns customer's saved price_list_id.
           Operator can persist as well. Unknown id -> 404. "" clears.
  Task 2 — New dispatches start total_value=0; PATCH preserves total_value when
           omitted; PATCH with explicit total_value updates it.
  Task 3 — GET /api/price-lists and /price-lists/{id} include customers_count.
           POST /price-lists/{id}/delink-customers admin-only, bulk-detaches.
"""
import os
import uuid
import pytest
import requests


def _load_base_url():
    u = os.environ.get("REACT_APP_BACKEND_URL")
    if not u:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    u = line.split("=", 1)[1].strip()
                    break
    assert u, "REACT_APP_BACKEND_URL not set"
    return u.rstrip("/")


BASE_URL = _load_base_url()
TAG = uuid.uuid4().hex[:6]


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


# ---------- helpers ----------------------------------------------------------
def _create_customer(headers, suffix=""):
    r = requests.post(
        f"{BASE_URL}/api/customers",
        json={"name": f"TEST_Cust_{TAG}_{suffix}",
              "phone": "9000000000",
              "address": "Test City"},
        headers=headers, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


def _create_product(headers, suffix=""):
    name = f"TEST_Prod_{TAG}_{suffix}"
    r = requests.post(
        f"{BASE_URL}/api/products",
        json={"name": name, "min_per_bag": 1, "max_per_bag": 100},
        headers=headers, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    p = r.json()
    # Items use the /api/items endpoint with product_id in body
    ri = requests.post(
        f"{BASE_URL}/api/items",
        json={"name": f"{name}_v1", "product_id": p["id"],
              "min_per_bag": 1, "max_per_bag": 100},
        headers=headers, timeout=30,
    )
    assert ri.status_code in (200, 201), ri.text
    return p, ri.json()


def _get_customer(headers, cid):
    # No GET /api/customers/{cid} endpoint -> use list & filter
    r = requests.get(f"{BASE_URL}/api/customers", headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    rows = data if isinstance(data, list) else data.get("customers") or []
    for c in rows:
        if c.get("id") == cid:
            return c
    raise AssertionError(f"customer {cid} not found in /api/customers list")


def _create_price_list(headers, suffix=""):
    r = requests.post(
        f"{BASE_URL}/api/price-lists",
        json={"name": f"TEST_PL_{TAG}_{suffix}"},
        headers=headers, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


def _create_order(headers, customer, item):
    r = requests.post(
        f"{BASE_URL}/api/orders",
        json={
            "customer_id": customer["id"],
            "items": [{
                "item_id": item["id"],
                "item_name": item["name"],
                "product_name": item.get("product_name") or item["name"],
                "quantity": 10,
            }],
        },
        headers=headers, timeout=30,
    )
    assert r.status_code in (200, 201), r.text
    return r.json()




# ============================================================================
# Task 1 — dispatch price-list-per-customer
# ============================================================================
class TestTask1DispatchPriceList:

    def test_match_includes_price_list_id_and_execute_persists(self, admin_h):
        cust = _create_customer(admin_h, "a")
        _, item = _create_product(admin_h, "a")
        order = _create_order(admin_h, cust, item)
        pl = _create_price_list(admin_h, "a")

        # /dispatch/match
        rm = requests.post(
            f"{BASE_URL}/api/dispatch/match",
            json={"items": {item["id"]: 5}},
            headers=admin_h, timeout=30,
        )
        assert rm.status_code == 200, rm.text
        match = rm.json()
        sugg = match.get("suggestions") or match.get("orders") or []
        # find our order in the suggestions
        ours = next((s for s in sugg if s.get("order_id") == order["id"]
                     or s.get("id") == order["id"]
                     or s.get("customer_id") == cust["id"]), None)
        assert ours is not None, f"order not in suggestions: {sugg}"
        assert "price_list_id" in ours, f"suggestion missing price_list_id: {ours}"
        assert ours["price_list_id"] in (None, "") or ours["price_list_id"] == cust.get("price_list_id")

        # /dispatch/execute with price_list_id
        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 5}],
                "price_list_id": pl["id"],
            },
            headers=admin_h, timeout=30,
        )
        assert rx.status_code == 200, rx.text
        resp = rx.json()
        slip = resp.get("dispatch") or resp
        assert slip.get("price_list_id") == pl["id"], \
            f"slip.price_list_id={slip.get('price_list_id')} expected {pl['id']}"
        assert slip.get("total_value") == 0.0, \
            f"new slip must start at 0, got {slip.get('total_value')}"

        # Customer persistence
        c_after = _get_customer(admin_h, cust["id"])
        assert c_after.get("price_list_id") == pl["id"], \
            f"customer pl not persisted: {c_after.get('price_list_id')}"

    def test_operator_can_persist_price_list(self, admin_h, user_h):
        cust = _create_customer(admin_h, "op")
        _, item = _create_product(admin_h, "op")
        order = _create_order(admin_h, cust, item)
        pl = _create_price_list(admin_h, "op")

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 3}],
                "price_list_id": pl["id"],
            },
            headers=user_h, timeout=30,
        )
        assert rx.status_code == 200, f"operator dispatch failed: {rx.status_code} {rx.text}"

        c_after = _get_customer(admin_h, cust["id"])
        assert c_after.get("price_list_id") == pl["id"]

    def test_unknown_price_list_returns_404(self, admin_h):
        cust = _create_customer(admin_h, "x404")
        _, item = _create_product(admin_h, "x404")
        order = _create_order(admin_h, cust, item)

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 1}],
                "price_list_id": "non-existent-id-xyz",
            },
            headers=admin_h, timeout=30,
        )
        assert rx.status_code == 404, f"expected 404, got {rx.status_code} {rx.text}"
        assert "not found" in rx.text.lower()

    def test_empty_string_clears_customer_price_list(self, admin_h):
        # Create customer and assign price list first
        cust = _create_customer(admin_h, "clr")
        pl = _create_price_list(admin_h, "clr")
        # assign
        pa = requests.patch(
            f"{BASE_URL}/api/customers/{cust['id']}",
            json={"price_list_id": pl["id"]},
            headers=admin_h, timeout=30,
        )
        assert pa.status_code in (200, 204), pa.text
        c_before = _get_customer(admin_h, cust["id"])
        assert c_before.get("price_list_id") == pl["id"]

        _, item = _create_product(admin_h, "clr")
        order = _create_order(admin_h, cust, item)

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 2}],
                "price_list_id": "",
            },
            headers=admin_h, timeout=30,
        )
        assert rx.status_code == 200, rx.text

        c_after = _get_customer(admin_h, cust["id"])
        assert c_after.get("price_list_id") in (None, ""), \
            f"price_list_id should be cleared, got {c_after.get('price_list_id')}"


# ============================================================================
# Task 2 — Bill Amount never auto-populated
# ============================================================================
class TestTask2BillAmountManual:

    def test_new_slip_total_value_is_zero(self, admin_h):
        cust = _create_customer(admin_h, "bv")
        _, item = _create_product(admin_h, "bv")
        order = _create_order(admin_h, cust, item)

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 4}],
            },
            headers=admin_h, timeout=30,
        )
        assert rx.status_code == 200, rx.text
        resp = rx.json()
        slip = resp.get("dispatch") or resp
        sid = slip["id"]
        assert slip.get("total_value") == 0.0

        # Verify persisted via GET
        gd = requests.get(f"{BASE_URL}/api/dispatches/{sid}",
                          headers=admin_h, timeout=30)
        if gd.status_code == 200:
            assert gd.json().get("total_value") == 0.0
        # Fallback to daily-dispatch
        gr = requests.get(f"{BASE_URL}/api/reports/daily-dispatch",
                          headers=admin_h, timeout=30)
        if gr.status_code == 200:
            data = gr.json()
            rows = (data.get("groups") or data.get("rows")
                    or data.get("dispatches") or [])
            for r in rows:
                # nested groups: rows may have nested slip listings
                slips = r.get("dispatches") or r.get("slips") or [r]
                for s in slips:
                    if s.get("id") == sid:
                        assert float(s.get("total_value") or 0) == 0.0

    def test_patch_without_total_value_preserves_it(self, admin_h):
        cust = _create_customer(admin_h, "pv")
        _, item = _create_product(admin_h, "pv")
        order = _create_order(admin_h, cust, item)

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 3}],
            },
            headers=admin_h, timeout=30,
        )
        assert rx.status_code == 200, rx.text
        sid = (rx.json().get("dispatch") or rx.json())["id"]

        # manually set total_value to 555.5
        p1 = requests.patch(
            f"{BASE_URL}/api/dispatches/{sid}",
            json={"total_value": 555.5},
            headers=admin_h, timeout=30,
        )
        assert p1.status_code == 200, p1.text
        assert float(p1.json().get("total_value") or 0) == 555.5

        # PATCH items but NOT total_value -> must stay at 555.5
        p2 = requests.patch(
            f"{BASE_URL}/api/dispatches/{sid}",
            json={"items": [{
                "item_id": item["id"],
                "item_name": item["name"],
                "product_name": item.get("product_name") or item["name"],
                "quantity": 2,
                "rate": 999,
                "value": 1998,
            }]},
            headers=admin_h, timeout=30,
        )
        assert p2.status_code == 200, p2.text
        body = p2.json()
        assert float(body.get("total_value") or 0) == 555.5, \
            f"total_value should be preserved at 555.5, got {body.get('total_value')}"

    def test_patch_with_explicit_total_value_updates(self, admin_h):
        cust = _create_customer(admin_h, "pe")
        _, item = _create_product(admin_h, "pe")
        order = _create_order(admin_h, cust, item)

        rx = requests.post(
            f"{BASE_URL}/api/dispatch/execute",
            json={
                "order_id": order["id"],
                "allocations": [{"item_id": item["id"], "quantity": 3}],
            },
            headers=admin_h, timeout=30,
        )
        sid = (rx.json().get("dispatch") or rx.json())["id"]

        p = requests.patch(
            f"{BASE_URL}/api/dispatches/{sid}",
            json={"total_value": 1234.5},
            headers=admin_h, timeout=30,
        )
        assert p.status_code == 200, p.text
        assert float(p.json().get("total_value") or 0) == 1234.5


# ============================================================================
# Task 3 — Price-list bulk de-link
# ============================================================================
class TestTask3DelinkPriceList:

    def test_price_lists_include_customers_count(self, admin_h):
        pl = _create_price_list(admin_h, "cnt")
        # link 2 customers
        ids = []
        for i in range(2):
            c = _create_customer(admin_h, f"cnt{i}")
            pa = requests.patch(
                f"{BASE_URL}/api/customers/{c['id']}",
                json={"price_list_id": pl["id"]},
                headers=admin_h, timeout=30,
            )
            assert pa.status_code in (200, 204), pa.text
            ids.append(c["id"])

        # GET /api/price-lists
        rl = requests.get(f"{BASE_URL}/api/price-lists",
                          headers=admin_h, timeout=30)
        assert rl.status_code == 200, rl.text
        lists = rl.json()
        ours = next((p for p in lists if p["id"] == pl["id"]), None)
        assert ours is not None
        assert "customers_count" in ours
        assert ours["customers_count"] >= 2

        # GET /api/price-lists/{id}
        rd = requests.get(f"{BASE_URL}/api/price-lists/{pl['id']}",
                          headers=admin_h, timeout=30)
        assert rd.status_code == 200, rd.text
        d = rd.json()
        assert d.get("customers_count", 0) >= 2

    def test_delink_bulk_detaches(self, admin_h):
        pl = _create_price_list(admin_h, "dlk")
        ids = []
        for i in range(3):
            c = _create_customer(admin_h, f"dlk{i}")
            pa = requests.patch(
                f"{BASE_URL}/api/customers/{c['id']}",
                json={"price_list_id": pl["id"]},
                headers=admin_h, timeout=30,
            )
            assert pa.status_code in (200, 204), pa.text
            ids.append(c["id"])

        # delink
        rd = requests.post(
            f"{BASE_URL}/api/price-lists/{pl['id']}/delink-customers",
            headers=admin_h, timeout=30,
        )
        assert rd.status_code == 200, rd.text
        body = rd.json()
        assert body.get("ok") is True
        assert body.get("delinked_customers") == 3, \
            f"expected 3, got {body.get('delinked_customers')}"

        # Verify each customer's price_list_id is None
        for cid in ids:
            c = _get_customer(admin_h, cid)
            assert c.get("price_list_id") in (None, ""), \
                f"customer {cid} still linked: {c.get('price_list_id')}"

        # Verify list itself still exists
        rg = requests.get(f"{BASE_URL}/api/price-lists/{pl['id']}",
                          headers=admin_h, timeout=30)
        assert rg.status_code == 200, "list should still exist"

    def test_delink_requires_admin(self, admin_h, user_h):
        pl = _create_price_list(admin_h, "p403")
        r = requests.post(
            f"{BASE_URL}/api/price-lists/{pl['id']}/delink-customers",
            headers=user_h, timeout=30,
        )
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"
