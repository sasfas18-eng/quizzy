# python3 claude-edition/test/make_super_pdf.py <out.pdf> — slides with raised and lowered figures (Ca²⁺, CO₂) inside their sentences, as a real
# muscle-physiology slide has them («Ca2+ active transport pumps use ATP to move Ca2+ ions back into SR cisterns»), drawn the way slide software does:
# the figure a smaller run of text, raised (or lowered) from the line.
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
out = sys.argv[1]; c = canvas.Canvas(out, pagesize=landscape(A4)); W, H = landscape(A4)
def run(x, y, parts):
    for text, kind in parts:
        size = 11 if kind else 18; dy = 7 if kind == 'sup' else (-4 if kind == 'sub' else 0)
        c.setFont('Helvetica', size); c.drawString(x, y + dy, text); x += c.stringWidth(text, 'Helvetica', size)
for title, rows in [('Cover', [[('Muscle Physiology', None)]]),
                    ('Relaxation', [[('Cessation of motor neuron impulses stops ACh release', None)],
                                    [('Ca', None), ('2+', 'sup'), (' active transport pumps use ATP to move Ca', None), ('2+', 'sup')],
                                    [('ions back into SR cisterns', None)],
                                    [('Exhaled air carries CO', None), ('2', 'sub'), (' out of the lungs during expiration', None)]]),
                    ('Contraction', [[('Troponin binds calcium and moves tropomyosin off the binding sites', None)], [('Myosin heads attach to actin and pull the filaments together', None)]])]:
    c.setFont('Helvetica-Bold', 26); c.drawString(60, H - 80, title); y = H - 140
    for r in rows: run(70, y, r); y -= 40
    c.showPage()
c.save(); print(out)
