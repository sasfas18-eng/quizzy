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


# ------------------------------------------------------------------ fixtures for the lecture reader (tables, notes, charts, scans)
EN_SCAN = ["Cell Energy Metabolism",
           "Mitochondria produce ATP through oxidative phosphorylation.",
           "Glycolysis occurs in the cytoplasm and yields two pyruvate molecules.",
           "The Krebs cycle takes place in the mitochondrial matrix."]
AR_SCAN = ["الطاقة في الخلية",
           "الميتوكوندريا هي العضية المسؤولة عن إنتاج الطاقة.",
           "يحدث التحلل السكري في السيتوبلازم وينتج جزيئين من البيروفات.",
           "تتم دورة كريبس في مصفوفة الميتوكوندريا."]


def _text_image(lines: list[str], ar: bool = False, size: int = 46, width: int = 1500):
    """Text rendered as a plain image (what a scan or a screenshot looks like): no text layer anywhere."""
    from PIL import ImageDraw, ImageFont
    from app.services.quiz_pdf import FONTS
    font = ImageFont.truetype(str(FONTS / ("NotoSansArabic-Regular.ttf" if ar else "DejaVuSans.ttf")), size)
    from PIL import features
    raqm = features.check("raqm")           # with raqm Pillow shapes/bidi-orders Arabic itself: feed it the LOGICAL text
    pad, step = 60, int(size * 1.9)
    img = Image.new("L", (width, pad * 2 + step * len(lines)), 255)
    d = ImageDraw.Draw(img)
    y = pad
    for ln in lines:
        if ar and raqm:
            d.text((width - pad, y), ln, font=font, fill=0, direction="rtl", language="ar", anchor="ra")
        else:
            t = _shape(ln, ar)
            x = width - pad - d.textlength(t, font=font) if ar else pad
            d.text((x, y), t, font=font, fill=0)
        y += step
    return img.convert("RGB")


def make_scanned_pdf(path: Path) -> Path:
    """Two image-only pages: page 1 English, page 2 Arabic. A scanned lecture: the text layer is empty."""
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    W, H = A4
    for ar in (False, True):
        img = _text_image(AR_SCAN if ar else EN_SCAN, ar=ar, size=40, width=1800)
        w = W - 60
        h = w * img.height / img.width
        c.drawImage(ImageReader(img), 30, H - 60 - h, w, h)
        c.showPage()
    c.save()
    return path


def make_noisy_scan_pdf(path: Path, level: str = "poor") -> Path:
    """The same two scanned pages (English, Arabic) degraded like a photo of a page: tilt, noise, blur, uneven light, JPEG, low resolution.
    "mild" must still be read by OCR; "poor" must be refused as unreadable (garbage text would become wrong questions). Deterministic."""
    import io, random
    from PIL import ImageChops, ImageFilter
    P = {"mild": dict(rot=1.0, sigma=10, blur=0.6, q=60, scale=0.6, shadow=0.0), "poor": dict(rot=2.0, sigma=18, blur=0.9, q=45, scale=0.5, shadow=0.25)}[level]
    rng = random.Random(7)

    def degrade(img):
        img = img.convert("L")
        img = img.resize((int(img.width * P["scale"]), int(img.height * P["scale"])), Image.LANCZOS)
        if P["shadow"]:
            g = Image.linear_gradient("L").resize(img.size).rotate(30, fillcolor=255).point(lambda v: 255 - int(v * P["shadow"]))
            img = ImageChops.multiply(img, g)
        if P["blur"]:
            img = img.filter(ImageFilter.GaussianBlur(P["blur"]))
        noise = bytes(max(0, min(255, int(128 + rng.gauss(0, P["sigma"])))) for _ in range(img.width * img.height))
        img = ImageChops.add(img, Image.frombytes("L", img.size, noise), scale=1.0, offset=-128)
        img = img.rotate(P["rot"], expand=True, fillcolor=255, resample=Image.BICUBIC)
        buf = io.BytesIO(); img.convert("RGB").save(buf, "JPEG", quality=P["q"]); buf.seek(0)
        return Image.open(buf)

    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    W, H = A4
    for ar in (False, True):
        img = degrade(_text_image(AR_SCAN if ar else EN_SCAN, ar=ar, size=40, width=1800))
        w = W - 60
        h = w * img.height / img.width
        c.drawImage(ImageReader(img), 30, H - 60 - h, w, h)
        c.showPage()
    c.save()
    return path


TABLE_EN = [["Drug", "Dose", "Route"], ["Aspirin", "75 mg", "Oral"], ["Heparin", "5000 IU", "IV"], ["Insulin", "10 units", "Subcutaneous"]]
TABLE_AR = [["الدواء", "الجرعة", "الطريق"], ["أسبرين", "٧٥ ملغ", "فموي"], ["هيبارين", "٥٠٠٠ وحدة", "وريدي"], ["إنسولين", "١٠ وحدات", "تحت الجلد"]]


def make_tables_pdf(path: Path) -> Path:
    """Page 1: an English table (with a sentence above and below). Page 2: an Arabic table (first column on the right)."""
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    W, H = A4
    xs = [60, 230, 400]
    # page 1
    c.setFont("QZ-Lat", 18); c.drawString(60, H - 70, "Drug dosing overview")
    c.setFont("QZ-Lat", 12); c.drawString(60, H - 100, "The table below lists the usual adult doses.")
    y = H - 140
    for r, row in enumerate(TABLE_EN):
        c.setFont("QZ-Lat-B" if r == 0 else "QZ-Lat", 12)
        for x, cell in zip(xs, row):
            c.drawString(x, y, cell)
        y -= 26
    c.setFont("QZ-Lat", 12); c.drawString(60, y - 20, "Doses must be adjusted for renal function in older patients.")
    c.showPage()
    # page 2 (Arabic: columns right-to-left, each cell right-aligned to its column edge)
    right = [W - 60, W - 230, W - 400]
    y = H - 140
    c.setFont("QZ-Ar-B", 18)
    t = _shape("جدول الجرعات الدوائية", True)
    c.drawString(W - 60 - pdfmetrics.stringWidth(t, "QZ-Ar-B", 18), H - 70, t)
    for r, row in enumerate(TABLE_AR):
        for edge, cell in zip(right, row):
            v = _shape(cell, True)
            runs = _runs(v, r == 0)
            w = sum(pdfmetrics.stringWidth(tt, f, 12) for f, tt in runs)
            x = edge - w
            for f, tt in runs:
                c.setFont(f, 12); c.drawString(x, y, tt); x += pdfmetrics.stringWidth(tt, f, 12)
        y -= 26
    c.showPage()
    c.save()
    return path


def make_rich_pptx(path: Path) -> Path:
    """Slide 1: table. 2: chart. 3: body + speaker notes. 4: a picture that contains the lecture text (no text in the slide XML)."""
    import tempfile
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Drug dosing overview"
    tbl = s.shapes.add_table(len(TABLE_EN), 3, Inches(0.7), Inches(2.0), Inches(8.6), Inches(2.2)).table
    for r, row in enumerate(TABLE_EN):
        for k, cell in enumerate(row):
            tbl.cell(r, k).text = cell
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Cardiac output by condition"
    cd = CategoryChartData()
    cd.categories = ["Rest", "Exercise", "Sepsis"]
    cd.add_series("Cardiac output (L/min)", (5.0, 15.0, 9.0))
    s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.7), Inches(2.0), Inches(8.6), Inches(4.2), cd)
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Stroke volume"
    s.placeholders[1].text_frame.text = "Stroke volume is the blood ejected by one ventricle in one beat."
    s.notes_slide.notes_text_frame.text = "Speaker notes: emphasise that stroke volume depends on preload, afterload and contractility."
    img = _text_image(["Frank-Starling law", "Stretch of the ventricle increases the force of contraction.", "Preload is the end-diastolic filling of the ventricle."], size=40, width=1600)
    s = prs.slides.add_slide(prs.slide_layouts[6])
    with tempfile.TemporaryDirectory() as td:
        png = Path(td) / "figure.png"
        img.save(png)
        s.shapes.add_picture(str(png), Inches(0.5), Inches(1.0), width=Inches(9.0))
    prs.save(str(path))
    return path


def make_grid_table_pdf(path: Path) -> Path:
    """A PDF whose table is drawn with ruling lines (the kind a table detector can see), with text above and below it."""
    register_fonts()
    c = canvas.Canvas(str(path), pagesize=A4)
    W, H = A4
    c.setFont("QZ-Lat", 12)
    c.drawString(60, H - 80, "The table below lists the usual adult doses.")
    xs, row_h, y0 = [60, 230, 400, 535], 26, H - 120
    for r in range(len(TABLE_EN) + 1):
        c.line(xs[0], y0 - r * row_h, xs[-1], y0 - r * row_h)
    for x in xs:
        c.line(x, y0, x, y0 - len(TABLE_EN) * row_h)
    for r, row in enumerate(TABLE_EN):
        c.setFont("QZ-Lat-B" if r == 0 else "QZ-Lat", 12)
        for k, cell in enumerate(row):
            c.drawString(xs[k] + 8, y0 - r * row_h - 17, cell)
    c.setFont("QZ-Lat", 12)
    c.drawString(60, y0 - len(TABLE_EN) * row_h - 30, "Doses must be adjusted for renal function in older patients.")
    c.showPage()
    c.save()
    return path
