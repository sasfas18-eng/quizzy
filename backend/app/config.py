"""Runtime configuration, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("QUIZZY_DATA_DIR", ROOT / "data")))
    secret: str = field(default_factory=lambda: os.environ.get("QUIZZY_SECRET", ""))
    # Anthropic key; without it generation is disabled (never faked silently).
    anthropic_key: str = field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY", ""))
    # Any OpenAI-compatible endpoint (Groq, OpenRouter, Gemini's compat API, a local Ollama...). Used when no Anthropic key.
    llm_base_url: str = field(default_factory=lambda: os.environ.get("QUIZZY_LLM_BASE_URL", "").rstrip("/"))
    llm_api_key: str = field(default_factory=lambda: os.environ.get("QUIZZY_LLM_API_KEY", ""))
    llm_model: str = field(default_factory=lambda: os.environ.get("QUIZZY_LLM_MODEL", ""))
    model: str = field(default_factory=lambda: os.environ.get("QUIZZY_MODEL", "claude-sonnet-5-5"))
    verifier_model: str = field(default_factory=lambda: os.environ.get("QUIZZY_VERIFIER_MODEL", ""))
    # Test-only provider; every item produced by it is stamped "test-generator" in the UI.
    allow_fake_llm: bool = field(default_factory=lambda: _bool("QUIZZY_ALLOW_FAKE_LLM"))
    admin_emails: list[str] = field(
        default_factory=lambda: [e.strip().lower() for e in os.environ.get("QUIZZY_ADMIN_EMAILS", "").split(",") if e.strip()]
    )
    cookie_secure: bool = field(default_factory=lambda: _bool("QUIZZY_COOKIE_SECURE", False))
    session_days: int = field(default_factory=lambda: int(os.environ.get("QUIZZY_SESSION_DAYS", "30")))
    max_upload_mb: int = field(default_factory=lambda: int(os.environ.get("QUIZZY_MAX_UPLOAD_MB", "40")))
    # LLM calls in flight per quiz (drafting waves). Raise it with a big provider pool / Anthropic; lower it for free tiers.
    llm_concurrency: int = field(default_factory=lambda: max(1, int(os.environ.get("QUIZZY_LLM_CONCURRENCY", "8"))))
    # open | invite (needs a code) | closed
    registration_mode: str = field(default_factory=lambda: os.environ.get("QUIZZY_REGISTRATION", "open").strip().lower())
    invite_codes: list[str] = field(default_factory=lambda: [c.strip() for c in os.environ.get("QUIZZY_INVITE_CODES", "").split(",") if c.strip()])
    allowed_email_domains: list[str] = field(
        default_factory=lambda: [d.strip().lower().lstrip("@") for d in os.environ.get("QUIZZY_ALLOWED_EMAIL_DOMAINS", "").split(",") if d.strip()])
    workers: int = field(default_factory=lambda: int(os.environ.get("QUIZZY_WORKERS", "4")))
    # Reading a newly uploaded file (text extraction) has its OWN workers: it must never queue behind slow quiz jobs (AI calls can take minutes).
    doc_workers: int = field(default_factory=lambda: max(1, int(os.environ.get("QUIZZY_DOC_WORKERS", "3"))))
    max_pages: int = field(default_factory=lambda: int(os.environ.get("QUIZZY_MAX_PAGES", "400")))
    # Trial deployments (e.g. a free instance with no persistent disk): the UI shows a permanent "data may be reset" banner.
    trial: bool = field(default_factory=lambda: _bool("QUIZZY_TRIAL"))
    public_url: str = field(default_factory=lambda: os.environ.get("QUIZZY_PUBLIC_URL", "http://localhost:8000"))
    # SMTP for password reset. If SMTP_HOST is empty, reset is reported as unavailable.
    smtp_host: str = field(default_factory=lambda: os.environ.get("SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: int(os.environ.get("SMTP_PORT", "587")))
    smtp_user: str = field(default_factory=lambda: os.environ.get("SMTP_USER", ""))
    smtp_password: str = field(default_factory=lambda: os.environ.get("SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.environ.get("SMTP_FROM", "Quizzy <no-reply@localhost>"))
    # Dev only: print the reset link to the server log when SMTP is not configured.
    dev_log_reset_links: bool = field(default_factory=lambda: _bool("QUIZZY_DEV_LOG_RESET_LINKS"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "quizzy.sqlite3"

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def llm_enabled(self) -> bool:
        return bool(self.anthropic_key) or self.openai_compat or self.allow_fake_llm

    @property
    def llm_pool(self) -> list[dict]:
        """Endpoints to rotate over. QUIZZY_LLM_POOL = JSON list of {name?, base_url, api_key?, model, rpm?, daily?};
        otherwise the single QUIZZY_LLM_* endpoint."""
        import json

        raw = os.environ.get("QUIZZY_LLM_POOL", "").strip()
        eps: list[dict] = []
        if raw:
            try:
                eps = [e for e in json.loads(raw) if e.get("base_url") and e.get("model")]
            except Exception:
                eps = []
        elif self.llm_base_url and self.llm_model:
            eps = [{"name": "default", "base_url": self.llm_base_url, "api_key": self.llm_api_key, "model": self.llm_model}]
        for e in eps:
            e["base_url"] = e["base_url"].rstrip("/")
            e.setdefault("rpm", int(os.environ.get("QUIZZY_LLM_RPM", "20")))
        return eps

    @property
    def openai_compat(self) -> bool:
        return bool(self.llm_pool)

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.smtp_host)


settings = Settings()


def reload_settings() -> Settings:
    """Re-read env (used by tests)."""
    global settings
    new = Settings()
    settings.__dict__.update(new.__dict__)
    return settings
