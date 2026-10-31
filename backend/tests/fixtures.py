"""Builds small real PDF/PPTX files for tests (no network, no stored binaries)."""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.services.quiz_pdf import _runs, _shape, register_fonts
from reportlab.pdfbase import pdfmetrics

EN_PAGES = [
    ["Cardiac Cycle Overview",
     "The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat.",
     "Systole is the phase of ventricular contraction that ejects blood into the aorta and pulmonary artery.",
     "Diastole is the phase of ventricular relaxation during which the ventricles fill with blood.",
     "Cardiac output equals stroke volume multiplied by heart rate, for example 70 mL x 72 beats per minute = 5040 mL per minute."],
    ["Phases of the Ventricular Cycle",
     "The ventricular cycle proceeds through four phases in a fixed order:",
     "1. Isovolumetric contraction closes the atrioventricular valves and raises ventricular pressure.",
     "2. Ejection opens the semilunar valves and ejects blood into the arteries.",
     "3. Isovolumetric relaxation closes the semilunar valves while pressure falls.",
     "4. Filling opens the atrioventricular valves and the ventricles refill with blood."],
    ["Left versus Right Ventricle",
     "The left ventricle has a thick muscular wall whereas the right ventricle has a thinner wall.",
     "Left ventricular pressure during systole reaches about 120 mmHg, unlike the right ventricle which reaches about 25 mmHg.",
     "The left ventricle supplies the systemic circulation while the right ventricle supplies the pulmonary circulation.",
     "A patient presenting with exertional dyspnea and a displaced apex beat may have left ventricular hypertrophy, which is diagnosed by echocardiography."],
]
AR_PAGES = [
    ["مقدمة في الخلية",
     "الخلية هي الوحدة الأساسية للحياة في جميع الكائنات الحية.",
     "الميتوكوندريا هي العضية المسؤولة عن إنتاج الطاقة على شكل ATP داخل الخلية.",
     "النواة تحتوي على المادة الوراثية DNA وتتحكم في أنشطة الخلية المختلفة."],
]


def make_pdf(path: Path, en=True, with_image_page=True, ar=False) -> Path:
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    W, H = A4
    pages = (AR_PAGES if ar else EN_PAGES)
    for pg in pages:
        y = H - 70
        for i, line in enumerate(pg):
            size = 18 if i == 0 else 12
            if ar:
                v = _shape(line, True)
                x = W - 60
                w = sum(pdfmetrics.stringWidth(t, f, size) for f, t in _runs(v, False))
                x = W - 60 - w
                for f, t in _runs(v, False):
                    c.setFont(f, size)
                    c.drawString(x, y, t)
                    x += pdfmetrics.stringWidth(t, f, size)
            else:
                c.setFont("QZ-Lat", size)
                c.drawString(60, y, line)
            y -= 30 if i == 0 else 22
        c.showPage()
    if with_image_page and not ar:
        img = Image.new("RGB", (400, 300), (200, 220, 240))
        c.drawImage(ImageReader(img), 80, 300, 400, 300)
        c.showPage()
    c.save()
    return path


def make_pptx(path: Path) -> Path:
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    for pg in EN_PAGES[:2]:
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = pg[0]
        tf = s.placeholders[1].text_frame
        tf.text = pg[1]
        for ln in pg[2:]:
            tf.add_paragraph().text = ln
    s = prs.slides.add_slide(prs.slide_layouts[6])  # picture-only slide
    img = io.BytesIO()
    Image.new("RGB", (200, 100), (10, 200, 10)).save(img, "PNG")
    img.seek(0)
    s.shapes.add_picture(img, Inches(1), Inches(1))
    prs.save(str(path))
    return path


def _sample_pages(name: str) -> list[str]:
    import json
    root = Path(__file__).resolve().parents[2] / "claude-edition" / "test" / "samples" / "pages.json"
    return json.loads(root.read_text(encoding="utf-8"))[name]


def make_slides_pptx(path: Path, name: str = "slides_en") -> Path:
    """Realistic bullet-style slides: first line = title, the rest = body paragraphs (PPTX bullets are formatting, so no bullet glyphs)."""
    import re
    from pptx import Presentation
    prs = Presentation()
    for text in _sample_pages(name):
        lines = [re.sub(r"^[•\-\*]\s*", "", ln) for ln in text.split("\n")]
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = lines[0]
        tf = s.placeholders[1].text_frame
        tf.text = lines[1] if len(lines) > 1 else ""
        for ln in lines[2:]:
            tf.add_paragraph().text = ln
    prs.save(str(path))
    return path


def make_notes_pdf(path: Path, name: str = "notes_en") -> Path:
    """Dense paragraph text (lecture notes), one page per sample, wrapped."""
    import textwrap
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    for text in _sample_pages(name):
        y = A4[1] - 70
        c.setFont("QZ-Lat", 12)
        for para in text.split("\n"):
            for ln in textwrap.wrap(para, 85) or [""]:
                c.drawString(55, y, ln)
                y -= 19
            y -= 6
        c.showPage()
    c.save()
    return path


def make_sparse_pdf(path: Path) -> Path:
    """A one-page PDF with four words: readable (a title-like page) but far too little to build any testable objective from."""
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("QZ-Lat", 14)
    c.drawString(60, A4[1] - 90, "Handout available online soon")
    c.showPage()
    c.save()
    return path
