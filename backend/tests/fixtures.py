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

PAPER_TEXT = [
    ("Renal Physiology: Glomerular Filtration", None),
    ("Abstract", "The kidney filters about 180 litres of plasma every day, yet excretes only one to two litres of urine. "
     "This handout reviews how the glomerular filtration barrier, the Starling forces and the autoregulatory mechanisms "
     "together keep the glomerular filtration rate remarkably constant across a wide range of arterial pressures."),
    ("1. The filtration barrier", "The glomerular filtration barrier consists of three layers: the fenestrated endothelium, the glomerular "
     "basement membrane and the slit diaphragms between podocyte foot processes. Podocytes are specialised epithelial cells that wrap "
     "around the glomerular capillaries. The barrier restricts the passage of molecules according to their size and electrical charge, "
     "so albumin, which is negatively charged, is largely retained in the blood. Proteinuria results from damage to the slit diaphragm "
     "proteins such as nephrin and podocin."),
    ("2. Starling forces", "Filtration is driven by the balance of hydrostatic and oncotic pressures across the capillary wall. The glomerular "
     "capillary hydrostatic pressure is about 55 mmHg, which is much higher than in other capillary beds because the efferent arteriole "
     "offers considerable resistance. Net filtration pressure is the hydrostatic pressure in the glomerular capillary minus the pressure in "
     "Bowman's space and the plasma oncotic pressure. The glomerular filtration rate is the volume of plasma filtered by both kidneys per "
     "minute, normally about 125 mL/min in a healthy adult."),
    ("3. Autoregulation", "Autoregulation keeps renal blood flow and filtration stable when the mean arterial pressure varies between 80 and "
     "180 mmHg. The myogenic response is the contraction of the afferent arteriole when its wall is stretched by a rise in pressure. "
     "Tubuloglomerular feedback is the mechanism by which the macula densa senses the sodium chloride delivered to the distal tubule and "
     "adjusts afferent arteriolar tone. Angiotensin II constricts the efferent arteriole more than the afferent arteriole, which preserves "
     "the filtration rate when renal perfusion falls."),
    ("4. Clinical assessment", "Creatinine clearance is used to estimate the glomerular filtration rate because creatinine is freely filtered "
     "and only slightly secreted. Inulin is the reference marker, but it must be infused, so it is used mainly in research. A falling "
     "filtration rate leads to the accumulation of urea, potassium and hydrogen ions in the plasma."),
    ("References", None),
    ("[1] Guyton AC, Hall JE. Textbook of Medical Physiology. 13th ed. Philadelphia: Elsevier; 2016.", None),
    ("[2] Koeppen BM, Stanton BA. Renal Physiology. 6th ed. Mosby; 2018. doi:10.1016/example", None),
]


def make_paper_pdf(path: Path) -> Path:
    """A real-world-like HANDOUT: two justified columns, words hyphenated at line ends, a running header and a page number, an e-mail line and a
    references list - the PDF layout that cut every sentence at each line end before the text was put back into paragraphs."""
    register_fonts()
    W, H = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    col_w, gap, left, top, bottom, size, lead = 235, 25, 50, H - 95, 70, 10, 13.5
    cols = [left, left + col_w + gap]
    page, col, y = 1, 0, top

    def header():
        c.setFont("QZ-Lat", 8); c.drawString(left, H - 45, "Physiology Handouts - Renal Block"); c.drawRightString(W - left, 40, str(page))

    def newline():
        nonlocal col, y, page
        y -= lead
        if y < bottom:
            col += 1; y = top
            if col > 1:
                c.showPage(); page += 1; col = 0; header()

    def wrap_words(text, font, sz):
        lines, cur = [], ""
        for w in text.split():
            trial = (cur + " " + w).strip()
            if pdfmetrics.stringWidth(trial, font, sz) <= col_w:
                cur = trial; continue
            # hyphenate a long word at the line end when half of it still fits
            if len(w) >= 9:
                for cut in range(len(w) - 4, 3, -1):
                    part = (cur + " " + w[:cut] + "-").strip()
                    if pdfmetrics.stringWidth(part, font, sz) <= col_w:
                        lines.append(part); cur = w[cut:]; break
                else:
                    lines.append(cur); cur = w
            else:
                lines.append(cur); cur = w
        if cur: lines.append(cur)
        return lines

    header()
    c.setFont("QZ-Lat", 17); c.drawString(left, H - 75, PAPER_TEXT[0][0])
    c.setFont("QZ-Lat", 8); c.drawString(left, H - 88, "Department of Physiology - teaching.renal@uni.example.edu")
    for head, body in PAPER_TEXT[1:]:
        c.setFont("QZ-Lat", 11.5 if body else size); c.drawString(cols[col], y, head); newline()
        if not body: continue
        c.setFont("QZ-Lat", size)
        lines = wrap_words(body, "QZ-Lat", size)
        for i, ln in enumerate(lines):
            words = ln.split()
            if i < len(lines) - 1 and len(words) > 1:      # justified, like a real handout
                spare = col_w - pdfmetrics.stringWidth(ln, "QZ-Lat", size); x = cols[col]; extra = spare / (len(words) - 1)
                for w in words:
                    c.drawString(x, y, w); x += pdfmetrics.stringWidth(w + " ", "QZ-Lat", size) + extra
            else:
                c.drawString(cols[col], y, ln)
            newline()
        y -= 6
    c.showPage(); c.save()
    return path


SCANNED_SLIDES = [
    ["Cell Energy Metabolism", "Mitochondria produce ATP through oxidative phosphorylation.", "Glycolysis occurs in the cytoplasm and yields two pyruvate molecules.",
     "The Krebs cycle takes place in the mitochondrial matrix.", "Oxidative phosphorylation depends on the electron transport chain."],
    ["Enzymes", "Enzymes are biological catalysts that lower the activation energy of reactions.", "Competitive inhibitors bind to the active site of the enzyme.",
     "Temperature and pH change the rate of enzyme activity.", "The active site is the region where the substrate binds."],
]


def make_scanned_pdf(path: Path, noise: bool = False) -> Path:
    """A SCANNED lecture: every page is a picture of text (no text layer at all), the way a photocopied handout or a phone photo arrives. Optional noise:
    a grey gradient and speckles, like a poor photocopy."""
    import random
    from PIL import ImageDraw, ImageFont
    font_dir = Path(__file__).resolve().parents[1] / "app" / "assets" / "fonts"
    big, small = ImageFont.truetype(str(font_dir / "DejaVuSans-Bold.ttf"), 46), ImageFont.truetype(str(font_dir / "DejaVuSans.ttf"), 30)
    pages = []
    for slide in SCANNED_SLIDES:
        im = Image.new("L", (1650, 1150), 255); d = ImageDraw.Draw(im)
        if noise:
            for x in range(0, 1650, 6): d.line([(x, 0), (x, 1150)], fill=255 - int(60 * x / 1650))
            rnd = random.Random(7)
            for _ in range(9000): d.point((rnd.randrange(1650), rnd.randrange(1150)), fill=rnd.randrange(0, 120))
        d.text((90, 80), slide[0], font=big, fill=20)
        for i, line in enumerate(slide[1:]): d.text((90, 220 + i * 90), line, font=small, fill=25)
        pages.append(im.convert("RGB"))
    pages[0].save(str(path), save_all=True, append_images=pages[1:], resolution=150)
    return path


def make_diagram_pptx(path: Path) -> Path:
    """Slides whose text is NOT in the slide's own shapes: a SmartArt diagram (its text lives in ppt/diagrams/dataN.xml, the way PowerPoint stores it) and a
    chart (title and category labels in ppt/charts/chartN.xml) - read without any text recognition."""
    import zipfile
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = "Chain of Infection"      # the SmartArt slide (diagram added below)
    s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = "Bacterial Growth by Temperature"
    data = CategoryChartData(); data.categories = ["Psychrophiles", "Mesophiles", "Thermophiles"]; data.add_series("Optimal growth rate", (3, 9, 5))
    ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.5), Inches(8), Inches(5), data).chart
    ch.has_title = True; ch.chart_title.text_frame.text = "Growth of microbes at different temperatures"
    s = prs.slides.add_slide(prs.slide_layouts[1]); s.shapes.title.text = "Portal of Exit"
    s.placeholders[1].text_frame.text = "The portal of exit is the site from where micro-organisms leave the host."
    tmp = path.with_suffix(".tmp.pptx"); prs.save(str(tmp))
    nodes = ["Infectious agent", "Reservoir", "Portal of exit", "Mode of transmission", "Portal of entry", "Susceptible host"]
    pts = "".join(f'<dgm:pt modelId="{{{i + 10}}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>{t}</a:t></a:r></a:p></dgm:t></dgm:pt>' for i, t in enumerate(nodes))
    data_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="{0}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>root</a:t></a:r></a:p></dgm:t></dgm:pt>'
                + pts + '</dgm:ptLst><dgm:cxnLst/></dgm:dataModel>')
    frame = ('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="99" name="Diagram 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="1371600"/><a:ext cx="7315200" cy="4572000"/></p:xfrm>'
             '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" '
             'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:dm="rIdDgm1" r:lo="rIdDgm2" r:qs="rIdDgm3" r:cs="rIdDgm4"/></a:graphicData></a:graphic></p:graphicFrame>')
    with zipfile.ZipFile(tmp) as zin, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            b = zin.read(item.filename)
            if item.filename == "ppt/slides/slide1.xml":
                b = b.decode().replace("</p:spTree>", frame + "</p:spTree>").encode()
            if item.filename == "ppt/slides/_rels/slide1.xml.rels":
                b = b.decode().replace("</Relationships>", '<Relationship Id="rIdDgm1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data1.xml"/></Relationships>').encode()
            zout.writestr(item, b)
        zout.writestr("ppt/diagrams/data1.xml", data_xml)
    tmp.unlink()
    return path
