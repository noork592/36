"""Real-audio Whisper smoke test for /api/voice/transcribe.

Generates a Hinglish sample audio via OpenAI TTS (Emergent LLM Key),
sends it to the transcribe endpoint, and asserts that:
  - HTTP 200
  - non-empty text returned
  - parsed_items contains at least one expected product with non-zero quantity
"""
import io
import os
import asyncio
import httpx
import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

BACKEND = "http://localhost:8001"
ADMIN = {"email": "admin@factory.com", "password": "admin123"}

pytestmark = pytest.mark.skipif(
    not os.environ.get("EMERGENT_LLM_KEY"),
    reason="EMERGENT_LLM_KEY not configured — skipping real-audio smoke test",
)

SAMPLE_TEXT = (
    "Ramesh ji ke liye order le lo. "
    "Side stand do sau piece, "
    "seat kunda teen sau piece, "
    "number plate chaar sau piece."
)


async def _run_full_flow():
    """Login -> TTS -> POST audio -> assert."""
    from emergentintegrations.llm.openai import OpenAITextToSpeech
    key = os.environ["EMERGENT_LLM_KEY"]

    async with httpx.AsyncClient(timeout=60.0) as c:
        # 1. Login
        r = await c.post(f"{BACKEND}/api/auth/login", json=ADMIN)
        r.raise_for_status()
        token = r.json()["token"]

        # 2. Generate audio
        tts = OpenAITextToSpeech(api_key=key)
        audio = await tts.generate_speech(
            text=SAMPLE_TEXT, model="tts-1", voice="alloy", response_format="mp3"
        )
        assert isinstance(audio, (bytes, bytearray)) and len(audio) > 1000, "TTS empty"

        # 3. POST
        files = {"file": ("sample.mp3", io.BytesIO(bytes(audio)), "audio/mpeg")}
        headers = {"Authorization": f"Bearer {token}"}
        r = await c.post(f"{BACKEND}/api/voice/transcribe", files=files, headers=headers)
        assert r.status_code == 200, f"HTTP {r.status_code}: {r.text}"
        return r.json()


def test_voice_transcribe_real_audio():
    body = asyncio.run(_run_full_flow())
    text = (body.get("text") or "").lower()
    parsed = body.get("parsed_items") or []
    print(f"\nTRANSCRIBED TEXT: {body.get('text')}")
    print(f"PARSED ITEMS: {parsed}")
    assert len(text) > 5, f"Transcription too short: {text!r}"
    matched_products = {p.get("product_name") for p in parsed}
    expected_any = {"Side Stand", "Seat Kunda", "Number Plate"}
    assert matched_products & expected_any, (
        f"None of expected products parsed. text={text!r} parsed={parsed}"
    )
    assert any((p.get("quantity") or 0) > 0 for p in parsed), (
        f"All quantities zero — number parsing failed. parsed={parsed}"
    )


if __name__ == "__main__":
    test_voice_transcribe_real_audio()
    print("\nVOICE TRANSCRIBE SMOKE TEST: PASS")
