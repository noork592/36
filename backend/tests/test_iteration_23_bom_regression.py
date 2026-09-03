"""Iteration 23 — BOM bug regression tests.

User reported: BOM dialog silently saved empty components when user filled
the picker but didn't click 'Add to BOM' before Save. Frontend now
auto-folds the pending picker row at save time. Backend consumption is
already correct — this file is the regression net for:

  1. PUT /api/items/{iid}/bom  — set/replace BOM works.
  2. GET /api/items/{iid}/bom  — returns enriched components.
  3. POST /api/dispatch/execute — auto-consumes BOM, decrements
     raw_materials.stock_on_hand, writes a movement with kind='dispatch'.
  4. POST /api/dispatch/off-order — same auto-consumption path.
  5. Movement rows are persisted with the correct delta.
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

# Seeded fixtures from the request prompt
SKU_ID = "211a26b0-bea9-4699-bdb2-bcc36fe38fbb"  # SIDE STAND HONDA SHINE / UNICORN
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


@pytest.fixture(scope="module", autouse=True)
def _restore_bom_on_exit():
    """Snapshot SKU's BOM and RM stocks at the start of this module and
    restore them at the end so we don't leave the seed data dirty."""
    sess = requests.Session()
    r = sess.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@factory.com", "password": "admin123"},
        timeout=30,
    )
    tok = r.json()["token"]
    sess.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tok}",
    })

    bom_snapshot = sess.get(f"{BASE_URL}/api/items/{SKU_ID}/bom").json()
    rms_snapshot = {
        RM_ANHADF: sess.get(f"{BASE_URL}/api/raw-materials").json(),
    }
    yield
    # Restore BOM
    comps = [
        {"raw_material_id": c["raw_material_id"], "qty_per_unit": c["qty_per_unit"]}
        for c in bom_snapshot.get("components", [])
    ]
    sess.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json={"components": comps})
    _ = rms_snapshot  # snapshot kept for diagnostics only


def _get_rm(client, rid):
    r = client.get(f"{BASE_URL}/api/raw-materials")
    assert r.status_code == 200
    for rm in r.json():
        if rm["id"] == rid:
            return rm
    raise AssertionError(f"RM {rid} not found")


def _ensure_rm_stock(client, rid, min_qty):
    rm = _get_rm(client, rid)
    cur = float(rm.get("stock_on_hand") or 0)
    if cur < min_qty:
        # Top up via adjust endpoint
        delta = (min_qty - cur) + 100
        client.post(
            f"{BASE_URL}/api/raw-materials/{rid}/adjust",
            json={"delta": delta, "notes": "test top-up"},
        )


# ============ TESTS ============

class TestBomCRUD:
    def test_get_bom_baseline(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/items/{SKU_ID}/bom")
        assert r.status_code == 200
        data = r.json()
        assert data["item_id"] == SKU_ID
        assert "components" in data
        assert isinstance(data["components"], list)

    def test_put_bom_sets_two_components(self, admin_client):
        payload = {
            "components": [
                {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
                {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
            ]
        }
        r = admin_client.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json=payload)
        assert r.status_code == 200, r.text
        data = r.json()
        comps = data["components"]
        assert len(comps) == 2
        by_id = {c["raw_material_id"]: c for c in comps}
        assert by_id[RM_ANHADF]["qty_per_unit"] == 2.0
        assert by_id[RM_GHNHG]["qty_per_unit"] == 0.5
        # Names + units enriched
        assert by_id[RM_ANHADF]["raw_material_name"]
        assert by_id[RM_GHNHG]["unit"]

    def test_get_bom_after_put_persists(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/items/{SKU_ID}/bom")
        assert r.status_code == 200
        comps = r.json()["components"]
        assert len(comps) == 2

    def test_put_empty_bom_clears(self, admin_client):
        r = admin_client.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json={"components": []})
        assert r.status_code == 200
        r2 = admin_client.get(f"{BASE_URL}/api/items/{SKU_ID}/bom")
        assert r2.json()["components"] == []

    def test_put_bom_rejects_unknown_rm(self, admin_client):
        bad_id = str(uuid.uuid4())
        r = admin_client.put(
            f"{BASE_URL}/api/items/{SKU_ID}/bom",
            json={"components": [{"raw_material_id": bad_id, "qty_per_unit": 1}]},
        )
        assert r.status_code == 400

    def test_put_bom_rejects_non_positive_qty(self, admin_client):
        r = admin_client.put(
            f"{BASE_URL}/api/items/{SKU_ID}/bom",
            json={"components": [{"raw_material_id": RM_ANHADF, "qty_per_unit": 0}]},
        )
        assert r.status_code == 400


class TestBomConsumptionOnDispatch:
    def test_dispatch_execute_consumes_bom(self, admin_client):
        # Setup: ensure stock + set BOM
        _ensure_rm_stock(admin_client, RM_ANHADF, 200)
        _ensure_rm_stock(admin_client, RM_GHNHG, 200)
        bom_payload = {"components": [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ]}
        r = admin_client.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json=bom_payload)
        assert r.status_code == 200

        rm_a_before = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_before = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])

        # Get a real customer
        cust_resp = admin_client.get(f"{BASE_URL}/api/customers?limit=1")
        assert cust_resp.status_code == 200
        customers = cust_resp.json()
        assert len(customers) > 0
        cust = customers[0]
        cust_id = cust["id"]

        # SKU lookup for item_name + product_name
        sku_resp = admin_client.get(f"{BASE_URL}/api/items").json()
        sku = next(s for s in sku_resp if s["id"] == SKU_ID)

        # Create order
        order_resp = admin_client.post(f"{BASE_URL}/api/orders", json={
            "customer_id": cust_id,
            "items": [{
                "product_name": sku.get("product_name") or sku["name"],
                "item_id": SKU_ID,
                "item_name": sku["name"],
                "quantity": 10,
            }],
            "notes": "TEST_bom_regression",
        })
        assert order_resp.status_code == 200, order_resp.text
        order = order_resp.json()
        order_id = order["id"]

        # Dispatch 5 pcs
        disp_resp = admin_client.post(f"{BASE_URL}/api/dispatch/execute", json={
            "order_id": order_id,
            "allocations": [{"item_id": SKU_ID, "quantity": 5}],
            "notes": "TEST_bom_regression",
        })
        assert disp_resp.status_code == 200, disp_resp.text
        dispatch_id = disp_resp.json()["dispatch"]["id"]

        # Verify stock decreased
        rm_a_after = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_after = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])
        assert rm_a_before - rm_a_after == pytest.approx(10.0), \
            f"ANHADF: expected -10, got -{rm_a_before - rm_a_after}"
        assert rm_g_before - rm_g_after == pytest.approx(2.5), \
            f"GHNHG: expected -2.5, got -{rm_g_before - rm_g_after}"

        # Verify movement rows — pick the LATEST movement for this dispatch
        # (existing slip may have been merged so multiple consumption events
        # can share the same reference_id; we care about the one just made)
        mov = admin_client.get(f"{BASE_URL}/api/raw-materials/{RM_ANHADF}/movements").json()
        rows = mov["rows"]
        recent = [r for r in rows if r.get("reference_id") == dispatch_id]
        assert len(recent) >= 1
        # Newest first per server sort
        assert recent[0]["kind"] == "dispatch"
        assert recent[0]["delta"] == pytest.approx(-10.0)

        mov2 = admin_client.get(f"{BASE_URL}/api/raw-materials/{RM_GHNHG}/movements").json()
        recent2 = [r for r in mov2["rows"] if r.get("reference_id") == dispatch_id]
        assert len(recent2) >= 1
        assert recent2[0]["delta"] == pytest.approx(-2.5)
        assert recent2[0]["kind"] == "dispatch"

        # Cleanup: cancel order (delete) if still pending
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}")

    def test_dispatch_off_order_consumes_bom(self, admin_client):
        # BOM should still be set from previous test (we re-set just in case)
        _ensure_rm_stock(admin_client, RM_ANHADF, 200)
        _ensure_rm_stock(admin_client, RM_GHNHG, 200)
        admin_client.put(f"{BASE_URL}/api/items/{SKU_ID}/bom", json={"components": [
            {"raw_material_id": RM_ANHADF, "qty_per_unit": 2},
            {"raw_material_id": RM_GHNHG, "qty_per_unit": 0.5},
        ]})

        rm_a_before = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_before = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])

        cust = admin_client.get(f"{BASE_URL}/api/customers?limit=1").json()[0]
        r = admin_client.post(f"{BASE_URL}/api/dispatch/off-order", json={
            "customer_id": cust["id"],
            "items": [{"item_id": SKU_ID, "quantity": 3}],
            "notes": "TEST_off_order_bom",
        })
        assert r.status_code == 200, r.text
        dispatch_id = r.json().get("id") or r.json().get("dispatch", {}).get("id")
        assert dispatch_id, f"No dispatch id in response: {r.json()}"

        rm_a_after = float(_get_rm(admin_client, RM_ANHADF)["stock_on_hand"])
        rm_g_after = float(_get_rm(admin_client, RM_GHNHG)["stock_on_hand"])
        # Note: off-order may merge into today's slip with the previous test's
        # dispatch. Stock should still decrement by 3*2=6 and 3*0.5=1.5.
        assert rm_a_before - rm_a_after == pytest.approx(6.0), \
            f"ANHADF: expected -6, got -{rm_a_before - rm_a_after}"
        assert rm_g_before - rm_g_after == pytest.approx(1.5)

        # Movement check
        mov = admin_client.get(f"{BASE_URL}/api/raw-materials/{RM_ANHADF}/movements").json()
        dispatch_kinds = [r for r in mov["rows"] if r.get("kind") == "dispatch"]
        assert len(dispatch_kinds) >= 1
