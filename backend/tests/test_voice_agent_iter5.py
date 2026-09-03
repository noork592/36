"""Iteration 5 tests:
- Task 3: Voice Agent text + audio endpoints
- Task 1: /api/customers/search returns address
- Regression: /api/auth/login, /api/voice/transcribe
"""
import io
import os
import wave
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # fallback to frontend .env file
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass

API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin@factory.com", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "token" in data
    return data["token"]


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# --- Regression: login ---
def test_login_admin_returns_token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert "token" in r.json()


# --- Task 1: customers/search returns address ---
def test_customers_search_returns_address(auth_headers):
    r = requests.get(f"{API}/customers/search?q=A", headers=auth_headers, timeout=30)
    assert r.status_code == 200
    arr = r.json()
    assert isinstance(arr, list)
    assert len(arr) > 0
    # at least one result should contain address key
    has_addr_key = all(("address" in c) for c in arr[:5])
    assert has_addr_key, f"customers/search results missing 'address' field: {arr[:1]}"


def test_customers_search_am_auto(auth_headers):
    r = requests.get(f"{API}/customers/search?q=A M", headers=auth_headers, timeout=30)
    assert r.status_code == 200
    arr = r.json()
    assert len(arr) > 0
    names = [c.get("name", "").upper() for c in arr]
    assert any("A M" in n or "AM AUTO" in n for n in names), f"Expected A M AUTO in results, got {names[:5]}"


# --- Task 3: voice agent text endpoint ---
def _call_agent_text(headers, text):
    r = requests.post(
        f"{API}/voice/agent/text",
        json={"text": text},
        headers=headers,
        timeout=60,
    )
    return r


def test_voice_agent_text_empty_returns_400(auth_headers):
    r = _call_agent_text(auth_headers, "")
    assert r.status_code == 400


def test_voice_agent_text_open_dispatch(auth_headers):
    r = _call_agent_text(auth_headers, "Open dispatch page")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "navigate", data
    assert data.get("params", {}).get("page") == "dispatch", data


def test_voice_agent_text_naya_order(auth_headers):
    r = _call_agent_text(auth_headers, "Naya order banao")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "navigate", data
    assert data.get("params", {}).get("page") == "new_order", data


def test_voice_agent_text_pending_orders(auth_headers):
    r = _call_agent_text(auth_headers, "Show me pending orders")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "filter_orders", data
    status = (data.get("params", {}) or {}).get("status", "")
    assert str(status).lower() == "pending", data


def test_voice_agent_text_customer_ledger(auth_headers):
    r = _call_agent_text(auth_headers, "Customer A M Auto ka ledger dikhao")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "show_customer_ledger", data
    assert data.get("resolved", {}).get("customer_id"), data


def test_voice_agent_text_search_customer(auth_headers):
    r = _call_agent_text(auth_headers, "Find customer Sharma Auto")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "search_customer", data
    assert data.get("resolved", {}).get("customer_id"), data


def test_voice_agent_text_help(auth_headers):
    r = _call_agent_text(auth_headers, "Help")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["intent"] == "help", data


# --- Task 3: voice agent audio endpoint ---
def test_voice_agent_audio_empty_returns_400(auth_headers):
    files = {"file": ("empty.webm", b"", "audio/webm")}
    r = requests.post(f"{API}/voice/agent", files=files, headers=auth_headers, timeout=60)
    assert r.status_code == 400


def _make_silence_wav(duration_s=0.5, sample_rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * duration_s))
    buf.seek(0)
    return buf.read()


def test_voice_agent_audio_silence_returns_payload(auth_headers):
    wav_bytes = _make_silence_wav()
    files = {"file": ("silence.wav", wav_bytes, "audio/wav")}
    r = requests.post(f"{API}/voice/agent", files=files, headers=auth_headers, timeout=120)
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("transcript", "intent", "params", "resolved", "spoken_reply", "confidence"):
        assert k in data, f"missing key {k} in {data}"


# --- Regression: /api/voice/transcribe ---
def test_voice_transcribe_silence_still_works(auth_headers):
    wav_bytes = _make_silence_wav()
    files = {"file": ("silence.wav", wav_bytes, "audio/wav")}
    r = requests.post(f"{API}/voice/transcribe", files=files, headers=auth_headers, timeout=120)
    # may return 200 with empty text, or 200 with text; accept 200
    assert r.status_code == 200, r.text
    assert "text" in r.json() or "transcript" in r.json()
