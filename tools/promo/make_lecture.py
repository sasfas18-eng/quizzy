"""A short, clean sample lecture (the cardiac cycle) for the intro video: landscape slides, one fact per line, so every line reads back as written."""
import sys
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

SLIDES = [
    ("Cardiac Physiology", ["The Cardiac Cycle", "Lecture 3"]),
    ("Phases of the Cardiac Cycle", [
        "The cardiac cycle is the sequence of events in one complete heartbeat.",
        "Systole is the phase of ventricular contraction, and diastole is the phase of ventricular relaxation.",
        "During isovolumetric contraction, all four heart valves are closed and ventricular pressure rises rapidly.",
        "Ventricular ejection begins when ventricular pressure exceeds aortic pressure and the semilunar valves open."]),
    ("Heart Valves and Heart Sounds", [
        "The atrioventricular valves prevent backflow of blood from the ventricles into the atria.",
        "The semilunar valves prevent backflow of blood from the arteries into the ventricles.",
        "The first heart sound (S1) is produced by closure of the atrioventricular valves.",
        "The second heart sound (S2) is produced by closure of the semilunar valves."]),
    ("Ventricular Volumes", [
        "End-diastolic volume is the volume of blood in each ventricle at the end of diastole.",
        "End-systolic volume is the volume of blood remaining in each ventricle after ejection.",
        "Stroke volume equals end-diastolic volume minus end-systolic volume.",
        "Ejection fraction is the stroke volume divided by the end-diastolic volume."]),
    ("Cardiac Output", [
        "Cardiac output is the volume of blood pumped by each ventricle per minute.",
        "Cardiac output equals heart rate multiplied by stroke volume.",
        "Sympathetic stimulation increases both heart rate and myocardial contractility.",
        "Parasympathetic stimulation through the vagus nerve decreases heart rate."]),
]

def main(out):
    w, h = landscape(A4); c = canvas.Canvas(out, pagesize=(w, h))
    for i, (title, lines) in enumerate(SLIDES):
        c.setFillColorRGB(0.06, 0.36, 0.31); c.rect(0, h - 70, w, 70, fill=1, stroke=0)
        c.setFillColorRGB(1, 1, 1); c.setFont("Helvetica-Bold", 26); c.drawString(36, h - 48, title)
        c.setFillColorRGB(0.1, 0.1, 0.1)
        if i == 0:
            c.setFont("Helvetica", 22)
            for k, t in enumerate(lines): c.drawString(36, h - 160 - 40 * k, t)
        else:
            c.setFont("Helvetica", 13)
            for k, t in enumerate(lines): c.drawString(36, h - 130 - 44 * k, "• " + t)
        c.showPage()
    c.save()

if __name__ == "__main__":
    main(sys.argv[1])
