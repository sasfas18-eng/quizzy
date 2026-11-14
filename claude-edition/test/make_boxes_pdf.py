# python3 claude-edition/test/make_boxes_pdf.py <out.pdf> — a slide of boxes, arrows and a table row, WRITTEN BOTTOM-UP the way a real nursing slide was
# («Dealing With the Terminal Patient»: its last box came first in the file, each cell broken into short lines).
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
out = sys.argv[1]; c = canvas.Canvas(out, pagesize=landscape(A4)); W, H = landscape(A4)
c.setFont('Helvetica-Bold', 24); c.drawString(60, H - 70, 'Cover: Nursing Ethics'); c.showPage()
def box(x, y, w, lines, size=13):
    c.rect(x, y - 6 - (len(lines) - 1) * (size + 3), w, (len(lines)) * (size + 3) + 10)
    c.setFont('Helvetica', size)
    for i, l in enumerate(lines): c.drawCentredString(x + w / 2, y + 4 - i * (size + 3) - 6, l)
# drawn bottom-up, as the slide software wrote it
box(80, 130, 680, ['Respect for human dignity is the fundamental principle when making ethical decisions for practice'])
box(80, 210, 680, ['Then patients can approach loss and death without fear and with a sense of peace'])
cells = [['Fear is', 'relieved'], ['Pain is', 'managed'], ['The needs for', 'reconciliation with loved', 'ones are met'], ['Spiritual', 'needs are', 'met']]
for i, cl in enumerate(cells): box(80 + i * 170, 330, 160, cl)
box(80, 420, 680, ['Professionals involved with end-of-life care feel strongly that', 'when'], 14)
c.setFont('Helvetica-Bold', 26); c.drawString(60, H - 70, 'Dealing With the Terminal Patient')
c.showPage(); c.save(); print(out)
