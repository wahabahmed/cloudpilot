"""
Email notifications for request lifecycle events.

If SMTP_HOST is unset, notifications are skipped and a log line is printed —
safe for local dev.
"""
import os
import smtplib
from email.message import EmailMessage

from . import models


def send_email(to: str, subject: str, body: str) -> bool:
    host = os.environ.get("SMTP_HOST")
    if not host:
        print(f"[notify] SMTP not configured — would have sent to {to}: {subject}")
        return False

    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM", "noreply@cloudpilot.local")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")

    with smtplib.SMTP(host, port, timeout=10) as s:
        if user and password:
            s.starttls()
            s.login(user, password)
        s.send_message(msg)
    return True


def notify_request_completed(db, request_row: models.Request, status: str):
    """Send the request outcome to the requestor (by user_id)."""
    if not request_row.requested_by:
        print(f"[notify] request {request_row.id} has no requested_by — skipping")
        return

    user = db.get(models.User, request_row.requested_by)
    if not user or not user.email:
        print(f"[notify] request {request_row.id}: user {request_row.requested_by} not found")
        return

    to = user.email
    frontend = os.environ.get("FRONTEND_URL", "http://localhost:5173")
    url = f"{frontend}/requests?state=all"

    if status in ("applied", "imported"):
        subject = f"✓ Your request #{request_row.id} completed"
        body = (
            f"Your request has been {status}.\n\n"
            f"Request: {request_row.nlp_text[:200]}\n"
            f"Environment: {request_row.env}\n"
            f"Additions: +{request_row.plan_additions}\n"
            f"Changes: ~{request_row.plan_changes}\n"
            f"Destructions: -{request_row.plan_destructions}\n\n"
            f"View the request: {url}\n"
        )
    else:  # failed
        subject = f"✕ Your request #{request_row.id} failed"
        body = (
            f"Your request failed.\n\n"
            f"Request: {request_row.nlp_text[:200]}\n"
            f"Environment: {request_row.env}\n\n"
            f"Reason:\n{(request_row.plan_summary or '')[-2000:]}\n\n"
            f"View the request: {url}\n"
        )

    try:
        send_email(to, subject, body)
    except Exception as e:
        print(f"[notify] request {request_row.id}: email failed: {e}")