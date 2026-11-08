# python3 claude-edition/test/make_sections_deck.py <out.pdf> — a synthetic slide deck whose sections run over several slides, marked the ways lecturers mark
# them: «(1/3)», «(continued)», «Part 2», and none at all (a slide without a heading continues its section). Five content sections + a cover and objectives.
import sys
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
out = sys.argv[1]
slides = [
  ('Lecture 5: The Heart as a Pump', ['Dr. Example Lecturer', 'Department of Physiology']),
  ('Objectives', ['- Describe the phases of the cardiac cycle', '- Explain how the conduction system starts each beat', '- Calculate cardiac output']),
  ('Cardiac Cycle (1/3)', ['- Atrial systole pushes the last fifth of ventricular filling into the ventricles.', '- The atrioventricular valves stay open while the atria contract.']),
  ('Cardiac Cycle (2/3)', ['- Isovolumetric contraction begins when the atrioventricular valves close.', '- Ventricular pressure rises quickly while every valve remains closed.']),
  ('Cardiac Cycle (3/3)', ['- Ventricular ejection starts once ventricular pressure exceeds aortic pressure.', '- Isovolumetric relaxation follows the closure of the semilunar valves.']),
  ('Conduction System', ['- The sinoatrial node generates the impulse that starts every normal heartbeat.', '- The atrioventricular node delays the impulse so the ventricles can fill.']),
  ('Conduction System (continued)', ['- The bundle of His carries the impulse into the interventricular septum.', '- Purkinje fibres spread the impulse rapidly through both ventricular walls.']),
  ('Heart Sounds', ['- The first heart sound is produced by closure of the atrioventricular valves.', '- The second heart sound is produced by closure of the semilunar valves.']),
  ('Cardiac Output - Part 1', ['- Cardiac output equals heart rate multiplied by stroke volume.', '- A resting adult heart pumps about five litres of blood every minute.']),
  ('Cardiac Output - Part 2', ['- Stroke volume rises when venous return stretches the ventricular muscle.', '- This stretch relationship is described by the Frank-Starling mechanism.']),
  ('Regulation of Heart Rate', ['- Sympathetic stimulation increases heart rate through noradrenaline release.', '- Parasympathetic stimulation through the vagus nerve slows the heart rate.']),
]
c = canvas.Canvas(out, pagesize=landscape(A4)); W, H = landscape(A4)
for title, lines in slides:
    c.setFont('Helvetica-Bold', 26); c.drawString(60, H - 90, title); c.setFont('Helvetica', 16); y = H - 150
    for l in lines: c.drawString(70, y, l); y -= 34
    c.showPage()
c.save(); print(out)
