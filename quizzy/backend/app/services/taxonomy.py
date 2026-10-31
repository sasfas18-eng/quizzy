"""The ten-part Quizzy quiz identity, optional specialised tasks, fields and focus weights."""
from __future__ import annotations

QTYPES: dict[str, dict] = {
    "basic_recall": {"n": 1, "en": "Basic Recall", "ar": "الاسترجاع الأساسي",
        "brief": "A single fact, definition, term, number or label stated in the source. No inference."},
    "understanding": {"n": 2, "en": "Understanding", "ar": "فهم المفاهيم",
        "brief": "Tests grasp of a concept's meaning/role/why — not wording recall. Options differ in meaning, not phrasing."},
    "mechanisms": {"n": 3, "en": "Mechanisms & Detail", "ar": "الآليات والتفاصيل",
        "brief": "How/why something works: causal steps, components, conditions, exact details the source gives."},
    "application": {"n": 4, "en": "Application", "ar": "تطبيق المعلومات",
        "brief": "Apply a rule/formula/principle from the source to a new concrete situation or numbers."},
    "critical_thinking": {"n": 5, "en": "Critical Thinking", "ar": "التفكير النقدي",
        "brief": "Evaluate, infer a consequence, spot a flaw, weigh evidence — reasoning that the source's content supports."},
    "scenarios": {"n": 6, "en": "Clinical Scenarios", "ar": "السيناريوهات السريرية",
        "brief": "A realistic case vignette in the student's own field (clinical for health fields, a domain case elsewhere)."},
    "compare_contrast": {"n": 7, "en": "Compare & Contrast", "ar": "المقارنة والتمييز",
        "brief": "Distinguish two or more related items the source treats side by side (differences/similarities)."},
    "best_answer": {"n": 8, "en": "Most Correct / Best Answer", "ar": "اختيار أفضل إجابة",
        "brief": "Several options are partly true; exactly one is the most complete/appropriate per the source."},
    "not_except": {"n": 9, "en": "NOT / EXCEPT", "ar": "الاستثناء أو العبارة غير الصحيحة",
        "brief": "Three options true per the source, one false/not belonging. The stem must contain NOT/EXCEPT (emphasised)."},
    "sequence": {"n": 10, "en": "Sequence / Ordering", "ar": "ترتيب الخطوات أو الأحداث",
        "brief": "Order steps/events/stages the source presents in a defined order; each option is a full ordering."},
}
QTYPE_ORDER = list(QTYPES)

TASKS: dict[str, dict] = {
    "error_diagnosis": {"ar": "تشخيص الخطأ وإصلاحه", "en": "Diagnose & fix the error"},
    "evidence_selection": {"ar": "اختيار الدليل", "en": "Choose the supporting evidence"},
    "assumption_detection": {"ar": "كشف الافتراضات", "en": "Detect hidden assumptions"},
    "counterexample": {"ar": "المثال المضاد وحدود القاعدة", "en": "Counterexample / limits of a rule"},
    "data_sufficiency": {"ar": "كفاية المعطيات", "en": "Data sufficiency"},
    "data_interpretation": {"ar": "تفسير البيانات", "en": "Interpret data"},
    "units_dimensions": {"ar": "الوحدات والأبعاد", "en": "Units & dimensions"},
    "estimation": {"ar": "التقدير والمعقولية", "en": "Estimation & plausibility"},
    "sensitivity": {"ar": "الحساسية للتغير", "en": "Sensitivity to change"},
    "constrained_decision": {"ar": "اتخاذ القرار تحت قيود", "en": "Decision under constraints"},
    "representation_conversion": {"ar": "التحويل بين التمثيلات", "en": "Convert between representations"},
    "hypothesis_discrimination": {"ar": "تمييز الفرضيات", "en": "Discriminate hypotheses"},
    "experiment_design": {"ar": "تصميم اختبار أو تجربة", "en": "Design a test/experiment"},
    "argument_check": {"ar": "فحص الحجة أو البرهان", "en": "Check an argument/proof"},
    "necessary_sufficient": {"ar": "الشرط اللازم والكافي", "en": "Necessary vs sufficient"},
    "inverse_problem": {"ar": "المسألة العكسية", "en": "Inverse problem"},
    "uncertainty": {"ar": "عدم اليقين", "en": "Uncertainty"},
    "scope_of_applicability": {"ar": "نطاق انطباق النص أو القاعدة", "en": "Scope of applicability"},
}

FIELDS: dict[str, dict] = {
    "health": {"ar": "العلوم الصحية والطبية", "scenario_ar": "سيناريو سريري", "clinical": True,
        "scenario_guidance": "Write a realistic CLINICAL vignette (patient presentation, findings) strictly using the concepts in the source."},
    "science": {"ar": "العلوم الطبيعية", "scenario_ar": "حالة علمية", "clinical": False,
        "scenario_guidance": "Write a laboratory/field/natural-phenomenon case. Do NOT use patients or clinical framing."},
    "engineering": {"ar": "الهندسة", "scenario_ar": "حالة هندسية", "clinical": False,
        "scenario_guidance": "Write a design/operation/failure case with concrete parameters. No clinical framing."},
    "cs": {"ar": "علوم الحاسب والبرمجيات", "scenario_ar": "حالة برمجية", "clinical": False,
        "scenario_guidance": "Write a system/code/debugging case. No clinical framing."},
    "math": {"ar": "الرياضيات والإحصاء", "scenario_ar": "مسألة تطبيقية", "clinical": False,
        "scenario_guidance": "Write an applied problem with explicit givens. No clinical framing."},
    "business": {"ar": "الأعمال والاقتصاد", "scenario_ar": "حالة عملية", "clinical": False,
        "scenario_guidance": "Write a business/economic decision case with figures. No clinical framing."},
    "law": {"ar": "القانون", "scenario_ar": "واقعة قانونية", "clinical": False,
        "scenario_guidance": "Write a factual legal situation to be analysed under the rule in the source. No clinical framing."},
    "humanities": {"ar": "الإنسانيات والاجتماعيات", "scenario_ar": "حالة تحليلية", "clinical": False,
        "scenario_guidance": "Write a short analytical case/excerpt situation tied to the source's concepts. No clinical framing."},
    "other": {"ar": "تخصص آخر", "scenario_ar": "حالة تطبيقية", "clinical": False,
        "scenario_guidance": "Write a realistic applied case in the subject of the source. No clinical framing."},
}


def scenario_label(field: str, lang: str = "ar") -> str:
    f = FIELDS.get(field) or FIELDS["other"]
    if lang == "ar":
        return f["scenario_ar"]
    return "Clinical Scenario" if f["clinical"] else "Domain Case Scenario"


def type_label(code: str, field: str = "other", lang: str = "ar") -> str:
    if code == "scenarios":
        return scenario_label(field, lang)
    return QTYPES[code]["ar" if lang == "ar" else "en"]


# Base weights: not a rigid equal split — follows content, level and chosen focus.
BASE_WEIGHTS = {
    "basic_recall": 0.12, "understanding": 0.14, "mechanisms": 0.12, "application": 0.12,
    "critical_thinking": 0.08, "scenarios": 0.10, "compare_contrast": 0.10,
    "best_answer": 0.08, "not_except": 0.07, "sequence": 0.07,
}
FOCUS = {
    "balanced": {},
    "understand_apply": {"understanding": 2.0, "application": 2.2, "mechanisms": 1.4, "scenarios": 1.5, "basic_recall": 0.5},
    "critical": {"critical_thinking": 3.0, "best_answer": 1.8, "scenarios": 1.6, "not_except": 1.3, "basic_recall": 0.4},
    "recall": {"basic_recall": 3.0, "not_except": 1.4, "sequence": 1.4, "compare_contrast": 1.2, "critical_thinking": 0.4, "scenarios": 0.4},
}
FOCUS_AR = {"balanced": "متوازن", "understand_apply": "فهم وتطبيق", "critical": "تفكير نقدي", "recall": "استرجاع"}
DIFFICULTY_AR = {"easy": "سهلة", "medium": "متوسطة", "hard": "متقدمة", "mixed": "متنوعة"}
LANG_OPTIONS = ("source", "ar", "en")


_FIELD_CUES = {
    "health": r"patient|clinical|diagnos|symptom|treatment|therapy|disease|cardiac|ventric|pharmac|anatom|physiolog|syndrome|مريض|سريري|تشخيص|أعراض|علاج|مرض|قلب|دواء|تشريح",
    "science": r"experiment|molecule|chemical|reaction|organelle|mitochond|species|ecosystem|photosynth|atom|تجربة|جزيء|تفاعل|خلية|ذرة|كيمياء|أحياء|فيزياء",
    "engineering": r"circuit|voltage|stress|beam|torque|thermodynamic|signal|turbine|دائرة|جهد|هندس|عزم|إشارة",
    "cs": r"algorithm|function|variable|database|compiler|network|software|code|complexity|خوارزمية|برمج|قاعدة بيانات|شبكة",
    "math": r"theorem|proof|integral|derivative|matrix|probability|variance|equation|نظرية|برهان|تكامل|مشتقة|مصفوفة|احتمال",
    "business": r"market|revenue|profit|strategy|customer|accounting|inflation|supply|demand|سوق|إيراد|ربح|استراتيجية|محاسبة|اقتصاد",
    "law": r"statute|contract|plaintiff|court|liability|jurisdiction|tort|قانون|عقد|محكمة|مسؤولية|دعوى",
    "humanities": r"literature|philosoph|historical|society|culture|political|psycholog|أدب|فلسفة|تاريخ|مجتمع|ثقافة|سياسة|نفس",
}


def detect_field(text: str) -> str:
    """Infer the subject area from the source itself (students are no longer asked)."""
    import re
    best, score = "other", 2  # need at least 3 cue hits
    for k, rx in _FIELD_CUES.items():
        n = len(re.findall(rx, text or "", flags=re.I))
        if n > score:
            best, score = k, n
    return best
