"""Iteration 7 — Sale Returns + Purchase Returns CRUD, ledger integration,
and voice-agent closing-balance regression.

Covered features:
- POST/GET/PATCH/DELETE /api/sale-returns
- POST/GET/PATCH/DELETE /api/purchase-returns
- GET /api/supplier-ledger/{sid} now includes purchase_return CREDIT rows
- POST /api/voice/agent/text closing-balance now subtracts returns
- Regression: /api/payments and /api/admin/dispatch-ledger still work
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@factory.com"
ADMIN_PASSWORD = "admin123"

# Pre-seeded entities (from review_request)
SHARMA_AUTO_ID = "c2197757-d936-4faa-8c9d-cdef4011d6ed"
STEEL_TRADERS_ID = "65995038-5139-40d1-8175-e6b64b554099"


# -------------------------- fixtures --------------------------

@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def token(session):
    r = session.post(f"{BASE_URL}/api/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth(session, token):
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


@pytest.fixture
def created_sale_return_ids():
    ids = []
    yield ids
    # teardown
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code == 200:
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        for rid in ids:
            s.delete(f"{BASE_URL}/api/sale-returns/{rid}", headers=h)


@pytest.fixture
def created_purchase_return_ids():
    ids = []
    yield ids
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code == 200:
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        for rid in ids:
            s.delete(f"{BASE_URL}/api/purchase-returns/{rid}", headers=h)


# ============================================================
# Sale Returns CRUD
# ============================================================

class TestSaleReturns:
    def test_create_sale_return(self, auth, created_sale_return_ids):
        body = {
            "customer_id": SHARMA_AUTO_ID,
            "amount": 1234.5,
            "returned_at": "2026-01-10",
            "reference": "TEST_SR_REF_1",
            "reason": "defective",
            "notes": "TEST_iter7",
        }
        r = auth.post(f"{BASE_URL}/api/sale-returns", json=body)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["customer_id"] == SHARMA_AUTO_ID
        assert doc["amount"] == 1234.5
        assert doc["reason"] == "defective"
        assert "id" in doc and isinstance(doc["id"], str)
        assert "return_no" in doc and int(doc["return_no"]) >= 1
        assert doc["customer_name"]  # should be enriched from customer doc
        created_sale_return_ids.append(doc["id"])

    def test_create_missing_customer_id_400(self, auth):
        r = auth.post(f"{BASE_URL}/api/sale-returns",
                      json={"customer_id": "", "amount": 100})
        assert r.status_code in (400, 422)

    def test_create_amount_zero_400(self, auth):
        r = auth.post(f"{BASE_URL}/api/sale-returns",
                      json={"customer_id": SHARMA_AUTO_ID, "amount": 0})
        assert r.status_code == 400

    def test_create_unknown_customer_404(self, auth):
        r = auth.post(f"{BASE_URL}/api/sale-returns",
                      json={"customer_id": "no-such-cust-" + uuid.uuid4().hex,
                            "amount": 100})
        assert r.status_code == 404

    def test_list_filtered_by_customer(self, auth, created_sale_return_ids):
        # Create one we know about
        body = {"customer_id": SHARMA_AUTO_ID, "amount": 250,
                "reason": "TEST_listfilter"}
        c = auth.post(f"{BASE_URL}/api/sale-returns", json=body)
        assert c.status_code == 200
        created_sale_return_ids.append(c.json()["id"])

        r = auth.get(f"{BASE_URL}/api/sale-returns",
                     params={"customer_id": SHARMA_AUTO_ID})
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "total_amount" in data
        assert isinstance(data["items"], list)
        # every item belongs to SHARMA
        for it in data["items"]:
            assert it["customer_id"] == SHARMA_AUTO_ID
        # total_amount equals sum of items
        s = round(sum(float(i.get("amount") or 0) for i in data["items"]), 2)
        assert s == round(float(data["total_amount"]), 2)

    def test_update_sale_return(self, auth, created_sale_return_ids):
        c = auth.post(f"{BASE_URL}/api/sale-returns",
                      json={"customer_id": SHARMA_AUTO_ID, "amount": 500,
                            "reason": "TEST_orig"})
        assert c.status_code == 200
        rid = c.json()["id"]
        created_sale_return_ids.append(rid)

        u = auth.patch(f"{BASE_URL}/api/sale-returns/{rid}",
                       json={"amount": 777, "reason": "TEST_updated"})
        assert u.status_code == 200, u.text
        assert u.json()["amount"] == 777
        assert u.json()["reason"] == "TEST_updated"

        # GET via list to verify persistence
        lst = auth.get(f"{BASE_URL}/api/sale-returns",
                       params={"customer_id": SHARMA_AUTO_ID}).json()["items"]
        match = [x for x in lst if x["id"] == rid]
        assert match and match[0]["amount"] == 777

    def test_update_nonexistent_404(self, auth):
        r = auth.patch(f"{BASE_URL}/api/sale-returns/nope-{uuid.uuid4().hex}",
                       json={"amount": 100})
        assert r.status_code == 404

    def test_delete_sale_return(self, auth):
        c = auth.post(f"{BASE_URL}/api/sale-returns",
                      json={"customer_id": SHARMA_AUTO_ID, "amount": 11,
                            "reason": "TEST_todel"})
        rid = c.json()["id"]
        d = auth.delete(f"{BASE_URL}/api/sale-returns/{rid}")
        assert d.status_code == 200
        # Subsequent delete returns 404
        d2 = auth.delete(f"{BASE_URL}/api/sale-returns/{rid}")
        assert d2.status_code == 404


# ============================================================
# Purchase Returns CRUD + supplier ledger integration
# ============================================================

class TestPurchaseReturns:
    def test_create_purchase_return(self, auth, created_purchase_return_ids):
        body = {
            "supplier_id": STEEL_TRADERS_ID,
            "amount": 333.25,
            "returned_at": "2026-01-10",
            "reference": "TEST_PR_REF",
            "material": "steel rods",
            "reason": "wrong size",
            "notes": "TEST_iter7",
        }
        r = auth.post(f"{BASE_URL}/api/purchase-returns", json=body)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["supplier_id"] == STEEL_TRADERS_ID
        assert doc["amount"] == 333.25
        assert doc["material"] == "steel rods"
        assert "id" in doc and "return_no" in doc
        assert doc["supplier_name"]
        created_purchase_return_ids.append(doc["id"])

    def test_create_amount_zero_400(self, auth):
        r = auth.post(f"{BASE_URL}/api/purchase-returns",
                      json={"supplier_id": STEEL_TRADERS_ID, "amount": -1})
        assert r.status_code == 400

    def test_create_unknown_supplier_404(self, auth):
        r = auth.post(f"{BASE_URL}/api/purchase-returns",
                      json={"supplier_id": "nope-" + uuid.uuid4().hex,
                            "amount": 100})
        assert r.status_code == 404

    def test_list_by_supplier(self, auth, created_purchase_return_ids):
        c = auth.post(f"{BASE_URL}/api/purchase-returns",
                      json={"supplier_id": STEEL_TRADERS_ID, "amount": 22,
                            "material": "TEST_mat"})
        assert c.status_code == 200
        created_purchase_return_ids.append(c.json()["id"])

        r = auth.get(f"{BASE_URL}/api/purchase-returns",
                     params={"supplier_id": STEEL_TRADERS_ID})
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data["items"], list) and "total_amount" in data
        for it in data["items"]:
            assert it["supplier_id"] == STEEL_TRADERS_ID

    def test_update_and_delete(self, auth):
        c = auth.post(f"{BASE_URL}/api/purchase-returns",
                      json={"supplier_id": STEEL_TRADERS_ID, "amount": 50,
                            "material": "TEST_udmat"})
        rid = c.json()["id"]
        u = auth.patch(f"{BASE_URL}/api/purchase-returns/{rid}",
                       json={"amount": 75, "material": "TEST_after"})
        assert u.status_code == 200
        assert u.json()["amount"] == 75
        assert u.json()["material"] == "TEST_after"
        d = auth.delete(f"{BASE_URL}/api/purchase-returns/{rid}")
        assert d.status_code == 200
        d2 = auth.delete(f"{BASE_URL}/api/purchase-returns/{rid}")
        assert d2.status_code == 404

    def test_update_nonexistent_404(self, auth):
        r = auth.patch(f"{BASE_URL}/api/purchase-returns/nope-{uuid.uuid4().hex}",
                       json={"amount": 1})
        assert r.status_code == 404


# ============================================================
# Supplier ledger now reflects purchase_return rows as CREDIT
# ============================================================

class TestSupplierLedgerWithReturns:
    def test_purchase_return_appears_as_credit(self, auth):
        # Pre-seeded vendor "Steel Traders" expected to have 12000 purchase + 1200 return
        r = auth.get(f"{BASE_URL}/api/supplier-ledger/{STEEL_TRADERS_ID}")
        assert r.status_code == 200, r.text
        data = r.json()
        rows = data.get("rows") or []
        return_rows = [x for x in rows if x.get("kind") == "purchase_return"]
        assert len(return_rows) >= 1, "Expected at least one purchase_return row"
        for rr in return_rows:
            assert rr["credit"] > 0
            assert rr["debit"] == 0
        # Verify totals reflect returns: total_credit must be >= total_credit_of_returns
        sum_ret = sum(r["credit"] for r in return_rows)
        assert data.get("total_credit", 0) + 1e-6 >= sum_ret

    def test_closing_balance_reduces_by_return(self, auth):
        """Add a fresh purchase_return and verify closing_balance drops by amount."""
        before = auth.get(f"{BASE_URL}/api/supplier-ledger/{STEEL_TRADERS_ID}").json()
        cb_before = float(before.get("closing_balance") or 0)

        c = auth.post(f"{BASE_URL}/api/purchase-returns",
                      json={"supplier_id": STEEL_TRADERS_ID, "amount": 500,
                            "material": "TEST_closingbalprobe"})
        assert c.status_code == 200
        rid = c.json()["id"]
        try:
            after = auth.get(f"{BASE_URL}/api/supplier-ledger/{STEEL_TRADERS_ID}").json()
            cb_after = float(after.get("closing_balance") or 0)
            assert round(cb_before - cb_after, 2) == 500.0, \
                f"closing_balance should drop by 500 (before={cb_before}, after={cb_after})"
        finally:
            auth.delete(f"{BASE_URL}/api/purchase-returns/{rid}")


# ============================================================
# Voice agent — closing balance now subtracts returns
# ============================================================

class TestVoiceAgentClosingBalanceWithReturns:
    def test_customer_closing_balance_subtracts_sale_returns(self, auth):
        r = auth.post(f"{BASE_URL}/api/voice/agent/text",
                      json={"text": "SHARMA AUTO ka closing balance kya hai"})
        assert r.status_code == 200, r.text
        data = r.json()
        resolved = data.get("resolved") or {}
        # Must include total_credit field that includes sale returns
        assert "closing_balance" in resolved
        assert "total_credit" in resolved
        # SHARMA has a 750 sale return seeded
        assert float(resolved["total_credit"]) >= 750.0, \
            f"Expected total_credit >= 750 (seeded SR), got {resolved.get('total_credit')}"

    def test_vendor_closing_balance_subtracts_purchase_returns(self, auth):
        r = auth.post(f"{BASE_URL}/api/voice/agent/text",
                      json={"text": "Steel Traders ko kitna dena hai"})
        assert r.status_code == 200, r.text
        data = r.json()
        resolved = data.get("resolved") or {}
        assert "closing_balance" in resolved
        # 12000 purchase - 1200 return = 10800 owed
        cb = float(resolved["closing_balance"])
        # Approximately 10800 (allow for other prior data, but should be at most 12000 - 1200)
        assert cb <= 11000, \
            f"closing_balance should reflect 1200 purchase_return subtraction, got {cb}"


# ============================================================
# Regression — payments + dispatch ledger still work
# ============================================================

class TestRegression:
    def test_payments_list(self, auth):
        r = auth.get(f"{BASE_URL}/api/payments")
        assert r.status_code == 200
        # Either list or dict-with-items contract — accept both
        payload = r.json()
        if isinstance(payload, dict):
            assert "items" in payload or "payments" in payload
        else:
            assert isinstance(payload, list)

    def test_admin_dispatch_ledger(self, auth):
        r = auth.get(f"{BASE_URL}/api/admin/dispatch-ledger",
                     params={"customer_id": SHARMA_AUTO_ID})
        assert r.status_code == 200
        data = r.json()
        # Has the expected keys from a ledger response
        assert "rows" in data or "items" in data or "dispatches" in data
