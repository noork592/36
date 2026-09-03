"""Iteration 15 — regression checks for dashboard/settings/customers + /voice/transcribe shape (no audio)."""
import os
import io
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") \
    if os.environ.get("REACT_APP_BACKEND_URL") else None

if not BASE_URL:
    # Fallback: read from frontend .env directly
    with open("/app/frontend/.env") as fh:
        for ln in fh:
            if ln.startswith("REACT_APP_BACKEND_URL"):
                BASE_URL = ln.split("=", 1)[1].strip().rstrip("/")
                break


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin", "password": "admin123"}, timeout=15)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("access_token") or j["token"]


@pytest.fixture(scope="module")
def auth(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# --- Dashboard summary regression ---
def test_dashboard_summary_has_overdue_and_stats(auth):
    r = requests.get(f"{BASE_URL}/api/dashboard/summary", headers=auth, timeout=15)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "overdue_customers" in data
    assert isinstance(data["overdue_customers"], list)
    # stats: must have at least one of the standard fields
    keys = set(data.keys())
    assert keys & {"total_orders", "pending_orders", "dispatched_orders", "stats"}, keys


# --- Settings GET/PATCH regression ---
def test_settings_get_then_patch_then_restore(auth):
    g = requests.get(f"{BASE_URL}/api/settings", headers=auth, timeout=15)
    assert g.status_code == 200, g.text
    original = g.json().get("overdue_days", 15)

    p = requests.patch(f"{BASE_URL}/api/settings",
                       headers=auth, json={"overdue_days": 20}, timeout=15)
    assert p.status_code == 200, p.text
    assert p.json().get("overdue_days") == 20

    # Restore
    r2 = requests.patch(f"{BASE_URL}/api/settings",
                        headers=auth, json={"overdue_days": original}, timeout=15)
    assert r2.status_code == 200
    assert r2.json().get("overdue_days") == original


# --- Customer DELETE smoke (idempotent: create→delete) ---
def test_customer_delete_smoke(auth):
    payload = {"name": "TEST_DEL_IT15", "city": "TestCity", "phone": "9999900015"}
    c = requests.post(f"{BASE_URL}/api/customers", headers=auth, json=payload, timeout=15)
    assert c.status_code in (200, 201), c.text
    cid = c.json()["id"]
    d = requests.delete(f"{BASE_URL}/api/customers/{cid}", headers=auth, timeout=15)
    assert d.status_code in (200, 204), d.text
    # Confirm gone
    g = requests.get(f"{BASE_URL}/api/customers", headers=auth, timeout=15)
    assert g.status_code == 200
    assert all(c["id"] != cid for c in g.json())


# --- /voice/transcribe shape — bad/empty audio should still respond
#     with consistent JSON shape OR a clean 4xx (not 500). ---
def test_voice_transcribe_shape_or_clean_error(auth):
    # Send a tiny invalid wav blob — we just want to verify it does NOT 500,
    # and if it returns 200 the shape includes the new keys.
    files = {"audio": ("clip.webm", io.BytesIO(b"not-real-audio"), "audio/webm")}
    r = requests.post(f"{BASE_URL}/api/voice/transcribe",
                      headers=auth, files=files, timeout=30)
    # Acceptable: 200 with proper shape, OR clean 4xx (bad audio); must not 500.
    assert r.status_code != 500, f"Server crashed on bad audio: {r.text[:300]}"
    if r.status_code == 200:
        data = r.json()
        assert "text" in data
        assert "parsed_items" in data
        assert "parsed_customer" in data
        # parsed_customer must be None or dict with required keys
        pc = data["parsed_customer"]
        assert pc is None or (isinstance(pc, dict) and {"id", "name", "score"} <= set(pc))
