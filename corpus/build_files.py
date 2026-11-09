#!/usr/bin/env python3
"""python3 corpus/build_files.py [out_dir] - the study files of the development track, from corpus/lectures.json.

Nine original lectures (three heavy, three medium, three light; one in Arabic), written as real slide files the way lecturers
hand them out: a PDF exported from slides (title + bullets, long lines wrapped, a page number) or a PowerPoint deck (title and
content layout, real bullets). Each lecture is ONE file, in the format named in FORMAT, so the track reads both kinds through
the app's own readers. The bytes are reproducible (fixed dates, invariant PDF), so rebuilding changes nothing.
Also writes index.json: [{id, title, density, lang, field, file}] - the list the development page runs through."""
import datetime, json, sys
from pathlib import Path
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
from pptx import Presentation
from pptx.util import Pt

here = Path(__file__).resolve().parent
out = Path(sys.argv[1]) if len(sys.argv) > 1 else here / 'files'
FORMAT = {'cardiac': 'pdf', 'antimicrobials': 'pptx', 'immunology': 'pdf', 'respiratory': 'pptx', 'bacterial_growth': 'pdf',
          'infection_control': 'pptx', 'cell': 'pdf', 'nutrition': 'pptx', 'digestion_ar': 'pptx'}
FIXED = datetime.datetime(2026, 1, 1, 9, 0, 0)


def wrap(text, width):
    """visual lines of at most `width` characters, cut at spaces (a PDF exported from slides stores its lines this way)"""
    lines = []
    while len(text) > width:
        k = text.rfind(' ', 0, width)
        k = k if k > 0 else width
        lines.append(text[:k]); text = text[k + 1:]
    return lines + [text]


def pdf(lec, path):
    c = canvas.Canvas(str(path), pagesize=landscape(A4), invariant=1); W, H = landscape(A4)
    c.setTitle(lec['title']); c.setAuthor('Quizzy corpus')
    for n, s in enumerate(lec['slides'], 1):
        cover = n == 1
        c.setFont('Helvetica-Bold', 30 if cover else 24)
        if cover: c.drawCentredString(W / 2, H / 2 + 40, s['t'])
        else: c.drawString(50, H - 80, s['t'])
        y = H / 2 - 10 if cover else H - 130
        c.setFont('Helvetica', 18 if cover else 15)
        for l in s['l']:
            bullet = l.startswith('- ')
            body = l[2:] if bullet else l
            for i, part in enumerate(wrap(body, 98)):
                if bullet and i == 0 and not cover: c.drawString(60, y, '•')      # the bullet glyph first, as slide software writes it
                if cover: c.drawCentredString(W / 2, y, part)
                else: c.drawString(78 if (bullet or i) else 60, y, part)
                y -= 23
            y -= 9
        if not cover:
            c.setFont('Helvetica', 10); c.drawRightString(W - 40, 28, str(n))
        c.showPage()
    c.save()


def pptx(lec, path):
    prs = Presentation()
    for n, s in enumerate(lec['slides'], 1):
        if n == 1:
            sl = prs.slides.add_slide(prs.slide_layouts[0]); sl.shapes.title.text = s['t']
            sl.placeholders[1].text = '\n'.join(s['l'])
            continue
        if not s['l']:
            sl = prs.slides.add_slide(prs.slide_layouts[5]); sl.shapes.title.text = s['t']; continue
        sl = prs.slides.add_slide(prs.slide_layouts[1]); sl.shapes.title.text = s['t']
        tf = sl.placeholders[1].text_frame
        for i, l in enumerate(s['l']):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = l[2:] if l.startswith('- ') else l
            p.font.size = Pt(20 if len(s['l']) <= 3 else 18)
            if lec['lang'] == 'ar': p.alignment = 3      # right-aligned, as an Arabic deck is written
    cp = prs.core_properties; cp.title = lec['title']; cp.author = 'Quizzy corpus'; cp.last_modified_by = 'Quizzy corpus'
    cp.created = FIXED; cp.modified = FIXED; cp.revision = 1
    prs.save(str(path))


def main():
    lectures = json.loads((here / 'lectures.json').read_text())
    out.mkdir(parents=True, exist_ok=True); index = []
    for lec in lectures:
        kind = FORMAT[lec['id']]; name = f"{lec['id']}.{kind}"
        (pdf if kind == 'pdf' else pptx)(lec, out / name)
        index.append({'id': lec['id'], 'title': lec['title'], 'density': lec['density'], 'lang': lec['lang'], 'field': lec['field'], 'file': name})
        print(f"{name:26s} {lec['density']:7s} {len(lec['slides'])} slides")
    (out / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1) + '\n')


if __name__ == '__main__':
    main()
