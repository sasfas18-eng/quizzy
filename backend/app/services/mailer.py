from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from ..config import settings

log = logging.getLogger("quizzy.mail")


def send_reset(to: str, link: str) -> None:
    if not settings.smtp_enabled:
        if settings.dev_log_reset_links:
            log.warning("DEV reset link for %s: %s", to, link)
        return
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.smtp_from, to, "استعادة كلمة المرور — كويزي"
    msg.set_content(f"لاستعادة كلمة المرور افتح الرابط التالي (صالح لمدة ساعة):\n{link}\n\nإن لم تطلب ذلك تجاهل الرسالة.")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
        s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)
