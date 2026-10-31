"""Flashcards from the student's own pages, with verbatim-quote verification and de-duplication."""
from __future__ import annotations

import hashlib
import sqlite3

from ..db import new_id, now
from . import prompts, validate
from .generator import _chunks, load_source
from .llm import LLMError, generator_label, get_provider


def generate_cards(conn: sqlite3.Connection, user_id: str, document_id: str, pages_spec, n: int, settings: dict) -> dict:
    provider = get_provider()
    src = load_source(conn, user_id, [{"document_id": document_id, "pages": pages_spec}])
    if not src["pages"]:
        raise ValueError("لا توجد صفحات مقروءة في النطاق المختار.")
    text_by_ref = {p["ref"]: p["text"] for p in src["pages"]}
    existing = conn.execute("SELECT front, fingerprint FROM flashcards WHERE user_id=? AND document_id=?", (user_id, document_id)).fetchall()
    seen_fp = {r["fingerprint"] for r in existing}
    seen_tokens = [validate.tokens(r["front"]) for r in existing]
    per_chunk = max(3, round(n * 1.3 / max(1, len(_chunks(src["pages"], 14000)))))
    created, rejected = [], {"quote_missing": 0, "duplicate": 0, "empty": 0, "error": 0}
    for chunk in _chunks(src["pages"], 14000):
        pages = {p["ref"]: p["text"][:5000] for p in chunk}
        system, prompt = prompts.cards_prompt(pages, per_chunk, settings.get("language", "source"), settings.get("field", "other"),
                                              settings.get("external_mode") == "supplement")
        try:
            r = provider.json_call("cards", system, prompt, {"pages": pages, "n": per_chunk}, max_tokens=4000)
        except LLMError:
            rejected["error"] += 1
            continue
        for c in r.get("cards", []):
            if len(created) >= n:
                break
            front, back = str(c.get("front", "")).strip(), str(c.get("back", "")).strip()
            ref, quote = c.get("page"), str(c.get("quote", ""))
            if len(front) < 8 or len(back) < 2:
                rejected["empty"] += 1
                continue
            if ref not in pages or not validate.quote_in_text(quote, pages[ref]):
                rejected["quote_missing"] += 1
                continue
            fp = hashlib.sha1(validate.norm(front).encode()).hexdigest()[:16]
            ft = validate.tokens(front)
            if fp in seen_fp or any(validate.jaccard(ft, t) >= 0.7 for t in seen_tokens):
                rejected["duplicate"] += 1
                continue
            seen_fp.add(fp)
            seen_tokens.append(ft)
            page_no = next(p["page_no"] for p in chunk if p["ref"] == ref)
            cid = new_id()
            conn.execute("""INSERT INTO flashcards(id,user_id,document_id,front,back,source_page,evidence,generator,fingerprint,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)""",
                         (cid, user_id, document_id, front, back, page_no, quote[:300], generator_label(provider), fp, now()))
            created.append(cid)
    return {"created": len(created), "requested": n, "rejected": rejected, "excluded_pages": src["excluded"]}
