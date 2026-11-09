# python3 claude-edition/test/make_long_deck.py <out.pdf> [pages] — a long slide lecture (default 40 slides of text) for timing uploads and deletes
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
out = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 40
c = canvas.Canvas(out, pagesize=landscape(A4)); W, H = landscape(A4)
for i in range(1, n + 1):
    c.setFont('Helvetica-Bold', 24); c.drawString(50, H - 80, f'Topic {i}: Cell Physiology Part {i}')
    c.setFont('Helvetica', 14); y = H - 130
    for k in range(1, 6):
        c.drawString(60, y, f'- Fact {k} of topic {i}: the membrane protein P{i}{k} moves the solute S{i}{k} across the cell membrane.'); y -= 28
    c.showPage()
c.save(); print(out, n, 'slides')
