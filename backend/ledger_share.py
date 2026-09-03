"""Ledger share utilities — render ledger PDF and deliver via
Gmail SMTP or Meta WhatsApp Cloud API.

Reuses the Gmail credentials already configured for the backup feature
(see backup.py → `app_backup_settings`). WhatsApp uses Cloud API v21
with env vars META_WHATSAPP_TOKEN, META_PHONE_NUMBER_ID, META_GRAPH_VERSION.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from typing import Any, Dict, List, Optional

import requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

logger = logging.getLogger("ledger_share")

GRAPH_VERSION = os.environ.get("META_GRAPH_VERSION", "v21.0")


# ---------------------------------------------------------- font setup
# reportlab's default Helvetica does NOT include the Rupee sign (U+20B9).
# DejaVu Sans (installed via `fonts-dejavu-core`) does. Register it as
# our default so ₹ renders correctly in emailed / WhatsApp'd PDFs.
_DEJAVU_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
_DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
_DEJAVU_OBL = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"
_DEJAVU_BOLDOBL = "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"

DEFAULT_FONT = "Helvetica"
DEFAULT_FONT_BOLD = "Helvetica-Bold"

try:
    if os.path.exists(_DEJAVU_REG):
        pdfmetrics.registerFont(TTFont("DejaVuSans", _DEJAVU_REG))
    if os.path.exists(_DEJAVU_BOLD):
        pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", _DEJAVU_BOLD))
    # DejaVu ships italics on some distros but not all — fall back to
    # bold/regular for italic/bolditalic if the file isn't there.
    if os.path.exists(_DEJAVU_OBL):
        pdfmetrics.registerFont(TTFont("DejaVuSans-Oblique", _DEJAVU_OBL))
    if os.path.exists(_DEJAVU_BOLDOBL):
        pdfmetrics.registerFont(TTFont("DejaVuSans-BoldOblique", _DEJAVU_BOLDOBL))
    if os.path.exists(_DEJAVU_REG) and os.path.exists(_DEJAVU_BOLD):
        registerFontFamily(
            "DejaVuSans",
            normal="DejaVuSans",
            bold="DejaVuSans-Bold",
            italic=(
                "DejaVuSans-Oblique"
                if os.path.exists(_DEJAVU_OBL)
                else "DejaVuSans"
            ),
            boldItalic=(
                "DejaVuSans-BoldOblique"
                if os.path.exists(_DEJAVU_BOLDOBL)
                else "DejaVuSans-Bold"
            ),
        )
        DEFAULT_FONT = "DejaVuSans"
        DEFAULT_FONT_BOLD = "DejaVuSans-Bold"
        logger.info("Registered DejaVuSans for PDF (₹ supported)")
except Exception as e:
    logger.warning("Failed to register DejaVuSans, falling back to Helvetica: %s", e)


# ---------------------------------------------------------- formatting
def _fmt_num(v: Any) -> str:
    try:
        n = float(v or 0)
    except Exception:
        return str(v or "")
    # Indian number formatting: 1,23,456.78
    negative = n < 0
    n = abs(n)
    int_part = int(n)
    frac_part = round(n - int_part, 2)
    s = str(int_part)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head_grp: List[str] = []
        while len(head) > 2:
            head_grp.insert(0, head[-2:])
            head = head[:-2]
        if head:
            head_grp.insert(0, head)
        s = ",".join(head_grp) + "," + tail
    if frac_part:
        s += f"{frac_part:.2f}"[1:]  # keeps ".xx"
    return f"-{s}" if negative else s


def _fmt_date(iso: Any) -> str:
    if not iso:
        return "—"
    try:
        s = str(iso)
        # Try parse ISO and reformat as dd/mm/YYYY
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.strftime("%d/%m/%Y")
        except Exception:
            pass
        # If it's a bare YYYY-MM-DD
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return f"{s[8:10]}/{s[5:7]}/{s[0:4]}"
        return s
    except Exception:
        return str(iso)


def _dr_cr(v: Any) -> str:
    try:
        return "Dr" if float(v or 0) >= 0 else "Cr"
    except Exception:
        return ""


# ---------------------------------------------------------- PDF renderer
def render_ledger_pdf(payload: Dict[str, Any]) -> bytes:
    """Build a print-friendly PDF from the ledger payload the frontend
    passes to LedgerPrintDialog. Returns raw PDF bytes.

    payload keys:
      title (str), party (dict|None), period (dict|None),
      opening (num), closing (num), total_debit (num), total_credit (num),
      rows (list of dict), pcs_total (num|None)
    """
    title = str(payload.get("title") or "Ledger")
    party = payload.get("party") or {}
    period = payload.get("period") or {}
    opening = payload.get("opening") or 0
    closing = payload.get("closing") or 0
    total_debit = payload.get("total_debit") or 0
    total_credit = payload.get("total_credit") or 0
    rows: List[Dict[str, Any]] = payload.get("rows") or []
    pcs_total = payload.get("pcs_total")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=title,
    )

    styles = getSampleStyleSheet()
    # Override base fonts so inherited ParagraphStyles use DejaVu (₹ support)
    for _n in ("Normal", "Heading1", "Heading2", "Heading3", "BodyText", "Italic"):
        if _n in styles.byName:
            styles[_n].fontName = DEFAULT_FONT
    h_title = ParagraphStyle(
        "h_title",
        parent=styles["Heading1"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=16,
        leading=20,
        textColor=colors.HexColor("#0f172a"),
        alignment=2,  # right
    )
    h_meta = ParagraphStyle(
        "h_meta",
        parent=styles["Normal"],
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#334155"),
        alignment=2,
    )
    lbl = ParagraphStyle(
        "lbl",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=7,
        leading=9,
        textColor=colors.HexColor("#475569"),
    )
    lblv = ParagraphStyle(
        "lblv",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=10,
        leading=12,
        textColor=colors.HexColor("#0f172a"),
    )
    tbl_head = ParagraphStyle(
        "tbl_head",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=7.5,
        leading=10,
        textColor=colors.HexColor("#334155"),
    )
    tbl_cell = ParagraphStyle(
        "tbl_cell",
        parent=styles["Normal"],
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#0f172a"),
    )
    tbl_note = ParagraphStyle(
        "tbl_note",
        parent=styles["Normal"],
        fontSize=7,
        leading=9,
        textColor=colors.HexColor("#64748b"),
    )

    story: List[Any] = []

    # ---- Header (title + period) ----
    period_str = ""
    if period and (period.get("startDate") or period.get("endDate")):
        period_str = (
            f"Period: <b>{_fmt_date(period.get('startDate'))} → "
            f"{_fmt_date(period.get('endDate'))}</b>"
        )
    printed_str = f"Printed: {_fmt_date(datetime.utcnow().isoformat())}"
    header_tbl = Table(
        [[
            "",
            [
                Paragraph(title, h_title),
                Paragraph(period_str, h_meta) if period_str else Spacer(1, 1),
                Paragraph(printed_str, h_meta),
            ],
        ]],
        colWidths=["*", 90 * mm],
    )
    header_tbl.setStyle(
        TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 1.4, colors.HexColor("#0f172a")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ])
    )
    story.append(header_tbl)
    story.append(Spacer(1, 6))

    # ---- Party card ----
    if party:
        lines = [Paragraph("ACCOUNT OF", lbl), Paragraph(str(party.get("name") or "—"), lblv)]
        sub = []
        if party.get("phone"):
            sub.append(f"Phone: {party.get('phone')}")
        addr = ", ".join(
            [x for x in [party.get("city"), party.get("location"), party.get("address")] if x]
        )
        if addr:
            sub.append(addr)
        if party.get("gst_number"):
            sub.append(f"GST: {party.get('gst_number')}")
        if party.get("material_category"):
            sub.append(f"Category: {party.get('material_category')}")
        if sub:
            lines.append(
                Paragraph(
                    " · ".join(sub),
                    ParagraphStyle(
                        "party_sub",
                        parent=styles["Normal"],
                        fontSize=8,
                        leading=10,
                        textColor=colors.HexColor("#475569"),
                    ),
                )
            )
        party_tbl = Table([[lines]], colWidths=["*"])
        party_tbl.setStyle(
            TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ])
        )
        story.append(party_tbl)
        story.append(Spacer(1, 8))

    # ---- Summary boxes ----
    def _box(label: str, value: str):
        return Table(
            [[Paragraph(label, lbl)], [Paragraph(value, lblv)]],
            colWidths=[40 * mm],
        )

    summary_row = [
        _box("OPENING", f"₹{_fmt_num(opening)} {_dr_cr(opening)}"),
        _box("TOTAL DEBIT", f"₹{_fmt_num(total_debit)}"),
        _box("TOTAL CREDIT", f"₹{_fmt_num(total_credit)}"),
        _box("CLOSING", f"₹{_fmt_num(closing)} {_dr_cr(closing)}"),
    ]
    sum_tbl = Table([summary_row], colWidths=["*"] * 4)
    sum_tbl.setStyle(
        TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ])
    )
    story.append(sum_tbl)
    story.append(Spacer(1, 8))

    # ---- Transaction table ----
    data: List[List[Any]] = [[
        Paragraph("DATE", tbl_head),
        Paragraph("PARTICULARS", tbl_head),
        Paragraph("REFERENCE", tbl_head),
        Paragraph("DEBIT ₹", tbl_head),
        Paragraph("CREDIT ₹", tbl_head),
        Paragraph("BALANCE ₹", tbl_head),
    ]]

    # Opening row
    data.append([
        Paragraph("—", tbl_cell),
        Paragraph("<i>Opening balance</i>", tbl_cell),
        "",
        "",
        "",
        Paragraph(
            f"<b>{_fmt_num(opening)} {_dr_cr(opening)}</b>",
            tbl_cell,
        ),
    ])

    if not rows:
        data.append([
            Paragraph(
                "<i>No transactions in this period.</i>", tbl_cell
            ),
            "",
            "",
            "",
            "",
            "",
        ])
    else:
        for r in rows:
            particulars = str(r.get("particulars") or "—")
            notes = r.get("notes")
            part_cell = [Paragraph(particulars, tbl_cell)]
            if notes:
                part_cell.append(Paragraph(f"<i>{notes}</i>", tbl_note))
            debit = r.get("debit") or 0
            credit = r.get("credit") or 0
            balance = r.get("balance") or 0
            data.append([
                Paragraph(_fmt_date(r.get("when")), tbl_cell),
                part_cell,
                Paragraph(str(r.get("reference") or "—"), tbl_note),
                Paragraph(
                    _fmt_num(debit) if float(debit or 0) > 0 else "—",
                    tbl_cell,
                ),
                Paragraph(
                    _fmt_num(credit) if float(credit or 0) > 0 else "—",
                    tbl_cell,
                ),
                Paragraph(
                    f"<b>{_fmt_num(balance)} {_dr_cr(balance)}</b>",
                    tbl_cell,
                ),
            ])

    # Footer totals row
    data.append([
        Paragraph("<b>Period totals</b>", tbl_head),
        "",
        "",
        Paragraph(f"<b>₹{_fmt_num(total_debit)}</b>", tbl_cell),
        Paragraph(f"<b>₹{_fmt_num(total_credit)}</b>", tbl_cell),
        Paragraph(
            f"<b>₹{_fmt_num(closing)} {_dr_cr(closing)}</b>", tbl_cell
        ),
    ])

    col_widths = [22 * mm, "*", 28 * mm, 22 * mm, 22 * mm, 30 * mm]
    txn_tbl = Table(data, colWidths=col_widths, repeatRows=1)
    tbl_style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#64748b")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ALIGN", (3, 0), (5, -1), "RIGHT"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ("ALIGN", (0, -1), (2, -1), "RIGHT"),
        ("SPAN", (0, -1), (2, -1)),
    ]
    # Handle "no rows" spanning
    if not rows:
        tbl_style_cmds.append(("SPAN", (0, 2), (-1, 2)))
        tbl_style_cmds.append(("ALIGN", (0, 2), (-1, 2), "CENTER"))
    txn_tbl.setStyle(TableStyle(tbl_style_cmds))
    story.append(txn_tbl)

    if pcs_total is not None:
        story.append(Spacer(1, 6))
        story.append(
            Paragraph(
                f"Total pieces dispatched: <b>{pcs_total}</b>",
                ParagraphStyle(
                    "pcs",
                    parent=styles["Normal"],
                    fontSize=9,
                    leading=11,
                    textColor=colors.HexColor("#334155"),
                ),
            )
        )

    # ---- Signatures ----
    story.append(Spacer(1, 24))
    sig_tbl = Table(
        [[
            Paragraph(
                "____________________<br/>Authorised signature",
                ParagraphStyle(
                    "sig",
                    parent=styles["Normal"],
                    fontSize=9,
                    leading=12,
                    alignment=1,
                    textColor=colors.HexColor("#334155"),
                ),
            ),
            Paragraph(
                "____________________<br/>Receiver signature",
                ParagraphStyle(
                    "sig2",
                    parent=styles["Normal"],
                    fontSize=9,
                    leading=12,
                    alignment=1,
                    textColor=colors.HexColor("#334155"),
                ),
            ),
        ]],
        colWidths=["*", "*"],
    )
    sig_tbl.setStyle(
        TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
        ])
    )
    story.append(sig_tbl)

    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------- Email
def _send_pdf_via_gmail(
    settings: Dict[str, Any],
    to_email: str,
    pdf_bytes: bytes,
    filename: str,
    subject: str,
    body_text: str,
) -> None:
    """Blocking SMTP send using the same Gmail credentials the backup
    feature uses. Runs in a worker thread — see share_ledger_email()."""
    user = settings.get("gmail_user") or ""
    pw = settings.get("gmail_app_password") or ""
    if not user or not pw:
        raise RuntimeError(
            "Gmail credentials are not configured. Ask an admin to fill "
            "them in Admin Settings → Backup & Restore first."
        )
    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body_text)
    msg.add_attachment(
        pdf_bytes,
        maintype="application",
        subtype="pdf",
        filename=filename,
    )
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60, context=ctx) as s:
        s.login(user, pw)
        s.send_message(msg)


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


async def share_ledger_email(
    db,
    payload: Dict[str, Any],
    recipient_email: str,
) -> Dict[str, Any]:
    """Render the ledger PDF and email it to `recipient_email` using the
    Gmail credentials stored on the backup settings doc."""
    if not recipient_email or not _EMAIL_RE.match(recipient_email.strip()):
        raise ValueError("Please enter a valid email address")
    settings = await db.app_backup_settings.find_one(
        {"id": "default"}, {"_id": 0}
    )
    if not settings or not settings.get("gmail_user") or not settings.get(
        "gmail_app_password"
    ):
        raise RuntimeError(
            "Gmail credentials are not configured. Ask an admin to fill "
            "them in Admin Settings → Backup & Restore first."
        )

    pdf_bytes = render_ledger_pdf(payload)
    party_name = (payload.get("party") or {}).get("name") or "ledger"
    safe_party = re.sub(r"[^A-Za-z0-9_-]+", "-", party_name).strip("-") or "ledger"
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"{safe_party}-ledger-{stamp}.pdf"

    title = payload.get("title") or "Ledger"
    period = payload.get("period") or {}
    period_str = ""
    if period.get("startDate") or period.get("endDate"):
        period_str = (
            f" ({_fmt_date(period.get('startDate'))} → "
            f"{_fmt_date(period.get('endDate'))})"
        )
    subject = f"{title} — {party_name}{period_str}"
    body = (
        f"Hi,\n\nPlease find attached the {title.lower()} for "
        f"{party_name}{period_str}.\n\n"
        f"— JK Products · Factory Order Management"
    )

    await asyncio.to_thread(
        _send_pdf_via_gmail,
        settings,
        recipient_email.strip(),
        pdf_bytes,
        filename,
        subject,
        body,
    )
    return {
        "ok": True,
        "sent_to": recipient_email.strip(),
        "filename": filename,
        "size_bytes": len(pdf_bytes),
    }


# ---------------------------------------------------------- WhatsApp
_PHONE_RE = re.compile(r"[^0-9]+")


def _normalize_phone(phone: str) -> str:
    """Meta expects an E.164-ish number WITHOUT the leading '+'.
    Accepts inputs like '+91 97800 00592', '9780000592', '919780000592'."""
    if not phone:
        raise ValueError("Phone number is required")
    digits = _PHONE_RE.sub("", str(phone))
    if not digits:
        raise ValueError("Please enter a valid phone number")
    # If user typed a 10-digit Indian mobile, prepend country code 91
    if len(digits) == 10:
        digits = "91" + digits
    if len(digits) < 10 or len(digits) > 15:
        raise ValueError("Phone number looks invalid (10–15 digits with country code)")
    return digits


def _upload_pdf_to_meta(
    token: str,
    phone_number_id: str,
    pdf_bytes: bytes,
    filename: str,
) -> str:
    """Upload the PDF as a media object and return the media_id.
    Meta's media upload accepts multipart/form-data."""
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/media"
    files = {
        "file": (filename, pdf_bytes, "application/pdf"),
    }
    data = {
        "messaging_product": "whatsapp",
        "type": "application/pdf",
    }
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        files=files,
        data=data,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Meta media upload failed ({resp.status_code}): {resp.text[:400]}"
        )
    j = resp.json()
    media_id = j.get("id")
    if not media_id:
        raise RuntimeError(f"Meta did not return a media id: {j}")
    return media_id


def _send_whatsapp_document(
    token: str,
    phone_number_id: str,
    to_number: str,
    media_id: str,
    filename: str,
    caption: str,
) -> Dict[str, Any]:
    """Send the uploaded document. This will succeed only inside the
    24-hour customer service window unless a pre-approved template is
    used. For messaging outside the window, we first fire a template
    (`hello_world`) to open the session."""
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/messages"
    body = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_number,
        "type": "document",
        "document": {
            "id": media_id,
            "filename": filename,
            "caption": caption[:1024] if caption else "",
        },
    }
    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Meta send-document failed ({resp.status_code}): {resp.text[:400]}"
        )
    return resp.json()


def _send_whatsapp_template(
    token: str,
    phone_number_id: str,
    to_number: str,
    template_name: str = "hello_world",
    lang_code: str = "en_US",
) -> None:
    """Fire a pre-approved template to open the 24h session if needed."""
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/messages"
    body = {
        "messaging_product": "whatsapp",
        "to": to_number,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": lang_code},
        },
    }
    try:
        requests.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=30,
        )
    except Exception:
        # Best-effort — even if template fails we still try to send the
        # document. Some numbers already inside the 24h window won't
        # need this step at all.
        logger.warning("hello_world template send failed (non-fatal)")


async def share_ledger_whatsapp(
    payload: Dict[str, Any],
    recipient_phone: str,
) -> Dict[str, Any]:
    """Render the ledger PDF and deliver it via Meta WhatsApp Cloud API
    as a document message. Uses env vars META_WHATSAPP_TOKEN and
    META_PHONE_NUMBER_ID."""
    token = os.environ.get("META_WHATSAPP_TOKEN") or ""
    phone_number_id = os.environ.get("META_PHONE_NUMBER_ID") or ""
    if not token or not phone_number_id:
        raise RuntimeError(
            "WhatsApp is not configured. Ask an admin to fill "
            "META_WHATSAPP_TOKEN and META_PHONE_NUMBER_ID."
        )
    to_number = _normalize_phone(recipient_phone)
    pdf_bytes = render_ledger_pdf(payload)

    party_name = (payload.get("party") or {}).get("name") or "ledger"
    safe_party = re.sub(r"[^A-Za-z0-9_-]+", "-", party_name).strip("-") or "ledger"
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"{safe_party}-ledger-{stamp}.pdf"

    title = payload.get("title") or "Ledger"
    period = payload.get("period") or {}
    period_str = ""
    if period.get("startDate") or period.get("endDate"):
        period_str = (
            f" ({_fmt_date(period.get('startDate'))} → "
            f"{_fmt_date(period.get('endDate'))})"
        )
    caption = f"{title} — {party_name}{period_str}"

    # 1) Open 24h session (best-effort)
    await asyncio.to_thread(
        _send_whatsapp_template,
        token,
        phone_number_id,
        to_number,
    )
    # 2) Upload PDF to Meta media
    media_id = await asyncio.to_thread(
        _upload_pdf_to_meta,
        token,
        phone_number_id,
        pdf_bytes,
        filename,
    )
    # 3) Send document
    result = await asyncio.to_thread(
        _send_whatsapp_document,
        token,
        phone_number_id,
        to_number,
        media_id,
        filename,
        caption,
    )
    return {
        "ok": True,
        "sent_to": to_number,
        "filename": filename,
        "size_bytes": len(pdf_bytes),
        "media_id": media_id,
        "wa_response": result,
    }


# =====================================================================
# Dispatch Slip PDF + share helpers
# =====================================================================
def render_slip_pdf(payload: Dict[str, Any]) -> bytes:
    """Build a print-friendly PDF for a Dispatch Slip. Mirrors the
    HTML layout in DispatchLedger's Slip Preview Dialog.

    payload keys:
      slip_no, date, gr_number, party (dict), transport_name,
      dispatched_by, items (list), bill_amount, cash_amount,
      grand_total, total_pcs, gst, private_mark, bag_count, notes
    """
    slip_no = str(payload.get("slip_no") or "—")
    date = payload.get("date")
    gr_number = payload.get("gr_number") or ""
    party = payload.get("party") or {}
    # Ludhiana parties skip GR number, private mark, and no. of bags (local
    # pickup — no LR paperwork). Frontend already blanks these in the slip
    # preview and edit dialog; mirror that here so the PDF stays in sync.
    # Match on city / location / address because operators sometimes type
    # "LUDHIANA" into the address field instead of the city field.
    import re as _re
    _hay = " | ".join([
        str(party.get("city") or ""),
        str(party.get("location") or ""),
        str(party.get("address") or ""),
    ]).lower()
    _is_ludhiana = bool(_re.search(r"\bludhiana\b", _hay))
    if _is_ludhiana:
        gr_number = ""
    transport_name = payload.get("transport_name") or ""
    dispatched_by = payload.get("dispatched_by") or ""
    items: List[Dict[str, Any]] = payload.get("items") or []
    bill_amount = float(payload.get("bill_amount") or 0)
    cash_amount = float(payload.get("cash_amount") or 0)
    grand_total = float(payload.get("grand_total") or 0)
    total_pcs = payload.get("total_pcs") or 0
    gst = float(payload.get("gst") or 0)
    private_mark = payload.get("private_mark") or ""
    bag_count = payload.get("bag_count") or 0
    if _is_ludhiana:
        private_mark = ""
        bag_count = 0
    notes = payload.get("notes") or ""
    line_amount = float(payload.get("line_amount") or 0)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Dispatch Slip {slip_no}",
    )

    styles = getSampleStyleSheet()
    # Override base fonts so inherited ParagraphStyles use DejaVu (₹ support)
    for _n in ("Normal", "Heading1", "Heading2", "Heading3", "BodyText", "Italic"):
        if _n in styles.byName:
            styles[_n].fontName = DEFAULT_FONT
    s_title = ParagraphStyle(
        "s_title",
        parent=styles["Heading1"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=16,
        leading=20,
        textColor=colors.HexColor("#0f172a"),
    )
    s_sub = ParagraphStyle(
        "s_sub",
        parent=styles["Normal"],
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#64748b"),
    )
    s_meta_right = ParagraphStyle(
        "s_meta_right",
        parent=styles["Normal"],
        fontSize=9,
        leading=12,
        alignment=2,
        textColor=colors.HexColor("#334155"),
    )
    s_lbl = ParagraphStyle(
        "s_lbl",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=7,
        leading=9,
        textColor=colors.HexColor("#475569"),
    )
    s_lblv = ParagraphStyle(
        "s_lblv",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=11,
        leading=13,
        textColor=colors.HexColor("#0f172a"),
    )
    s_lblv_r = ParagraphStyle(
        "s_lblv_r",
        parent=s_lblv,
        alignment=2,
    )
    s_lbl_r = ParagraphStyle(
        "s_lbl_r",
        parent=s_lbl,
        alignment=2,
    )
    s_note = ParagraphStyle(
        "s_note",
        parent=styles["Normal"],
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#334155"),
    )
    tbl_head = ParagraphStyle(
        "tbl_head",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=7.5,
        leading=10,
        textColor=colors.HexColor("#334155"),
    )
    tbl_cell = ParagraphStyle(
        "tbl_cell",
        parent=styles["Normal"],
        fontSize=9,
        leading=11,
        textColor=colors.HexColor("#0f172a"),
    )
    tbl_desc = ParagraphStyle(
        "tbl_desc",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT_BOLD,
        fontSize=8.5,
        leading=10,
        textColor=colors.HexColor("#0f172a"),
    )

    story: List[Any] = []

    # ---- Header ----
    right_meta_lines = [f"<b>Slip #:</b> {slip_no}"]
    if date:
        right_meta_lines.append(f"<b>Date:</b> {_fmt_date(date)}")
    if gr_number:
        right_meta_lines.append(f"<b>GR No.:</b> {gr_number}")
    header_tbl = Table(
        [[
            [
                Paragraph("Dispatch Slip", s_title),
                Paragraph("Two-wheeler spare parts", s_sub),
            ],
            [Paragraph(l, s_meta_right) for l in right_meta_lines],
        ]],
        colWidths=["*", 80 * mm],
    )
    header_tbl.setStyle(
        TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 1.4, colors.HexColor("#0f172a")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ])
    )
    story.append(header_tbl)
    story.append(Spacer(1, 6))

    # ---- Party / Transport ----
    party_lines = [
        Paragraph("PARTY", s_lbl),
        Paragraph(str(party.get("name") or "—"), s_lblv),
    ]
    if party.get("phone"):
        party_lines.append(Paragraph(f"Phone: {party.get('phone')}", s_note))
    addr = ", ".join(
        [x for x in [party.get("city"), party.get("location")] if x]
    )
    if addr:
        party_lines.append(Paragraph(addr, s_note))
    if party.get("address"):
        party_lines.append(Paragraph(str(party.get("address")), s_note))

    transport_lines = [
        Paragraph("TRANSPORT", s_lbl_r),
        Paragraph(str(transport_name or "—"), s_lblv_r),
    ]
    if dispatched_by:
        transport_lines.append(
            Paragraph(
                f"Dispatched by · {dispatched_by}",
                ParagraphStyle("dp_by", parent=s_note, alignment=2),
            )
        )

    party_tbl = Table(
        [[party_lines, transport_lines]],
        colWidths=["*", "*"],
    )
    party_tbl.setStyle(
        TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ])
    )
    story.append(party_tbl)
    story.append(Spacer(1, 4))

    # ---- Items table ----
    data: List[List[Any]] = [[
        Paragraph("ITEM", tbl_head),
        Paragraph("QTY", tbl_head),
        Paragraph("NET ₹", tbl_head),
        Paragraph("TOTAL", tbl_head),
    ]]
    for it in items:
        qty = float(it.get("quantity") or 0)
        unit = float(it.get("unit_price") or 0)
        net = float(it.get("net_unit_price") or unit)
        line = float(it.get("line_value") or (net * qty))
        item_cell = [Paragraph(str(it.get("item_name") or "—"), tbl_desc)]
        if it.get("description"):
            item_cell.append(
                Paragraph(
                    str(it.get("description")).upper(),
                    ParagraphStyle(
                        "it_desc",
                        parent=tbl_cell,
                        fontName=DEFAULT_FONT_BOLD,
                        fontSize=8.5,
                        leading=10,
                    ),
                )
            )
        data.append([
            item_cell,
            Paragraph(f"<b>{_fmt_num(qty)}</b>", tbl_cell),
            Paragraph(f"<b>{_fmt_num(net)}</b>", tbl_cell),
            Paragraph(
                f'<font color="#E65100"><b>{_fmt_num(line)}</b></font>',
                tbl_cell,
            ),
        ])
    # Footer rows
    data.append([
        Paragraph("<b>Total amount</b>", tbl_head),
        "",
        "",
        Paragraph(f"<b>₹{_fmt_num(line_amount)}</b>", tbl_cell),
    ])
    data.append([
        Paragraph("<b>GST</b>", tbl_head),
        "",
        "",
        Paragraph(f"<b>₹{_fmt_num(gst)}</b>", tbl_cell),
    ])
    data.append([
        Paragraph("<b>Grand Total</b>", tbl_head),
        Paragraph(f"<b>{_fmt_num(total_pcs)}</b>", tbl_cell),
        "",
        Paragraph(
            f'<font color="#E65100" size="11"><b>₹{_fmt_num(grand_total)}/-</b></font>',
            tbl_cell,
        ),
    ])

    n_items = len(items)
    col_widths = ["*", 20 * mm, 24 * mm, 32 * mm]
    itbl = Table(data, colWidths=col_widths, repeatRows=1)
    row_style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ALIGN", (1, 0), (3, -1), "RIGHT"),
        # Grand total row highlight
        ("BACKGROUND", (0, 1 + n_items + 2), (-1, 1 + n_items + 2), colors.HexColor("#fff7ed")),
        ("LINEABOVE", (0, 1 + n_items + 2), (-1, 1 + n_items + 2), 1.2, colors.HexColor("#fdba74")),
        # Total amount / GST rows – span first 3 cols for the label
        ("SPAN", (0, 1 + n_items), (2, 1 + n_items)),
        ("SPAN", (0, 1 + n_items + 1), (2, 1 + n_items + 1)),
        ("BACKGROUND", (0, 1 + n_items), (-1, 1 + n_items + 1), colors.HexColor("#f8fafc")),
        ("ALIGN", (0, 1 + n_items), (2, 1 + n_items + 1), "LEFT"),
    ]
    itbl.setStyle(TableStyle(row_style_cmds))
    story.append(itbl)
    story.append(Spacer(1, 8))

    # ---- Bill/Cash and Private mark/Bags boxes ----
    # Hide the CASH AMOUNT row entirely when the bill amount already covers
    # the full GST-inclusive grand total (cash is 0 within a ±₹2 tolerance).
    _left_rows = [
        [Paragraph("BILL AMOUNT", s_lbl), Paragraph(f"<b>₹{_fmt_num(bill_amount)}/-</b>", s_lblv_r)],
    ]
    if float(cash_amount or 0) > 2:
        _left_rows.append(
            [Paragraph("CASH AMOUNT", s_lbl), Paragraph(f"<b>₹{_fmt_num(cash_amount)}/-</b>", s_lblv_r)]
        )
    left_box = Table(
        _left_rows,
        colWidths=[35 * mm, 35 * mm],
    )
    left_box.setStyle(
        TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#94a3b8")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ])
    )
    right_box = Table(
        [
            [Paragraph("PRIVATE MARK", s_lbl), Paragraph(f"<b>{private_mark or '—'}</b>", s_lblv_r)],
            [Paragraph("NO. OF BAGS", s_lbl), Paragraph(f"<b>{bag_count if bag_count else '—'}</b>", s_lblv_r)],
        ],
        colWidths=[35 * mm, 25 * mm],
    )
    right_box.setStyle(
        TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#94a3b8")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ])
    )
    if _is_ludhiana:
        # For Ludhiana parties the private-mark/bag-count box is omitted
        # entirely — the Bill/Cash box sits alone on this row.
        box_row = Table([[left_box, ""]], colWidths=[75 * mm, "*"])
    else:
        box_row = Table([[left_box, right_box]], colWidths=[75 * mm, "*"])
    box_row.setStyle(
        TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")])
    )
    story.append(box_row)

    if notes:
        story.append(Spacer(1, 6))
        story.append(
            Paragraph(
                f"<b>Notes:</b> <i>{notes}</i>",
                s_note,
            )
        )

    # ---- Signature ----
    story.append(Spacer(1, 24))
    story.append(
        Paragraph(
            "Customer signature: ____________________",
            ParagraphStyle(
                "sig_slip",
                parent=styles["Normal"],
                fontSize=9,
                leading=12,
                textColor=colors.HexColor("#334155"),
            ),
        )
    )

    doc.build(story)
    return buf.getvalue()


async def share_slip_email(
    db,
    payload: Dict[str, Any],
    recipient_email: str,
) -> Dict[str, Any]:
    if not recipient_email or not _EMAIL_RE.match(recipient_email.strip()):
        raise ValueError("Please enter a valid email address")
    settings = await db.app_backup_settings.find_one(
        {"id": "default"}, {"_id": 0}
    )
    if not settings or not settings.get("gmail_user") or not settings.get(
        "gmail_app_password"
    ):
        raise RuntimeError(
            "Gmail credentials are not configured. Ask an admin to fill "
            "them in Admin Settings → Backup & Restore first."
        )

    pdf_bytes = render_slip_pdf(payload)
    party_name = (payload.get("party") or {}).get("name") or "party"
    safe_party = re.sub(r"[^A-Za-z0-9_-]+", "-", party_name).strip("-") or "party"
    slip_no = str(payload.get("slip_no") or "slip")
    safe_slip = re.sub(r"[^A-Za-z0-9_-]+", "-", slip_no).strip("-") or "slip"
    filename = f"dispatch-slip-{safe_slip}-{safe_party}.pdf"

    subject = f"Dispatch Slip #{slip_no} — {party_name}"
    body = (
        f"Hi,\n\nPlease find attached the dispatch slip #{slip_no} for "
        f"{party_name}.\n\n"
        f"— JK Products · Factory Order Management"
    )

    await asyncio.to_thread(
        _send_pdf_via_gmail,
        settings,
        recipient_email.strip(),
        pdf_bytes,
        filename,
        subject,
        body,
    )
    return {
        "ok": True,
        "sent_to": recipient_email.strip(),
        "filename": filename,
        "size_bytes": len(pdf_bytes),
    }


async def share_slip_whatsapp(
    payload: Dict[str, Any],
    recipient_phone: str,
) -> Dict[str, Any]:
    token = os.environ.get("META_WHATSAPP_TOKEN") or ""
    phone_number_id = os.environ.get("META_PHONE_NUMBER_ID") or ""
    if not token or not phone_number_id:
        raise RuntimeError(
            "WhatsApp is not configured. Ask an admin to fill "
            "META_WHATSAPP_TOKEN and META_PHONE_NUMBER_ID."
        )
    to_number = _normalize_phone(recipient_phone)
    pdf_bytes = render_slip_pdf(payload)

    party_name = (payload.get("party") or {}).get("name") or "party"
    safe_party = re.sub(r"[^A-Za-z0-9_-]+", "-", party_name).strip("-") or "party"
    slip_no = str(payload.get("slip_no") or "slip")
    safe_slip = re.sub(r"[^A-Za-z0-9_-]+", "-", slip_no).strip("-") or "slip"
    filename = f"dispatch-slip-{safe_slip}-{safe_party}.pdf"

    caption = f"Dispatch Slip #{slip_no} — {party_name}"

    await asyncio.to_thread(
        _send_whatsapp_template,
        token,
        phone_number_id,
        to_number,
    )
    media_id = await asyncio.to_thread(
        _upload_pdf_to_meta,
        token,
        phone_number_id,
        pdf_bytes,
        filename,
    )
    result = await asyncio.to_thread(
        _send_whatsapp_document,
        token,
        phone_number_id,
        to_number,
        media_id,
        filename,
        caption,
    )
    return {
        "ok": True,
        "sent_to": to_number,
        "filename": filename,
        "size_bytes": len(pdf_bytes),
        "media_id": media_id,
        "wa_response": result,
    }

