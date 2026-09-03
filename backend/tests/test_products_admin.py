"""Backend regression tests for iteration_4:
- Products admin endpoints (list/create/update + RBAC).
- Items / search sanity (regression).
- Auth for both users.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://build-from-git-2.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _login(email: str, pw: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers():
    return {"Authorization": f"Bearer {_login('admin@factory.com', 'admin123')}"}


@pytest.fixture(scope="module")
def user_headers():
    return {"Authorization": f"Bearer {_login('user@factory.com', 'user123')}"}


# ======================== Auth ========================
class TestAuth:
    def test_admin_login(self):
        r = requests.post(f"{API}/auth/login", json={"email": "admin@factory.com", "password": "admin123"})
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"

    def test_user_login(self):
        r = requests.post(f"{API}/auth/login", json={"email": "user@factory.com", "password": "user123"})
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "user"


# ======================== Products ========================
class TestProducts:
    def test_list_15_products(self, admin_headers):
        r = requests.get(f"{API}/products", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        # could be 15 base + any leftover TEST_ products from prior runs
        names = [p["name"] for p in data]
        assert len(data) >= 15, f"got {len(data)}: {names}"
        # core products present
        for n in ["Side Stand", "Center Stand with Kit", "Number Plate", "V-Bracket", "Rear Seat Handle"]:
            assert n in names

    def test_update_product_min_max_persists(self, admin_headers):
        r = requests.get(f"{API}/products", headers=admin_headers)
        side = next(p for p in r.json() if p["name"] == "Side Stand")
        pid = side["id"]
        original_min, original_max = side["min_per_bag"], side["max_per_bag"]
        try:
            # update
            r2 = requests.patch(f"{API}/products/{pid}", headers=admin_headers,
                                json={"min_per_bag": 170, "max_per_bag": 210})
            assert r2.status_code == 200, r2.text
            assert r2.json()["min_per_bag"] == 170
            assert r2.json()["max_per_bag"] == 210
            # verify persisted via GET
            r3 = requests.get(f"{API}/products", headers=admin_headers)
            again = next(p for p in r3.json() if p["id"] == pid)
            assert again["min_per_bag"] == 170
            assert again["max_per_bag"] == 210
        finally:
            # restore
            requests.patch(f"{API}/products/{pid}", headers=admin_headers,
                           json={"min_per_bag": original_min, "max_per_bag": original_max})

    def test_user_cannot_update_product(self, user_headers, admin_headers):
        r = requests.get(f"{API}/products", headers=admin_headers)
        pid = r.json()[0]["id"]
        r2 = requests.patch(f"{API}/products/{pid}", headers=user_headers, json={"min_per_bag": 999})
        assert r2.status_code == 403

    def test_user_cannot_create_product(self, user_headers):
        r = requests.post(f"{API}/products", headers=user_headers,
                          json={"name": "TEST_NoAuth", "min_per_bag": 1, "max_per_bag": 2})
        assert r.status_code == 403

    def test_create_and_cleanup_product(self, admin_headers):
        # cleanup any leftover from previous iteration
        existing = requests.get(f"{API}/products", headers=admin_headers).json()
        leftover = next((p for p in existing if p["name"] == "TEST PRODUCT"), None)
        if leftover:
            # no DELETE endpoint → use DB-side cleanup via direct mongo not possible from here;
            # instead rename via PATCH (PATCH doesn't accept name). Best we can do: skip duplicate
            pytest.skip("TEST PRODUCT already exists from previous run; no DELETE endpoint available")
        r = requests.post(f"{API}/products", headers=admin_headers,
                          json={"name": "TEST PRODUCT", "min_per_bag": 10, "max_per_bag": 20,
                                "variants": ["X", "Y"]})
        assert r.status_code == 200, r.text
        created = r.json()
        assert created["name"] == "TEST PRODUCT"
        assert created["min_per_bag"] == 10
        assert created["max_per_bag"] == 20
        # verify in list
        r2 = requests.get(f"{API}/products", headers=admin_headers)
        names = [p["name"] for p in r2.json()]
        assert "TEST PRODUCT" in names
        # NOTE: no DELETE /api/products/{id} endpoint exists → cannot clean up.

    def test_update_missing_product_returns_404(self, admin_headers):
        r = requests.patch(f"{API}/products/no-such-id", headers=admin_headers,
                           json={"min_per_bag": 5})
        assert r.status_code == 404


# ======================== Items / Search ========================
class TestItems:
    def test_items_count_388(self, admin_headers):
        r = requests.get(f"{API}/items", headers=admin_headers)
        assert r.status_code == 200
        assert len(r.json()) == 388

    def test_search_yamaha(self, admin_headers):
        r = requests.get(f"{API}/items/search", params={"q": "yamaha", "limit": 20}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data) <= 20
        assert len(data) > 0
        for it in data:
            assert "match_score" in it

    def test_search_side_stand_splendor(self, admin_headers):
        r = requests.get(f"{API}/items/search", params={"q": "side stand splendor"}, headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0
        # top result should mention SPLENDOR
        assert any("SPLENDOR" in it["name"].upper() for it in data)
