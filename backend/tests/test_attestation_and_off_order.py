"""Tests for login attestation + off-order (no order) dispatch.

Both features added July 2026.
"""
import os
import base64
import io
import requests
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip()
                    break
    except FileNotFoundError:
        pass
BASE_URL = (BASE_URL or "http://localhost:8001").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"email": "admin@factory.com", "password": "admin123"}
USER = {"email": "user@factory.com", "password": "user123"}


def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


# Minimal 8x8 black JPEG (real, decodable)
_TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcU"
    "FhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo"
    "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIA"
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB"
    "AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKqgA//Z"
)


# ============================================================
# Login Attestation
# ============================================================
class TestLoginAttestation:
    def test_attestation_with_consent(self):
        token = _login(ADMIN)
        r = requests.post(
            f"{API}/auth/attestation",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "consent": True,
                "latitude": 28.6139,
                "longitude": 77.2090,
                "accuracy_meters": 12.5,
                "photo_b64": _TINY_JPEG_B64,
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["stored"] is True
        assert data["has_photo"] is True
        assert "id" in data

    def test_attestation_skipped(self):
        token = _login(USER)
        r = requests.post(
            f"{API}/auth/attestation",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "consent": False,
                "photo_skipped": True,
                "location_skipped": True,
                "error": "user_skipped",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["has_photo"] is False

    def test_attestation_oversized_photo_rejected(self):
        token = _login(ADMIN)
        # 1 MB of base64 = ~750 KB raw → exceeds the 600 KB cap
        big = "A" * (1_200_000)
        r = requests.post(
            f"{API}/auth/attestation",
            headers={"Authorization": f"Bearer {token}"},
            json={"consent": True, "photo_b64": big},
            timeout=15,
        )
        assert r.status_code == 413, r.text

    def test_attestation_requires_auth(self):
        r = requests.post(f"{API}/auth/attestation", json={"consent": True}, timeout=15)
        assert r.status_code in (401, 403), r.text

    def test_admin_can_list_attestations(self):
        admin_t = _login(ADMIN)
        r = requests.get(
            f"{API}/admin/login-attestations?limit=10",
            headers={"Authorization": f"Bearer {admin_t}"},
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert "total" in data and "items" in data
        assert isinstance(data["items"], list)
        # Photo blob must NOT be in list payload (only has_photo flag)
        for it in data["items"]:
            assert "photo_b64" not in it
            assert "has_photo" in it

    def test_non_admin_cannot_list_attestations(self):
        user_t = _login(USER)
        r = requests.get(
            f"{API}/admin/login-attestations",
            headers={"Authorization": f"Bearer {user_t}"},
            timeout=15,
        )
        assert r.status_code == 403

    def test_admin_can_fetch_photo(self):
        admin_t = _login(ADMIN)
        # Create one with a photo
        r = requests.post(
            f"{API}/auth/attestation",
            headers={"Authorization": f"Bearer {admin_t}"},
            json={"consent": True, "photo_b64": _TINY_JPEG_B64},
            timeout=15,
        )
        att_id = r.json()["id"]
        photo_r = requests.get(
            f"{API}/admin/login-attestations/{att_id}/photo",
            headers={"Authorization": f"Bearer {admin_t}"},
            timeout=15,
        )
        assert photo_r.status_code == 200
        assert photo_r.headers["content-type"].startswith("image/jpeg")
        # decode round-trip
        assert photo_r.content == base64.b64decode(_TINY_JPEG_B64)

    def test_filter_by_consent(self):
        admin_t = _login(ADMIN)
        r_yes = requests.get(
            f"{API}/admin/login-attestations?consent=true&limit=50",
            headers={"Authorization": f"Bearer {admin_t}"},
            timeout=15,
        )
        r_no = requests.get(
            f"{API}/admin/login-attestations?consent=false&limit=50",
            headers={"Authorization": f"Bearer {admin_t}"},
            timeout=15,
        )
        for it in r_yes.json()["items"]:
            assert it["consent"] is True
        for it in r_no.json()["items"]:
            assert it["consent"] is False

    def test_is_mobile_flag_from_ua(self):
        """The server should classify the request as mobile/desktop based on UA."""
        admin_t = _login(ADMIN)
        IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 "
                     "(KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1")
        WIN_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        # Submit one from each
        for ua, expected_mobile in [(IPHONE_UA, True), (WIN_UA, False)]:
            r = requests.post(
                f"{API}/auth/attestation",
                headers={"Authorization": f"Bearer {admin_t}", "User-Agent": ua},
                json={"consent": False, "photo_skipped": True, "location_skipped": True},
                timeout=15,
            )
            assert r.status_code == 200
        # Now read them back and check the flag
        rows = requests.get(
            f"{API}/admin/login-attestations?limit=10",
            headers={"Authorization": f"Bearer {admin_t}"},
            timeout=15,
        ).json()["items"]
        # Most recent 2 are the ones we just inserted
        recent_mobile = [r for r in rows[:5] if r.get("is_mobile") is True]
        recent_desktop = [r for r in rows[:5] if r.get("is_mobile") is False]
        assert recent_mobile, "expected at least one is_mobile=True record"
        assert recent_desktop, "expected at least one is_mobile=False record"


# ============================================================
# Off-Order (no-order) Dispatch
# ============================================================
class TestOffOrderDispatch:
    def _pick_item(self, token):
        r = requests.get(
            f"{API}/items/search?q=side stand&limit=1",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        assert r.status_code == 200
        items = r.json()
        assert items, "no items found"
        return items[0]

    def test_dispatch_to_walkin_party(self):
        token = _login(ADMIN)
        item = self._pick_item(token)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "customer_name": "OFFORDER_TEST_WALKIN",
                "transport_name": "OWN TEMPO",
                "items": [{"item_id": item["id"], "quantity": 25}],
                "notes": "pytest walk-in",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()["dispatch"]
        assert d["order_id"] is None
        assert d["off_order"] is True
        assert d["customer_id"] is None
        assert d["customer_name"] == "OFFORDER_TEST_WALKIN"
        assert d["transport_name"] == "OWN TEMPO"
        assert d["total_pcs"] == 25
        assert len(d["items"]) == 1
        assert d["items"][0]["quantity"] == 25
        # cleanup
        self._cleanup_walkin()

    def test_dispatch_to_existing_customer(self):
        token = _login(ADMIN)
        item = self._pick_item(token)
        # Create or reuse a real customer
        r = requests.post(
            f"{API}/customers",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "OFFORDER_TEST_CUST", "city": "TEST", "transport_name": "TEST TRPT"},
            timeout=15,
        )
        cust = r.json()
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "customer_id": cust["id"],
                "items": [{"item_id": item["id"], "quantity": 10}],
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()["dispatch"]
        assert d["customer_id"] == cust["id"]
        assert d["customer_name"] == "OFFORDER_TEST_CUST"
        # transport falls back to customer's default
        assert d["transport_name"] == "TEST TRPT"
        # cleanup
        requests.delete(
            f"{API}/customers/{cust['id']}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        self._cleanup_cust()

    def test_rejects_zero_quantity(self):
        token = _login(ADMIN)
        item = self._pick_item(token)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "customer_name": "Z",
                "items": [{"item_id": item["id"], "quantity": 0}],
            },
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_rejects_missing_customer(self):
        token = _login(ADMIN)
        item = self._pick_item(token)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={"items": [{"item_id": item["id"], "quantity": 1}]},
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_rejects_unknown_item(self):
        token = _login(ADMIN)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "customer_name": "Z",
                "items": [{"item_id": "does-not-exist", "quantity": 1}],
            },
            timeout=15,
        )
        assert r.status_code == 404, r.text

    def test_non_admin_cannot_dispatch_off_order(self):
        token = _login(USER)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={"customer_name": "X", "items": [{"item_id": "x", "quantity": 1}]},
            timeout=15,
        )
        assert r.status_code == 403, r.text

    def test_appears_in_daily_report(self):
        from datetime import datetime, timezone
        token = _login(ADMIN)
        item = self._pick_item(token)
        r = requests.post(
            f"{API}/dispatch/off-order",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "customer_name": "OFFORDER_REPORT_TEST",
                "items": [{"item_id": item["id"], "quantity": 33}],
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        today = datetime.now(timezone.utc).date().isoformat()
        r = requests.get(
            f"{API}/reports/daily-dispatch?date={today}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        assert r.status_code == 200
        groups = r.json().get("groups", [])
        names = [g["customer_name"] for g in groups]
        assert "OFFORDER_REPORT_TEST" in names, f"off-order dispatch missing from daily report: {names}"
        # cleanup
        self._cleanup_report()

    # ---- cleanup helpers ----
    def _cleanup_walkin(self):
        import os
        import pymongo
        from urllib.parse import quote_plus  # noqa: F401  (kept for parity with other helpers)
        mongo = pymongo.MongoClient(os.environ["MONGO_URL"])
        mongo[os.environ["DB_NAME"]].dispatches.delete_many({"customer_name": "OFFORDER_TEST_WALKIN"})
        mongo.close()

    def _cleanup_cust(self):
        import os
        import pymongo
        mongo = pymongo.MongoClient(os.environ["MONGO_URL"])
        mongo[os.environ["DB_NAME"]].dispatches.delete_many({"customer_name": "OFFORDER_TEST_CUST"})
        mongo[os.environ["DB_NAME"]].customers.delete_many({"name": "OFFORDER_TEST_CUST"})
        mongo.close()

    def _cleanup_report(self):
        import os
        import pymongo
        mongo = pymongo.MongoClient(os.environ["MONGO_URL"])
        mongo[os.environ["DB_NAME"]].dispatches.delete_many({"customer_name": "OFFORDER_REPORT_TEST"})
        mongo.close()
