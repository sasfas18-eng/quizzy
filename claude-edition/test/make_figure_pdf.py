"""python3 make_figure_pdf.py <out.pdf> - a small lecture for the figure reader's test (run_figures.js):
 page 1 the cover; page 2 text; page 3 «three regions» with a LARGE labelled drawing (the reader is asked); page 4 text with a SMALL logo (never sent);
 page 5 text with a LARGE picture that carries no lecture text (asked, nothing added); page 6 text;
 page 7 a slide whose own text TEACHES (30 words and more) beside a LARGE picture (never sent: its questions come from its text);
 page 8 a TABLE whose cells are separate text boxes (its text comes back in scattered pieces): read in layout mode, row by row."""
import io, sys
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

def drawing(labels, size=(900, 600), fill=(250, 235, 230)):
    im = Image.new('RGB', size, 'white'); d = ImageDraw.Draw(im)
    d.ellipse([120, 80, 620, 540], outline=(120, 40, 40), width=6, fill=fill); d.ellipse([240, 200, 500, 420], outline=(120, 40, 40), width=4)
    for k, t in enumerate(labels): y = 120 + k * 140; d.line([560, y, 700, y], fill='black', width=3); d.text((710, y - 8), t, fill='black')
    b = io.BytesIO(); im.save(b, 'PNG'); b.seek(0); return ImageReader(b)

W, H = landscape(A4); c = canvas.Canvas(sys.argv[1], pagesize=(W, H))
def page(title, lines, img=None, box=None):
    c.setFont('Helvetica-Bold', 26); c.drawString(50, H - 70, title); c.setFont('Helvetica', 16)
    for k, l in enumerate(lines): c.drawString(50, H - 120 - k * 26, l)
    if img: c.drawImage(img, *box)
    c.showPage()
page('Kidney Physiology', ['Lecture 4', 'Department of Physiology'])
page('Functions of the kidney', ['The kidney filters the blood and removes waste products as urine.', 'It regulates water balance, electrolytes and blood pressure.', 'It produces erythropoietin, which stimulates red blood cell production.'])
page('Regions of the kidney', ['The kidney has three regions shown in the figure below.'], drawing(['Renal cortex', 'Renal medulla', 'Renal pelvis']), (180, 40, 480, 320))
page('The nephron', ['The nephron is the functional unit of the kidney.', 'Each kidney contains about one million nephrons.', 'Blood is filtered in the glomerulus into Bowman capsule.'], drawing([], (120, 120)), (W - 70, H - 70, 50, 50))
page('Glomerular filtration', ['Glomerular filtration rate is about 125 mL per minute in adults.', 'Filtration depends on the pressure in the glomerular capillaries.'], drawing([], fill=(220, 235, 250)), (200, 30, 420, 280))
page('Tubular reabsorption', ['Most filtered sodium is reabsorbed in the proximal tubule.', 'Antidiuretic hormone increases water reabsorption in the collecting duct.', 'Aldosterone increases sodium reabsorption in the distal tubule.'])
page('Renal blood flow', ['The kidneys receive about one fifth of the cardiac output at rest, roughly 1.1 litres of blood per minute.', 'Blood enters through the renal artery, which divides into segmental, interlobar, arcuate and interlobular arteries.', 'Afferent arterioles carry blood to the glomeruli and efferent arterioles carry it away.'], drawing(['Renal artery'], fill=(240, 220, 220)), (500, 30, 300, 200))
def table(title, rows):
    c.setFont('Helvetica-Bold', 26); c.drawString(50, H - 70, title); c.setFont('Helvetica', 16)
    for k, (a, b) in enumerate(rows): y = H - 130 - k * 40; c.drawString(60, y, a); c.drawString(380, y - 7, b)      # the second column a little lower: separate pieces, as in real slides
    c.showPage()
table('Acid base disorders', [('Disorder', 'Cause'), ('Respiratory acidosis', 'inadequate ventilation'), ('Respiratory alkalosis', 'hyperventilation'), ('Metabolic acidosis', 'diarrhea'), ('Metabolic alkalosis', 'vomiting')])
c.save()
