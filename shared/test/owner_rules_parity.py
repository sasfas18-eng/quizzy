"""python3 shared/test/owner_rules_parity.py — the JavaScript port (shared/owner_rules.js) must decide EXACTLY as the owner's lecture_reader.py:
same units (offsets), same decision, category and reason, on a corpus of real sample lectures, the server's fixtures, Arabic and English
metadata lines, objectives pages, presenter credits, references, tables, mixed blocks. Also checks quiz_engine's signature/letters."""
import json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
import lecture_reader as LR  # the owner's file, as written
from tests import fixtures

def corpus():
    out = []
    samples = json.loads((ROOT / "claude-edition/test/samples/pages.json").read_text())
    for name, pages in samples.items():
        out.append((name, [{"number": i + 1, "blocks": [{"text": p if isinstance(p, str) else p["text"]}]} for i, p in enumerate(pages)]))
    for name, pages in (("fixture_en", fixtures.EN_PAGES), ("fixture_ar", fixtures.AR_PAGES)):
        out.append((name, [{"number": i + 1, "blocks": [{"text": pg[0], "kind": "heading"}, {"text": "\n".join(pg[1:])}]} for i, pg in enumerate(pages)]))
    tricky = [
        ("Lecture 7", "heading"), ("Prepared by Dr. Ahmed", "text"), ("College of Nursing", "text"), ("Learning Outcomes", "heading"),
        ("• Identify the structures of the urinary system.\n• Describe urine formation.", "text"), ("Each kidney contains approximately 1 million nephrons.", "text"),
        ("History of Nursing", "heading"), ("Dr. Loretta Ford developed the first nurse practitioner program in 1965.", "text"), ("Renal cortex", "heading"), ("Outer layer", "text"),
        ("Blood filtration occurs in the renal cortex.", "text"), ("أهداف المحاضرة", "heading"), ("• أن يكون الطالب قادرًا على شرح الدورة القلبية\n• يحدد مراحل الانقباض", "text"),
        ("إعداد: د. سعد مقبل", "text"), ("جامعة الملك سعود", "text"), ("القلب هو عضو عضلي يضخ الدم إلى جميع أجزاء الجسم.", "text"), ("تتكون الكلية من مليون نيفرون تقريبًا.", "text"),
        ("References", "heading"), ("Guyton AC (2016). Textbook of Medical Physiology. Elsevier.", "text"), ("https://www.example.com/page", "text"), ("Email: dr@uni.edu", "text"),
        ("Slide 12 of 40", "text"), ("© 2024 Pearson Education. All rights reserved.", "text"), ("Thank you!", "text"), ("شكرا لكم", "text"), ("Date: 12/03/2025", "text"),
        ("Systole: the contraction phase in which the ventricles eject blood.", "text"), ("Stroke volume (SV)", "text"), ("Assess the patient's pain level every 4 hours.", "text"),
        ("Figure 3 The nephron", "text"), ("Prepared by Dr. Smith. The heart has four chambers.", "text"), ("Explain the cardiac cycle\nThe heart contracts in two phases.", "text"),
        ("Lecturer is Dr. Omar", "text"), ("By the end of this lecture, students will be able to describe the nephron.", "text"), ("Table: Normal values\nNa 135-145", "table"),
        ("٣ من ١٠", "text"), ("Week 3", "text"), ("2023-2024", "text"), ("Due date: Friday", "text"), ("Course code: NUR 210", "text"), ("Any questions?", "text"),
        ("The ventricle is cone-shaped.", "text"), ("1.5 liters per minute", "text"), ("Department of Physiology", "text"), ("Prof. Ahmed Ali", "text"),
    ]
    out.append(("tricky", [{"number": i + 1, "blocks": [{"text": "Topic heading", "kind": "heading"}, {"text": t, "kind": k}]} for i, (t, k) in enumerate(tricky)]))
    out.append(("tricky_one_page", [{"number": 1, "blocks": [{"text": t, "kind": k} for t, k in tricky]}]))
    margin = [{"number": i + 1, "blocks": [{"text": "Physiology 101 - Page %d" % (i + 1), "bbox": [0, .95, 1, .99]}, {"text": "The heart pumps blood number %d." % i}]} for i in range(6)]
    out.append(("margins", margin))
    return out

def py_units(pages):
    P = [LR.Page(p["number"], tuple(LR.Block(b["text"], tuple(b["bbox"]) if b.get("bbox") else None, b.get("kind", "text"), b.get("region", "body"), b.get("layout_verified", False)) for b in p["blocks"]), True) for p in pages]
    r = LR.read_pages(P, "doc")
    return [[u.unit_id, u.start, u.end, u.decision, u.category, u.reason] for u in r.units]

data = corpus()
js = subprocess.run(["node", "-e", """
const R = require(process.argv[1]); const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = data.map(([name, pages]) => { const P = pages.map((p) => R.Page(p.number, p.blocks.map((b) => R.Block(b.text, b.bbox || null, b.kind || 'text', b.region || 'body', !!b.layout_verified)), true));
  return [name, R.readPages(P, 'doc').units.map((u) => [u.unit_id, u.start, u.end, u.decision, u.category, u.reason])]; });
const sig = ['Heart\\u2019s: 3 ×', 'الدورة القلبية!', 'ABC_def 12'].map(R.signature);
console.log(JSON.stringify({ out, sig }));""", str(ROOT / "shared/owner_rules.js")], input=json.dumps(data), capture_output=True, text=True, check=True)
res = json.loads(js.stdout)
units = total = 0
for (name, pages), (jname, junits) in zip(data, res["out"]):
    pyu = py_units(pages); assert name == jname
    if pyu != junits:
        for a, b in zip(pyu, junits):
            if a != b: print("MISMATCH", name, "\n  py:", a, "\n  js:", b)
        print(name, "units py/js:", len(pyu), len(junits)); sys.exit(1)
    units += len(pyu); total += 1
from quiz_engine import signature  # the owner's file, as written
assert res["sig"] == [signature(t) for t in ["Heart’s: 3 ×", "الدورة القلبية!", "ABC_def 12"]], res["sig"]
decisions = {}
for name, pages in data:
    for u in py_units(pages): decisions[u[3]] = decisions.get(u[3], 0) + 1
print(f"owner rules parity ok: {units} units in {total} documents decided identically by lecture_reader.py and its JavaScript port {decisions}")
