"""Iteration 15 — voice parser & customer-match unit tests.

Pure server-side parser tests — no Whisper / network. Run with plain pytest:
    python -m pytest tests/test_voice_iteration_15.py -v
"""
import asyncio
import sys
import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from server import (  # noqa: E402
    parse_voice_order_with_items,
    match_customer_from_voice,
    _parse_word_number,
    db,
)


def _run(coro):
    """Run an async coroutine to completion on a fresh loop."""
    return asyncio.get_event_loop().run_until_complete(coro)


def test_hinglish_quantity_parses():
    out = _run(parse_voice_order_with_items(
        "Side stand do sau piece, seat kunda teen sau pachas piece."
    ))
    products = {i["product_name"]: i["quantity"] for i in out}
    assert products.get("Side Stand") == 200, out
    assert products.get("Seat Kunda") == 350, out


def test_english_quantity_parses():
    out = _run(parse_voice_order_with_items(
        "I need 500 side stands and three hundred footrest rods."
    ))
    products = {i["product_name"]: i["quantity"] for i in out}
    assert products.get("Side Stand") == 500, out
    assert products.get("Footrest Rod") == 300, out


def test_devanagari_quantity_parses():
    out = _run(parse_voice_order_with_items(
        "साइड स्टैंड दो सौ। सीट कुंडा तीन सौ।"
    ))
    products = {i["product_name"]: i["quantity"] for i in out}
    assert products.get("Side Stand") == 200, out
    assert products.get("Seat Kunda") == 300, out


def test_word_number_misspellings():
    assert _parse_word_number("dosa") == 200
    assert _parse_word_number("paanchso") == 500
    assert _parse_word_number("teen sau pachas") == 350
    assert _parse_word_number("two hundred") == 200


def test_customer_fuzzy_match_exact():
    cust = _run(db.customers.find_one({}, {"_id": 0, "id": 1, "name": 1}))
    if not cust:
        pytest.skip("No customers seeded")
    text = f"{cust['name']} ke liye side stand do sau piece."
    res = _run(match_customer_from_voice(text))
    assert res is not None, "Should match exact customer name"
    assert res["id"] == cust["id"], res
    assert res["score"] >= 65


def test_customer_fuzzy_match_partial_misspelled():
    cust = _run(db.customers.find_one({}, {"_id": 0, "id": 1, "name": 1}))
    if not cust:
        pytest.skip("No customers seeded")
    name = cust["name"]
    mangled = name[:max(3, len(name) - 2)]  # truncate last 2 chars
    text = f"{mangled} ke liye seat kunda teen sau."
    res = _run(match_customer_from_voice(text))
    assert res is not None, f"Mangled '{mangled}' should still fuzzy-match"
    assert res["id"] == cust["id"], res


def test_customer_fuzzy_no_match_returns_none():
    res = _run(match_customer_from_voice("xyzxyzxyz random nonsense word"))
    assert res is None or res["score"] < 65, res
