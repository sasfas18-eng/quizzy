from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import ROOT, settings
from .db import connect, init_db, now
from .deps import ApiError
from .routers import admin, attempts, auth, cards, documents, quizzes, reports
from .services.llm import LLMUnavailable

log = logging.getLogger("quizzy")
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


def create_app() -> FastAPI:
    app = FastAPI(title="Quizzy", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    init_db()
    _recover_interrupted_jobs()
    if not settings.secret:
        log.warning("QUIZZY_SECRET is not set (reserved for signing features); sessions use random server-side tokens.")

    app.add_middleware(GZipMiddleware, minimum_size=600)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("Content-Security-Policy",
                                "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; script-src 'self'; frame-ancestors 'none'")
        p = request.url.path
        if settings.cookie_secure:
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if p.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif p.startswith(("/static/fonts/", "/static/vendor/")):
            resp.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        elif p.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"  # revalidate via ETag: cheap 304s, always fresh code
        return resp

    @app.exception_handler(StarletteHTTPException)
    async def http_exc(request, exc):
        d = exc.detail
        if isinstance(d, dict) and "code" in d:
            return JSONResponse(d, status_code=exc.status_code)
        return JSONResponse({"code": "http_error", "message": str(d)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def val_exc(request, exc):
        errs = exc.errors()
        first = errs[0] if errs else {}
        loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        return JSONResponse({"code": "validation", "message": f"قيمة غير صالحة: {loc or 'الطلب'}", "errors": [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in errs[:5]]}, status_code=422)

    @app.exception_handler(LLMUnavailable)
    async def llm_exc(request, exc):
        return JSONResponse({"code": "llm_not_configured", "message": str(exc)}, status_code=503)

    for r in (auth.router, documents.router, quizzes.router, attempts.router, cards.router, reports.router, admin.router):
        app.include_router(r)

    @app.get("/api/health")
    def health():
        with connect() as c:
            c.execute("SELECT 1")
        return {"ok": True, "llm": settings.llm_enabled, "smtp": settings.smtp_enabled}

    if FRONTEND.exists():
        app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

        @app.get("/")
        def index():
            return FileResponse(FRONTEND / "index.html", headers={"Cache-Control": "no-cache"})
    return app


def _recover_interrupted_jobs() -> None:
    conn = connect()
    try:
        conn.execute("UPDATE quizzes SET status='failed', error='انقطعت المعالجة بإعادة تشغيل الخادم. أعد المحاولة.' WHERE status IN ('analyzing','generating')")
        conn.execute("UPDATE generation_runs SET status='failed', finished_at=? WHERE status='running'", (now(),))
        conn.execute("UPDATE documents SET status='failed', error='انقطعت المعالجة بإعادة تشغيل الخادم. أعد رفع الملف.' WHERE status='processing'")
    finally:
        conn.close()


app = create_app()
