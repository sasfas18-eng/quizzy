"""PDF export with correct Arabic shaping + bidi and mixed Arabic/English runs.

Own line-breaking flowable: text is wrapped in logical order, then each line is shaped and bidi-reordered
independently (reportlab's Paragraph cannot do this). Options are keyed by option id; the key printed in the
PDF refers to the letters of THIS PDF's option order.
"""
from __future__ import annotations

import io
import random
import re
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, KeepTogether, PageTemplate, Spacer

from .taxonomy import QTYPES, type_label

FONTS = Path(__file__).resolve().parents[1] / "assets" / "fonts"
_registered = False
LETTERS = "ABCD"
INK, MUTED, ACCENT, RULE = colors.HexColor("#1f2937"), colors.HexColor("#6b7280"), colors.HexColor("#0f766e"), colors.HexColor("#d9dee3")
_AR = re.compile("[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")
_RECH = re.compile("[؀-ۿ]")


def register_fonts() -> None:
    global _registered
    if _registered:
        return
    for name, f in [("QZ-Ar", "NotoSansArabic-Regular.ttf"), ("QZ-Ar-B", "NotoSansArabic-Bold.ttf"),
                    ("QZ-Lat", "DejaVuSans.ttf"), ("QZ-Lat-B", "DejaVuSans-Bold.ttf")]:
        pdfmetrics.registerFont(TTFont(name, str(FONTS / f)))
    _registered = True


def is_rtl(s: str) -> bool:
    letters = [c for c in s if c.isalpha()]
    return bool(letters) and sum(1 for c in letters if _RECH.match(c)) / len(letters) > 0.3


_CLOSERS = re.compile(r"([A-Za-z0-9%][^\u0600-\u06ff\s]*?[)\]}])")


def _shape(line: str, rtl: bool) -> str:
    if _AR.search(line):
        # keep a closing bracket attached to the Latin term before it (otherwise bidi flips it to the Arabic side)
        line = _CLOSERS.sub(lambda m: m.group(1) + "\u200e", line)
        line = arabic_reshaper.reshape(line)
    return get_display(line, base_dir="R" if rtl else "L")


def _runs(visual: str, bold: bool):
    """split visual string into (font, text) runs: Arabic chars -> Noto, rest -> DejaVu; neutrals follow previous."""
    ar_font, lat_font = ("QZ-Ar-B", "QZ-Lat-B") if bold else ("QZ-Ar", "QZ-Lat")
    out: list[list] = []
    cur = None
    for ch in visual:
        if _AR.match(ch):
            f = ar_font
        elif ch.isalnum() or ord(ch) > 0x2000:
            f = lat_font
        else:
            f = cur or lat_font
        if f != cur:
            out.append([f, ""])
            cur = f
        out[-1][1] += ch
    return out


def _width(visual: str, size: float, bold: bool) -> float:
    return sum(pdfmetrics.stringWidth(t, f, size) for f, t in _runs(visual, bold))


class TextBlock(Flowable):
    def __init__(self, text: str, size=10.5, leading=None, bold=False, color=INK, rtl: bool | None = None,
                 indent=0.0, hang: str | None = None, lines: list[str] | None = None):
        super().__init__()
        self.text, self.size, self.leading = text, size, leading or size * 1.55
        self.bold, self.color = bold, color
        self.auto_dir = rtl is None
        self.rtl = is_rtl(text.split("\n")[0]) if rtl is None else rtl
        self.indent = indent
        self.hang = hang  # label drawn at the leading edge (e.g. "A.")
        self.lines = lines
        self.hang_w = 0.0

    def _wrap_lines(self, width: float) -> list[tuple[str, bool]]:
        lines: list[tuple[str, bool]] = []
        for pi, para in enumerate(self.text.split("\n")):
            prtl = is_rtl(para) if (self.auto_dir and any(c.isalpha() for c in para)) else self.rtl
            words = para.split(" ")
            cur = ""
            for w in words:
                trial = (cur + " " + w).strip() if cur else w
                if cur and _width(_shape(trial, prtl), self.size, self.bold) > width:
                    lines.append((cur, prtl))
                    cur = w
                else:
                    cur = trial
            lines.append((cur, prtl))
        return lines

    def wrap(self, aw, ah):
        self.avail = aw
        self.hang_w = _width(self.hang, self.size, True) + 4 if self.hang else 0
        inner = aw - self.indent - self.hang_w
        if self.lines is None:
            self.lines = self._wrap_lines(inner)
        self.width = aw
        self.height = len(self.lines) * self.leading
        return aw, self.height

    def split(self, aw, ah):  # noqa: D401
        n = int(ah // self.leading)
        if self.lines is None:
            self.wrap(aw, ah)
        if n < 2 or n >= len(self.lines):
            return []
        mk = lambda ls: TextBlock(self.text, self.size, self.leading, self.bold, self.color, self.rtl, self.indent, None, ls)
        return [mk(self.lines[:n]), mk(self.lines[n:])]

    def _draw_runs(self, x, y, visual, bold):
        c = self.canv
        for f, t in _runs(visual, bold):
            c.setFont(f, self.size)
            c.drawString(x, y, t)
            x += pdfmetrics.stringWidth(t, f, self.size)

    def draw(self):
        c = self.canv
        c.setFillColor(self.color)
        y = self.height - self.size * 1.12
        left = self.indent + self.hang_w
        inner = self.avail - left
        for i, (ln, lrtl) in enumerate(self.lines):
            v = _shape(ln, lrtl)
            w = _width(v, self.size, self.bold)
            x = (self.avail - self.indent - self.hang_w - w) if lrtl else left
            self._draw_runs(x, y, v, self.bold)
            if i == 0 and self.hang:
                c.setFillColor(ACCENT)
                hv = _shape(self.hang, False)
                hx = (self.avail - self.indent - _width(hv, self.size, True)) if self.rtl else self.indent
                self._draw_runs(hx, y, hv, True)
                c.setFillColor(self.color)
            y -= self.leading


class Rule(Flowable):
    def __init__(self, color=RULE, thickness=0.6):
        super().__init__()
        self.color, self.t = color, thickness

    def wrap(self, aw, ah):
        self.aw = aw
        return aw, 3

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.t)
        self.canv.line(0, 1.5, self.aw, 1.5)


def _opt_rtl(text: str, stem_rtl: bool) -> bool:
    if not any(c.isalpha() for c in text):
        return stem_rtl
    return is_rtl(text) or (stem_rtl and not re.search(r"[A-Za-z]{3,}", text))


def display_order(question: dict, shuffle: bool, seed: str) -> list[dict]:
    opts = list(question["options"])
    if shuffle:
        random.Random(f"{seed}:{question['id']}").shuffle(opts)
    return opts


def build_pdf(quiz: dict, questions: list[dict], settings: dict, owner_name: str = "") -> tuple[bytes, dict]:
    """Returns (pdf_bytes, key) where key = {question_id: letter} for this export."""
    register_fonts()
    shuffle = bool(settings.get("shuffle_options", True))
    seed = f"{quiz['id']}:pdf"
    field = settings.get("field", "other")
    buf = io.BytesIO()
    W, H = A4
    margin = 20 * mm
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=22 * mm, bottomMargin=20 * mm,
                          title=quiz["title"], author="Quizzy")
    frame = Frame(margin, 20 * mm, W - 2 * margin, H - 42 * mm, id="f", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    badge = "محتوى اختباري (Test generator) — ليس جودة نهائية" if quiz.get("generator") == "test-generator" else ""
    short_title = quiz["title"][:60]

    def on_page(c, d):
        c.saveState()
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        c.line(margin, 16 * mm, W - margin, 16 * mm)
        c.setFont("QZ-Lat", 8)
        c.setFillColor(MUTED)
        c.drawString(margin, 11 * mm, f"Quizzy · {d.page}")
        v = _shape(short_title, is_rtl(short_title))
        w = _width(v, 8, False)
        x = W - margin - w
        for f, t in _runs(v, False):
            c.setFont(f, 8)
            c.drawString(x, 11 * mm, t)
            x += pdfmetrics.stringWidth(t, f, 8)
        if badge:
            bv = _shape(badge, True)
            c.setFillColor(colors.HexColor("#b45309"))
            bx = (W - _width(bv, 8, False)) / 2
            for f, t in _runs(bv, False):
                c.setFont(f, 8)
                c.drawString(bx, H - 12 * mm, t)
                bx += pdfmetrics.stringWidth(t, f, 8)
        c.restoreState()

    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=on_page)])
    story = []
    story.append(TextBlock(quiz["title"], size=19, bold=True, color=INK, leading=26))
    mode = "اختبار" if settings.get("mode") == "exam" else "تدريب"
    meta = f"{len(questions)} سؤال · {mode} · درجة واحدة لكل سؤال صحيح، بلا خصم على الخطأ"
    story.append(TextBlock(meta, size=9.5, color=MUTED, leading=14))
    if owner_name:
        story.append(TextBlock(f"الاسم: {owner_name}      التاريخ: ____ / ____ / ________", size=9.5, color=MUTED, leading=16, rtl=True))
    story.append(Spacer(1, 4))
    story.append(Rule(ACCENT, 1.2))
    story.append(Spacer(1, 10))

    key: dict[str, str] = {}
    for n, q in enumerate(questions, start=1):
        opts = display_order(q, shuffle, seed)
        for i, o in enumerate(opts):
            if o["id"] == q["correct_option_id"]:
                key[q["id"]] = LETTERS[i]
        rtl = is_rtl(q["stem"].split("\n")[0])
        tag = type_label(q["qtype"], field, "ar" if rtl else "en") if settings.get("pdf_show_type") else None
        block = []
        if tag:
            block.append(TextBlock(tag, size=8, color=MUTED, leading=11, rtl=rtl))
        block.append(TextBlock(q["stem"], size=11, bold=True, leading=17, rtl=None, hang=f"{n}."))
        block.append(Spacer(1, 3))
        for i, o in enumerate(opts):
            block.append(TextBlock(o["text"], size=10.5, leading=16, rtl=_opt_rtl(o["text"], rtl), indent=14, hang=f"{LETTERS[i]}."))
            block.append(Spacer(1, 2))
        block.append(Spacer(1, 9))
        story.append(KeepTogether(block))

    if settings.get("pdf_include_key"):
        story.append(KeepTogether([Spacer(1, 6), Rule(ACCENT, 1.2), Spacer(1, 6),
                                   TextBlock("مفتاح الإجابة (Answer Key)", size=14, bold=True, leading=20, rtl=True)]))
        row, rows = [], []
        for n, q in enumerate(questions, start=1):
            row.append(f"{n}: {key[q['id']]}")
            if len(row) == 8:
                rows.append("    ".join(row))
                row = []
        if row:
            rows.append("    ".join(row))
        for r in rows:
            story.append(TextBlock(r, size=10.5, leading=17, rtl=False, bold=True))
        story.append(Spacer(1, 8))
        if settings.get("pdf_include_explanations", True):
            for n, q in enumerate(questions, start=1):
                rtl = is_rtl(q["explanation"])
                src = ""
                if q.get("source_pages"):
                    src = "  [ص " + ", ".join(str(p) for p in q["source_pages"]) + "]" if rtl else "  [p. " + ", ".join(str(p) for p in q["source_pages"]) + "]"
                story.append(KeepTogether([TextBlock(f"{key[q['id']]}", size=9.5, leading=14, bold=True, rtl=False, hang=f"{n}."),
                                           TextBlock(q["explanation"] + src, size=9.5, leading=14, color=MUTED, rtl=rtl, indent=14),
                                           Spacer(1, 4)]))
    doc.build(story)
    return buf.getvalue(), key
