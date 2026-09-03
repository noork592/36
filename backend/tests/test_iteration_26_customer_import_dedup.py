"""
Iteration 26 — Customer Excel import dedup key = name + city + address
(case-insensitive, whitespace-collapsed).  Phone is no longer part of dedupe.

Endpoint: POST /api/customers/import  (multipart, field='file')
Response: {imported:int, skipped:int, skipped_reasons:[{row,name,reason}]}

Covers:
  - exact dup against existing DB row -> skipped (new reason wording)
  - same name, different city  -> imported (different branch)
  - same name, different address -> imported (different branch)
  - within-file exact dup -> 2nd row skipped (new reason wording)
  - within-file same name but different city/address -> both imported
  - whitespace + case normalization
  - phone-duplicate NO LONGER skips
  - empty rows skipped silently
  - missing 'name' column -> 400
  - unknown price_list -> per-row skip with 'unknown price list'
  - GET /api/customers reflects new rows (count grows)

Test rows use the prefix 'ZZTEST_' so the teardown can clean them up safely.
"""

import io
import os
import uuid
import pytest
import requests
from openpyxl import Workbook

def _load_base_url():
    url = os.environ.get("REACT_APP_BACKEND_URL")
    if not url:
        # Fallback: read from /app/frontend/.env (tests are usually launched
        # without the frontend env vars sourced into the shell).
        try:
            with open("/app/frontend/.env") as fh:
                for line in fh:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        url = line.split("=", 1)[1].strip()
                        break
        except FileNotFoundError:
            pass
    assert url, "REACT_APP_BACKEND_URL is not set"
    return url.rstrip("/")


BASE_URL = _load_base_url()
PREFIX = "ZZTEST_"


# ---------------------------------------------------------------- helpers
def _xlsx(headers, rows):
    """Return bytes of a tiny .xlsx workbook."""
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


def _import(session, blob, filename="t.xlsx"):
    files = {"file": (filename, blob,
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    return session.post(f"{BASE_URL}/api/customers/import", files=files)


# ---------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": "admin@factory.com", "password": "admin123"},
               timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"no token in login response: {r.json()}"
    s.headers.update({"Authorization": f"Bearer {tok}"})
    yield s
    # teardown: delete any ZZTEST_* customers we left behind
    r = s.get(f"{BASE_URL}/api/customers", timeout=30)
    if r.status_code == 200:
        ids = [c["id"] for c in r.json() if (c.get("name") or "").startswith(PREFIX)]
        if ids:
            s.post(f"{BASE_URL}/api/customers/bulk-delete", json={"ids": ids}, timeout=60)


@pytest.fixture
def unique_name():
    return f"{PREFIX}{uuid.uuid4().hex[:8].upper()}"


# ---------------------------------------------------------------- 1. seed + exact dup against existing DB
def test_existing_db_exact_dup_skipped_with_new_reason(admin_session, unique_name):
    # Seed a customer
    blob = _xlsx(["name", "city", "address", "phone"],
                 [[unique_name, "Mumbai", "Plot 9, Andheri", "9000000001"]])
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 1 and j["skipped"] == 0, j

    # Re-import same row -> must be skipped with the new reason wording
    r2 = _import(admin_session, blob)
    assert r2.status_code == 200, r2.text
    j2 = r2.json()
    assert j2["imported"] == 0 and j2["skipped"] == 1, j2
    reason = j2["skipped_reasons"][0]["reason"]
    assert "same name + city + address already exists" in reason, reason
    # The old wording must be gone
    assert "name already exists" not in reason.lower() or "city" in reason
    assert "phone already used" not in reason.lower()


# ---------------------------------------------------------------- 2. same name, different city/address -> imported
def test_same_name_different_branch_imported(admin_session, unique_name):
    # Seed branch A
    blob = _xlsx(["name", "city", "address"],
                 [[unique_name, "Delhi", "Plot 1"]])
    assert _import(admin_session, blob).status_code == 200

    # Branch B: same name, different city -> imported
    # Branch C: same name, different address -> imported
    blob2 = _xlsx(["name", "city", "address"],
                  [[unique_name, "Kolkata", "Plot 1"],
                   [unique_name, "Delhi",   "Plot 2"]])
    r = _import(admin_session, blob2)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 2 and j["skipped"] == 0, j


# ---------------------------------------------------------------- 3. within-file dedup
def test_within_file_exact_dup_skipped(admin_session, unique_name):
    blob = _xlsx(["name", "city", "address"],
                 [[unique_name, "Pune", "Shop 1"],
                  [unique_name, "Pune", "Shop 1"]])     # exact dup
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 1 and j["skipped"] == 1, j
    reason = j["skipped_reasons"][0]["reason"]
    assert "duplicate of row 2 in this file" in reason, reason
    assert "same name + city + address" in reason, reason


def test_within_file_same_name_different_branch_both_imported(admin_session, unique_name):
    blob = _xlsx(["name", "city", "address"],
                 [[unique_name, "Pune",      "Shop 1"],
                  [unique_name, "Mumbai",    "Shop 1"],   # diff city
                  [unique_name, "Pune",      "Shop 2"]])  # diff address
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 3 and j["skipped"] == 0, j


# ---------------------------------------------------------------- 4. normalization (case + whitespace)
def test_normalization_case_and_whitespace(admin_session, unique_name):
    # Seed
    blob = _xlsx(["name", "city", "address"],
                 [[unique_name, "Delhi", "Plot 12"]])
    assert _import(admin_session, blob).status_code == 200

    # Same key, but altered casing & whitespace -> must dedupe
    altered_name = unique_name.lower().replace("_", "  _  ")  # extra whitespace
    blob2 = _xlsx(["name", "city", "address"],
                  [[f"  {altered_name}  ", "DELHI", "plot   12"]])
    r = _import(admin_session, blob2)
    assert r.status_code == 200, r.text
    j = r.json()
    # NOTE: the underscore is preserved by the normaliser (only whitespace is
    # collapsed). So we use whitespace-only variation, not underscore variation.
    # Build a stricter test below to make this deterministic.


def test_normalization_strict(admin_session, unique_name):
    blob = _xlsx(["name", "city", "address"],
                 [[f"{unique_name} Auto", "Delhi", "Plot 12"]])
    assert _import(admin_session, blob).status_code == 200

    # whitespace-collapse + case-fold should make these the same key
    blob2 = _xlsx(["name", "city", "address"],
                  [[f"  {unique_name.lower()}   AUTO ", "DELHI", "plot   12"]])
    r = _import(admin_session, blob2)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 0 and j["skipped"] == 1, j
    assert "same name + city + address already exists" in j["skipped_reasons"][0]["reason"]


# ---------------------------------------------------------------- 5. phone is NOT a dedupe key any more
def test_phone_duplicates_no_longer_skipped(admin_session, unique_name):
    shared_phone = "9999911111"
    blob = _xlsx(["name", "city", "address", "phone"],
                 [[f"{unique_name}_A", "Delhi", "Branch 1", shared_phone],
                  [f"{unique_name}_B", "Delhi", "Branch 2", shared_phone],
                  [f"{unique_name}_C", "Pune",  "Branch 1", shared_phone]])
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 3, j
    assert j["skipped"] == 0, j
    # And re-importing one of them with a different phone but identical
    # name/city/address still skips (proves the new key, not phone, drives dedupe)
    blob2 = _xlsx(["name", "city", "address", "phone"],
                  [[f"{unique_name}_A", "Delhi", "Branch 1", "0000000000"]])
    r2 = _import(admin_session, blob2)
    j2 = r2.json()
    assert r2.status_code == 200 and j2["imported"] == 0 and j2["skipped"] == 1, j2
    assert "phone" not in j2["skipped_reasons"][0]["reason"].lower()


# ---------------------------------------------------------------- 6. existing-vs-file precedence + GET count growth
def test_existing_vs_file_precedence_and_get_count(admin_session, unique_name):
    before = admin_session.get(f"{BASE_URL}/api/customers", timeout=30).json()
    before_count = len(before)

    # Two rows in the file share key with each other; first one also exists in DB
    blob_seed = _xlsx(["name", "city", "address"],
                      [[unique_name, "Jaipur", "X1"]])
    assert _import(admin_session, blob_seed).status_code == 200

    blob = _xlsx(["name", "city", "address"],
                 [[unique_name, "Jaipur", "X1"],        # dup of DB
                  [unique_name, "Jaipur", "X1"],        # dup of row 2 too
                  [unique_name, "Jaipur", "X2"],        # new branch -> imported
                  [unique_name, "Jaipur", "X2"]])       # dup of row 4
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 1, j
    assert j["skipped"] == 3, j
    reasons = [s["reason"] for s in j["skipped_reasons"]]
    # Precedence rule: existing-DB check fires before within-file check.
    # row 2 -> existing, row 3 -> existing, row 5 -> duplicate of row 4 in file.
    existing_hits = [x for x in reasons if "already exists in customer list" in x]
    file_dup_hits = [x for x in reasons if "duplicate of row 4 in this file" in x]
    assert len(existing_hits) == 2, reasons
    assert len(file_dup_hits) == 1, reasons

    after = admin_session.get(f"{BASE_URL}/api/customers", timeout=30).json()
    # Seed added 1 + this import added 1 = 2 new rows for the chosen name
    new_for_name = [c for c in after if c.get("name") == unique_name]
    assert len(new_for_name) == 2, new_for_name
    assert len(after) >= before_count + 2


# ---------------------------------------------------------------- 7. regression: empty rows / missing name col / unknown PL
def test_empty_rows_are_silently_skipped(admin_session, unique_name):
    blob = _xlsx(["name", "city", "address"],
                 [["", "", ""],
                  [None, None, None],
                  [unique_name, "Surat", "S1"]])
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 1 and j["skipped"] == 0, j


def test_missing_name_column_400(admin_session):
    blob = _xlsx(["city", "address"], [["Delhi", "X"]])
    r = _import(admin_session, blob)
    assert r.status_code == 400, r.text
    assert "name" in r.text.lower()


def test_unknown_price_list_skips_row(admin_session, unique_name):
    blob = _xlsx(["name", "city", "address", "price_list"],
                 [[unique_name, "Goa", "Beach Rd", "__definitely_not_a_list__"]])
    r = _import(admin_session, blob)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["imported"] == 0 and j["skipped"] == 1, j
    assert "unknown price list" in j["skipped_reasons"][0]["reason"].lower()
