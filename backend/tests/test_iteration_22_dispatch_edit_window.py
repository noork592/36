"""Iteration 22 — Dispatch edit-window & settings tests.

Covers:
  * GET /api/settings exposes overdue_days + edit_window_days (default 3)
  * PATCH /api/settings as admin: edit_window_days validation (0..365) and
    not clobbering overdue_days.
  * PATCH /api/settings as non-admin is 403.
  * PATCH /api/dispatches/{id}: user is blocked outside the window, admin works,
    user is allowed within the window.
  * Setting edit_window_days=0 locks all user edits.
  * GET /api/reports/daily-dispatch returns edit_window_days, is_admin and
    per-dispatch can_edit booleans (admin=True, user reflects window).
  * Item-level edits recompute total_value/total_pcs and propagate to the
    customer ledger.
"""

import os
import pytest
import requests
from datetime import datetime, timedelta, timezone

def _load_frontend_env():
    p = "/app/frontend/.env"
    if os.path.exists(p):
        for line in open(p):
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("REACT_APP_BACKEND_URL", "")

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _load_frontend_env()).rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set or present in /app/frontend/.env"
API = f"{BASE_URL}/api"


# ----------------------------- fixtures -----------------------------
def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login("admin@factory.com", "admin123")


@pytest.fixture(scope="module")
def user_token() -> str:
    return _login("user@factory.com", "user123")


@pytest.fixture
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture
def user_h(user_token):
    return {"Authorization": f"Bearer {user_token}", "Content-Type": "application/json"}


# Mongo helper for backdating dispatches.
@pytest.fixture(scope="module")
def mongo_db():
    from pymongo import MongoClient
    cli = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    yield cli[os.environ.get("DB_NAME", "test_database")]
    cli.close()


@pytest.fixture(scope="module")
def settings_baseline(admin_h_token_str):
    """Capture and at-end restore settings."""
    h = {"Authorization": f"Bearer {admin_h_token_str}", "Content-Type": "application/json"}
    pre = requests.get(f"{API}/settings", headers=h, timeout=15).json()
    yield pre
    # restore
    body = {
        "overdue_days": int(pre.get("overdue_days", 15)),
        "edit_window_days": int(pre.get("edit_window_days", 3)),
    }
    requests.patch(f"{API}/settings", headers=h, json=body, timeout=15)


@pytest.fixture(scope="module")
def admin_h_token_str(admin_token):
    return admin_token


# ----------------------------- settings tests -----------------------------
class TestSettings:
    def test_get_settings_returns_both_fields(self, admin_h):
        r = requests.get(f"{API}/settings", headers=admin_h, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "overdue_days" in data and "edit_window_days" in data
        assert isinstance(data["overdue_days"], int)
        assert isinstance(data["edit_window_days"], int)

    def test_get_settings_user_also_allowed(self, user_h):
        r = requests.get(f"{API}/settings", headers=user_h, timeout=15)
        assert r.status_code == 200
        assert "edit_window_days" in r.json()

    def test_patch_settings_rejects_non_admin(self, user_h):
        r = requests.patch(f"{API}/settings", headers=user_h, json={"edit_window_days": 5}, timeout=15)
        assert r.status_code == 403

    def test_patch_edit_window_validation(self, admin_h):
        # negative rejected
        r = requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": -1}, timeout=15)
        assert r.status_code == 400
        # >365 rejected
        r = requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": 400}, timeout=15)
        assert r.status_code == 400

    def test_patch_edit_window_preserves_overdue(self, admin_h, settings_baseline):
        # set overdue to a known value first
        pre = requests.patch(
            f"{API}/settings", headers=admin_h,
            json={"overdue_days": 17, "edit_window_days": 5}, timeout=15,
        ).json()
        assert pre["overdue_days"] == 17 and pre["edit_window_days"] == 5
        # now update only edit_window_days
        upd = requests.patch(
            f"{API}/settings", headers=admin_h,
            json={"edit_window_days": 9}, timeout=15,
        ).json()
        assert upd["edit_window_days"] == 9
        assert upd["overdue_days"] == 17, "overdue_days was clobbered"


# ----------------------------- dispatch-edit window tests -----------------------------
SEED_DISPATCH_ID_PREFIX = "2a84fb2a"


def _find_seed_dispatch(mongo_db):
    return mongo_db.dispatches.find_one({"id": {"$regex": f"^{SEED_DISPATCH_ID_PREFIX}"}})


class TestDispatchEditWindow:
    @pytest.fixture(autouse=True)
    def _ensure_seed(self, mongo_db):
        d = _find_seed_dispatch(mongo_db)
        if not d:
            pytest.skip("Seed dispatch (id starts with 2a84fb2a) not present")
        self.dispatch_id = d["id"]
        self.orig_dispatched_at = d.get("dispatched_at")
        self.orig_gr = d.get("gr_number", "")
        yield
        # restore original dispatched_at + gr_number
        mongo_db.dispatches.update_one(
            {"id": self.dispatch_id},
            {"$set": {
                "dispatched_at": self.orig_dispatched_at,
                "gr_number": self.orig_gr,
            }},
        )

    def _set_window(self, admin_h, days: int):
        r = requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": days}, timeout=15)
        assert r.status_code == 200, r.text

    def _backdate(self, mongo_db, days_ago: float):
        ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
        mongo_db.dispatches.update_one({"id": self.dispatch_id}, {"$set": {"dispatched_at": ts}})

    def test_user_blocked_outside_window(self, admin_h, user_h, mongo_db):
        self._set_window(admin_h, 3)
        self._backdate(mongo_db, 10)  # 10 days old
        r = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=user_h,
            json={"gr_number": "GR-USER-LOCKED"}, timeout=15,
        )
        assert r.status_code == 403
        msg = r.json().get("detail", "")
        assert "locked" in msg.lower() and "admin" in msg.lower()

    def test_admin_can_edit_old_dispatch(self, admin_h, mongo_db):
        self._set_window(admin_h, 3)
        self._backdate(mongo_db, 30)
        r = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=admin_h,
            json={"gr_number": "GR-ADMIN-OK"}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["gr_number"] == "GR-ADMIN-OK"

    def test_user_can_edit_within_window(self, admin_h, user_h, mongo_db):
        self._set_window(admin_h, 3)
        # dispatched right now
        self._backdate(mongo_db, 0)
        r = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=user_h,
            json={"gr_number": "GR-USER-OK"}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["gr_number"] == "GR-USER-OK"

    def test_window_zero_blocks_all_users_admin_still_works(self, admin_h, user_h, mongo_db):
        self._set_window(admin_h, 0)
        self._backdate(mongo_db, 0)
        # user blocked even for a fresh dispatch
        r = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=user_h,
            json={"gr_number": "SHOULD-FAIL"}, timeout=15,
        )
        assert r.status_code == 403
        # admin still ok
        r2 = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=admin_h,
            json={"gr_number": "ADMIN-ZERO"}, timeout=15,
        )
        assert r2.status_code == 200


# ----------------------------- daily-dispatch report meta -----------------------------
class TestDailyReportMeta:
    @pytest.fixture(autouse=True)
    def _seed(self, mongo_db, admin_h):
        d = _find_seed_dispatch(mongo_db)
        if not d:
            pytest.skip("Seed dispatch not present")
        self.dispatch_id = d["id"]
        self.orig = d.get("dispatched_at")
        # ensure dispatched_at is today (UTC) so the row appears in today's IST report
        mongo_db.dispatches.update_one(
            {"id": self.dispatch_id},
            {"$set": {"dispatched_at": datetime.now(timezone.utc).isoformat()}},
        )
        # set a known window
        requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": 3}, timeout=15)
        yield
        mongo_db.dispatches.update_one({"id": self.dispatch_id}, {"$set": {"dispatched_at": self.orig}})

    def _find_dispatch_row(self, report):
        for g in report.get("groups", []):
            for dsp in g.get("dispatches", []):
                if dsp["id"] == self.dispatch_id:
                    return dsp
        return None

    def test_admin_payload(self, admin_h):
        r = requests.get(f"{API}/reports/daily-dispatch", headers=admin_h, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data.get("is_admin") is True
        assert int(data.get("edit_window_days", -1)) == 3
        row = self._find_dispatch_row(data)
        assert row is not None, "seed dispatch missing from today's report"
        assert row["can_edit"] is True

    def test_user_within_window(self, user_h):
        r = requests.get(f"{API}/reports/daily-dispatch", headers=user_h, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data.get("is_admin") is False
        assert int(data["edit_window_days"]) == 3
        row = self._find_dispatch_row(data)
        assert row is not None
        assert row["can_edit"] is True

    def test_user_outside_window(self, admin_h, user_h, mongo_db):
        # backdate to 10 days ago; report uses today's IST date for filtering, so
        # we keep dispatched_at today but artificially old enough — instead use
        # a separate test: explicitly set dispatched_at today (it already is) and
        # set window=0 so can_edit must become false for user.
        requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": 0}, timeout=15)
        r = requests.get(f"{API}/reports/daily-dispatch", headers=user_h, timeout=20)
        data = r.json()
        row = self._find_dispatch_row(data)
        assert row is not None
        assert row["can_edit"] is False
        # restore window
        requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": 3}, timeout=15)


# ----------------------------- item-level edit & ledger propagation -----------------------------
class TestItemEditLedger:
    @pytest.fixture(autouse=True)
    def _seed(self, mongo_db, admin_h):
        d = _find_seed_dispatch(mongo_db)
        if not d:
            pytest.skip("Seed dispatch not present")
        self.dispatch_id = d["id"]
        self.customer_id = d.get("customer_id")
        self.orig_items = d.get("items") or []
        self.orig_total_value = d.get("total_value")
        self.orig_total_pcs = d.get("total_pcs")
        self.orig_dispatched_at = d.get("dispatched_at")
        # ensure window is generous and dispatch is fresh
        requests.patch(f"{API}/settings", headers=admin_h, json={"edit_window_days": 30}, timeout=15)
        mongo_db.dispatches.update_one(
            {"id": self.dispatch_id},
            {"$set": {"dispatched_at": datetime.now(timezone.utc).isoformat()}},
        )
        yield
        # Restore
        mongo_db.dispatches.update_one(
            {"id": self.dispatch_id},
            {"$set": {
                "items": self.orig_items,
                "total_value": self.orig_total_value,
                "total_pcs": self.orig_total_pcs,
                "dispatched_at": self.orig_dispatched_at,
            }},
        )

    def test_item_edit_recomputes_totals_and_ledger(self, admin_h):
        # Build new items: take first existing item, qty=77, net_unit_price=9.0
        if not self.orig_items:
            pytest.skip("seed dispatch has no items")
        src = self.orig_items[0]
        new_items = [{
            "item_id": src.get("item_id"),
            "item_name": src.get("item_name") or "TEST_ITEM",
            "product_name": src.get("product_name") or "",
            "variant": src.get("variant") or "",
            "quantity": 77,
            "unit_price": 10.0,
            "net_unit_price": 9.0,
            "discount_value": 0,
            "discount_type": "",
        }]
        r = requests.patch(
            f"{API}/dispatches/{self.dispatch_id}", headers=admin_h,
            json={"items": new_items}, timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # backend recomputes totals from items: total_pcs = 77
        assert int(body.get("total_pcs", 0)) == 77, body
        # total_value should be ~ 77 * 9 = 693 (round to 2dp)
        assert abs(float(body.get("total_value", 0)) - 693.0) < 0.5, body

        # ledger should reflect the same dispatch with new pcs/items via admin/dispatch-ledger
        led = requests.get(
            f"{API}/admin/dispatch-ledger?customer_id={self.customer_id}&limit=50",
            headers=admin_h, timeout=20,
        )
        assert led.status_code == 200, led.text
        items = led.json().get("items") or []
        match = next((row for row in items if row.get("id") == self.dispatch_id), None)
        assert match is not None, f"dispatch {self.dispatch_id} not found in ledger items"
        assert int(match.get("total_pcs", 0)) == 77, match
        assert abs(float(match.get("total_value", 0)) - 693.0) < 0.5, match
        new_items_after = match.get("items") or []
        assert len(new_items_after) == 1
        assert int(new_items_after[0]["quantity"]) == 77
