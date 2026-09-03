"""Daily Gmail backup + on-demand restore for the Factory Order Management
app.

Design:
  - Stores Gmail SMTP credentials and the daily schedule in the
    `app_backup_settings` MongoDB collection (single doc with `id="default"`).
  - `run_backup_now(db)` dumps every collection in the DB to JSON, zips
    them up in-memory and emails the archive as an attachment via Gmail
    SMTP over SSL (port 465).
  - `restore_from_zip(db, file_bytes)` wipes every collection in the DB
    (except `app_backup_settings`) and reloads it from the supplied ZIP.
  - APScheduler runs `run_backup_now` daily at the configured IST time.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import smtplib
import ssl
import zipfile
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz

logger = logging.getLogger("backup")

# Seeded factory defaults captured from the initial admin request. The user
# can change these any time from Admin Settings → Backup & Restore.
DEFAULT_BACKUP_SETTINGS = {
    "id": "default",
    "enabled": True,
    "gmail_user": os.environ.get("GMAIL_USER", ""),
    # Gmail App Password (16 chars, spaces removed). DO NOT log this value.
    "gmail_app_password": os.environ.get("GMAIL_APP_PASSWORD", ""),
    "send_to": os.environ.get("BACKUP_EMAIL_TO", os.environ.get("GMAIL_USER", "")),
    "schedule_hour": 21,   # 9 PM IST
    "schedule_minute": 0,
    "last_run_at": None,
    "last_run_status": None,   # "success" | "failed"
    "last_run_message": None,
    "last_run_size_bytes": None,
}

# Collections that must NEVER be wiped/overwritten on restore — these hold
# infra/credential state that should survive a data restore.
PROTECTED_COLLECTIONS = {"app_backup_settings"}

# Module-level scheduler handle (created on FastAPI startup).
_scheduler: Optional[AsyncIOScheduler] = None
_db_ref = None   # set by `init_scheduler`


# ------------------------------------------------------------ settings
async def get_settings(db) -> Dict[str, Any]:
    doc = await db.app_backup_settings.find_one({"id": "default"}, {"_id": 0})
    if not doc:
        doc = dict(DEFAULT_BACKUP_SETTINGS)
        await db.app_backup_settings.insert_one(dict(doc))
    # Never leak the password to callers that should not see it. The PATCH
    # endpoint returns the masked view; the actual send uses get_settings
    # internally so that's fine.
    return doc


def _mask(doc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(doc)
    pw = out.get("gmail_app_password") or ""
    if pw:
        out["gmail_app_password"] = "•" * 12 + pw[-4:] if len(pw) > 4 else "••••"
    out["gmail_app_password_set"] = bool(pw)
    return out


async def update_settings(db, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Patch a few fields on the backup settings doc. `gmail_app_password`
    is only overwritten when a non-empty value is supplied."""
    cur = await get_settings(db)
    allowed = {
        "enabled", "gmail_user", "send_to",
        "schedule_hour", "schedule_minute",
    }
    upd: Dict[str, Any] = {}
    for k, v in (patch or {}).items():
        if k in allowed and v is not None:
            upd[k] = v
        elif k == "gmail_app_password" and v:
            # strip any spaces the user pasted from the Google UI
            upd[k] = str(v).replace(" ", "").strip()
    if upd:
        await db.app_backup_settings.update_one(
            {"id": "default"}, {"$set": upd}, upsert=True,
        )
        cur.update(upd)
    # Reschedule if cadence changed
    if any(k in upd for k in ("schedule_hour", "schedule_minute", "enabled")):
        try:
            await _reschedule_from_settings(db)
        except Exception as e:
            logger.warning("Failed to reschedule backup job: %s", e)
    return _mask(cur)


# ------------------------------------------------------------ dump & restore
async def _dump_all_collections(db) -> bytes:
    """Serialise every collection (except protected ones) into a single
    ZIP whose entries are <collection>.json files. Returns the ZIP bytes."""
    collections = await db.list_collection_names()
    buf = io.BytesIO()
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "db_name": db.name,
        "collections": {},
    }
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(collections):
            if name in PROTECTED_COLLECTIONS:
                continue
            docs = await db[name].find({}, {"_id": 0}).to_list(length=10_000_000)
            payload = json.dumps(docs, default=str, ensure_ascii=False)
            zf.writestr(f"{name}.json", payload)
            manifest["collections"][name] = len(docs)
        zf.writestr("__manifest__.json", json.dumps(manifest, indent=2))
    return buf.getvalue()


async def restore_from_zip(db, file_bytes: bytes) -> Dict[str, Any]:
    """Wipe + reload every non-protected collection from the supplied ZIP."""
    buf = io.BytesIO(file_bytes)
    try:
        zf = zipfile.ZipFile(buf, "r")
    except zipfile.BadZipFile:
        raise ValueError("Uploaded file is not a valid backup ZIP")

    names = [n for n in zf.namelist() if n.endswith(".json") and n != "__manifest__.json"]
    if not names:
        raise ValueError("Backup ZIP contains no collection files")

    # Sanity check — our own backups always include a manifest. If it's
    # missing, the user is probably uploading a third-party ZIP (e.g. an
    # mongodump archive, or an Excel/Office file, which is also a ZIP).
    if "__manifest__.json" not in zf.namelist():
        logger.warning(
            "Backup ZIP missing __manifest__.json — accepting anyway, but "
            "this may not be a backup produced by this app."
        )

    def _decode(blob: bytes, entry_name: str) -> str:
        """Decode a JSON entry tolerantly: try UTF-8 (with BOM), then fall
        back to UTF-8 with replacement. Raise a clear error rather than a
        cryptic codec message if all strategies fail."""
        # Strip UTF-8 BOM if present
        if blob.startswith(b"\xef\xbb\xbf"):
            blob = blob[3:]
        try:
            return blob.decode("utf-8")
        except UnicodeDecodeError:
            pass
        try:
            return blob.decode("utf-8-sig")
        except UnicodeDecodeError:
            pass
        # Last-resort: lossy decode so json.loads has a chance and we can
        # raise a *useful* error pointing at the entry that's broken.
        return blob.decode("utf-8", errors="replace")

    summary: Dict[str, int] = {}
    for entry in names:
        coll_name = entry[:-5]   # strip .json
        if coll_name in PROTECTED_COLLECTIONS:
            continue
        try:
            raw = _decode(zf.read(entry), entry)
        except Exception as e:
            raise ValueError(
                f"Could not read '{entry}' from the uploaded ZIP — the file "
                f"does not look like a backup produced by this app ({e})."
            )
        try:
            docs = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in '{entry}' — please make sure you uploaded "
                f"a backup ZIP emailed by this app, not a different file "
                f"that happens to have the same extension. ({e})"
            )
        if not isinstance(docs, list):
            raise ValueError(f"Expected a list of documents in '{entry}'")
        # Wipe + reload
        await db[coll_name].delete_many({})
        if docs:
            # Drop any leftover _id fields (we already excluded them on dump
            # but be defensive in case of older backups).
            for d in docs:
                if isinstance(d, dict):
                    d.pop("_id", None)
            await db[coll_name].insert_many(docs)
        summary[coll_name] = len(docs)
    return {"restored": summary, "total_collections": len(summary)}


# ------------------------------------------------------------ email
def _send_via_gmail(settings: Dict[str, Any], attachment: bytes, filename: str) -> None:
    """Synchronous SMTP send. Called from a worker thread to avoid blocking
    the event loop."""
    user = settings.get("gmail_user") or ""
    pw = settings.get("gmail_app_password") or ""
    to = settings.get("send_to") or user
    if not user or not pw:
        raise RuntimeError("Gmail credentials are not configured")

    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to
    msg["Subject"] = f"JK Products Backup — {datetime.now().strftime('%d-%b-%Y %H:%M')}"
    msg.set_content(
        "Automated daily backup of the JK Products Factory Order Management "
        "database is attached as a ZIP archive.\n\n"
        "To restore, sign in as admin → Settings → Backup & Restore → "
        "Upload backup file."
    )
    msg.add_attachment(
        attachment,
        maintype="application",
        subtype="zip",
        filename=filename,
    )

    ctx = ssl.create_default_context()
    # Gmail SMTP-over-SSL on 465 is the most reliable from background jobs.
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60, context=ctx) as s:
        s.login(user, pw)
        s.send_message(msg)


def _send_otp_via_gmail(settings: Dict[str, Any], code: str, to: Optional[str] = None) -> str:
    """Synchronous SMTP send of a one-time login code. Reuses the same
    Gmail SMTP credentials configured for daily backups. Returns the
    recipient address it sent to. Raises on failure."""
    user = settings.get("gmail_user") or ""
    pw = settings.get("gmail_app_password") or ""
    to_addr = to or settings.get("send_to") or user
    if not user or not pw:
        raise RuntimeError("Gmail credentials are not configured")
    if not to_addr:
        raise RuntimeError("No recipient email configured for OTP")

    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to_addr
    msg["Subject"] = f"JK Products — Your admin login code: {code}"
    msg.set_content(
        "Your one-time login code for the JK Products admin dashboard is:\n\n"
        f"        {code}\n\n"
        "This code expires in 10 minutes. If you did not try to sign in, "
        "you can safely ignore this email."
    )
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60, context=ctx) as s:
        s.login(user, pw)
        s.send_message(msg)
    return to_addr


async def send_otp_email(db, code: str, to: Optional[str] = None) -> str:
    """Async wrapper: look up the Gmail backup settings and email the OTP
    on a worker thread. Returns the recipient address."""
    settings = await get_settings(db)
    return await asyncio.to_thread(_send_otp_via_gmail, settings, code, to)


async def run_backup_now(db) -> Dict[str, Any]:
    """Build the backup ZIP and email it. Records the result on the
    settings doc. Returns a small status dict for the API."""
    settings = await get_settings(db)
    started = datetime.now(timezone.utc)
    try:
        blob = await _dump_all_collections(db)
        filename = f"jk-backup-{started.strftime('%Y%m%d-%H%M%S')}.zip"
        await asyncio.to_thread(_send_via_gmail, settings, blob, filename)
        status = {
            "last_run_at": started.isoformat(),
            "last_run_status": "success",
            "last_run_message": f"Sent to {settings.get('send_to')}",
            "last_run_size_bytes": len(blob),
        }
        logger.info("Backup OK (%s bytes) → %s", len(blob), settings.get("send_to"))
    except Exception as e:
        logger.exception("Backup failed: %s", e)
        status = {
            "last_run_at": started.isoformat(),
            "last_run_status": "failed",
            "last_run_message": str(e)[:500],
            "last_run_size_bytes": None,
        }
    await db.app_backup_settings.update_one(
        {"id": "default"}, {"$set": status}, upsert=True,
    )
    return status


# ------------------------------------------------------------ scheduler
async def _job():
    """Cron-fired wrapper around `run_backup_now`."""
    if _db_ref is None:
        return
    settings = await get_settings(_db_ref)
    if not settings.get("enabled", True):
        logger.info("Backup job skipped — disabled in settings")
        return
    await run_backup_now(_db_ref)


async def _reschedule_from_settings(db) -> None:
    global _scheduler
    if _scheduler is None:
        return
    settings = await get_settings(db)
    # Remove any existing job so we replace cleanly
    try:
        _scheduler.remove_job("daily_backup")
    except Exception:
        pass
    if not settings.get("enabled", True):
        return
    hour = int(settings.get("schedule_hour", 21))
    minute = int(settings.get("schedule_minute", 0))
    tz = pytz.timezone("Asia/Kolkata")
    _scheduler.add_job(
        _job,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        id="daily_backup",
        replace_existing=True,
        misfire_grace_time=3600,   # if app was down, still run within an hour
    )
    logger.info("Daily backup scheduled at %02d:%02d IST", hour, minute)


async def init_scheduler(db) -> None:
    """Start the APScheduler on FastAPI app startup."""
    global _scheduler, _db_ref
    _db_ref = db
    # Ensure settings doc exists so the UI has something to render even on
    # a fresh install.
    await get_settings(db)
    if _scheduler is None:
        _scheduler = AsyncIOScheduler()
        _scheduler.start()
    await _reschedule_from_settings(db)


async def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
