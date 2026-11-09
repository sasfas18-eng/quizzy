# python3 claude-edition/test/make_fragments_deck.py <out.pdf> — a lecture written the way many slide decks are: short fragments under labels, no full stops
# («• Glomerulus» / «– Tuft of capillaries inside Bowman's capsule»), a symbol with its charge set as a small raised run («Na» «+»), and a bullet that wraps onto
# a second line. The owner's reader files every line of nine words or fewer without a full stop as a «short label»; a real 50-question quiz of such a lecture
# lost 24 of its 54 drafts to the evidence rule and ended at 21. Original text (renal physiology), written for this test.
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
S = [
 ('Renal Physiology', ['Lecture 4', 'Department of Physiology']),
 ('Learning Objectives', ['- Describe the parts of the nephron', '- Explain how urine is formed']),
 ('The Nephron', [('•', 'Nephron'), ('–', 'Functional unit of the kidney'), ('–', 'About one million nephrons in each kidney'), ('•', 'Renal corpuscle'), ('–', 'Glomerulus plus the surrounding Bowman capsule'), ('–', 'Site where blood plasma is first filtered')]),
 ('Glomerulus', [('•', 'Glomerulus'), ('–', 'Tuft of capillaries inside Bowman capsule'), ('–', 'Fed by the afferent arteriole of the kidney'), ('–', 'Drained by the narrower efferent arteriole'), ('•', 'Podocytes'), ('–', 'Cells whose foot processes wrap the capillaries')]),
 ('Filtration Barrier', [('•', 'Three layers'), ('–', 'Fenestrated endothelium of the glomerular capillaries'), ('–', 'Basement membrane with a negative charge'), ('–', 'Filtration slits between the podocyte foot processes'), ('•', 'Blocked'), ('–', 'Plasma proteins such as albumin stay in blood')]),
 ('Glomerular Filtration Rate', [('•', 'Normal value'), ('–', 'About 125 mL of filtrate formed each minute'), ('–', 'About 180 litres of filtrate formed each day'), ('•', 'Reabsorbed'), ('–', 'Roughly ninety-nine percent of the filtrate returns')]),
 ('Proximal Tubule', [('•', 'Reabsorption'), ('–', 'Most filtered water and sodium reabsorbed here'), ('–', 'All filtered glucose returned by SGLT2 carriers'), ('–', 'Amino acids almost completely reabsorbed here'), ('•', 'Brush border'), ('–', 'Microvilli enlarge the surface for absorption')]),
 ('Sodium Transport', [('•', 'Pump'), ('sup', 'Na', '+', '/K', '+', ' ATPase on the basolateral membrane'), ('–', 'Keeps sodium low inside the tubule cells'), ('•', 'Entry'), ('–', 'Sodium enters the cell down its gradient')]),
 ('Loop of Henle', [('•', 'Descending limb'), ('–', 'Permeable to water but not to solutes'), ('•', 'Thick ascending limb'), ('–', 'Pumps sodium and chloride out of the lumen'), ('–', 'Impermeable to water so the fluid becomes dilute'), ('wrap', 'Builds the medullary gradient that the collecting duct uses to concentrate urine later')]),
 ('Distal Tubule and Collecting Duct', [('•', 'Aldosterone'), ('–', 'Raises sodium reabsorption by the principal cells'), ('–', 'Raises potassium secretion into the tubular fluid'), ('•', 'ADH'), ('–', 'Inserts aquaporin channels into collecting duct cells'), ('–', 'Allows a small volume of concentrated urine')]),
 ('Renin-Angiotensin System', [('•', 'Renin'), ('–', 'Released by juxtaglomerular cells when pressure falls'), ('–', 'Converts angiotensinogen into angiotensin I'), ('•', 'Angiotensin II'), ('–', 'Constricts arterioles and releases aldosterone'), ('–', 'Stimulates thirst and the release of ADH')]),
 ('Acid-Base Role', [('•', 'Bicarbonate'), ('–', 'Filtered bicarbonate reclaimed mainly in the proximal tubule'), ('•', 'Hydrogen ions'), ('–', 'Secreted by intercalated cells into the lumen'), ('–', 'Buffered in the urine by phosphate and ammonia')]),
 ('Renal Clearance', [('•', 'Clearance'), ('–', 'Plasma volume cleared of a substance per minute'), ('•', 'Inulin'), ('–', 'Filtered but neither reabsorbed nor secreted'), ('–', 'Its clearance therefore equals the filtration rate'), ('•', 'Creatinine'), ('–', 'Used in clinical practice to estimate filtration')]),
 ('Micturition', [('•', 'Ureters'), ('–', 'Move urine to the bladder by peristalsis'), ('•', 'Bladder'), ('–', 'Stretch of its wall triggers the voiding reflex'), ('–', 'Detrusor muscle contracts under parasympathetic control'), ('–', 'External sphincter remains under voluntary control')]),
 ('Thank You', ['Questions?']),
]
c = canvas.Canvas(sys.argv[1], pagesize=landscape(A4), invariant=1); W, H = landscape(A4)
for title, lines in S:
    c.setFont('Helvetica-Bold', 26); c.drawString(50, H - 80, title); y = H - 130
    for l in lines:
        if isinstance(l, str): c.setFont('Helvetica', 16); c.drawString(60, y, l); y -= 32; continue
        kind = l[0]
        if kind == 'sup':      # «– Na+/K+ ATPase …»: the charges as small raised runs
            x = 78; c.setFont('Helvetica', 16); c.drawString(60, y, '–')
            for i, part in enumerate(l[1:]):
                if i % 2 == 1 and part in ('+', '-', '2+'): c.setFont('Helvetica', 10); c.drawString(x, y + 7, part); x += c.stringWidth(part, 'Helvetica', 10)
                else: c.setFont('Helvetica', 16); c.drawString(x, y, part); x += c.stringWidth(part, 'Helvetica', 16)
            y -= 32; continue
        if kind == 'wrap':     # a long bullet wrapped onto a second line
            c.setFont('Helvetica', 16); c.drawString(60, y, '–'); words = l[1].split(' '); first = ' '.join(words[:6]); rest = ' '.join(words[6:])
            c.drawString(78, y, first); y -= 24; c.drawString(78, y, rest); y -= 32; continue
        c.setFont('Helvetica-Bold' if kind == '•' else 'Helvetica', 17 if kind == '•' else 15); c.drawString(60 if kind == '•' else 78, y, kind + ' ' + l[1]); y -= 30
    c.showPage()
c.save(); print(sys.argv[1], len(S), 'slides')
