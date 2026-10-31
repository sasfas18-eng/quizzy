"""Heuristic pre-screen: does the selected source plausibly support each quiz task?

This is a cheap, deterministic signal shown to the student before generation and used
to veto tasks with no textual footing (e.g. a sequence question where no ordering exists).
The LLM analysis refines it; the evidence check at validation time is the final gate.
"""
from __future__ import annotations

import re

from .taxonomy import FIELDS, QTYPES

CUES: dict[str, list[str]] = {
    "mechanisms": [r"\bmechanism", r"\bbecause\b", r"\bleads? to\b", r"\bresults? in\b", r"\bcauses?\b", r"\bpathway",
                   r"\bby (?:which|binding|inhibit)", r"آلية", r"بسبب", r"يؤدي إلى", r"ينتج عن", r"مسار", r"يتم ذلك"],
    "application": [r"\bformula", r"\bequation", r"\bcalculate", r"\bexample", r"\bapply", r"=", r"\bsolve", r"\bdose",
                    r"معادلة", r"قانون", r"مثال", r"احسب", r"تطبيق", r"\d+\s*(?:mg|kg|m|s|%|ml|mol|hz|v|a)\b"],
    "compare_contrast": [r"\bvs\.?\b", r"\bversus\b", r"\bdiffer", r"\bcompared? (?:to|with)", r"\bwhereas\b", r"\bunlike\b",
                         r"\bwhile\b", r"\bsimilar", r"\bin contrast", r"بينما", r"بخلاف", r"الفرق", r"مقارنة", r"يختلف", r"على عكس"],
    "sequence": [r"\bstep\s*\d", r"\bfirst\b.*\bthen\b", r"\bstages?\b", r"\bphases?\b", r"\bfollowed by\b", r"\bnext\b",
                 r"\bfinally\b", r"^\s*\d+[\.\)]\s", r"مرحلة", r"خطوة", r"ثم ", r"أولا|أولًا", r"يلي ذلك", r"تسلسل", r"\bprocedure"],
    "critical_thinking": [r"\blimitation", r"\bassum", r"\badvantage", r"\bdisadvantage", r"\bcontroversy", r"\bcriticism",
                          r"\bhowever\b", r"\bevidence", r"\bwhy\b", r"\btrade-?off", r"قيود|محدد|عيوب|مزايا|افتراض|دليل|لكن"],
    "best_answer": [r"\bmost (?:common|important|appropriate|likely)", r"\bfirst[- ]line", r"\bbest\b", r"\bpreferred\b",
                    r"\bindicated\b", r"الأفضل|الأكثر|الأنسب|الخيار الأول"],
    "scenarios": [r"\bcase\b", r"\bpatient", r"\bpresent(?:s|ing|ation)", r"\bdiagnos", r"\btreat", r"\bsymptom", r"\bclient",
                  r"\bscenario", r"\bsituation", r"حالة", r"مريض", r"تشخيص", r"أعراض", r"سيناريو"],
    "not_except": [r"\binclude[sd]?\b", r"\btypes? of\b", r"\bclassif", r"\bfeatures? (?:of|are)", r"\bcharacteristics",
                   r"\bcomponents?", r"\bcriteria", r"\bcategories", r"أنواع", r"تصنيف", r"خصائص", r"مكونات", r"معايير", r"^\s*[-•●▪]\s"],
    "understanding": [r"\bdefin", r"\bmeans?\b", r"\bis (?:a|an|the)\b", r"\brefers? to\b", r"\bconcept", r"\bprinciple", r"تعريف|يعني|مفهوم|مبدأ|هو |هي "],
    "basic_recall": [r"\bdefin", r"\bis (?:a|an|the)\b", r"\d", r"تعريف|هو |هي |\d"],
}
# clinical cues only count for health fields
CLINICAL = re.compile(r"patient|diagnos|symptom|clinical|treatment|therapy|مريض|تشخيص|أعراض|علاج|سريري", re.I)


def _count(patterns: list[str], text: str) -> int:
    n = 0
    for p in patterns:
        n += len(re.findall(p, text, flags=re.I | re.M))
    return n


def analyze_support(pages_text: list[str], field: str = "other") -> dict:
    """Return {type: {level, score, reasons, missing}} for the given page texts."""
    text = "\n".join(pages_text)
    words = max(1, len(re.findall(r"\w+", text)))
    out: dict[str, dict] = {}
    for code in QTYPES:
        hits = _count(CUES.get(code, []), text)
        density = hits / (words / 200)  # hits per ~200 words
        reasons: list[str] = []
        missing: str | None = None
        if code == "scenarios":
            if not FIELDS.get(field, FIELDS["other"])["clinical"]:
                level = "limited" if hits >= 3 else "none"
                missing = "المحتوى لا يحوي حالات/مواقف تطبيقية كافية لبناء سيناريو متخصص." if level == "none" else None
            else:
                clin = len(CLINICAL.findall(text))
                level = "strong" if clin >= 6 else ("limited" if clin >= 2 else "none")
                if level == "none":
                    missing = "لا توجد مادة سريرية (أعراض/تشخيص/علاج) كافية لبناء سيناريو سريري صحيح."
        elif code == "sequence":
            level = "strong" if hits >= 6 else ("limited" if hits >= 2 else "none")
            if level == "none":
                missing = "لا توجد عملية/خطوات/مراحل مرتبة في النطاق المختار."
        elif code == "compare_contrast":
            level = "strong" if hits >= 5 else ("limited" if hits >= 2 else "none")
            if level == "none":
                missing = "لا توجد عناصر متقابلة تُقارن في النص؛ وسّع النطاق ليشمل بدائل/أنواعًا متشابهة."
        elif code == "application":
            level = "strong" if hits >= 5 else ("limited" if hits >= 2 else "none")
            if level == "none":
                missing = "لا توجد قوانين/أمثلة/أرقام لتطبيقها."
        else:
            level = "strong" if density >= 1.0 else ("limited" if hits >= 1 else "none")
            if level == "none":
                missing = "إشارات النص لهذا النوع ضعيفة جدًا."
        if hits:
            reasons.append(f"{hits} إشارة نصية")
        out[code] = {"level": level, "score": hits, "reasons": reasons, "missing": missing}
    out["_meta"] = {"words": words, "pages": len(pages_text)}
    return out
