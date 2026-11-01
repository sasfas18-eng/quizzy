"""TEST-ONLY deterministic provider (needs QUIZZY_ALLOW_FAKE_LLM=1). It builds cloze-style questions from the
actual page text so pipeline mechanics (validation, verification, dedupe, persistence, PDF, attempts) can be tested
without an API key. It is NOT a quality benchmark; its output is stamped 'test-generator' everywhere in the UI."""
from __future__ import annotations

import random
import re

from .support import analyze_support
from .taxonomy import QTYPE_ORDER
from .validate import norm

STOP = set("the a an of in on to and or is are was were be by for with as at from that this these those it its which "
           "في من على إلى عن مع هو هي هذا هذه ذلك التي الذي".split())


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?؟])\s+|\n+", text)
    out = []
    for p in parts:
        p = p.strip(" -•●▪\t")
        p = re.sub(r"^\d+[\.\)]\s*", "", p)
        w = p.split()
        if 6 <= len(w) <= 40 and not p.startswith("[ملاحظات"):
            out.append(p)
    return out


def _terms(s: str) -> list[str]:
    return [w.strip(".,;:()،") for w in s.split() if len(w.strip(".,;:()،")) >= 5 and w.lower().strip(".,;:()،") not in STOP
            and not w.strip(".,;:()،").isdigit()]


def _is_ar(s: str) -> bool:
    return sum(1 for c in s if "؀" <= c <= "ۿ") > len(s) * 0.4


class FakeProvider:
    name = "fake"
    model = "test"

    def __init__(self):
        self.used: dict[str, int] = {}

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        return getattr(self, "_" + task)(payload or {})

    # ---- analysis
    def _analyze(self, p):
        objs = []
        for pg in p["pages"]:
            t = pg["text"]
            if len(t) < 80:
                continue
            h = analyze_support([t], p.get("field") or "other")
            sents = _sentences(t)
            lines = [ln for ln in t.splitlines() if re.match(r"\s*\d+[\.\)]\s", ln)]
            sup = {"basic_recall": {"pages": [pg["ref"]]}, "understanding": {"pages": [pg["ref"]]}}
            for k in ("mechanisms", "application", "compare_contrast", "critical_thinking", "best_answer", "scenarios"):
                if h[k]["level"] != "none" and len(sents) >= 3:
                    sup[k] = {"pages": [pg["ref"]]}
            if len(lines) >= 3:
                sup["sequence"] = {"pages": [pg["ref"]]}
            if len(sents) >= 4 and len({w for s in sents for w in _terms(s)}) >= 5:
                sup["not_except"] = {"pages": [pg["ref"]]}
            objs.append({"statement": t.splitlines()[0][:120], "pages": [pg["ref"]], "key_terms": _terms(t)[:5],
                         "capacity": min(4, max(1, len(sents) // 2)), "supports": sup})
        return {"objectives": objs, "gaps": [], "lecture_character": "تحليل اختباري آلي (fake).", "discipline_guess": None}

    def _profile(self, p):
        """TEST provider's profiler: it agrees with its own analysis - a type is as supportable as the objectives that carry it (so a source the test analysis finds no
        sequence in has none here either)."""
        objs = self._analyze(p)["objectives"]
        out = {}
        for c in QTYPE_ORDER:
            have = [o for o in objs if c in o["supports"]]
            out[c] = {"capacity": min(40, sum(max(1, o["capacity"]) for o in have)), "pages": sorted({r for o in have for r in o["pages"]})}
        return {"types": out}

    # ---- generation
    def _generate(self, p):
        pages = p["pages"]
        out = []
        for s in p["slots"]:
            ref = s["pages"][0]
            text = pages.get(ref, "")
            q = self._one(s, ref, text, pages)
            out.append(q or {"slot": s["slot"], "unwritable_reason": "المصدر لا يكفي لهذا النوع (مولّد اختباري)."})
        return {"questions": out}

    def _one(self, s, ref, text, pages):
        sents = _sentences(text)
        if not sents:
            return None
        i = self.used.get(ref, 0)
        self.used[ref] = i + 1
        ar = _is_ar(text)
        t = s["qtype"]
        if t == "sequence":
            lines = [re.sub(r"^\s*\d+[\.\)]\s*", "", ln).strip() for ln in text.splitlines() if re.match(r"\s*\d+[\.\)]\s", ln)]
            if len(lines) < 3:
                return None
            lines = lines[:4]
            order = list(range(len(lines)))
            rng = random.Random(len(text) + i)
            shuffled = order[:]
            rng.shuffle(shuffled)
            if shuffled == order:
                shuffled = order[1:] + order[:1]
            items = "\n".join(f"{n + 1}. {lines[k]}" for n, k in enumerate(shuffled))
            correct = [shuffled.index(k) + 1 for k in order]
            opts = {tuple(correct)}
            while len(opts) < 4:
                perm = list(range(1, len(lines) + 1))
                rng.shuffle(perm)
                opts.add(tuple(perm))
            opts = list(opts)
            ci = opts.index(tuple(correct))
            stem = ("رتّب الخطوات التالية كما وردت في المحاضرة:\n" if ar else "Put the following steps in the order given in the lecture:\n") + items
            return self._pack(s, stem, [" → ".join(map(str, o)) for o in opts], ci, ref, lines[0] if len(lines[0]) > 10 else text[:120], text)
        sent = sents[i % len(sents)]
        terms = _terms(sent)
        if not terms:
            return None
        term = max(terms, key=len)
        pool = [w for sn in sents for w in _terms(sn) if norm(w) != norm(term)]
        for rp, rt in pages.items():
            if rp != ref:
                pool += [w for w in _terms(rt)][:10]
        pool = list(dict.fromkeys(pool))
        rng = random.Random(i + len(sent))
        if t == "not_except":
            inside = list(dict.fromkeys(w for sn in sents for w in _terms(sn)))
            foreign = [w for w in pool if norm(w) not in norm(text)]
            if len(inside) < 3 or not foreign:
                return None
            true3 = rng.sample(inside, 3)
            opts = true3 + [foreign[0]]
            stem = ("أي مما يلي لم يرد في هذا الجزء من المحاضرة (ما عدا)؟ — " + s["objective"][:80]) if ar else \
                f"Which of the following is NOT mentioned in this part of the lecture ({s['objective'][:80]})?"
            rng.shuffle(opts)
            return self._pack(s, stem, opts, opts.index(foreign[0]), ref, sent, text, nxt=" ".join(true3))
        distract = [w for w in pool if len(w) >= 4][:30]
        if len(distract) < 3:
            return None
        ds = rng.sample(distract, 3)
        opts = ds + [term]
        rng.shuffle(opts)
        blank = sent.replace(term, "_____", 1)
        pre = {"best_answer": "Select the best answer to complete: ", "compare_contrast": "Which term completes the distinction: ",
               "scenarios": "Case: a learner reads this lecture statement. Which term completes it: ", "application": "Apply the rule — complete: ",
               "critical_thinking": "Evaluate and complete: "}.get(t, "Complete according to the lecture: ")
        if ar:
            pre = "أكمل حسب المحاضرة: "
        stem = pre + blank
        if t == "best_answer":
            stem = ("ما هو الأنسب لإكمال: " if ar else "Which is the best term to complete: ") + blank
        return self._pack(s, stem, opts, opts.index(term), ref, sent, text)

    def _pack(self, s, stem, opts, ci, ref, quote, text, nxt=""):
        q = quote if quote in text else text[:150]
        return {"slot": s["slot"], "unwritable_reason": None, "stem": stem, "options": opts, "correct_index": ci,
                "explanation": f"الإجابة الصحيحة مبنية على نص المحاضرة: «{q[:160]}». الخيارات الأخرى لا تظهر في هذا السياق.",
                "purpose": f"{s['qtype']} / {s['objective'][:50]} / {norm(q)[:40]}", "reasoning_pattern": s["qtype"],
                "evidence": [{"page": ref, "quote": q[:300]}], "calc": None, "uses_external": False}

    # ---- verification (blind solve against the pages)
    def _verify(self, p):
        q, pages = p["question"], p["pages"]
        blob = norm(" ".join(pages.values()))
        opts = q["options"]
        stem = q["stem"]
        ch = None
        if q["qtype"] == "not_except":
            absent = [i for i, o in enumerate(opts) if norm(o) not in blob]
            ch = absent[0] if len(absent) == 1 else None
        elif q["qtype"] == "sequence":
            items = [re.sub(r"^\d+\.\s*", "", ln) for ln in stem.splitlines()[1:]]
            src_lines = [norm(re.sub(r"^\s*\d+[\.\)]\s*", "", ln)) for ln in " ".join(pages.values()).replace("\n", "\n").splitlines()]
            pos = [src_lines.index(norm(it)) if norm(it) in src_lines else 99 for it in items]
            want = [pos.index(v) + 1 for v in sorted(pos)]
            for i, o in enumerate(opts):
                if [int(x) for x in re.findall(r"\d+", o)] == want:
                    ch = i
        else:
            body = stem.split(": ", 1)[-1] if ": " in stem else stem
            hits = [i for i, o in enumerate(opts) if norm(body.replace("_____", o)) in blob]
            ch = hits[0] if len(hits) == 1 else None
        return {"chosen_index": ch, "answerable_from_source": ch is not None, "single_best_answer": ch is not None,
                "sufficient_data": True, "needs_outside_knowledge": False, "flaws": [], "severity": "none"}

    def _verify_batch(self, p):
        return {"results": [{"id": it["id"], **self._verify({"question": it["question"], "pages": p["pages"]})} for it in p["items"]]}

    def _explain_batch(self, p):
        return {"results": [{"id": it["id"], **self._verify_explanation({})} for it in p["items"]]}

    def _verify_explanation(self, p):
        return {"explanation_supported": True, "contradicts_source": False, "notes": ""}

    # ---- flashcards
    def _cards(self, p):
        cards = []
        for ref, text in p["pages"].items():
            for sn in _sentences(text)[: max(1, p["n"] // max(1, len(p["pages"])))]:
                terms = _terms(sn)
                if not terms:
                    continue
                t = max(terms, key=len)
                ar = _is_ar(sn)
                cards.append({"front": ("أكمل: " if ar else "Complete: ") + sn.replace(t, "_____", 1), "back": t,
                              "page": ref, "quote": sn[:300]})
        return {"cards": cards[: p["n"]]}
