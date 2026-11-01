"""Versioned prompts. Bump PROMPT_VERSION on any wording change; every question stores it."""
from __future__ import annotations

import json

from .taxonomy import FIELDS, QTYPES, TASKS

PROMPT_VERSION = "p1.1"

QUALITY_RULES = """You write exam-grade multiple-choice questions for university students from THEIR OWN lecture material.
Student satisfaction depends on question quality, clarity and usefulness. Quality beats quantity: if a slot cannot be done
correctly from the source, return it as unwritable with a reason instead of inventing content.

Hard rules
1. Source only (unless the settings say supplement is allowed): every fact needed to pick the key AND the explanation must be
   stated in the cited pages. Never import knowledge from another field (e.g. no medical/clinical framing outside health fields).
2. Exactly 4 options, exactly 1 correct. Distractors are plausible, drawn from related concepts/common confusions in the same
   source, similar in length, grammar and specificity to the key. No "all/none of the above", no "both A and B", no joke options.
3. Stem is self-contained and unambiguous; do not say "according to the slide/page"; never refer to other questions.
   Do not leak other questions' answers. Do not put the answer's distinctive words in the stem.
4. Evidence: for each cited page copy a VERBATIM quote (<= 300 chars) that supports the key. Quotes are machine-checked
   against the page text; paraphrased quotes make the question fail.
5. Explanation: say why the key is right and why the closest distractor is wrong, using the source's own content. 2-4 sentences.
6. `purpose` = one sentence naming exactly what skill/knowledge this question measures. Questions in a quiz must not share
   purpose or reasoning pattern: different facts, different solving routes — not renamed copies.
7. Numbers/calculations: put every numerical result in `calc` as {"expression": "<python arithmetic only>", "expected": <number>}
   and make the key's number equal `expected`. Keep units consistent.
8. Option order: do NOT try to randomise; put the correct option anywhere. The system re-orders and keys by option id.
9. Technical terms stay in their original language (e.g. English) when writing in Arabic; use LaTeX inside $...$ only for real formulas.

Difficulty: easy = one step, direct from a statement; medium = needs understanding of 1-2 linked statements; hard = multi-step
reasoning/discrimination between close alternatives, still fully answerable from the source."""

TYPE_FORMATS = {
    "basic_recall": "Direct factual recall of a definition/term/number/label from the source.",
    "understanding": "Ask about meaning/role/reason; distractors are misconceptions, not wording variants.",
    "mechanisms": "Ask how/why in causal detail (steps, components, conditions) given in the source.",
    "application": "New concrete situation or numbers that require applying a rule/formula/principle from the source.",
    "critical_thinking": "Evaluate/infer/spot a flaw or limitation; reasoning must be derivable from the source.",
    "scenarios": "Case vignette (see field guidance) with the necessary details; ask for diagnosis/decision/explanation the source supports.",
    "compare_contrast": "Differentiate between items the source discusses side by side; a single distinguishing criterion.",
    "best_answer": "All options may be partly true; exactly one is the most complete/appropriate according to the source. Say 'best/most appropriate' in the stem.",
    "not_except": "Stem must contain the capitalised word NOT or EXCEPT (Arabic: 'ما عدا' / 'غير صحيحة'). Three options are true per the source; the key is the false/foreign one.",
    "sequence": "List the items in the stem (numbered 1..n, in shuffled order). Each option is a COMPLETE ordering of those same items (e.g. '2 → 4 → 1 → 3'). Use only an order the source states.",
}


def analyze_prompt(pages: list[dict], field: str, lang: str, supplement: bool) -> tuple[str, str]:
    system = (
        "You analyse lecture material to plan a quiz. Be conservative: only claim a task is supported if the pages contain "
        "the material for it. Pages are labelled by ref (e.g. d1p5). Never invent content."
    )
    types_desc = "\n".join(f'- "{k}": {v["brief"]}' for k, v in QTYPES.items())
    tasks_desc = ", ".join(TASKS)
    body = json.dumps(
        [{"ref": p["ref"], "text": p["text"][:6000]} for p in pages], ensure_ascii=False)
    prompt = f"""Field of study: {field} ({FIELDS.get(field, FIELDS['other'])['ar']}).
Task: split the pages into learning OBJECTIVES (each a distinct teachable unit, 1-6 pages), and for each decide which quiz types
the pages genuinely support.

Quiz types:
{types_desc}
Optional specialised tasks (use as `task` on a type only when it fits the content): {tasks_desc}

Return JSON:
{{"lecture_character": "<2 sentences: style/density/what kind of exam fits this lecture>",
 "discipline_guess": "<one of {list(FIELDS)}>",
 "objectives": [{{"id": "o1", "statement": "<what the student should know/do, in the source language>",
   "pages": ["d1p3"], "key_terms": ["..."],
   "capacity": <int 1-4: how many DISTINCT, non-duplicative questions this objective can yield>,
   "supports": {{"basic_recall": {{"pages": ["d1p3"]}}, "mechanisms": {{"pages": ["d1p3"], "task": null}}}}}}],
 "gaps": ["<important thing the pages mention but do not explain enough to examine>"]}}
Only list a type under `supports` if the cited pages contain what is needed (e.g. sequence only if an explicit order exists;
scenarios only if the content lets you write a correct case). External knowledge allowed: {"yes (flag it)" if supplement else "NO"}.

PAGES:
{body}"""
    return system, prompt


def profile_prompt(pages: list[dict], field: str) -> tuple[str, str]:
    """The lecture profiler (internal agent): how many DISTINCT, fully answerable questions of each type can these pages sustain?"""
    system = ("You profile lecture material for a quiz generator. For EACH quiz type decide how many DISTINCT, fully answerable questions of that type the pages can sustain. "
              "Be conservative and literal: count only what the text itself supports (never outside knowledge), and give 0 when the pages give no real basis. "
              "Pages are labelled by ref (e.g. d1p5). Never invent content.")
    types_desc = "\n".join(f'- "{k}": {v["brief"]}' for k, v in QTYPES.items())
    shape = ",".join(f'"{k}":{{"capacity":<integer 0-40>,"pages":["d1p3"]}}' for k in QTYPES)
    body = json.dumps({p["ref"]: p["text"][:1100] for p in pages}, ensure_ascii=False)
    return system, f"Quiz types:\n{types_desc}\nSubject guess: {field}.\nReturn JSON: {{\"types\":{{{shape}}}}}\nPAGES:\n{body}"


def generate_prompt(slots: list[dict], pages: dict[str, str], settings: dict, existing: list[dict], feedback: dict[int, list[str]]) -> tuple[str, str]:
    field = settings.get("field", "other")
    lang = settings.get("language", "source")
    lang_rule = {"source": "Write in the language of the source pages.", "ar": "Write the question text in Arabic (keep technical terms in English).",
                 "en": "Write in English."}[lang]
    supplement = settings.get("external_mode") == "supplement"
    system = QUALITY_RULES + f"\n\n{lang_rule}\nField guidance for scenarios: {FIELDS.get(field, FIELDS['other'])['scenario_guidance']}"
    slot_desc = []
    for s in slots:
        slot_desc.append({
            "slot": s["slot"], "type": s["qtype"], "format": TYPE_FORMATS[s["qtype"]], "difficulty": s["difficulty"],
            "objective": s["objective"], "task": TASKS.get(s.get("task") or "", {}).get("en"), "pages": s["pages"],
            "reinforcement": {"variant": s.get("variant"), "angle": s.get("angle")} if s.get("extra") else None,
            "retry_feedback": feedback.get(s["slot"]) or None})
    reinforcement_note = ""
    if any(s.get("extra") for s in slots):
        reinforcement_note = (
            "\nSlots that carry \"reinforcement\" are EXTRA questions on material that may already have been asked. The topic may overlap with an accepted question, "
            "but ask a DIFFERENT specific fact or take the direction named by \"angle\" (reverse: start from the answer's side; other_fact: another fact stated on the pages; "
            "not_true: which statement is NOT true; apply: a short applied example of the same facts; compare: contrast two items from the pages; detail: a specific term, number or step) "
            "- never a reworded copy of an accepted question. Every other rule still holds: verbatim evidence from the cited pages, one correct option, source only. "
            "Do not return such a slot as unwritable just because the topic was covered: vary the angle.\n")
    prompt = f"""Write one question per slot, using ONLY the cited pages.
External knowledge: {"allowed but set uses_external=true when used" if supplement else "NOT allowed"}.

Already accepted questions (do NOT repeat their purpose, fact or reasoning route, and do not leak their answers):
{json.dumps(existing[-40:], ensure_ascii=False)}
{reinforcement_note}
SLOTS:
{json.dumps(slot_desc, ensure_ascii=False)}

PAGES:
{json.dumps(pages, ensure_ascii=False)}

Return JSON:
{{"questions": [{{"slot": <int>, "unwritable_reason": null,
 "stem": "...", "options": ["...","...","...","..."], "correct_index": <0-3>,
 "explanation": "...", "purpose": "...", "reasoning_pattern": "...",
 "evidence": [{{"page": "d1p3", "quote": "<verbatim from page>"}}],
 "calc": null, "uses_external": false}}]}}
If a slot cannot be written correctly: {{"slot": n, "unwritable_reason": "<why>"}}."""
    return system, prompt


def verify_prompt(q: dict, pages: dict[str, str], lang: str) -> tuple[str, str]:
    system = (
        "You are a strict, independent exam reviewer and test-taker. You see only the source pages and one question "
        "WITHOUT its key. First solve it using only the source, then audit it. Be skeptical; do not assume the question is good."
    )
    prompt = f"""SOURCE PAGES:
{json.dumps(pages, ensure_ascii=False)}

QUESTION type={q['qtype']}:
{q['stem']}
{json.dumps(q['options'], ensure_ascii=False)}

Return JSON:
{{"chosen_index": <0-3 or null if you cannot decide from the source>,
 "answerable_from_source": <bool: all facts needed are in the pages>,
 "single_best_answer": <bool: exactly one option is correct/best; no second defensible option>,
 "sufficient_data": <bool: stem gives enough information; nothing essential missing>,
 "needs_outside_knowledge": <bool>,
 "flaws": ["<concrete defects: ambiguity, give-away, wrong fact, two keys, bad distractor, wrong units ...>"],
 "severity": "none" | "minor" | "decisive"}}"""
    return system, prompt


def verify_explanation_prompt(q: dict, key_text: str, pages: dict[str, str]) -> tuple[str, str]:
    system = "You check whether an explanation is correct and supported by the source pages only."
    prompt = f"""SOURCE PAGES:
{json.dumps(pages, ensure_ascii=False)}
QUESTION: {q['stem']}
KEY: {key_text}
EXPLANATION: {q['explanation']}
Return JSON: {{"explanation_supported": <bool>, "contradicts_source": <bool>, "notes": "<short>"}}"""
    return system, prompt


def verify_batch_prompt(items: list[dict], pages: dict[str, str]) -> tuple[str, str]:
    """Blind-solve + audit SEVERAL questions in one call. items: [{"id","qtype","stem","options"}] (no keys)."""
    system = (
        "You are a strict, independent exam reviewer and test-taker. You see only the source pages and several questions "
        "WITHOUT their keys. For EACH question: solve it using only the source, then audit it. Be skeptical; judge every "
        "question independently of the others."
    )
    prompt = f"""SOURCE PAGES:
{json.dumps(pages, ensure_ascii=False)}

QUESTIONS:
{json.dumps(items, ensure_ascii=False)}

Return JSON:
{{"results": [{{"id": "<same id>", "chosen_index": <0-3 or null if you cannot decide from the source>,
 "answerable_from_source": <bool>, "single_best_answer": <bool>, "sufficient_data": <bool>,
 "needs_outside_knowledge": <bool>, "flaws": ["<concrete defects>"], "severity": "none" | "minor" | "decisive"}}]}}"""
    return system, prompt


def explain_batch_prompt(items: list[dict], pages: dict[str, str]) -> tuple[str, str]:
    """items: [{"id","stem","key","explanation"}]"""
    system = "You check whether each explanation is correct and supported by the source pages only."
    prompt = f"""SOURCE PAGES:
{json.dumps(pages, ensure_ascii=False)}

ITEMS:
{json.dumps(items, ensure_ascii=False)}

Return JSON: {{"results": [{{"id": "<same id>", "explanation_supported": <bool>, "contradicts_source": <bool>, "notes": "<short>"}}]}}"""
    return system, prompt


def cards_prompt(pages: dict[str, str], n: int, lang: str, field: str, supplement: bool) -> tuple[str, str]:
    lang_rule = {"source": "same language as the source", "ar": "Arabic (keep technical terms in English)", "en": "English"}[lang]
    system = (
        "You create spaced-repetition flashcards from lecture pages. Each card tests ONE atomic idea, front is a clear, "
        "self-contained question or concept prompt (no yes/no, no 'what does the slide say'), back is a short precise answer "
        "(1-3 lines) plus, if useful, one memory hook taken from the source. Only use the pages. No duplicates, no trivia."
    )
    prompt = f"""Write up to {n} cards (fewer if the pages do not support {n} distinct good ones). Language: {lang_rule}.
Return JSON: {{"cards":[{{"front":"...","back":"...","page":"d1p3","quote":"<verbatim from that page>"}}]}}
PAGES:
{json.dumps(pages, ensure_ascii=False)}"""
    return system, prompt
