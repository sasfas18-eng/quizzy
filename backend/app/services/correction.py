"""The ARABIC CORRECTION of a wrong (or blank) answer: made on demand, never during generation (a quiz costs nothing more), kept with the attempt.

The model is free in its phrasing, never in its facts, so what it returns is CHECKED: it must be Arabic, it must keep the ORIGINAL (the correct answer verbatim when it is short, otherwise one of
its key terms) and it may not bring a number the lecture does not contain. A first attempt that fails gets ONE retry that says what was wrong; if only the original was forgotten it is named first;
otherwise there is no correction (the page keeps the plain slip). Mirrors claude-edition/engine.js (P.correction / checkCorrection / makeCorrection)."""
from __future__ import annotations

import json
import re

SHORT_ANSWER = 60
SYSTEM = """You are a warm, sharp Arabic-speaking tutor. A student got a multiple-choice question from THEIR OWN lecture wrong (or left it blank). Write the correction so that it sticks: clear, vivid, friendly Modern Standard Arabic.
Rules
1. Faithful: use ONLY what the lecture sentence and the lecture's explanation below say. Add no fact, number, example, cause or definition that is not in them. Creativity lives in the phrasing and in at most ONE short memory hook (a vivid image, a contrast or a tiny mnemonic) built only from the words and ideas of that sentence.
2. Keep the ORIGINAL: the correct answer and every technical term stay in their original language and spelling, exactly as in the lecture, each next to its Arabic meaning, for example: الكهربائية (electrical).
3. Name the correction first: begin with «الصواب: » followed by the correct answer exactly as given.
4. In one clause say why the student's choice does not fit - only if the lecture sentence shows it; otherwise skip it.
5. 2-4 short sentences. Plain text only: no markdown, no lists, no emojis, no greeting, no phrases like "according to the text". Encouraging, never mocking."""
FEEDBACK = {
    "length": "Keep it between 30 and 900 characters.",
    "not_arabic": "Write it in Arabic.",
    "original_missing": "It must contain the correct answer EXACTLY as written in the lecture (original spelling), e.g. after «الصواب: ».",
    "invented_number": "It contains a number that the lecture sentence and explanation do not contain - remove it.",
}
_DIGITS = {**{0x660 + i: ord("0") + i for i in range(10)}, **{0x6F0 + i: ord("0") + i for i in range(10)}}


def prompt(c: dict, fb: list[str] | None = None) -> str:
    return (f"QUESTION: {c['stem']}\nOPTIONS: {json.dumps(c['options'], ensure_ascii=False)}\n"
            f"THE STUDENT {'CHOSE (wrong): ' + c['chosen'] if c.get('chosen') else 'LEFT IT BLANK'}\nCORRECT ANSWER: {c['correct']}\n"
            f"THE LECTURE'S EXPLANATION: {c['explanation']}\nLECTURE SENTENCE (verbatim): {c.get('quote') or '-'}\n"
            f"{'YOUR PREVIOUS ATTEMPT WAS REJECTED: ' + ' '.join(fb) + chr(10) if fb else ''}"
            'Return JSON: {"ar":"<the correction in Arabic>"}')


def _numbers(s: str) -> list[str]:
    return [x.replace(",", ".") for x in re.findall(r"\d+(?:[.,]\d+)?", (s or "").translate(_DIGITS))]


def _spaced(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def clean(s) -> str:
    t = "" if s is None else str(s)
    t = re.sub(r"\*\*|__|`+", "", t)
    t = re.sub(r"(?m)^\s*[-*•]\s+", "", t)
    t = re.sub(r"\s*\n\s*", " ", t)
    return re.sub(r"[ \t]+", " ", t).strip()


_QUOTED = re.compile(r"«[^»]*»|\"[^\"]*\"|“[^”]*”")


def is_arabic(text: str, share: float = 0.5) -> bool:
    """Is the explanation written in Arabic? What it QUOTES from the lecture does not count: an Arabic sentence around an English quotation is Arabic, an English one around it is not."""
    text = text or ""
    letters = [ch for ch in _QUOTED.sub(" ", text) if ch.isalpha()] or [ch for ch in text if ch.isalpha()]
    return bool(letters) and sum(1 for ch in letters if "\u0600" <= ch <= "\u06ff") / len(letters) > share


def check(ar: str, c: dict) -> list[str]:
    out: list[str] = []
    t = (ar or "").strip()
    low = _spaced(t)
    correct = (c.get("correct") or "").strip()
    if len(t) < 30 or len(t) > 900:
        out.append("length")
    if sum(1 for ch in t if "؀" <= ch <= "ۿ") < 15:
        out.append("not_arabic")
    if re.search(r"[A-Za-z]", correct):
        if len(correct) <= SHORT_ANSWER:
            if _spaced(correct) not in low:
                out.append("original_missing")
        else:
            keys = re.findall(r"[A-Za-z][A-Za-z0-9'-]{3,}", correct)
            if keys and not any(k.lower() in low for k in keys):
                out.append("original_missing")
    known = set(_numbers(" ".join([c.get("stem", ""), *(c.get("options") or []), c.get("explanation", ""), c.get("quote", "")])))
    if any(n not in known for n in _numbers(t)):
        out.append("invented_number")
    return out


def _pick(r):
    """the text out of what the model returned: {"ar": ...} (or a near name of it), or a bare string"""
    if isinstance(r, dict):
        for k in ("ar", "arabic", "correction"):
            if r.get(k) is not None:
                return r[k]
        return None
    return r


def make(provider, c: dict) -> str | None:
    """The correction in Arabic, or None when the model cannot give one that passes the checks. An error of the provider on the FIRST call is raised to the caller."""
    fb: list[str] | None = None
    last: tuple[str, list[str]] | None = None
    for k in range(2):
        try:
            r = provider.json_call("correction", SYSTEM, prompt(c, fb), c, max_tokens=700)
        except Exception:
            if k == 0:
                raise
            break
        ar = clean(_pick(r))
        bad = check(ar, c)
        if not bad:
            return ar
        last, fb = (ar, bad), [FEEDBACK[b] for b in bad if b in FEEDBACK]
    if last and last[1] == ["original_missing"] and len((c.get("correct") or "").strip()) <= SHORT_ANSWER:
        right = c["correct"].strip()
        lead = re.compile(r"^الصواب\s*[:：]\s*")
        fixed = f"الصواب: «{right}» — {lead.sub('', last[0])}" if lead.match(last[0]) else f"الصواب: «{right}». {last[0]}"
        if not check(fixed, c):
            return fixed
    return None
