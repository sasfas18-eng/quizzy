# python3 claude-edition/test/make_phases_deck.py <out.pdf> — a synthetic deck shaped like a real CVS lecture: one running title over several slides
# («CARDIAC CYCLE: VENTRICULAR SYSTOLE»), each slide a different phase, its heading in capitals either on its own line or opening the first sentence
# («MAXIMUM EJECTION PHASE: The ventricles contract…»).
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
out = sys.argv[1]
slides = [
  (None, ['CARDIAC PHYSIOLOGY', 'Department of Physiology']),
  ('CARDIAC CYCLE', ['From the beginning of one heartbeat to the beginning of the next heartbeat is called the cardiac cycle.', 'The cardiac cycle consists of a period of relaxation called diastole followed by a period of contraction called systole.']),
  ('CONDUCTING SYSTEM OF THE HEART', ['The sinoatrial node is the pacemaker of the heart and starts every normal heartbeat.', 'Purkinje fibres have the fastest conducting velocity of the conducting system.']),
  ('CARDIAC CYCLE: VENTRICULAR SYSTOLE', ['Isovolumetric contraction: The left ventricle begins to contract while every valve stays closed.', 'As the intraventricular pressure rises it pushes the cusps of the atrioventricular valves up.']),
  (None, ['MAXIMUM EJECTION PHASE: The ventricles contract and raise their pressure above the large arteries.', 'The left ventricular pressure rises up to 120 mm Hg and opens the aortic valve.', 'Blood leaves the ventricles rapidly into the aorta and the pulmonary artery.']),
  ('REDUCED EJECTION PHASE', ['The pressure within the ventricles decreases but stays higher than that of the aorta.', 'Less blood flows into the aorta because the ventricles contract more weakly.']),
  ('ISOVOLUMETRIC RELAXATION', ['The semilunar valves remain closed because the arterial pressure is higher than the ventricular pressure.', 'The ventricular pressure is still higher than the atrial pressure, so the atrioventricular valves stay closed.']),
  ('RAPID INFLOW', ['The left ventricular pressure falls to 2-4 mm Hg, below the maximum left atrial pressure.', 'This change in pressure opens the mitral valve and atrial blood rushes into the ventricle.']),
  ('HEART SOUNDS', ['The first heart sound is produced by closure of the atrioventricular valves.', 'The second heart sound is produced by closure of the semilunar valves.']),
]
c = canvas.Canvas(out, pagesize=landscape(A4)); W, H = landscape(A4)
for title, lines in slides:
    y = H - 90
    if title: c.setFont('Helvetica-Bold', 24); c.drawString(50, y, title); y -= 60
    c.setFont('Helvetica', 14)
    for l in lines: c.drawString(50, y, l); y -= 30
    c.showPage()
c.save(); print(out)
