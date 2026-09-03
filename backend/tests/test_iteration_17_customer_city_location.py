"""Iteration 17 backend tests:
 - Customer create/update now accept `city` + `location` fields
 - Daily dispatch report group dict exposes `city` and `location`
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://build-from-git-2.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": username, "password": password})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "admin123")


@pytest.fixture(scope="module")
def user_token():
    return _login("user", "user123")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def user_headers(user_token):
    return {"Authorization": f"Bearer {user_token}", "Content-Type": "application/json"}


# ---------- Customer city + location ----------
class TestCustomerCityLocation:
    def test_create_customer_with_city_location(self, admin_headers):
        payload = {
            "name": f"TEST_CityLoc_{uuid.uuid4().hex[:6]}",
            "phone": "9999999999",
            "address": "Plot 23",
            "city": "Indore",
            "location": "Sapna Sangeeta",
        }
        r = requests.post(f"{API}/customers", json=payload, headers=admin_headers)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        assert data["name"] == payload["name"]
        assert data.get("city") == "Indore"
        assert data.get("location") == "Sapna Sangeeta"
        assert data.get("address") == "Plot 23"
        assert "id" in data

        # GET verify persistence via list (single-GET not exposed)
        g = requests.get(f"{API}/customers/search?q={payload['name']}", headers=admin_headers)
        assert g.status_code == 200, g.text
        rows = g.json() if isinstance(g.json(), list) else g.json().get("results", [])
        match = next((c for c in rows if c.get("id") == data["id"]), None)
        assert match, f"created customer not found in search: {rows}"
        assert match["city"] == "Indore"
        assert match["location"] == "Sapna Sangeeta"

        # cleanup
        requests.delete(f"{API}/customers/{data['id']}", headers=admin_headers)

    def test_update_customer_city_location(self, admin_headers):
        # create base
        cr = requests.post(
            f"{API}/customers",
            json={"name": f"TEST_Upd_{uuid.uuid4().hex[:6]}", "phone": "9", "address": "x"},
            headers=admin_headers,
        )
        assert cr.status_code in (200, 201), cr.text
        cid = cr.json()["id"]
        # patch city + location only
        u = requests.patch(
            f"{API}/customers/{cid}",
            json={"city": "Bhopal", "location": "MP Nagar"},
            headers=admin_headers,
        )
        assert u.status_code == 200, u.text
        ud = u.json()
        assert ud["city"] == "Bhopal"
        assert ud["location"] == "MP Nagar"
        # GET verify via list
        g = requests.get(f"{API}/customers", headers=admin_headers)
        assert g.status_code == 200
        rows = g.json() if isinstance(g.json(), list) else g.json().get("results", [])
        match = next((c for c in rows if c.get("id") == cid), None)
        assert match, "customer not found after PATCH"
        assert match["city"] == "Bhopal"
        assert match["location"] == "MP Nagar"
        requests.delete(f"{API}/customers/{cid}", headers=admin_headers)


# ---------- Daily dispatch report exposes city + location ----------
class TestDailyDispatchCityLocation:
    def test_admin_daily_report_group_has_city_location(self, admin_headers):
        r = requests.get(f"{API}/reports/daily-dispatch", headers=admin_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "groups" in body
        # Spec requires `city` and `location` keys to be exposed in every group dict
        for g in body["groups"]:
            assert "city" in g, f"group missing city: {g}"
            assert "location" in g, f"group missing location: {g}"

    def test_non_admin_can_view_daily_report(self, user_headers):
        r = requests.get(f"{API}/reports/daily-dispatch", headers=user_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "groups" in body
        # ensure fields still present in payload (frontend gates totals, not backend payload)
        for g in body["groups"]:
            assert "city" in g
            assert "location" in g
            # transport_name should also be present per iter-16 contract
            assert "transport_name" in g


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
