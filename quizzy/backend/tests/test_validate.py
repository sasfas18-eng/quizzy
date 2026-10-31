from app.services import validate as v


def ctx(text="The mitochondria produce ATP through oxidative phosphorylation in cells.", **kw):
    base = {"page_text": {"d1p1": text}, "allowed_refs": {"d1p1"}, "field": "science", "language": "en", "source_lang_ar": False, "allow_external": False}
    base.update(kw)
    return base


def good(**kw):
    q = {"qtype": "understanding", "stem": "Which organelle produces ATP through oxidative phosphorylation in cells?",
         "options": ["Mitochondria", "Ribosome", "Golgi apparatus", "Lysosome"], "correct_index": 0,
         "explanation": "Mitochondria produce ATP through oxidative phosphorylation, as the lecture states.",
         "purpose": "Identify the organelle responsible for ATP production",
         "evidence": [{"page": "d1p1", "quote": "The mitochondria produce ATP through oxidative phosphorylation"}]}
    q.update(kw)
    return q


def codes(q, c=None):
    return {i["code"] for i in v.validate_question(q, c or ctx())}


def test_good_question_passes():
    assert not v.decisive(v.validate_question(good(), ctx()))


def test_quote_must_exist_in_source():
    assert "evidence_not_found" in codes(good(evidence=[{"page": "d1p1", "quote": "Ribosomes synthesise ATP in the nucleus quickly"}]))


def test_evidence_out_of_scope():
    assert "evidence_out_of_scope" in codes(good(evidence=[{"page": "d1p9", "quote": "The mitochondria produce ATP"}]))


def test_options_structure():
    assert "options_duplicate" in codes(good(options=["A", "A", "B", "C"]))
    assert "options_count" in codes(good(options=["A", "B", "C"]))
    assert "all_none_above" in codes(good(options=["Mitochondria", "Ribosome", "Golgi apparatus", "All of the above"]))


def test_not_except_needs_negation_marker():
    q = good(qtype="not_except")
    assert "not_marker_missing" in codes(q)
    q["stem"] = "Which of the following is NOT produced through oxidative phosphorylation in cells?"
    assert "not_marker_missing" not in codes(q)


def test_sequence_options_must_be_permutations():
    stem = "Order the steps:\n1. A step\n2. B step\n3. C step"
    ok = good(qtype="sequence", stem=stem, options=["1 → 2 → 3", "2 → 1 → 3", "3 → 2 → 1", "1 → 3 → 2"])
    assert "sequence_options_invalid" not in codes(ok)
    bad = good(qtype="sequence", stem=stem, options=["1 → 2 → 3", "2 → 1", "3 → 2 → 1", "1 → 3 → 2"])
    assert "sequence_options_invalid" in codes(bad)


def test_no_clinical_import_outside_health():
    q = good(stem="A patient presents with fatigue; which organelle produces ATP through oxidative phosphorylation?")
    assert "cross_field_import" in codes(q, ctx(field="engineering"))
    assert "cross_field_import" not in codes(q, ctx(field="health"))
    # allowed if the source itself talks about patients
    assert "cross_field_import" not in codes(q, ctx(text="The mitochondria produce ATP through oxidative phosphorylation; a patient may...", field="engineering"))


def test_language_mismatch():
    assert "language_mismatch" in codes(good(), ctx(language="ar"))
    assert "language_mismatch" not in codes(good(stem="أي عضية تنتج ATP عبر الفسفرة التأكسدية في الخلايا؟"), ctx(language="ar"))


def test_calc_check():
    q = good(qtype="application", stem="A heart ejects 70 mL per beat at 72 beats per minute. What is the cardiac output?",
             options=["5040 mL/min", "3500 mL/min", "7200 mL/min", "142 mL/min"], correct_index=0,
             calc={"expression": "70*72", "expected": 5040},
             evidence=[{"page": "d1p1", "quote": "The mitochondria produce ATP through oxidative phosphorylation"}])
    assert not ({"calc_mismatch", "calc_key_mismatch"} & codes(q))
    q["calc"] = {"expression": "70*72", "expected": 5000}
    assert "calc_mismatch" in codes(q)
    q["calc"] = {"expression": "70*72", "expected": 5040}
    q["correct_index"] = 1
    assert "calc_key_mismatch" in codes(q)
    q["calc"] = {"expression": "__import__('os').system('x')", "expected": 1}
    assert "calc_invalid" in codes(q)


def test_duplicates_and_leaks():
    a = good(slot=1)
    near = good(slot=2, stem="Which organelle produces ATP via oxidative phosphorylation within cells?", purpose="Identify organelle for ATP production")
    assert v.duplicate_of(near, [a])
    other = good(slot=3, stem="Where does the Krebs cycle occur?", options=["Matrix", "Cytosol", "Nucleus", "Ribosome"], purpose="Locate Krebs cycle",
                 evidence=[{"page": "d1p1", "quote": "something else entirely different here"}])
    assert not v.duplicate_of(other, [a])
    k = good(slot=4, options=["Oxidative phosphorylation machinery", "Ribosome", "Golgi apparatus", "Lysosome"])
    leaker = good(slot=5, stem="Knowing that the oxidative phosphorylation machinery sits in mitochondria, which organelle makes ATP in cells?")
    assert v.leaks_other(leaker, [k])
    assert not v.leaks_other(other, [k])


def test_safe_eval_blocks_dangerous():
    import pytest
    with pytest.raises(Exception):
        v.safe_eval("2**9999")
    with pytest.raises(Exception):
        v.safe_eval("open('x')")
    assert v.safe_eval("(70*72)/2") == 2520
