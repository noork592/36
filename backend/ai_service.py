"""AI Assistant service — floating chatbot + on-demand summaries.

Uses the Emergent Universal LLM key via emergentintegrations. Chat
sessions are persisted in MongoDB (`ai_chat_sessions` + `ai_chat_messages`
collections) so multi-turn conversations survive page reloads.

- Feature A: multi-turn chat assistant that can answer questions about
  orders, dispatches, customers, ledger balances etc. Streams responses
  via SSE for perceived speed.
- Feature C: on-demand AI summaries of ledger / dispatch data.

The voice-order flow (feature B) is already served by
`parse_voice_order_with_items` in server.py and is unchanged here.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from emergentintegrations.llm.chat import (
    LlmChat,
    StreamDone,
    TextDelta,
    UserMessage,
)

logger = logging.getLogger("ai_service")

# Default provider / model — user picked "leave it to you" so we use
# the OpenAI flagship recommended in the playbook.
CHAT_PROVIDER = "openai"
CHAT_MODEL = "gpt-5.4"

# For structured / one-shot tasks (summaries) a faster & cheaper mini is
# fine and keeps latency low.
SUMMARY_MODEL = "gpt-5.4-mini"


# ==================================================================
# Chat sessions — persistent multi-turn conversations
# ==================================================================
CHAT_SYSTEM_PROMPT = """You are the JK Products factory floor assistant — a smart, concise co-pilot for a two-wheeler spare-parts manufacturing and dispatch business.

You help the admin/operator with:
- Order & dispatch questions ("how many pending orders for AMK?", "what did we ship yesterday?").
- Ledger & payment context ("who owes the most?", "any overdue parties?").
- Inventory & product questions ("bag size for M8 nut", "stock of raw material X").
- Voice-order hints in English / Hindi / Hinglish.
- Everyday operational Q&A on the factory floor.

Style:
- Reply in the SAME language / script the user used (English, Hindi, or Hinglish written in Roman script).
- Be brief and action-oriented. Bullet points for lists. Use bold for numbers / party names.
- Use Indian number formatting (1,23,456) and the ₹ symbol for currency.
- If you don't know a factual answer (e.g., real-time DB data you weren't given), say so and suggest which page in the app to open (Orders, Dispatch Center, Customer Ledger, Vendor Ledger, Products, etc.).
- Never fabricate order/slip/GR numbers. Never claim to have queried the DB unless the user has explicitly pasted data.

Keep replies short — usually under 6 lines — unless the user asks for depth."""


async def _get_or_create_session(db, session_id: Optional[str], user_id: str) -> Dict[str, Any]:
    """Return an existing session doc or create a new one. Idempotent."""
    if session_id:
        doc = await db.ai_chat_sessions.find_one(
            {"id": session_id, "user_id": user_id}, {"_id": 0}
        )
        if doc:
            return doc
    sid = session_id or str(uuid.uuid4())
    doc = {
        "id": sid,
        "user_id": user_id,
        "title": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ai_chat_sessions.insert_one(dict(doc))
    return doc


async def _load_history(db, session_id: str, limit: int = 40) -> List[Dict[str, Any]]:
    """Load last N messages for the session, oldest first."""
    cur = (
        db.ai_chat_messages.find(
            {"session_id": session_id}, {"_id": 0}
        )
        .sort("created_at", 1)
        .limit(limit)
    )
    return await cur.to_list(length=limit)


async def _save_message(
    db,
    session_id: str,
    role: str,
    content: str,
) -> Dict[str, Any]:
    doc = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "role": role,
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ai_chat_messages.insert_one(dict(doc))
    await db.ai_chat_sessions.update_one(
        {"id": session_id},
        {"$set": {"updated_at": doc["created_at"]}},
    )
    return doc


def _build_chat(session_id: str, history: List[Dict[str, Any]]) -> LlmChat:
    """Instantiate a fresh LlmChat and seed it with prior messages so the
    model has context. LlmChat maintains its own in-memory history for
    subsequent turns during this request."""
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=api_key,
        session_id=session_id,
        system_message=CHAT_SYSTEM_PROMPT,
    ).with_model(CHAT_PROVIDER, CHAT_MODEL)
    # Note: LlmChat doesn't expose a public "seed history" API. We rely
    # on our own DB history + fresh instances per HTTP request. To give
    # the model context of past turns, we prepend the last few Q/A into
    # the user's next message when the client asks. Simpler & robust.
    return chat


def _format_context(history: List[Dict[str, Any]], max_turns: int = 8) -> str:
    """Take the last N turns and format them as a compact context block
    the model receives inside the user message."""
    tail = history[-(max_turns * 2):] if history else []
    if not tail:
        return ""
    lines = ["Previous conversation:"]
    for m in tail:
        role = "User" if m["role"] == "user" else "Assistant"
        content = (m.get("content") or "").strip()
        if not content:
            continue
        # Keep each turn compact
        if len(content) > 600:
            content = content[:600] + "…"
        lines.append(f"{role}: {content}")
    lines.append("")
    return "\n".join(lines)


async def chat_stream(
    db,
    user: Dict[str, Any],
    session_id: Optional[str],
    user_text: str,
) -> AsyncIterator[Dict[str, Any]]:
    """Async generator that yields SSE-friendly dicts:
        {"type": "session", "session_id": ...}
        {"type": "delta", "text": "..."}
        {"type": "done", "assistant_message_id": ...}
        {"type": "error", "message": "..."}

    Persists both the user question and the assistant's final answer.
    """
    if not user_text or not user_text.strip():
        yield {"type": "error", "message": "Message is empty"}
        return

    user_id = str(user.get("id") or user.get("email") or "anon")
    try:
        sess = await _get_or_create_session(db, session_id, user_id)
    except Exception as e:
        logger.exception("Failed to open chat session")
        yield {"type": "error", "message": f"Session error: {e}"}
        return

    session_id = sess["id"]
    yield {"type": "session", "session_id": session_id, "title": sess.get("title")}

    # Persist the user message first so it survives a mid-stream disconnect
    await _save_message(db, session_id, "user", user_text.strip())

    # Auto-title the session on the very first user message
    if not sess.get("title"):
        title = user_text.strip().splitlines()[0][:60]
        await db.ai_chat_sessions.update_one(
            {"id": session_id}, {"$set": {"title": title}}
        )

    # Rebuild history (excluding the just-saved user message so we can
    # send it as the "current turn" instead of context)
    history = await _load_history(db, session_id, limit=40)
    prior = history[:-1] if history and history[-1].get("role") == "user" else history

    try:
        chat = _build_chat(session_id, prior)
    except Exception as e:
        yield {"type": "error", "message": str(e)}
        return

    context = _format_context(prior)
    prompt = user_text.strip()
    if context:
        prompt = f"{context}\nUser: {prompt}"

    collected: List[str] = []
    try:
        async for event in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(event, TextDelta):
                collected.append(event.content)
                yield {"type": "delta", "text": event.content}
            elif isinstance(event, StreamDone):
                break
    except Exception as e:
        logger.exception("LLM stream failed")
        yield {"type": "error", "message": f"LLM error: {e}"}
        # Still persist whatever we managed to collect so history stays consistent
        if collected:
            msg = await _save_message(
                db, session_id, "assistant", "".join(collected)
            )
            yield {"type": "done", "assistant_message_id": msg["id"]}
        return

    final = "".join(collected).strip()
    if not final:
        yield {"type": "error", "message": "Empty response from model"}
        return
    msg = await _save_message(db, session_id, "assistant", final)
    yield {"type": "done", "assistant_message_id": msg["id"]}


async def list_sessions(db, user_id: str, limit: int = 30) -> List[Dict[str, Any]]:
    cur = (
        db.ai_chat_sessions.find({"user_id": user_id}, {"_id": 0})
        .sort("updated_at", -1)
        .limit(limit)
    )
    return await cur.to_list(length=limit)


async def get_session_messages(
    db, session_id: str, user_id: str
) -> List[Dict[str, Any]]:
    sess = await db.ai_chat_sessions.find_one(
        {"id": session_id, "user_id": user_id}, {"_id": 0}
    )
    if not sess:
        return []
    return await _load_history(db, session_id, limit=200)


async def delete_session(db, session_id: str, user_id: str) -> None:
    await db.ai_chat_sessions.delete_one({"id": session_id, "user_id": user_id})
    await db.ai_chat_messages.delete_many({"session_id": session_id})


# ==================================================================
# On-demand summaries (feature C)
# ==================================================================
LEDGER_SUMMARY_SYSTEM = """You are the JK Products factory floor assistant.

The user has just opened a party's ledger. Given a compact JSON of the
ledger (opening/closing balance, period totals, and per-row transactions),
write a SHORT natural-language summary suitable to read at a glance on
the shop floor.

Structure (max 6 bullets total):
- One-line headline: e.g. "Party is ₹X Dr as of {end_date}."
- Money flow: total dispatched vs total received in the period.
- Notable activity: largest 1–2 dispatches / payments (date + amount).
- Trend / concern: growing debit, long silent stretch, or "all clean".
- Suggested action (only if warranted): "collect ₹X — overdue since …",
  "confirm bill amount", etc. Do NOT invent facts.

Style:
- Use ₹ and Indian number formatting.
- Reply in the language the user's app is in (default English).
- Never invent slip numbers, dates or amounts — quote what's in the JSON.
- Keep it under ~100 words."""


DISPATCH_SUMMARY_SYSTEM = """You are the JK Products factory floor assistant.

The user has opened the Dispatch Report page. Given a compact JSON of
today's / the period's dispatches (per-slip totals + optional
per-item breakdown), write a SHORT operational summary.

Structure (max 6 bullets total):
- Headline: total slips + total pcs + total bill amount for the period.
- Top parties by amount (top 2–3, one line each).
- Any anomalies: parties with unusually large amounts, missing bag counts,
  missing private marks, GR numbers not filled.
- Suggested next actions.

Style rules — same as ledger summary."""


async def _summarize(system_prompt: str, payload: Dict[str, Any]) -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=api_key,
        session_id=f"summary-{uuid.uuid4()}",
        system_message=system_prompt,
    ).with_model(CHAT_PROVIDER, SUMMARY_MODEL)
    text = f"Data (JSON):\n```json\n{json.dumps(payload, ensure_ascii=False, default=str)[:8000]}\n```\n\nSummarize now."
    reply = await chat.send_message(UserMessage(text=text))
    raw = reply if isinstance(reply, str) else getattr(reply, "content", str(reply))
    return (raw or "").strip()


async def summarize_ledger(payload: Dict[str, Any]) -> str:
    return await _summarize(LEDGER_SUMMARY_SYSTEM, payload)


async def summarize_dispatch(payload: Dict[str, Any]) -> str:
    return await _summarize(DISPATCH_SUMMARY_SYSTEM, payload)


# ==================================================================
# Tool-calling agent — plan → confirm-if-write → execute → respond
# ==================================================================
import ai_tools as _tools

# In-memory registry of pending write actions awaiting user confirmation.
# Keyed by action_id → {user_id, tool, args, created_at}
_PENDING: Dict[str, Dict[str, Any]] = {}


def _tool_specs_prompt() -> str:
    lines = ["Available tools:"]
    for s in _tools.TOOL_SPECS:
        write_flag = " [WRITE - needs confirmation]" if s.get("is_write") else ""
        lines.append(f"- {s['name']}{write_flag}: {s['description']}")
        for k, v in (s.get("args") or {}).items():
            lines.append(f"    · {k}: {v}")
    return "\n".join(lines)


PLANNER_SYSTEM = f"""You are the JK Products factory assistant's PLANNER.

Given a user message, decide whether to (a) call ONE of the available tools to fetch/change data in the system, or (b) reply directly (chit-chat, greetings, general Q&A).

{{tool_specs}}

Return STRICT JSON matching one of these shapes — no prose, no markdown, no code fences, JUST JSON:

  {{{{"action": "tool", "tool": "<tool_name>", "args": {{{{...}}}}}}}}

  {{{{"action": "reply", "text": "<direct reply to user in their language>"}}}}

Rules:
- Only pick a tool if the user is clearly asking for factory data or an operation. Otherwise use "reply".
- For write tools you STILL propose the tool call — the system will ask the user to confirm before executing.
- Numbers must be numbers (not strings). Missing optional args must be omitted.
- If the user's request is ambiguous (e.g. missing party name), pick a search tool first OR reply asking for clarification.
- Reply text should match the language / script the user used.
"""

RESPONDER_SYSTEM = """You are the JK Products factory assistant.

You will receive:
- The user's original question.
- The RESULT of a tool call executed on their behalf (JSON).
Compose a SHORT natural-language reply that presents the result clearly.

Rules:
- Reply in the same language / script the user used.
- Use ₹ + Indian number formatting for money.
- Bullet points or a compact table style for lists (max 8 rows shown).
- If the tool result has `ok: false`, empathically say what went wrong and how the user can fix it (e.g. try a different party name).
- Never invent data that isn't in the tool result.
- Keep it under ~120 words unless the user asked for detail."""


async def _planner(user_text: str, history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Ask the LLM to pick a tool or reply. Returns a parsed dict."""
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not configured")
    sys_prompt = PLANNER_SYSTEM.format(tool_specs=_tool_specs_prompt())
    chat = LlmChat(
        api_key=api_key,
        session_id=f"plan-{uuid.uuid4()}",
        system_message=sys_prompt,
    ).with_model(CHAT_PROVIDER, CHAT_MODEL)
    ctx = _format_context(history, max_turns=6)
    prompt = (f"{ctx}\n" if ctx else "") + f"User: {user_text.strip()}\n\nReturn JSON only."
    reply = await chat.send_message(UserMessage(text=prompt))
    raw = reply if isinstance(reply, str) else getattr(reply, "content", str(reply))
    raw = (raw or "").strip()
    # Strip ```json fences if the model added them anyway
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except Exception:
        # Fallback: treat as reply
        return {"action": "reply", "text": raw}


async def _responder_stream(
    user_text: str, tool_name: str, tool_result: Dict[str, Any]
) -> AsyncIterator[Any]:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=api_key,
        session_id=f"resp-{uuid.uuid4()}",
        system_message=RESPONDER_SYSTEM,
    ).with_model(CHAT_PROVIDER, SUMMARY_MODEL)
    prompt = (
        f"User asked: {user_text}\n\n"
        f"Tool: {tool_name}\n"
        f"Tool result (JSON):\n```json\n"
        f"{json.dumps(tool_result, ensure_ascii=False, default=str)[:6000]}\n```\n\n"
        "Reply now."
    )
    async for event in chat.stream_message(UserMessage(text=prompt)):
        yield event


async def agent_stream(
    db, user: Dict[str, Any], session_id: Optional[str], user_text: str,
    confirm_action_id: Optional[str] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Main agent loop with tool-calling. Yields SSE-ready dicts:
        {type: session, session_id}
        {type: reply_delta, text}          — direct chat reply tokens
        {type: tool_call, tool, args}      — informational
        {type: confirm, action_id, tool, args, intent}  — pause for confirm
        {type: tool_result, tool, result}  — after execution
        {type: reply_delta, text}          — natural-language responder
        {type: done, assistant_message_id}
        {type: error, message}
    """
    if not user_text or not user_text.strip():
        yield {"type": "error", "message": "Message is empty"}
        return

    user_id = str(user.get("id") or user.get("email") or "anon")
    try:
        sess = await _get_or_create_session(db, session_id, user_id)
    except Exception as e:
        logger.exception("Failed to open agent session")
        yield {"type": "error", "message": f"Session error: {e}"}
        return
    session_id = sess["id"]
    yield {"type": "session", "session_id": session_id, "title": sess.get("title")}

    # ---- Confirmation continuation? ----
    if confirm_action_id:
        pending = _PENDING.pop(confirm_action_id, None)
        if not pending or pending.get("user_id") != user_id:
            yield {"type": "error", "message":
                   "This action is no longer pending. Please try again."}
            return
        tool = pending["tool"]
        args = pending["args"] or {}
        # persist the user's confirmation message
        confirm_msg = user_text.strip() or f"Confirmed: {_tools.human_intent(tool, args)}"
        await _save_message(db, session_id, "user", confirm_msg)
        yield {"type": "tool_call", "tool": tool, "args": args}
        result = await _tools.execute_tool(db, tool, args, user=user)
        yield {"type": "tool_result", "tool": tool, "result": result}
        # Stream natural language reply
        collected: List[str] = []
        try:
            async for event in _responder_stream(confirm_msg, tool, result):
                if isinstance(event, TextDelta):
                    collected.append(event.content)
                    yield {"type": "reply_delta", "text": event.content}
                elif isinstance(event, StreamDone):
                    break
        except Exception as e:
            yield {"type": "error", "message": f"LLM error: {e}"}
        final = "".join(collected).strip() or (result.get("message") or "Done.")
        if not collected:
            yield {"type": "reply_delta", "text": final}
        msg = await _save_message(db, session_id, "assistant", final)
        yield {"type": "done", "assistant_message_id": msg["id"]}
        return

    # ---- Fresh user turn ----
    await _save_message(db, session_id, "user", user_text.strip())
    if not sess.get("title"):
        title = user_text.strip().splitlines()[0][:60]
        await db.ai_chat_sessions.update_one(
            {"id": session_id}, {"$set": {"title": title}}
        )
    history = await _load_history(db, session_id, limit=30)
    prior = history[:-1] if history and history[-1].get("role") == "user" else history

    try:
        plan = await _planner(user_text, prior)
    except Exception as e:
        logger.exception("Planner failed")
        yield {"type": "error", "message": f"Planner error: {e}"}
        return

    action = (plan or {}).get("action") or "reply"

    # ---- Direct chat reply path ----
    if action != "tool":
        reply = str(plan.get("text") or "").strip() or "…"
        # Stream it back token-ish (simulated) so the UI feels alive
        yield {"type": "reply_delta", "text": reply}
        msg = await _save_message(db, session_id, "assistant", reply)
        yield {"type": "done", "assistant_message_id": msg["id"]}
        return

    tool = plan.get("tool") or ""
    args = plan.get("args") or {}
    if tool not in _tools._TOOL_FUNCS:
        # Unknown tool → fall back to direct reply
        reply = f"I couldn't find a tool for that. Please rephrase, or ask me to search / list something."
        yield {"type": "reply_delta", "text": reply}
        msg = await _save_message(db, session_id, "assistant", reply)
        yield {"type": "done", "assistant_message_id": msg["id"]}
        return

    yield {"type": "tool_call", "tool": tool, "args": args}

    # ---- Write tool → require confirmation ----
    if _tools.is_write_tool(tool):
        action_id = str(uuid.uuid4())
        _PENDING[action_id] = {
            "user_id": user_id,
            "tool": tool,
            "args": args,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        intent = _tools.human_intent(tool, args)
        # Save an assistant message describing the pending action
        pending_note = f"⚙️  Ready to: {intent}. Please confirm."
        yield {"type": "confirm", "action_id": action_id,
               "tool": tool, "args": args, "intent": intent}
        yield {"type": "reply_delta", "text": pending_note}
        msg = await _save_message(db, session_id, "assistant", pending_note)
        yield {"type": "done", "assistant_message_id": msg["id"]}
        return

    # ---- Read tool → execute + stream nlg ----
    result = await _tools.execute_tool(db, tool, args, user=user)
    yield {"type": "tool_result", "tool": tool, "result": result}

    collected: List[str] = []
    try:
        async for event in _responder_stream(user_text, tool, result):
            if isinstance(event, TextDelta):
                collected.append(event.content)
                yield {"type": "reply_delta", "text": event.content}
            elif isinstance(event, StreamDone):
                break
    except Exception as e:
        yield {"type": "error", "message": f"LLM error: {e}"}

    final = "".join(collected).strip() or (result.get("message") or "Done.")
    if not collected:
        yield {"type": "reply_delta", "text": final}
    msg = await _save_message(db, session_id, "assistant", final)
    yield {"type": "done", "assistant_message_id": msg["id"]}


async def cancel_pending(action_id: str, user_id: str) -> bool:
    p = _PENDING.get(action_id)
    if not p or p.get("user_id") != user_id:
        return False
    _PENDING.pop(action_id, None)
    return True
