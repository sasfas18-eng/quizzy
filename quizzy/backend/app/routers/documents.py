from __future__ import annotations

import hashlib
import sqlite3
import traceback
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel

from ..config import settings
from ..db import connect, db_dep, jdump, jload, new_id, now
from ..deps import ApiError, current_user, owned_doc, pool
from ..services.extract import ExtractResult, detect_kind, extract_file
from ..services.taxonomy import FIELDS

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _process(doc_id: str) -> None:
    conn = connect()
    try:
        d = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        try:
            res: ExtractResult = extract_file(Path(d["stored_path"]), d["kind"], settings.max_pages)
        except Exception as e:  # noqa
            traceback.print_exc()
            conn.execute("UPDATE documents SET status='failed', error=? WHERE id=?", (f"تعذّرت قراءة الملف: {e}", doc_id))
            return
        conn.execute("DELETE FROM pages WHERE document_id=?", (doc_id,))
        for p in res.pages:
            conn.execute("INSERT INTO pages(document_id,page_no,text,char_count,status,notes,image_count) VALUES(?,?,?,?,?,?,?)",
                         (doc_id, p.page_no, p.text, p.char_count, p.status, " ".join(p.notes), p.image_count))
        q = res.quality()
        status = "ready" if q["ok"] + len(q["low_text"]) > 0 else "unreadable"
        err = None if status == "ready" else "لم يُستخرج أي نص قابل للقراءة من الملف (قد يكون ممسوحًا ضوئيًا). المعالجة بـ OCR غير مفعّلة بعد."
        conn.execute("UPDATE documents SET status=?, page_count=?, error=? WHERE id=?", (status, len(res.pages), err, doc_id))
    finally:
        conn.close()


def doc_summary(conn: sqlite3.Connection, d: sqlite3.Row, with_pages: bool = False) -> dict:
    rows = conn.execute("SELECT page_no,status,char_count,notes,image_count,substr(text,1,160) AS snippet FROM pages WHERE document_id=? ORDER BY page_no",
                        (d["id"],)).fetchall()
    out = {"id": d["id"], "title": d["title"], "filename": d["filename"], "kind": d["kind"], "status": d["status"], "error": d["error"],
           "page_count": d["page_count"], "field": d["field"], "created_at": d["created_at"],
           "quality": {
               "ok": sum(1 for r in rows if r["status"] == "ok"),
               "low_text": [r["page_no"] for r in rows if r["status"] == "low_text"],
               "image_only": [r["page_no"] for r in rows if r["status"] == "image_only"],
               "empty": [r["page_no"] for r in rows if r["status"] == "empty"],
               "garbled": [r["page_no"] for r in rows if r["status"] == "garbled"],
               "figures_unread": [r["page_no"] for r in rows if r["image_count"] and r["status"] == "ok"],
           }}
    if with_pages:
        out["pages"] = [dict(r) for r in rows]
    return out


@router.post("")
async def upload(file: UploadFile = File(...), title: str = Form(""), field: str = Form(""),
                 conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if field and field not in FIELDS:
        raise ApiError(422, "bad_field", "التخصص غير معروف.")
    limit = settings.max_upload_mb * 1024 * 1024
    head = await file.read(8)
    kind = detect_kind(file.filename or "", head)
    if not kind:
        raise ApiError(415, "unsupported_type", "الملف غير مدعوم أو تالف. المدعوم: PDF وPPTX فقط.")
    doc_id = new_id()
    folder = settings.upload_dir / user["id"]
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{doc_id}.{kind}"
    h = hashlib.sha256(head)
    size = len(head)
    with open(dest, "wb") as out:
        out.write(head)
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise ApiError(413, "too_large", f"حجم الملف يتجاوز {settings.max_upload_mb}MB.")
            h.update(chunk)
            out.write(chunk)
    t = (title or Path(file.filename or "ملف").stem).strip()[:120] or "ملف"
    conn.execute("""INSERT INTO documents(id,user_id,title,filename,kind,sha256,stored_path,status,field,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""",
                 (doc_id, user["id"], t, (file.filename or "")[:200], kind, h.hexdigest(), str(dest), "processing",
                  field or user["field"], now()))
    pool.submit(_process, doc_id)
    return doc_summary(conn, conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone())


@router.get("")
def list_docs(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    rows = conn.execute("SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC", (user["id"],)).fetchall()
    return [doc_summary(conn, d) for d in rows]


@router.get("/{doc_id}")
def get_doc(doc_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    return doc_summary(conn, owned_doc(conn, user["id"], doc_id), with_pages=True)


@router.get("/{doc_id}/pages/{page_no}")
def get_page(doc_id: str, page_no: int, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    owned_doc(conn, user["id"], doc_id)
    r = conn.execute("SELECT page_no,text,status,notes,image_count FROM pages WHERE document_id=? AND page_no=?", (doc_id, page_no)).fetchone()
    if not r:
        raise ApiError(404, "not_found", "الصفحة غير موجودة.")
    return dict(r)


class DocPatch(BaseModel):
    title: str | None = None
    field: str | None = None


@router.patch("/{doc_id}")
def patch_doc(doc_id: str, body: DocPatch, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    owned_doc(conn, user["id"], doc_id)
    if body.field and body.field not in FIELDS:
        raise ApiError(422, "bad_field", "التخصص غير معروف.")
    conn.execute("UPDATE documents SET title=COALESCE(?,title), field=COALESCE(?,field) WHERE id=?",
                 ((body.title or "").strip()[:120] or None, body.field, doc_id))
    return doc_summary(conn, conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone())


@router.delete("/{doc_id}")
def delete_doc(doc_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    d = owned_doc(conn, user["id"], doc_id)
    Path(d["stored_path"]).unlink(missing_ok=True)
    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    return {"ok": True, "note": "الكويزات المبنية على الملف تحتفظ بأسئلتها ومصادرها المقتبسة."}
