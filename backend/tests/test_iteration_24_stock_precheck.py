"""Iteration 24 — Stock-availability precheck regression tests.

DEPRECATED (iter-25): The reject-policy this file asserted has been reversed.
Dispatches now ALWAYS proceed and stock is CLAMPED at zero instead. See
`test_iteration_25_clamp_zero_policy.py` for the current regression. The
file is kept for historical reference; the 4 reject-path tests are skipped
because they would otherwise fail by design.
"""
import pytest
pytestmark = pytest.mark.skip(
    reason="Reject-policy reversed in iter-25; see test_iteration_25_clamp_zero_policy.py"
)
_DEPRECATED_DOC = """

Bug-fix being verified:
    Raw material stock must NEVER go below zero on dispatch consumption.
    `_assert_bom_stock_available(lines)` is called BEFORE any mutation in
    both /api/dispatch/execute and /api/dispatch/off-order. When any BOM-
    linked raw material would be driven negative, the endpoint must:
      1. return HTTP 400 with a human-readable shortage message,
      2. NOT update the order document (status/items unchanged),
      3. NOT insert/merge a dispatch document,
      4. NOT write any raw_material_movements row.
    Purchases (/api/supplier-purchases) only add stock and are not gated.

Coverage in this file:
  - test_dispatch_execute_rejects_when_short            (rejection path + order untouched)
  - test_dispatch_execute_boundary_equal_succeeds       (have == need OK)
  - test_purchase_then_retry_dispatch_succeeds          (purchase un-blocks)
  - test_multi_rm_only_short_listed_no_partial_consume  (no partial consumption)
  - test_aggregates_multiple_lines_same_rm              (sums, not max)
  - test_dispatch_no_item_id_or_no_bom_skips_precheck   (no-op path)
  - test_off_order_rejects_no_dispatch_or_movement      (off-order parity)
  - test_off_order_succeeds_after_purchase_top_up       (off-order happy path)
"""

import os
import uuid
import requests
import pytest


def _read_frontend_env():
    p = "/app/frontend/.env"
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    return line.split("=", 1)[1].strip()
    return None


BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _read_frontend_env()).rstrip("/")

SKU_ID = "211a26b0-bea9-4699-bdb2-bcc36fe38fbb"   # SIDE STAND HONDA SHINE / UNICORN
RM_ANHADF = "0735ee46-6d47-4cdf-a24e-dc1bc1de648e"
RM_GHNHG = "3a885da7-4f73-4b41-9194-6a72c62e1479"


# ----- fixtures -----
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@factory.com", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def admin_client(admin_token):
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {admin_token}",
    })
    return s


def _all_rms(client):
    r = client.get(f"{BASE_URL}/api/raw-materials")
    assert r.status_code == 200, r.text
    return r.json()


def _get_rm(client, rid):
    for rm in _all_rms(client):
        if rm["id"] == rid:
            return rm
    raise AssertionError(f"RM {rid} not found")


def _set_rm_stock(client, rid, target):
    """Force a raw material's stock_on_hand to exactly `target` using the
    /adjust endpoint. Returns the final balance."""
    rm = _get_rm(client, rid)
    cur = float(rm.get("stock_on_hand") or 0)
    delta = float(target) - cur
    if abs(delta) < 1e-9:
        return cur
    r = client.post(
        f"{BASE_URL}/api/raw-materials/{rid}/adjust",
        json={"delta": delta, "notes": f"TEST_iter24 set_to {target}"},
    )
    assert r.status_code == 200, r.text
    return float(r.json().get("balance_after"))


def _set_bom(client, components):
    r = client.put(
        f"{BASE_URL}/api/items/{SKU_ID}/bom",
        json={"components": components},
    )
    assert r.status_code == 200, r.text


def _movements_count(client, rid):
    r = client.get(f"{BASE_URL}/api/raw-materials/{rid}/movements")
    assert r.status_code == 200, r.text
    return len(r.json().get("rows", []))


def _make_customer(client):
    """Return a real customer id (first seeded one)."""
    r = client.get(f"{BASE_URL}/api/customers?limit=1")
    assert r.status_code == 200, r.text
    customers = r.json()
    assert customers, "no customers seeded — cannot run dispatch tests"
    return customers[0]


def _get_order(client, oid):
    """No GET /orders/{id} endpoint — fetch via list and filter."""
    r = client.get(f"{BASE_URL}/api/orders")
    assert r.status_code == 200, r.text
    for o in r.json():
        if o.get("id") == oid:
            return o
    return None


def _get_sku(client):
    items = client.get(f"{BASE_URL}/api/items").json()
    return next(s for s in items if s["id"] == SKU_ID)


def _create_order(client, cust_id, qty=10, notes="TEST_iter24"):
    sku = _get_sku(client)
    r = client.post(f"{BASE_URL}/api/orders", json={
        "customer_id": cust_id,
        "items": [{
            "product_name": sku.get("product_name") or sku["name"],
            "item_id": SKU_ID,
            "item_name": sku["name"],
            "quantity": qty,
        }],
        "notes": notes,
    })
    assert r.status_code == 200, r.text
    return r.json()


def _pick_supplier(client):
    r = client.get(f"{BASE_URL}/api/suppliers")
    assert r.status_code == 200, r.text
    sups = r.json()
    assert sups, "no suppliers seeded — purchase tests need at least one"
    return sups[0]


def _purchase(client, rid, qty, unit="pcs", rate=1.0):
    """Add raw-material stock via /api/supplier-purchases. Returns the
    created purchase doc."""
    sup = _pick_supplier(client)
    rm = _get_rm(client, rid)
    r = client.post(f"{BASE_URL}/api/supplier-purchases", json={
        "supplier_id": sup["id"],
        "amount": round(rate * qty, 2) or 1,
        "bill_number": f"TEST_iter24_{uuid.uuid4().hex[:6]}",
        "items": [{
            "raw_material_id": rid,
            "name": rm.get("name"),
            "unit": rm.get("unit") or unit,
            "quantity": qty,
            "rate": rate,
        }],
        "notes": "TEST_iter24 purchase top-up",
    })
    assert r.status_code == 200, r.text
    return r.json()


# Module-level snapshot / restore so we don't leave seed data dirty.
@pytest.fixture(scope="module", autouse=True)
def _snapshot_and_restore():
    sess = requests.Session()
    tok = sess.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@factory.com", "password": "admin123"},
        timeout=30,
    ).json()["token"]
    sess.headers.update({"Authorization": f"Bearer {tok}",
                         "Content-Type": "application/json"})
    bom = sess.get(f"{BASE_URL}/api/items/{SKU_ID}/bom").json()
    stock_a = float(_get_rm(sess, RM_ANHADF).get("stock_on_hand") or 0)
    stock_g = float(_get_rm(sess, RM_GHNHG).get("stock_on_hand") or 0)
    yield
    # restore BOM
    comps = [
        {"raw_material_id": c["raw_material_id"], "qty_per_unit": c["qty_per_unit"]}
        for c in bom.get("components", [])
    ]
    sess.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json={"components": comps})
    # restore RM balances
    _set_rm_stock(sess, RM_ANHADF, stock_a)
    _set_rm_stock(sess, RM_GHNHG, stock_g)


# ===================== TESTS =====================

class TestDispatchExecutePrecheck:
    def test_dispatch_execute_rejects_when_short(self, admin_client):
        """Stock at 0 → dispatch needing positive consumption is rejected
        with HTTP 400, order is left untouched, no dispatch / movement
        is written."""
        # Set deterministic starting stock
        _set_rm_stock(admin_client, RM_ANHADF, 0)
        _set_rm_stock(admin_client, RM_GHNHG, 100)  # enough for GHNHG side
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=10)
        order_id = order["id"]

        movs_a_before = _movements_count(admin_client, RM_ANHADF)
        movs_g_before = _movements_count(admin_client, RM_GHNHG)
        order_before = _get_order(admin_client, order_id)
        assert order_before is not None

        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
            "notes": "TEST_iter24 should-reject",
        })
        assert resp.status_code == 400, resp.text
        body = resp.json()
        detail = body.get("detail", "")
        assert "Add a purchase first" in detail
        # ANHADF must be named in the shortage list
        assert "short by" in detail
        # GHNHG should NOT be listed as short (it has 100, needs 2.5)
        rm_g_name = _get_rm(admin_client, RM_GHNHG)["name"]
        assert rm_g_name not in detail, \
            f"OK material '{rm_g_name}' must not be flagged short: {detail}"

        # Order untouched
        order_after = _get_order(admin_client, order_id)
        assert order_after is not None
        assert order_after.get("status") == order_before.get("status") == "Pending"
        assert order_after.get("items") == order_before.get("items")
        assert order_after.get("original_items") == order_before.get("original_items")

        # No partial deduction on the OK material
        rm_g_after = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])
        assert rm_g_after == pytest.approx(100.0), \
            f"GHNHG should not be consumed on rejection, got {rm_g_after}"
        rm_a_after = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        assert rm_a_after == pytest.approx(0.0)

        # No movement rows added
        assert _movements_count(admin_client, RM_ANHADF) == movs_a_before
        assert _movements_count(admin_client, RM_GHNHG) == movs_g_before

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}")

    def test_dispatch_execute_boundary_equal_succeeds(self, admin_client):
        """Have == Need (exactly) must succeed; stocks land at exactly 0."""
        # qty 5 with qty_per_unit ANHADF=2 → need 10. Set stock to exactly 10.
        _set_rm_stock(admin_client, RM_ANHADF, 10)
        _set_rm_stock(admin_client, RM_GHNHG, 2.5)  # 5 * 0.5 = 2.5 exactly
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=5,
                              notes="TEST_iter24 boundary")
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order["id"],
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
            "notes": "TEST_iter24 boundary",
        })
        assert resp.status_code == 200, resp.text
        # Stock at exactly 0 after consumption
        assert float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"]) == pytest.approx(0.0)
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(0.0)

    def test_purchase_then_retry_dispatch_succeeds(self, admin_client):
        """After a supplier purchase tops the stock back up, the same
        dispatch payload that was previously rejected now succeeds."""
        _set_rm_stock(admin_client, RM_ANHADF, 0)
        _set_rm_stock(admin_client, RM_GHNHG, 100)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=10,
                              notes="TEST_iter24 retry")
        order_id = order["id"]

        # First attempt: rejected
        bad = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
        })
        assert bad.status_code == 400

        # Purchase 15000 pcs of ANHADF (test-data top-up)
        _purchase(admin_client, RM_ANHADF, 15000, unit="pcs", rate=1)
        rm_a_after_purchase = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        assert rm_a_after_purchase == pytest.approx(15000.0)

        # Now the same dispatch must succeed
        good = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
        })
        assert good.status_code == 200, good.text
        # ANHADF should have decreased by 10 (5 * 2)
        rm_a_final = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        assert rm_a_final == pytest.approx(rm_a_after_purchase - 10.0)
        # Cleanup leftover order line (5 of 10 remaining)
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}")

    def test_aggregates_multiple_lines_same_rm(self, admin_client):
        """If the BOM aggregates the same RM, the precheck must SUM
        across lines, not take max. Two lines: qty=5 + qty=3, both
        consuming ANHADF 2 pcs/unit → need = 16, not 10."""
        # Set ANHADF to 15 (less than 16 sum, more than 10 max).
        _set_rm_stock(admin_client, RM_ANHADF, 15)
        _set_rm_stock(admin_client, RM_GHNHG, 100)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
        ])
        cust = _make_customer(admin_client)
        sku = _get_sku(admin_client)
        # Create an order with two identical lines for the same SKU.
        # (Orders normally have one line per SKU but the precheck
        # handles BOM aggregation across allocations — we test the
        # in-allocation aggregation via two allocations in one call.)
        # Simulate by creating an order with quantity=8 then dispatching
        # 5 + 3 in two consecutive calls; the 2nd one should be rejected
        # if stock isn't enough.  Cleaner: create two SEPARATE orders
        # and dispatch them in one execute call? execute is single-order.
        # Easier: dispatch 8 in one go (qty_per_unit 2 → need 16).
        order = admin_client.post(f"{BASE_URL}/api/orders", json={
            "customer_id": cust["id"],
            "items": [{
                "product_name": sku.get("product_name") or sku["name"],
                "item_id": SKU_ID,
                "item_name": sku["name"],
                "quantity": 8,
            }],
            "notes": "TEST_iter24 sum",
        })
        assert order.status_code == 200, order.text
        order_id = order.json()["id"]

        # Need = 8 * 2 = 16, have = 15. Must reject.
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 8}],
        })
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        # Must mention need=16 and only 15 in stock
        assert "16" in detail
        assert "15" in detail
        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}")

    def test_dispatch_no_bom_succeeds_without_precheck(self, admin_client):
        """A SKU with NO BOM contributes nothing to the precheck — the
        dispatch must succeed regardless of raw-material stock state."""
        # Pick / create a SKU that has no BOM
        items = admin_client.get(f"{BASE_URL}/api/items").json()
        no_bom_sku = None
        for it in items:
            if it["id"] == SKU_ID:
                continue
            bom = it.get("bom") or []
            if not bom:
                no_bom_sku = it
                break
        if no_bom_sku is None:
            pytest.skip("No SKU without a BOM available in seed; precheck no-op already covered indirectly")

        # Reset ANHADF so we'd FAIL if precheck ran erroneously
        _set_rm_stock(admin_client, RM_ANHADF, 0)
        cust = _make_customer(admin_client)
        order = admin_client.post(f"{BASE_URL}/api/orders", json={
            "customer_id": cust["id"],
            "items": [{
                "product_name": no_bom_sku.get("product_name") or no_bom_sku["name"],
                "item_id": no_bom_sku["id"],
                "item_name": no_bom_sku["name"],
                "quantity": 2,
            }],
            "notes": "TEST_iter24 no-bom",
        })
        assert order.status_code == 200, order.text
        oid = order.json()["id"]
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": oid,
            "allocations": [{"item_id": no_bom_sku["id"], "quantity": 2}],
        })
        assert resp.status_code == 200, resp.text
        # cleanup if still pending
        admin_client.delete(f"{BASE_URL}/api/orders/{oid}")


class TestDispatchOffOrderPrecheck:
    def test_off_order_rejects_no_dispatch_or_movement(self, admin_client):
        """/dispatch/off-order is gated by the same precheck — rejection
        must not create a dispatch doc or movement row."""
        _set_rm_stock(admin_client, RM_ANHADF, 0)
        _set_rm_stock(admin_client, RM_GHNHG, 100)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        movs_a_before = _movements_count(admin_client, RM_ANHADF)
        # Count existing dispatches for this customer/today as a baseline
        dispatches_before = admin_client.get(
            f"{BASE_URL}/api/dispatches?customer_id={cust['id']}"
        ).json()
        ids_before = {d["id"] for d in dispatches_before}

        resp = admin_client.post(f"{BASE_URL}/api/dispatch/off-order", json={
            "customer_id": cust["id"],
            "items": [{"item_id": SKU_ID, "quantity": 3}],
            "notes": "TEST_iter24 off-reject",
        })
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "Add a purchase first" in detail
        assert "short by" in detail

        # No dispatch doc inserted (no new id)
        dispatches_after = admin_client.get(
            f"{BASE_URL}/api/dispatches?customer_id={cust['id']}"
        ).json()
        ids_after = {d["id"] for d in dispatches_after}
        assert ids_after == ids_before, "off-order rejection must not insert a dispatch doc"

        # No movement row added on ANHADF
        assert _movements_count(admin_client, RM_ANHADF) == movs_a_before
        # GHNHG stock unchanged (no partial consumption)
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(100.0)

    def test_off_order_succeeds_after_purchase_top_up(self, admin_client):
        """After a purchase tops up ANHADF, the same off-order call goes
        through and consumes the right amounts."""
        _set_rm_stock(admin_client, RM_ANHADF, 0)
        _set_rm_stock(admin_client, RM_GHNHG, 100)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        # purchase enough ANHADF
        _purchase(admin_client, RM_ANHADF, 500)
        rm_a_before = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_before = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])

        cust = _make_customer(admin_client)
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/off-order", json={
            "customer_id": cust["id"],
            "items": [{"item_id": SKU_ID, "quantity": 3}],
            "notes": "TEST_iter24 off-success",
        })
        assert resp.status_code == 200, resp.text
        rm_a_after = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_after = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])
        assert rm_a_before - rm_a_after == pytest.approx(6.0)
        assert rm_g_before - rm_g_after == pytest.approx(1.5)
