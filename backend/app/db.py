"""SQLite persistence. One connection per request/thread; WAL mode; versioned migrations."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

from .config import settings

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student',
  field TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at REAL NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chatgpt_oauth_pending (
  state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL, verifier_cipher TEXT NOT NULL, nonce TEXT NOT NULL,
  expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chatgpt_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, email TEXT, credentials_cipher TEXT NOT NULL,
  scopes_json TEXT NOT NULL, expires_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, filename TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
  stored_path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing', error TEXT, field TEXT,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL, text TEXT NOT NULL, char_count INTEGER NOT NULL,
  status TEXT NOT NULL, notes TEXT, image_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(document_id, page_no));
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, settings_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  analysis_json TEXT, plan_json TEXT, report_json TEXT, error TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, generator TEXT,
  progress_stage TEXT, progress_pct INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, qtype TEXT NOT NULL, task TEXT, objective TEXT, difficulty TEXT,
  stem TEXT NOT NULL, options_json TEXT NOT NULL, correct_option_id TEXT NOT NULL,
  explanation TEXT NOT NULL, purpose TEXT NOT NULL,
  source_doc_id TEXT, source_pages_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, review_status TEXT NOT NULL DEFAULT 'machine_verified',
  validation_json TEXT, fingerprint TEXT, prompt_version TEXT,
  reviewed_by TEXT, reviewed_at REAL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS q_quiz ON questions(quiz_id, position);
CREATE TABLE IF NOT EXISTS question_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT, actor TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress',
  current_index INTEGER NOT NULL DEFAULT 0, question_order_json TEXT NOT NULL,
  option_order_json TEXT NOT NULL, timer_seconds INTEGER, elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  score REAL, max_score REAL, started_at REAL NOT NULL, submitted_at REAL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS attempt_answers (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
  selected_option_id TEXT, flagged INTEGER NOT NULL DEFAULT 0, is_correct INTEGER,
  revealed INTEGER NOT NULL DEFAULT 0, answered_at REAL,
  PRIMARY KEY(attempt_id, question_id));
CREATE TABLE IF NOT EXISTS corrections (      -- the Arabic correction of a wrong answer, kept with the attempt (see services/correction.py)
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, option_id TEXT, text TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(attempt_id, question_id));
CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  front TEXT NOT NULL, back TEXT NOT NULL, source_page INTEGER, evidence TEXT,
  state TEXT NOT NULL DEFAULT 'new', times_known INTEGER NOT NULL DEFAULT 0,
  times_review INTEGER NOT NULL DEFAULT 0, last_reviewed_at REAL,
  generator TEXT, fingerprint TEXT, due_at REAL, interval_days REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS fc_user ON flashcards(user_id, document_id);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, message TEXT,
  status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_by TEXT,
  created_at REAL NOT NULL, resolved_at REAL);
CREATE TABLE IF NOT EXISTS generation_runs (
  id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
  stats_json TEXT, prompt_version TEXT, model TEXT, started_at REAL NOT NULL, finished_at REAL);
CREATE TABLE IF NOT EXISTS analysis_cache (
  key TEXT PRIMARY KEY, user_id TEXT NOT NULL, analysis_json TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT NOT NULL, ref TEXT, ok INTEGER, value REAL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT, description TEXT NOT NULL,
  before_json TEXT, after_json TEXT, result_json TEXT, actor TEXT, reverted INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_docs_user ON documents(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_quiz_user ON quizzes(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_att_user ON attempts(user_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_att_quiz ON attempts(quiz_id);
CREATE INDEX IF NOT EXISTS ix_rep_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS ix_sess_exp ON sessions(expires_at);
"""

_local = threading.local()


def connect() -> sqlite3.Connection:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-20000")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(flashcards)")}
        for col, ddl in (("due_at", "REAL"), ("interval_days", "REAL NOT NULL DEFAULT 0")):  # upgrade older databases
            if col not in cols:
                conn.execute(f"ALTER TABLE flashcards ADD COLUMN {col} {ddl}")
        conn.execute("DELETE FROM sessions WHERE expires_at<?", (time.time(),))
        conn.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
    finally:
        conn.close()


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def db_dep() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency."""
    with get_db() as conn:
        yield conn


def new_id() -> str:
    return uuid.uuid4().hex[:20]


def now() -> float:
    return time.time()


def jdump(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)


def jload(s: str | None, default: Any = None) -> Any:
    if not s:
        return default
    return json.loads(s)
