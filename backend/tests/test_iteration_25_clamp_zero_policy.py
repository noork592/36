"""Iteration 25 — "Stock never goes below zero" CLAMP policy.

Policy change (reverses iter-24's hard reject):
    Dispatch ALWAYS proceeds. If a BOM consumption would drive a raw material
    below zero, we CLAMP the deduction at the available balance (so stock
    lands at exactly 0) and mark the movement row with `clamped=true` plus
    a `requested` field recording the *full* BOM need. Operators can still
    dispatch even when not every historical purchase has been entered yet;
    over time, more purchases are recorded and software stock realigns
    with physical reality.

Coverage in this file:
  1. test_startup_migration_clamps_negative_to_zero
     — manually set a RM stock to a negative value in Mongo, restart backend
       (sudo supervisorctl restart backend), then verify
         * stock_on_hand == 0
         * a movement row with kind='adjust', reference_id='policy-clamp-zero',
           actor='migration', notes mentions 'Stock-never-negative policy'.
  2. test_dispatch_execute_clamps_short_rm_to_zero
     — short RM clamped, OK RM fully consumed, dispatch returns HTTP 200,
       movement rows reflect requested vs delta + clamped flag.
  3. test_second_dispatch_on_zero_stock_still_succeeds
     — stock already 0, dispatch still succeeds, delta=0, balance_after=0,
       clamped=true.
  4. test_boundary_exact_landing_zero_is_not_clamped
     — stock == need exactly → delta == -need, balance 0, clamped=false.
  5. test_multi_rm_one_short_one_ok_independent
     — both RMs in the same BOM; short one is clamped, OK one is fully
       deducted; behaviour is independent per RM.
  6. test_purchase_recovers_then_dispatch_resumes_full_deduction
     — after clamping, a purchase brings stock back up; the next dispatch
       on the same RM does a full (un-clamped) deduction again.
  7. test_off_order_clamps_same_way
     — /api/dispatch/off-order shares _consume_bom_for_lines path and
       therefore shows identical clamping behaviour.
  8. test_assert_helper_not_invoked_anywhere_in_dispatch_path
     — static guard: greps the server source to confirm
       `_assert_bom_stock_available(` is never *called* anywhere
       (it may still be defined for legacy reasons — main agent's note).
"""

import os
import time
import uuid
import subprocess
import requests
import pytest
from pymongo import MongoClient

# ----- backend URL -----
def _read_frontend_env():
    p = "/app/frontend/.env"
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _read_frontend_env()).rstrip("/")

# ----- mongo direct connection (for migration test only) -----
def _read_backend_env():
    out = {}
    with open("/app/backend/.env") as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out

_be = _read_backend_env()
MONGO_URL = _be.get("MONGO_URL")
DB_NAME = _be.get("DB_NAME")

# ----- fixed seeded references -----
SKU_ID = "211a26b0-bea9-4699-bdb2-bcc36fe38fbb"  # SIDE STAND HONDA SHINE / UNICORN
RM_ANHADF = "0735ee46-6d47-4cdf-a24e-dc1bc1de648e"
RM_GHNHG = "3a885da7-4f73-4b41-9194-6a72c62e1479"


# ===================== fixtures =====================
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


# ----- helpers -----
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
    rm = _get_rm(client, rid)
    cur = float(rm.get("stock_on_hand") or 0)
    delta = float(target) - cur
    if abs(delta) < 1e-9:
        return cur
    r = client.post(
        f"{BASE_URL}/api/raw-materials/{rid}/adjust",
        json={"delta": delta, "notes": f"TEST_iter25 set_to {target}"},
    )
    assert r.status_code == 200, r.text
    return float(r.json().get("balance_after"))


def _set_bom(client, components):
    r = client.put(
        f"{BASE_URL}/api/items/{SKU_ID}/bom",
        json={"components": components},
    )
    assert r.status_code == 200, r.text


def _movements(client, rid, limit=20):
    r = client.get(f"{BASE_URL}/api/raw-materials/{rid}/movements?limit={limit}")
    assert r.status_code == 200, r.text
    return r.json().get("rows", [])


def _movements_count(client, rid):
    return len(_movements(client, rid, limit=500))


def _make_customer(client):
    r = client.get(f"{BASE_URL}/api/customers?limit=1")
    assert r.status_code == 200, r.text
    customers = r.json()
    assert customers, "no customers seeded — cannot run dispatch tests"
    return customers[0]


def _get_sku(client):
    items = client.get(f"{BASE_URL}/api/items").json()
    return next(s for s in items if s["id"] == SKU_ID)


def _create_order(client, cust_id, qty=10, notes="TEST_iter25"):
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
    assert sups, "no suppliers seeded"
    return sups[0]


def _purchase(client, rid, qty, unit="pcs", rate=1.0):
    sup = _pick_supplier(client)
    rm = _get_rm(client, rid)
    r = client.post(f"{BASE_URL}/api/supplier-purchases", json={
        "supplier_id": sup["id"],
        "amount": round(rate * qty, 2) or 1,
        "bill_number": f"TEST_iter25_{uuid.uuid4().hex[:6]}",
        "items": [{
            "raw_material_id": rid,
            "name": rm.get("name"),
            "unit": rm.get("unit") or unit,
            "quantity": qty,
            "rate": rate,
        }],
        "notes": "TEST_iter25 purchase top-up",
    })
    assert r.status_code == 200, r.text
    return r.json()


# ----- module snapshot / restore (BOM + RM balances + clean test movements) -----
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
    comps = [
        {"raw_material_id": c["raw_material_id"], "qty_per_unit": c["qty_per_unit"]}
        for c in bom.get("components", [])
    ]
    sess.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json={"components": comps})
    _set_rm_stock(sess, RM_ANHADF, stock_a)
    _set_rm_stock(sess, RM_GHNHG, stock_g)


# ===================== TESTS =====================

class TestStartupMigration:
    def test_startup_migration_clamps_negative_to_zero(self, admin_client):
        """Manually set a RM stock to -50 in Mongo, restart backend, verify
        startup hook clamps it to 0 and logs an `adjust` movement with
        reference_id='policy-clamp-zero', actor='migration'."""
        assert MONGO_URL and DB_NAME, "MONGO_URL/DB_NAME missing from /app/backend/.env"
        mclient = MongoClient(MONGO_URL)
        try:
            mdb = mclient[DB_NAME]
            # capture starting state
            before = _get_rm(admin_client, RM_GHNHG)
            start_stock = float(before.get("stock_on_hand") or 0)

            # Force GHNHG to -50 directly in Mongo (bypasses API guards)
            res = mdb.raw_materials.update_one(
                {"id": RM_GHNHG},
                {"$set": {"stock_on_hand": -50.0}},
            )
            assert res.matched_count == 1, "RM_GHNHG missing in DB"

            # Trigger startup migration
            subprocess.run(
                ["sudo", "supervisorctl", "restart", "backend"],
                check=True, capture_output=True, timeout=30,
            )
            # Wait for backend to come back up
            for _ in range(30):
                try:
                    h = requests.get(f"{BASE_URL}/api/raw-materials",
                                     headers=admin_client.headers, timeout=3)
                    if h.status_code == 200:
                        break
                except Exception:
                    pass
                time.sleep(1)
            else:
                pytest.fail("backend did not come back up after restart")

            # 1) stock must be clamped to 0
            after = _get_rm(admin_client, RM_GHNHG)
            assert float(after.get("stock_on_hand") or 0) == pytest.approx(0.0), \
                f"expected 0 after migration, got {after.get('stock_on_hand')}"

            # 2) a movement row with the expected metadata must exist
            rows = _movements(admin_client, RM_GHNHG, limit=20)
            policy_rows = [
                r for r in rows
                if (r.get("reference_id") == "policy-clamp-zero"
                    and r.get("kind") == "adjust"
                    and r.get("actor") == "migration")
            ]
            assert policy_rows, (
                "expected at least one 'policy-clamp-zero' migration "
                f"movement; got rows={[r.get('reference_id') for r in rows[:5]]}"
            )
            top = policy_rows[0]
            assert top.get("balance_after") == pytest.approx(0.0)
            # delta should be +50 (bringing -50 → 0)
            assert float(top.get("delta") or 0) == pytest.approx(50.0)
            notes = (top.get("notes") or "").lower()
            assert "stock-never-negative policy" in notes
            assert "clamped from" in notes
            assert " to 0" in notes

            # Restore GHNHG to its pre-test value
            _set_rm_stock(admin_client, RM_GHNHG, start_stock)
        finally:
            mclient.close()


class TestDispatchExecuteClamp:
    def test_dispatch_execute_clamps_short_rm_to_zero(self, admin_client):
        """GHNHG starts at 3 (need 10) → dispatch must succeed; GHNHG ends
        at 0 with clamped movement; ANHADF (50 → 10) fully consumed."""
        _set_rm_stock(admin_client, RM_ANHADF, 50)
        _set_rm_stock(admin_client, RM_GHNHG, 3)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=20)
        order_id = order["id"]

        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 20}],
            "notes": "TEST_iter25 clamp",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        dispatch_doc = body["dispatch"]
        dispatch_id = dispatch_doc["id"]
        assert body["fully_dispatched"] is True

        # Stock landed
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(0.0)
        assert float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"]) == pytest.approx(10.0)

        # Movements
        g_rows = _movements(admin_client, RM_GHNHG)
        g_clamped = next((r for r in g_rows if r.get("reference_id") == dispatch_id), None)
        assert g_clamped is not None, "GHNHG dispatch movement missing"
        assert g_clamped.get("kind") == "dispatch"
        assert float(g_clamped["delta"]) == pytest.approx(-3.0)
        assert float(g_clamped["balance_after"]) == pytest.approx(0.0)
        assert float(g_clamped.get("requested")) == pytest.approx(10.0)
        assert g_clamped.get("clamped") is True
        notes_g = (g_clamped.get("notes") or "")
        assert "clamped from" in notes_g
        assert "to keep stock" in notes_g

        a_rows = _movements(admin_client, RM_ANHADF)
        a_norm = next((r for r in a_rows if r.get("reference_id") == dispatch_id), None)
        assert a_norm is not None, "ANHADF dispatch movement missing"
        assert float(a_norm["delta"]) == pytest.approx(-40.0)
        assert float(a_norm["balance_after"]) == pytest.approx(10.0)
        assert float(a_norm.get("requested")) == pytest.approx(40.0)
        assert a_norm.get("clamped") is False

    def test_second_dispatch_on_zero_stock_still_succeeds(self, admin_client):
        """With GHNHG = 0 already, another dispatch must still succeed.
        delta will be 0 (or -0.0); balance_after = 0; clamped = true."""
        _set_rm_stock(admin_client, RM_ANHADF, 100)
        _set_rm_stock(admin_client, RM_GHNHG, 0)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=4)
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order["id"],
            "allocations": [{"item_id": SKU_ID, "quantity": 4}],
            "notes": "TEST_iter25 zero-stock",
        })
        assert resp.status_code == 200, resp.text
        dispatch_id = resp.json()["dispatch"]["id"]

        g_rows = _movements(admin_client, RM_GHNHG)
        row = next((r for r in g_rows if r.get("reference_id") == dispatch_id), None)
        assert row is not None
        assert abs(float(row["delta"])) < 1e-9  # 0 or -0.0
        assert float(row["balance_after"]) == pytest.approx(0.0)
        assert float(row.get("requested")) == pytest.approx(2.0)  # 4 * 0.5
        assert row.get("clamped") is True
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(0.0)

    def test_boundary_exact_landing_zero_is_not_clamped(self, admin_client):
        """stock == need → delta = -need, balance_after = 0, clamped = false.
        Exact landing on zero must NOT be flagged as clamped."""
        _set_rm_stock(admin_client, RM_ANHADF, 10)
        _set_rm_stock(admin_client, RM_GHNHG, 2.5)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order = _create_order(admin_client, cust["id"], qty=5, notes="TEST_iter25 boundary")
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order["id"],
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
        })
        assert resp.status_code == 200, resp.text
        dispatch_id = resp.json()["dispatch"]["id"]

        for rid, need in [(RM_ANHADF, 10.0), (RM_GHNHG, 2.5)]:
            rows = _movements(admin_client, rid)
            row = next((r for r in rows if r.get("reference_id") == dispatch_id), None)
            assert row is not None, f"missing movement for {rid}"
            assert float(row["delta"]) == pytest.approx(-need)
            assert float(row["balance_after"]) == pytest.approx(0.0)
            assert row.get("clamped") is False, \
                f"exact-zero landing should NOT be clamped (rid={rid}, row={row})"
            assert float(row.get("requested")) == pytest.approx(need)
            assert float(_get_rm(admin_client, rid)["stock_on_hand"]) == pytest.approx(0.0)


class TestPurchaseRecoveryAndOffOrder:
    def test_purchase_recovers_then_dispatch_resumes_full_deduction(self, admin_client):
        """After clamping, a supplier purchase brings stock back above zero;
        the next dispatch on the same RM does a full (un-clamped) deduction."""
        # Start with GHNHG very low, clamp once
        _set_rm_stock(admin_client, RM_ANHADF, 1000)
        _set_rm_stock(admin_client, RM_GHNHG, 1)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        order1 = _create_order(admin_client, cust["id"], qty=10,
                               notes="TEST_iter25 recover-1")
        r1 = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order1["id"],
            "allocations": [{"item_id": SKU_ID, "quantity": 10}],
        })
        assert r1.status_code == 200
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(0.0)

        # Purchase 50 kg of GHNHG — credit must still work normally
        _purchase(admin_client, RM_GHNHG, 50, unit="kg")
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(50.0)

        # Next dispatch: full deduction (un-clamped) on GHNHG
        order2 = _create_order(admin_client, cust["id"], qty=4,
                               notes="TEST_iter25 recover-2")
        r2 = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order2["id"],
            "allocations": [{"item_id": SKU_ID, "quantity": 4}],
        })
        assert r2.status_code == 200, r2.text
        dispatch_id = r2.json()["dispatch"]["id"]
        rows = _movements(admin_client, RM_GHNHG)
        row = next((r for r in rows if r.get("reference_id") == dispatch_id), None)
        assert row is not None
        # need = 4 * 0.5 = 2; have was 50 → full deduction
        assert float(row["delta"]) == pytest.approx(-2.0)
        assert float(row["balance_after"]) == pytest.approx(48.0)
        assert row.get("clamped") is False
        assert float(row.get("requested")) == pytest.approx(2.0)

    def test_off_order_clamps_same_way(self, admin_client):
        """/api/dispatch/off-order shares _consume_bom_for_lines, so it
        must clamp identically."""
        _set_rm_stock(admin_client, RM_ANHADF, 50)
        _set_rm_stock(admin_client, RM_GHNHG, 1)
        _set_bom(admin_client, [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ])
        cust = _make_customer(admin_client)
        resp = admin_client.post(f"{BASE_URL}/api/dispatch/off-order", json={
            "customer_id": cust["id"],
            "items": [{"item_id": SKU_ID, "quantity": 10}],
            "notes": "TEST_iter25 off-order clamp",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # off-order returns a dispatch document (id present)
        dispatch_doc = body.get("dispatch") or body
        dispatch_id = dispatch_doc.get("id") or body.get("id")
        assert dispatch_id, f"no dispatch id in response: {body}"

        # GHNHG: need 5, have 1 → clamped at 0
        assert float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"]) == pytest.approx(0.0)
        # ANHADF: need 20, have 50 → full, ends at 30
        assert float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"]) == pytest.approx(30.0)

        g_rows = _movements(admin_client, RM_GHNHG)
        g_row = next((r for r in g_rows if r.get("reference_id") == dispatch_id), None)
        assert g_row is not None
        assert float(g_row["delta"]) == pytest.approx(-1.0)
        assert float(g_row.get("requested")) == pytest.approx(5.0)
        assert g_row.get("clamped") is True

        a_rows = _movements(admin_client, RM_ANHADF)
        a_row = next((r for r in a_rows if r.get("reference_id") == dispatch_id), None)
        assert a_row is not None
        assert float(a_row["delta"]) == pytest.approx(-20.0)
        assert a_row.get("clamped") is False


class TestStaticGuards:
    def test_assert_helper_not_invoked_anywhere_in_dispatch_path(self):
        """_assert_bom_stock_available must be defined-but-never-called.
        Greps the server source for any *call* (with open-paren) of the
        helper. Definitions (`async def _assert_bom_stock_available(`)
        are allowed; calls aren't.
        """
        src = open("/app/backend/server.py").read()
        # All occurrences of the helper name followed by '('
        lines = src.splitlines()
        offenders = []
        for i, line in enumerate(lines, start=1):
            if "_assert_bom_stock_available(" not in line:
                continue
            stripped = line.lstrip()
            # `async def _assert_bom_stock_available(` is the definition
            if stripped.startswith("async def _assert_bom_stock_available(") \
               or stripped.startswith("def _assert_bom_stock_available("):
                continue
            # Allow plain references inside comments (rare)
            if stripped.startswith("#"):
                continue
            offenders.append(f"line {i}: {line.strip()}")
        assert not offenders, (
            "`_assert_bom_stock_available` must NOT be called anywhere "
            "under the new clamp-at-zero policy; offenders:\n  "
            + "\n  ".join(offenders)
        )
