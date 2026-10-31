from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import db_dep, now
from ..deps import ApiError, current_user, owned_doc, require_llm
from ..services import cards as cardsvc
from ..services.extract import parse_page_spec

router = APIRouter(prefix="/api", tags=["cards"])


class CardGenIn(BaseModel):
    pages: str | list[int] | None = None
    count: int = Field(default=20, ge=3, le=60)
    language: Literal["source", "ar", "en"] = "source"
    external_mode: Literal["source_only", "supplement"] = "source_only"


@router.post("/documents/{doc_id}/cards/generate")
def generate(doc_id: str, body: CardGenIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    d = owned_doc(conn, user["id"], doc_id)
    require_llm()
    try:
        parse_page_spec(body.pages, d["page_count"])
        return cardsvc.generate_cards(conn, user["id"], doc_id, body.pages, body.count,
                                      {"language": body.language, "external_mode": body.external_mode})
    except (ValueError, PermissionError) as e:
        raise ApiError(422, "cards_error", str(e))


def card_out(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "document_id": r["document_id"], "front": r["front"], "back": r["back"], "source_page": r["source_page"],
            "evidence": r["evidence"], "state": r["state"], "times_known": r["times_known"], "times_review": r["times_review"],
            "last_reviewed_at": r["last_reviewed_at"], "due_at": r["due_at"], "interval_days": r["interval_days"], "generator": r["generator"], "document_title": r["document_title"] if "document_title" in r.keys() else None}


@router.get("/cards")
def list_cards(document_id: str | None = None, state: Literal["new", "known", "review"] | None = None, due: bool = False,
               conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    sql = "SELECT f.*, d.title AS document_title FROM flashcards f JOIN documents d ON d.id=f.document_id WHERE f.user_id=?"
    args: list = [user["id"]]
    if document_id:
        sql += " AND f.document_id=?"
        args.append(document_id)
    if state:
        sql += " AND f.state=?"
        args.append(state)
    if due:
        sql += " AND (f.due_at IS NULL OR f.due_at<=?)"
        args.append(now())
    rows = conn.execute(sql + " ORDER BY COALESCE(f.due_at,0), f.source_page, f.created_at", args).fetchall()
    return [card_out(r) for r in rows]


@router.get("/cards/stats")
def stats(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    rows = conn.execute("""SELECT d.id, d.title, COUNT(*) total,
        SUM(f.state='known') known, SUM(f.state='review') review, SUM(f.state='new') new,
        SUM(f.due_at IS NULL OR f.due_at<=?) due
        FROM flashcards f JOIN documents d ON d.id=f.document_id WHERE f.user_id=? GROUP BY d.id ORDER BY d.title""", (now(), user["id"])).fetchall()
    return [dict(r) for r in rows]


class StateIn(BaseModel):
    state: Literal["known", "review", "new"]


@router.put("/cards/{card_id}/state")
def set_state(card_id: str, body: StateIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    c = conn.execute("SELECT * FROM flashcards WHERE id=? AND user_id=?", (card_id, user["id"])).fetchone()
    if not c:
        raise ApiError(404, "not_found", "البطاقة غير موجودة.")
    # Spaced repetition (simplified SM-2 style): "known" stretches the interval, "review" brings the card back in 10 minutes.
    prev = c["interval_days"] or 0
    if body.state == "known":
        interval = 1.0 if prev < 1 else min(180.0, round(prev * 2.2, 1))
        due = now() + interval * 86400
    elif body.state == "review":
        interval, due = 0.0, now() + 600
    else:
        interval, due = 0.0, None
    conn.execute("""UPDATE flashcards SET state=?, times_known=times_known+?, times_review=times_review+?, last_reviewed_at=?,
                    interval_days=?, due_at=? WHERE id=?""",
                 (body.state, int(body.state == "known"), int(body.state == "review"), now(), interval, due, card_id))
    return {"saved": True, "state": body.state, "interval_days": interval, "due_at": due, "saved_at": now()}


@router.delete("/cards/{card_id}")
def delete_card(card_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    cur = conn.execute("DELETE FROM flashcards WHERE id=? AND user_id=?", (card_id, user["id"]))
    if cur.rowcount == 0:
        raise ApiError(404, "not_found", "البطاقة غير موجودة.")
    return {"ok": True}
