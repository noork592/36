"""Iteration 6 tests for voice agent extensions:
- New Q&A intents: query_closing_balance, query_daily_summary, query_pending_count, query_stock
- New mutation intents (preview-only via /voice/agent/text):
  record_customer_payment, record_supplier_payment, record_supplier_purchase,
  set_private_mark, update_order_status, add_customer, add_supplier,
  update_price, delete_dispatch
- New prefill intents: prefill_new_order, prefill_stock_match
- Regression: navigate, filter_orders, search_customer, show_customer_ledger,
  show_vendor_ledger, help
- Real mutation: POST /api/payments with body from voice → balance reflected
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass

API = f"{BASE_URL}/api"

SHARMA_ID = "c2197757-d936-4faa-8c9d-cdef4011d6ed"
AM_ID = "c0764d7b-57b8-43cb-8b55-1ff22721764f"


@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin@factory.com", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


def _voice(text, headers):
    r = requests.post(
        f"{API}/voice/agent/text",
        json={"text": text},
        headers=headers,
        timeout=60,
    )
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    return r.json()


# ---------- REGRESSION ----------
def test_regression_navigate(auth_headers):
    out = _voice("Open dispatch page", auth_headers)
    assert out["intent"] == "navigate"
    p = out.get("params", {})
    target = (p.get("target") or p.get("page") or "").lower()
    assert "dispatch" in target


def test_regression_show_customer_ledger_resolves_am_auto(auth_headers):
    out = _voice("Customer A M Auto ka ledger dikhao", auth_headers)
    assert out["intent"] == "show_customer_ledger"
    assert out.get("resolved", {}).get("customer_id") == AM_ID


def test_regression_filter_orders(auth_headers):
    out = _voice("Show only pending orders", auth_headers)
    assert out["intent"] in ("filter_orders", "navigate")


def test_regression_help(auth_headers):
    out = _voice("Help", auth_headers)
    assert out["intent"] in ("help", "navigate")


# ---------- Q&A ----------
def test_qa_closing_balance(auth_headers):
    out = _voice("A M Auto ka closing balance kya hai", auth_headers)
    assert out["intent"] == "query_closing_balance"
    resolved = out.get("resolved", {})
    assert resolved.get("customer_id") == AM_ID
    assert "closing_balance" in resolved
    assert isinstance(resolved["closing_balance"], (int, float))
    assert out.get("spoken_reply")


def test_qa_daily_summary(auth_headers):
    out = _voice("Aaj ka summary sunao", auth_headers)
    assert out["intent"] == "query_daily_summary"
    r = out.get("resolved", {})
    for k in ("dispatch_count", "dispatch_value", "dispatch_pcs", "payment_count", "payment_amount"):
        assert k in r, f"missing {k} in resolved: {r}"
        assert isinstance(r[k], (int, float))


def test_qa_pending_count(auth_headers):
    out = _voice("Kitne pending orders hain", auth_headers)
    assert out["intent"] == "query_pending_count"
    assert isinstance(out.get("resolved", {}).get("pending_count"), (int, float))


def test_qa_stock(auth_headers):
    out = _voice("Side stand kitna stock hai", auth_headers)
    assert out["intent"] == "query_stock"
    r = out.get("resolved", {})
    assert r.get("item_id")
    assert isinstance(r.get("open_demand"), (int, float))


# ---------- MUTATIONS (preview only) ----------
def test_mut_record_customer_payment(auth_headers):
    out = _voice("Sharma Auto se das hazaar cash mila", auth_headers)
    assert out["intent"] == "record_customer_payment"
    p = out.get("params", {})
    assert p.get("amount") == 10000
    assert (p.get("source") or "").lower() == "cash"
    assert out.get("resolved", {}).get("customer_id") == SHARMA_ID


def test_mut_record_customer_payment_does_not_write(auth_headers):
    # Get payment count before
    before = requests.get(
        f"{API}/payments?customer_id={SHARMA_ID}", headers=auth_headers, timeout=30
    )
    before_count = len(before.json()) if before.status_code == 200 else 0
    _voice("Sharma Auto se das hazaar cash mila", auth_headers)
    after = requests.get(
        f"{API}/payments?customer_id={SHARMA_ID}", headers=auth_headers, timeout=30
    )
    after_count = len(after.json()) if after.status_code == 200 else 0
    assert before_count == after_count, "voice/agent/text should NOT write payment"


def test_mut_record_supplier_payment(auth_headers):
    out = _voice("Steel Traders ko paanch hazaar UPI diya", auth_headers)
    assert out["intent"] == "record_supplier_payment"
    p = out.get("params", {})
    assert p.get("amount") == 5000
    assert (p.get("source") or "").lower() == "upi"
    # vendor may or may not resolve depending on seed


def test_mut_record_supplier_purchase(auth_headers):
    out = _voice("Naya purchase Steel Traders se 12000 ka, bill 234, MS rod", auth_headers)
    assert out["intent"] == "record_supplier_purchase"
    p = out.get("params", {})
    assert p.get("amount") == 12000
    assert str(p.get("bill_number")) == "234"
    assert "rod" in (p.get("material") or "").lower()


def test_mut_set_private_mark(auth_headers):
    out = _voice("Sharma Auto ko private mark RG laga do", auth_headers)
    assert out["intent"] == "set_private_mark"
    assert (out["params"].get("private_mark") or "").upper() == "RG"
    assert out.get("resolved", {}).get("customer_id") == SHARMA_ID


def test_mut_update_order_status(auth_headers):
    out = _voice("Order ABC123 ko dispatched mark karo", auth_headers)
    assert out["intent"] == "update_order_status"
    ns = (out["params"].get("new_status") or "").lower()
    assert "dispatch" in ns


def test_mut_add_customer(auth_headers):
    out = _voice("Add new customer Test Auto Ludhiana phone 9876543210", auth_headers)
    assert out["intent"] == "add_customer"
    p = out["params"]
    assert "test auto" in (p.get("name") or "").lower()
    assert "ludhiana" in (p.get("city") or "").lower()
    assert "9876543210" in (p.get("phone") or "")


def test_mut_add_supplier(auth_headers):
    out = _voice("Add new supplier Iron Works phone 9999 MS rod", auth_headers)
    assert out["intent"] == "add_supplier"
    assert "iron works" in (out["params"].get("name") or "").lower()


def test_mut_update_price(auth_headers):
    out = _voice("Side stand without kit ka rate 640 kar do", auth_headers)
    assert out["intent"] == "update_price"
    assert out["params"].get("new_price") == 640
    assert out.get("resolved", {}).get("item_id")


def test_mut_delete_last_dispatch(auth_headers):
    out = _voice("Delete last dispatch", auth_headers)
    assert out["intent"] == "delete_dispatch"
    assert (out["params"].get("dispatch_ref") or "").lower() == "last"
    # resolved should contain dispatch_id if any dispatch exists
    r = out.get("resolved", {})
    # Either no dispatches in DB or resolved.dispatch_id is set
    if r.get("dispatch_id"):
        assert isinstance(r["dispatch_id"], str)


# ---------- PREFILL ----------
def test_prefill_new_order(auth_headers):
    out = _voice(
        "A M Auto ke liye center stand do sau aur side stand teen sau", auth_headers
    )
    assert out["intent"] == "prefill_new_order"
    r = out.get("resolved", {})
    assert r.get("customer_id") == AM_ID
    items = r.get("items") or []
    assert len(items) >= 2
    qtys = sorted(int(it.get("quantity") or 0) for it in items[:2])
    assert qtys == [200, 300]
    for it in items[:2]:
        assert it.get("item_id")


def test_prefill_stock_match(auth_headers):
    out = _voice("Side stand char sau pieces dispatch karo", auth_headers)
    assert out["intent"] == "prefill_stock_match"
    items = out.get("resolved", {}).get("items") or []
    assert len(items) >= 1
    assert int(items[0].get("quantity")) == 400


# ---------- REAL API EXECUTION ----------
def test_real_payment_post_and_balance_reflects(auth_headers):
    # capture balance before
    before = _voice("Sharma Auto ka closing balance kya hai", auth_headers)
    before_bal = before["resolved"].get("closing_balance", 0)

    body = {
        "customer_id": SHARMA_ID,
        "amount": 10000,
        "source": "cash",
        "notes": "TEST_Voice-recorded payment",
        "payment_mode": "cash",
    }
    r = requests.post(f"{API}/payments", json=body, headers=auth_headers, timeout=30)
    assert r.status_code in (200, 201), r.text
    created = r.json()
    pid = created.get("id") or created.get("_id")
    assert pid, f"payment id missing in {created}"

    time.sleep(0.5)
    after = _voice("Sharma Auto ka closing balance kya hai", auth_headers)
    after_bal = after["resolved"].get("closing_balance", 0)
    # closing balance = debit - credit. New 10000 credit must reduce balance by 10000.
    assert round(before_bal - after_bal, 2) == 10000.0, (
        f"expected delta 10000, before={before_bal} after={after_bal}"
    )

    # cleanup
    try:
        requests.delete(f"{API}/payments/{pid}", headers=auth_headers, timeout=30)
    except Exception:
        pass
