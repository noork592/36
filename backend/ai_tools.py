"""AI Tools registry — bridge between the chatbot's LLM and concrete
factory operations (orders, dispatches, ledger, payments, customers).

Design:
- Every tool has a TOOL_SPEC (name, description, JSON-schema args, is_write).
- The planner LLM sees TOOL_SPECS as JSON and picks ONE tool + args.
- READ tools execute immediately; WRITE tools return a pending_action
  that the frontend must confirm before we execute.

All DB access goes through the shared `db` handle from server.py — this
module is stateless, tools receive `db` as their first arg.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    from rapidfuzz import fuzz, process as _rf_process
    from rapidfuzz.utils import default_process as _rf_default_process
    _RF_OK = True
except Exception:
    _RF_OK = False

logger = logging.getLogger("ai_tools")


# ----------------------------------------------------------- helpers
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fmt_inr(v: Any) -> str:
    try:
        n = float(v or 0)
    except Exception:
        return str(v or "")
    neg = n < 0
    n = abs(n)
    ip = int(n)
    fp = round(n - ip, 2)
    s = str(ip)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        grp = []
        while len(head) > 2:
            grp.insert(0, head[-2:])
            head = head[:-2]
        if head:
            grp.insert(0, head)
        s = ",".join(grp) + "," + tail
    if fp:
        s += f"{fp:.2f}"[1:]
    return f"-₹{s}" if neg else f"₹{s}"


async def _fuzzy_find_customer(db, query: str) -> Optional[Dict[str, Any]]:
    """Best-effort typo-tolerant customer lookup. Order of attempts:
      1. Exact case-insensitive match on name / phone.
      2. Case-insensitive substring regex on name / phone.
      3. rapidfuzz token_set_ratio against ALL customer names — handles
         typos like 'Moter' vs 'Motor', word reorderings, extra spaces.
    Returns the single best match (score >= 70 for step 3) or None."""
    if not query:
        return None
    q = query.strip()
    if not q:
        return None

    # 1) Exact match on name OR phone
    doc = await db.customers.find_one(
        {
            "$or": [
                {"name": {"$regex": f"^{re.escape(q)}$", "$options": "i"}},
                {"phone": {"$regex": f"^{re.escape(q)}$", "$options": "i"}},
            ]
        },
        {"_id": 0},
    )
    if doc:
        return doc

    # 2) Substring regex on name / phone. If exactly one match — take it.
    docs = (
        await db.customers.find(
            {
                "$or": [
                    {"name": {"$regex": re.escape(q), "$options": "i"}},
                    {"phone": {"$regex": re.escape(q), "$options": "i"}},
                ]
            },
            {"_id": 0},
        )
        .limit(6)
        .to_list(6)
    )
    if len(docs) == 1:
        return docs[0]
    if docs:
        docs.sort(key=lambda d: len(d.get("name") or ""))
        return docs[0]

    # 3) Typo-tolerant match via rapidfuzz across ALL customer names.
    if _RF_OK:
        all_docs = await db.customers.find(
            {}, {"_id": 0, "id": 1, "name": 1, "phone": 1, "city": 1,
                 "location": 1, "address": 1}
        ).to_list(5000)
        if not all_docs:
            return None
        # Build a name→doc map. If duplicate names exist, last wins (fine).
        by_name = {(d.get("name") or "").strip(): d for d in all_docs if d.get("name")}
        names = list(by_name.keys())
        if not names:
            return None
        # token_set_ratio ignores word order and duplicates, WRatio combines
        # several heuristics. Use WRatio for the primary score.
        best = _rf_process.extractOne(
            q, names, scorer=fuzz.WRatio, processor=_rf_default_process
        )
        if best and best[1] >= 70:
            return by_name.get(best[0])
        # Fallback: try partial_ratio for cases like "popular motor"
        # matching "POPULAR MOTOR CYCLE".
        best2 = _rf_process.extractOne(
            q, names, scorer=fuzz.partial_ratio, processor=_rf_default_process
        )
        if best2 and best2[1] >= 85:
            return by_name.get(best2[0])
    return None


async def _list_customer_matches(db, query: str, limit: int = 6) -> List[Dict[str, Any]]:
    """Return up to `limit` best-scored candidate customer docs. Used
    by search_customers and error hints on failed exact lookups."""
    q = (query or "").strip()
    if not q:
        return []

    # Fast path: regex substring
    docs = (
        await db.customers.find(
            {
                "$or": [
                    {"name": {"$regex": re.escape(q), "$options": "i"}},
                    {"phone": {"$regex": re.escape(q), "$options": "i"}},
                ]
            },
            {"_id": 0},
        )
        .limit(int(limit) * 3)
        .to_list(int(limit) * 3)
    )
    if len(docs) >= int(limit):
        return docs[: int(limit)]

    # Augment with rapidfuzz ranking against ALL customers to catch typos
    if _RF_OK:
        all_docs = await db.customers.find(
            {}, {"_id": 0, "id": 1, "name": 1, "phone": 1, "city": 1,
                 "location": 1, "address": 1}
        ).to_list(5000)
        by_name = {(d.get("name") or "").strip(): d for d in all_docs if d.get("name")}
        names = list(by_name.keys())
        # extract top candidates
        ranked = _rf_process.extract(
            q, names, scorer=fuzz.WRatio,
            processor=_rf_default_process, limit=int(limit) * 2,
        )
        seen_ids = {d.get("id") for d in docs}
        for name, score, _idx in ranked:
            if score < 50:
                continue
            d = by_name.get(name)
            if not d or d.get("id") in seen_ids:
                continue
            docs.append(d)
            seen_ids.add(d.get("id"))
            if len(docs) >= int(limit):
                break
    return docs[: int(limit)]


async def _fuzzy_find_item(db, query: str) -> Optional[Dict[str, Any]]:
    """Typo-tolerant item lookup. Mirrors _fuzzy_find_customer."""
    if not query:
        return None
    q = query.strip()
    if not q:
        return None
    doc = await db.items.find_one(
        {"name": {"$regex": f"^{re.escape(q)}$", "$options": "i"}}, {"_id": 0}
    )
    if doc:
        return doc
    docs = (
        await db.items.find(
            {"name": {"$regex": re.escape(q), "$options": "i"}}, {"_id": 0}
        )
        .limit(6)
        .to_list(6)
    )
    if len(docs) == 1:
        return docs[0]
    if docs:
        docs.sort(key=lambda d: len(d.get("name") or ""))
        return docs[0]
    # Typo-tolerant fallback
    if _RF_OK:
        all_items = await db.items.find(
            {}, {"_id": 0, "id": 1, "name": 1}
        ).to_list(5000)
        by_name = {(d.get("name") or "").strip(): d for d in all_items if d.get("name")}
        names = list(by_name.keys())
        if names:
            best = _rf_process.extractOne(
                q, names, scorer=fuzz.WRatio, processor=_rf_default_process
            )
            if best and best[1] >= 70:
                return by_name.get(best[0])
    return None


# ----------------------------------------------------------- READ tools
async def tool_list_pending_orders(db, party_name: Optional[str] = None,
                                    limit: int = 15) -> Dict[str, Any]:
    q: Dict[str, Any] = {"status": "Pending"}
    if party_name:
        cust = await _fuzzy_find_customer(db, party_name)
        if not cust:
            return {"ok": False, "message": f"No customer matches '{party_name}'."}
        q["customer_id"] = cust["id"]
    docs = (
        await db.orders.find(q, {"_id": 0})
        .sort("order_date", -1)
        .limit(int(limit))
        .to_list(int(limit))
    )
    rows = [
        {
            "id": d.get("id"),
            "customer": d.get("customer_name"),
            "order_date": d.get("order_date"),
            "delivery_date": d.get("delivery_date"),
            "items_count": len(d.get("items", [])),
            "total_pcs": sum(int(it.get("quantity") or 0) for it in d.get("items", [])),
            "notes": (d.get("notes") or "")[:80],
        }
        for d in docs
    ]
    return {"ok": True, "count": len(rows), "rows": rows}


async def tool_list_todays_dispatches(db, limit: int = 20) -> Dict[str, Any]:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    q = {"dispatch_date": {"$regex": f"^{today}"}}
    docs = (
        await db.dispatches.find(q, {"_id": 0})
        .sort("dispatch_date", -1)
        .limit(int(limit))
        .to_list(int(limit))
    )
    rows = [
        {
            "slip_no": d.get("slip_no"),
            "customer": d.get("customer_name"),
            "total_pcs": d.get("total_pcs"),
            "total_value": d.get("total_value"),
            "transport_name": d.get("transport_name"),
            "gr_number": d.get("gr_number"),
            "dispatch_date": d.get("dispatch_date"),
        }
        for d in docs
    ]
    total_bill = sum(float(d.get("total_value") or 0) for d in docs)
    total_pcs = sum(int(d.get("total_pcs") or 0) for d in docs)
    return {
        "ok": True,
        "count": len(rows),
        "total_bill_amount": total_bill,
        "total_pcs": total_pcs,
        "rows": rows,
    }


async def tool_get_ledger_balance(db, party_name: str) -> Dict[str, Any]:
    cust = await _fuzzy_find_customer(db, party_name)
    if not cust:
        matches = await _list_customer_matches(db, party_name)
        return {
            "ok": False,
            "message": f"No customer matches '{party_name}'.",
            "hints": [m.get("name") for m in matches][:5],
        }
    # Sum of all dispatch total_value = debit
    dispatch_docs = await db.dispatches.find(
        {"customer_id": cust["id"]}, {"_id": 0, "total_value": 1, "slip_no": 1, "dispatch_date": 1}
    ).to_list(5000)
    debit = sum(float(d.get("total_value") or 0) for d in dispatch_docs)
    # Sum of all payments = credit
    pay_docs = await db.payments.find(
        {"customer_id": cust["id"]}, {"_id": 0, "amount": 1, "when": 1}
    ).to_list(5000)
    credit = sum(float(p.get("amount") or 0) for p in pay_docs)
    balance = debit - credit
    last_dispatch = None
    if dispatch_docs:
        latest = max(dispatch_docs, key=lambda d: d.get("dispatch_date") or "")
        last_dispatch = {"slip_no": latest.get("slip_no"),
                         "date": latest.get("dispatch_date"),
                         "amount": latest.get("total_value")}
    last_payment = None
    if pay_docs:
        latest = max(pay_docs, key=lambda d: d.get("when") or "")
        last_payment = {"date": latest.get("when"), "amount": latest.get("amount")}
    return {
        "ok": True,
        "customer": {"id": cust["id"], "name": cust.get("name"),
                     "phone": cust.get("phone"), "city": cust.get("city")},
        "total_dispatched": debit,
        "total_paid": credit,
        "balance": balance,
        "balance_side": "Dr" if balance >= 0 else "Cr",
        "dispatch_count": len(dispatch_docs),
        "payment_count": len(pay_docs),
        "last_dispatch": last_dispatch,
        "last_payment": last_payment,
    }


async def tool_search_customers(db, query: str, limit: int = 10) -> Dict[str, Any]:
    docs = await _list_customer_matches(db, query, limit=int(limit))
    return {
        "ok": True,
        "count": len(docs),
        "rows": [
            {
                "id": d.get("id"),
                "name": d.get("name"),
                "phone": d.get("phone"),
                "city": d.get("city"),
                "location": d.get("location"),
            }
            for d in docs
        ],
    }


async def tool_get_product_info(db, product_name: str) -> Dict[str, Any]:
    item = await _fuzzy_find_item(db, product_name)
    if not item:
        # search products collection too
        p = await db.products.find_one(
            {"name": {"$regex": re.escape(product_name), "$options": "i"}}, {"_id": 0}
        )
        if not p:
            return {"ok": False, "message": f"No item / product matches '{product_name}'."}
        return {"ok": True, "type": "product", "product": p}
    return {"ok": True, "type": "item", "item": item}


async def tool_list_overdue_parties(db, min_days: int = 30,
                                    limit: int = 15) -> Dict[str, Any]:
    """Return top parties with a positive Dr balance and no payment in the
    last `min_days` days."""
    # Aggregate dispatches per customer
    cust_docs = await db.customers.find({}, {"_id": 0, "id": 1, "name": 1, "phone": 1}).to_list(5000)
    result = []
    cutoff_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for c in cust_docs:
        dispatches = await db.dispatches.find(
            {"customer_id": c["id"]}, {"_id": 0, "total_value": 1, "dispatch_date": 1}
        ).to_list(5000)
        if not dispatches:
            continue
        debit = sum(float(d.get("total_value") or 0) for d in dispatches)
        payments = await db.payments.find(
            {"customer_id": c["id"]}, {"_id": 0, "amount": 1, "when": 1}
        ).to_list(5000)
        credit = sum(float(p.get("amount") or 0) for p in payments)
        bal = debit - credit
        if bal <= 0:
            continue
        last_pay = max((p.get("when") or "" for p in payments), default="")
        # days since last payment or last dispatch
        last_activity = last_pay or max((d.get("dispatch_date") or "" for d in dispatches), default="")
        try:
            la_dt = datetime.fromisoformat((last_activity or cutoff_iso).replace("Z", "+00:00"))
            days_ago = (datetime.now(timezone.utc) - la_dt).days
        except Exception:
            days_ago = 999
        if days_ago < int(min_days):
            continue
        result.append({
            "id": c["id"],
            "name": c.get("name"),
            "phone": c.get("phone"),
            "balance": bal,
            "days_since_activity": days_ago,
        })
    result.sort(key=lambda r: r["balance"], reverse=True)
    return {"ok": True, "count": len(result), "rows": result[: int(limit)]}


# ----------------------------------------------------------- WRITE tools
async def tool_record_payment(
    db, party_name: str, amount: float, mode: str = "Cash",
    notes: str = "", user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if amount is None or float(amount) <= 0:
        return {"ok": False, "message": "Amount must be > 0"}
    cust = await _fuzzy_find_customer(db, party_name)
    if not cust:
        return {"ok": False, "message": f"No customer matches '{party_name}'."}
    doc = {
        "id": str(uuid.uuid4()),
        "customer_id": cust["id"],
        "customer_name": cust.get("name"),
        "amount": float(amount),
        "mode": mode or "Cash",
        "notes": (notes or "").strip(),
        "when": _now_iso(),
        "created_by": (user or {}).get("email") or "ai-agent",
        "created_at": _now_iso(),
    }
    await db.payments.insert_one(dict(doc))
    doc.pop("_id", None)
    return {"ok": True, "payment": doc, "message":
            f"Recorded payment of {_fmt_inr(amount)} from {cust.get('name')}."}


async def tool_create_order(
    db, party_name: str, items: List[Dict[str, Any]],
    notes: str = "", user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """items: list of {item_name, quantity}"""
    if not items:
        return {"ok": False, "message": "No items provided"}
    cust = await _fuzzy_find_customer(db, party_name)
    if not cust:
        return {"ok": False, "message": f"No customer matches '{party_name}'."}
    resolved_items: List[Dict[str, Any]] = []
    unresolved: List[str] = []
    for row in items:
        nm = str(row.get("item_name") or "").strip()
        qty = row.get("quantity") or 0
        try:
            qty = int(float(qty))
        except Exception:
            qty = 0
        if not nm or qty <= 0:
            continue
        it = await _fuzzy_find_item(db, nm)
        if not it:
            unresolved.append(nm)
            continue
        resolved_items.append({
            "item_id": it["id"],
            "item_name": it.get("name"),
            "quantity": qty,
            "description": row.get("description") or "",
        })
    if not resolved_items:
        return {"ok": False, "message": "None of the items could be matched.",
                "unresolved": unresolved}
    doc = {
        "id": str(uuid.uuid4()),
        "customer_id": cust["id"],
        "customer_name": cust.get("name"),
        "items": resolved_items,
        "order_date": _now_iso(),
        "delivery_date": None,
        "status": "Pending",
        "notes": (notes or "").strip(),
        "created_by": (user or {}).get("email") or "ai-agent",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    await db.orders.insert_one(dict(doc))
    doc.pop("_id", None)
    total_pcs = sum(it["quantity"] for it in resolved_items)
    return {"ok": True, "order": doc, "unresolved": unresolved,
            "message": f"Created order for {cust.get('name')} with "
                       f"{len(resolved_items)} item(s) · {total_pcs} pcs."}


async def tool_add_customer(
    db, name: str, phone: str = "", city: str = "",
    location: str = "", address: str = "",
    user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not name or not name.strip():
        return {"ok": False, "message": "Customer name is required"}
    # Avoid duplicates
    existing = await db.customers.find_one(
        {"name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"}}, {"_id": 0}
    )
    if existing:
        return {"ok": False, "message":
                f"A customer named '{existing.get('name')}' already exists.",
                "existing": {"id": existing.get("id"),
                             "name": existing.get("name"),
                             "phone": existing.get("phone")}}
    doc = {
        "id": str(uuid.uuid4()),
        "name": name.strip(),
        "phone": (phone or "").strip(),
        "city": (city or "").strip(),
        "location": (location or "").strip(),
        "address": (address or "").strip(),
        "created_by": (user or {}).get("email") or "ai-agent",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    await db.customers.insert_one(dict(doc))
    doc.pop("_id", None)
    return {"ok": True, "customer": doc,
            "message": f"Added customer '{doc['name']}'."}


async def tool_mark_dispatch_delivered(
    db, slip_no: str, user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not slip_no:
        return {"ok": False, "message": "Slip number is required"}
    disp = await db.dispatches.find_one(
        {"slip_no": str(slip_no)}, {"_id": 0}
    )
    if not disp:
        return {"ok": False, "message": f"No dispatch found for slip #{slip_no}."}
    await db.dispatches.update_one(
        {"id": disp["id"]},
        {"$set": {"status": "Delivered", "delivered_at": _now_iso(),
                  "updated_at": _now_iso()}},
    )
    return {"ok": True, "message":
            f"Marked slip #{slip_no} ({disp.get('customer_name')}) as Delivered."}


# ----------------------------------------------------------- registry
TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "name": "list_pending_orders",
        "description": "List Pending orders. Optionally filter by party_name.",
        "args": {"party_name": "string (optional)", "limit": "integer (default 15)"},
        "is_write": False,
    },
    {
        "name": "list_todays_dispatches",
        "description": "List dispatch slips created today (UTC).",
        "args": {"limit": "integer (default 20)"},
        "is_write": False,
    },
    {
        "name": "get_ledger_balance",
        "description": "Get the current outstanding ledger balance for a customer (Dr/Cr).",
        "args": {"party_name": "string (required)"},
        "is_write": False,
    },
    {
        "name": "search_customers",
        "description": "Search customers by name or phone.",
        "args": {"query": "string (required)", "limit": "integer (default 10)"},
        "is_write": False,
    },
    {
        "name": "get_product_info",
        "description": "Look up an item (SKU) or product by name.",
        "args": {"product_name": "string (required)"},
        "is_write": False,
    },
    {
        "name": "list_overdue_parties",
        "description": "List customers with a positive Dr balance and no activity for at least `min_days` days.",
        "args": {"min_days": "integer (default 30)", "limit": "integer (default 15)"},
        "is_write": False,
    },
    {
        "name": "record_payment",
        "description": "WRITE: record a payment received from a customer. Requires user confirmation.",
        "args": {
            "party_name": "string (required)",
            "amount": "number (required, > 0)",
            "mode": "string (Cash / UPI / Bank / Cheque; default Cash)",
            "notes": "string (optional)",
        },
        "is_write": True,
    },
    {
        "name": "create_order",
        "description": "WRITE: create a new Pending order for a customer. Requires user confirmation. items = [{item_name, quantity}].",
        "args": {
            "party_name": "string (required)",
            "items": "array of {item_name:string, quantity:integer}",
            "notes": "string (optional)",
        },
        "is_write": True,
    },
    {
        "name": "add_customer",
        "description": "WRITE: create a new customer record. Requires user confirmation.",
        "args": {
            "name": "string (required)",
            "phone": "string (optional)",
            "city": "string (optional)",
            "location": "string (optional)",
            "address": "string (optional)",
        },
        "is_write": True,
    },
    {
        "name": "mark_dispatch_delivered",
        "description": "WRITE: mark a dispatch slip as Delivered. Requires user confirmation.",
        "args": {"slip_no": "string (required)"},
        "is_write": True,
    },
]

_TOOL_FUNCS: Dict[str, Callable] = {
    "list_pending_orders": tool_list_pending_orders,
    "list_todays_dispatches": tool_list_todays_dispatches,
    "get_ledger_balance": tool_get_ledger_balance,
    "search_customers": tool_search_customers,
    "get_product_info": tool_get_product_info,
    "list_overdue_parties": tool_list_overdue_parties,
    "record_payment": tool_record_payment,
    "create_order": tool_create_order,
    "add_customer": tool_add_customer,
    "mark_dispatch_delivered": tool_mark_dispatch_delivered,
}


def is_write_tool(name: str) -> bool:
    for s in TOOL_SPECS:
        if s["name"] == name:
            return bool(s.get("is_write"))
    return False


async def execute_tool(
    db, name: str, args: Dict[str, Any],
    user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    fn = _TOOL_FUNCS.get(name)
    if not fn:
        return {"ok": False, "message": f"Unknown tool: {name}"}
    try:
        # Only pass `user` to write tools
        if is_write_tool(name):
            return await fn(db, **(args or {}), user=user)
        return await fn(db, **(args or {}))
    except TypeError as e:
        return {"ok": False, "message": f"Bad arguments for {name}: {e}"}
    except Exception as e:
        logger.exception("Tool %s failed", name)
        return {"ok": False, "message": f"Tool error: {e}"}


def human_intent(name: str, args: Dict[str, Any]) -> str:
    """Short one-line description of what a write tool would do — shown
    on the confirmation banner in the chatbot."""
    if name == "record_payment":
        return f"Record ₹{args.get('amount')} payment from {args.get('party_name')} ({args.get('mode', 'Cash')})"
    if name == "create_order":
        items = args.get("items") or []
        summary = ", ".join(
            f"{it.get('quantity')}× {it.get('item_name')}" for it in items[:3]
        )
        if len(items) > 3:
            summary += f" +{len(items) - 3} more"
        return f"Create order for {args.get('party_name')} — {summary}"
    if name == "add_customer":
        return f"Add customer '{args.get('name')}' ({args.get('phone', '—')})"
    if name == "mark_dispatch_delivered":
        return f"Mark dispatch slip #{args.get('slip_no')} as Delivered"
    return f"Execute {name}"
