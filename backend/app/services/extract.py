"""Text extraction from PDF and PPTX with per-page quality status.

Principle: only verifiable text. Pages whose content is not text (scanned images,
figures, SmartArt) are flagged — never guessed.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

OK_MIN_CHARS = 80

_ARABIC_PRES = re.compile("[ﭐ-﷿ﹰ-﻿]")
_WS = re.compile(r"[ \t ​]+")


@dataclass
class PageResult:
    page_no: int
    text: str
    status: str  # ok | low_text | image_only | empty | garbled
    image_count: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def char_count(self) -> int:
        return len(self.text)


@dataclass
class ExtractResult:
    kind: str
    pages: list[PageResult]
    removed_boilerplate: list[str] = field(default_factory=list)

    def quality(self) -> dict:
        c = Counter(p.status for p in self.pages)
        return {
            "total_pages": len(self.pages),
            "ok": c.get("ok", 0),
            "low_text": [p.page_no for p in self.pages if p.status == "low_text"],
            "image_only": [p.page_no for p in self.pages if p.status == "image_only"],
            "empty": [p.page_no for p in self.pages if p.status == "empty"],
            "garbled": [p.page_no for p in self.pages if p.status == "garbled"],
            "with_figures_unread": [p.page_no for p in self.pages if p.image_count and p.status == "ok"],
            "removed_boilerplate": self.removed_boilerplate,
        }


def clean_text(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "")
    if _ARABIC_PRES.search(s):
        # PDFs frequently store Arabic as shaped presentation forms in VISUAL order (reversed).
        # Re-run bidi per line to restore logical order, then fold the forms back to base letters.
        from bidi.algorithm import get_display

        s = "\n".join(get_display(ln, base_dir="R") if _ARABIC_PRES.search(ln) else ln for ln in s.splitlines())
        s = unicodedata.normalize("NFKC", s)
    s = s.replace("\x00", "")
    lines = [_WS.sub(" ", ln).strip() for ln in s.splitlines()]
    out: list[str] = []
    for ln in lines:
        if ln or (out and out[-1]):
            out.append(ln)
    return "\n".join(out).strip()


def _classify(text: str, images: int) -> tuple[str, list[str]]:
    notes: list[str] = []
    n = len(text)
    if n:
        bad = sum(1 for ch in text if ch == "�" or 0xE000 <= ord(ch) <= 0xF8FF)
        if bad / n > 0.15:
            return "garbled", ["النص المستخرج تالف (ترميز خطوط غير قابل للقراءة)؛ قد تحتاج الصفحة إلى OCR."]
    if n == 0:
        if images:
            return "image_only", ["الصفحة صورة بلا نص قابل للاستخراج؛ القراءة الضوئية (OCR) متاحة في نسخة المتصفح (الموقع على GitHub Pages ونسخة Claude)، لا في نسخة الخادم."]
        return "empty", ["صفحة فارغة."]
    if n < OK_MIN_CHARS:
        if images:
            notes.append("نص قليل مع صور؛ محتوى الصور غير مقروء.")
        else:
            notes.append("نص قليل جدًا (قد تكون صفحة عنوان أو فاصل).")
        return "low_text", notes
    if images:
        notes.append("تحتوي على صور/أشكال لم تُقرأ؛ الأسئلة لن تعتمد عليها.")
    return "ok", notes


def _strip_boilerplate(pages: list[PageResult]) -> list[str]:
    """Remove short lines repeated on most pages (running headers/footers, slide numbers)."""
    if len(pages) < 4:
        return []
    cnt: Counter[str] = Counter()
    for p in pages:
        seen = {re.sub(r"\d+", "#", ln.strip()) for ln in p.text.splitlines() if 0 < len(ln.strip()) < 80}
        cnt.update(seen)
    thr = max(3, int(len(pages) * 0.6))
    rep = {k for k, v in cnt.items() if v >= thr}
    if not rep:
        return []
    removed: set[str] = set()
    for p in pages:
        keep = []
        for ln in p.text.splitlines():
            key = re.sub(r"\d+", "#", ln.strip())
            if ln.strip() and key in rep:
                removed.add(key)
            else:
                keep.append(ln)
        p.text = clean_text("\n".join(keep))
    return sorted(removed)


_AR_LETTER = re.compile("[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]")


def _arabic_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    return sum(1 for c in letters if _AR_LETTER.match(c)) / len(letters) if letters else 0.0


def _table_lines(rows: list[list]) -> list[str]:
    """pdfplumber table rows -> "a | b | c" lines (Arabic rows read right to left: first column = rightmost)."""
    out = []
    for r in rows:
        cells = [re.sub(r"\s+", " ", (c or "")).strip() for c in r]
        if _arabic_ratio(" ".join(cells)) > 0.5:
            cells = cells[::-1]
        full = [c for c in cells if c]
        if len(full) >= 2:
            out.append(" | ".join(cells))
        elif full:
            out.append(full[0])
    return out


def _page_text_with_tables(page) -> str:
    """The page text in reading order with bordered tables (ruled grids) rebuilt as pipe rows where they stand on the page."""
    try:
        tables = [t for t in page.find_tables() if t.bbox]
    except Exception:
        tables = []
    tables = [t for t in tables if len(t.rows) >= 2]
    if not tables:
        return page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""
    tables.sort(key=lambda t: t.bbox[1])
    parts: list[str] = []
    top = 0.0
    for t in tables:
        x0, y0, x1, y1 = t.bbox
        if y0 - top > 2:
            parts.append(page.crop((0, top, page.width, y0)).extract_text(x_tolerance=1.5, y_tolerance=3) or "")
        try:
            parts.append("\n".join(_table_lines(t.extract())))
        except Exception:
            parts.append(page.crop(t.bbox).extract_text(x_tolerance=1.5, y_tolerance=3) or "")
        top = y1
    if page.height - top > 2:
        parts.append(page.crop((0, top, page.width, page.height)).extract_text(x_tolerance=1.5, y_tolerance=3) or "")
    return "\n".join(p for p in parts if p)


def extract_pdf(path: Path, max_pages: int = 400) -> ExtractResult:
    import pdfplumber

    pages: list[PageResult] = []
    with pdfplumber.open(str(path)) as pdf:
        total = len(pdf.pages)
        if total > max_pages:
            raise ValueError(f"عدد الصفحات {total} يتجاوز الحد المسموح ({max_pages}).")
        for i, page in enumerate(pdf.pages, start=1):
            try:
                raw = _page_text_with_tables(page)
            except Exception:
                raw = ""
            try:
                images = len(page.images)
            except Exception:
                images = 0
            text = clean_text(raw)
            status, notes = _classify(text, images)
            pages.append(PageResult(i, text, status, images, notes))
    res = ExtractResult("pdf", pages)
    res.removed_boilerplate = _strip_boilerplate(pages)
    for p in pages:  # reclassify after boilerplate removal
        p.status, p.notes = _classify(p.text, p.image_count)
    return res


def _chart_lines(chart) -> list[str]:
    """Chart data as text: title, then "series: category=value; ..." (the numbers live in the file, so they can be asked about)."""
    out: list[str] = []
    try:
        if chart.has_title and chart.chart_title.has_text_frame:
            t = chart.chart_title.text_frame.text.strip()
            if t:
                out.append("Chart: " + t)
    except Exception:
        pass
    try:
        for plot in chart.plots:
            cats = [str(c) for c in plot.categories]
            for ser in plot.series:
                vals = list(ser.values)
                if vals:
                    out.append((f"{ser.name}: " if ser.name else "") + "; ".join((f"{cats[i]}=" if i < len(cats) else "") + f"{v}" for i, v in enumerate(vals)))
    except Exception:
        pass
    return out


def _iter_shapes(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == 6 and hasattr(sh, "shapes"):  # group
            yield from _iter_shapes(sh.shapes)


def extract_pptx(path: Path, max_pages: int = 400) -> ExtractResult:
    from pptx import Presentation

    prs = Presentation(str(path))
    slides = list(prs.slides)
    if len(slides) > max_pages:
        raise ValueError(f"عدد الشرائح {len(slides)} يتجاوز الحد المسموح ({max_pages}).")
    pages: list[PageResult] = []
    for i, slide in enumerate(slides, start=1):
        blocks: list[tuple[int, int, str]] = []
        images = 0
        notes: list[str] = []
        for sh in _iter_shapes(slide.shapes):
            try:
                top, left = int(sh.top or 0), int(sh.left or 0)
            except Exception:
                top = left = 0
            st = getattr(sh, "shape_type", None)
            if st == 13:  # picture
                images += 1
                continue
            if getattr(sh, "has_text_frame", False) and sh.has_text_frame:
                paras = []
                for para in sh.text_frame.paragraphs:
                    t = "".join(r.text for r in para.runs).strip() or para.text.strip()
                    if t:
                        paras.append(("  " * min(para.level, 3)) + t)
                if paras:
                    blocks.append((top, left, "\n".join(paras)))
            if getattr(sh, "has_table", False) and sh.has_table:
                rows = []
                for r in sh.table.rows:
                    rows.append(" | ".join(c.text.strip().replace("\n", " ") for c in r.cells))
                blocks.append((top, left, "\n".join(rows)))
            if getattr(sh, "has_chart", False) and sh.has_chart:
                lines = _chart_lines(sh.chart)
                if lines:
                    blocks.append((top, left, "\n".join(lines)))
                else:
                    notes.append("تحتوي على رسم بياني تعذّرت قراءة قيمه.")
                    images += 1
        blocks.sort(key=lambda b: (b[0] // 200000, b[1]))
        text = "\n".join(b[2] for b in blocks)
        try:
            if slide.has_notes_slide:
                nt = slide.notes_slide.notes_text_frame.text.strip()
                if nt:
                    text += "\n[ملاحظات المتحدث] " + nt
        except Exception:
            pass
        text = clean_text(text)
        status, n2 = _classify(text, images)
        pages.append(PageResult(i, text, status, images, notes + n2))
    res = ExtractResult("pptx", pages)
    res.removed_boilerplate = _strip_boilerplate(pages)
    for p in pages:
        extra = [n for n in p.notes if "رسم بياني" in n]   # keep the "chart not readable" note
        p.status, p.notes = _classify(p.text, p.image_count)
        p.notes += extra
    return res


def extract_file(path: Path, kind: str, max_pages: int = 400) -> ExtractResult:
    if kind == "pdf":
        return extract_pdf(path, max_pages)
    if kind == "pptx":
        return extract_pptx(path, max_pages)
    raise ValueError("نوع الملف غير مدعوم. المدعوم: PDF وPPTX.")


def detect_kind(filename: str, head: bytes) -> str | None:
    name = filename.lower()
    if head.startswith(b"%PDF") and name.endswith(".pdf"):
        return "pdf"
    if head.startswith(b"PK") and name.endswith(".pptx"):
        return "pptx"
    return None


def parse_page_spec(spec: str | list | None, total: int) -> list[int]:
    """'1-5, 8, 10-12' or list -> sorted unique valid page numbers."""
    if spec is None or spec == "" or spec == []:
        return list(range(1, total + 1))
    pages: set[int] = set()
    if isinstance(spec, list):
        pages = {int(x) for x in spec}
    else:
        for part in re.split(r"[,،;\s]+", spec.strip()):
            if not part:
                continue
            m = re.fullmatch(r"(\d+)\s*[-–]\s*(\d+)", part)
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                if a > b:
                    a, b = b, a
                pages.update(range(a, b + 1))
            elif part.isdigit():
                pages.add(int(part))
            else:
                raise ValueError(f"نطاق صفحات غير صالح: {part}")
    bad = [p for p in pages if p < 1 or p > total]
    if bad:
        raise ValueError(f"صفحات خارج الملف (١–{total}): {sorted(bad)[:5]}")
    return sorted(pages)
