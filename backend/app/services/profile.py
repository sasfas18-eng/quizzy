"""The lecture PROFILER (an internal agent; the learner never sees it): which of the ten question types THIS lecture supports and how many distinct questions of
each it can sustain. Two readings are merged: a deterministic one of the lecture's wording cues (`structural`) and a dedicated model call that reads the pages and counts what
each type can sustain (`agent`). The planner distributes the questions from this profile, and the objectives that the profile says support a type carry it.
Mirrors claude-edition/engine.js (profileAgent / reconcileProfile / attachSupports)."""
from __future__ import annotations

import re

from .support import analyze_support
from .taxonomy import QTYPE_ORDER

STRUCT_BOUND = ("sequence", "application", "not_except")      # types that need visible structure: a model cannot claim many of them where the text shows none


def level_of(n: int) -> str:
    return "none" if n <= 0 else "limited" if n <= 2 else "good" if n <= 5 else "strong"


def words_of(texts: list[str]) -> int:
    return len(re.findall(r"\S+", "\n".join(texts)))


def structural(pages: list[dict], field: str) -> dict:
    """What the wording of the pages shows (cue hits turned into a count of questions each type could sustain)."""
    texts = [p["text"] for p in pages]
    h = analyze_support(texts, field)
    w = words_of(texts)
    hit = lambda c: int((h.get(c) or {}).get("hits", (h.get(c) or {}).get("score", 0)) or 0)  # noqa: E731
    cap = {
        "basic_recall": max(1, w // 90), "understanding": max(1, w // 110), "mechanisms": hit("mechanisms") // 1, "application": hit("application") // 3,
        "not_except": hit("not_except") // 2, "sequence": hit("sequence") // 2, "compare_contrast": int(hit("compare_contrast") / 1.5), "critical_thinking": hit("critical_thinking") // 2,
        "best_answer": min(8, hit("best_answer")), "scenarios": hit("scenarios") // (3 if field == "health" else 6),
    }
    per = [(p["ref"], analyze_support([p["text"]], field)) for p in pages]
    types = {}
    for c in QTYPE_ORDER:
        n = max(0, min(40, cap.get(c, 0)))
        refs = [r for r, hh in per if int((hh.get(c) or {}).get("hits", (hh.get(c) or {}).get("score", 0)) or 0) > 0] if n else []
        types[c] = {"capacity": n, "level": level_of(n), "pages": refs}
    return {"types": types, "source": "rules"}


def merge_agent(parts: list[dict | None]) -> dict | None:
    out: dict[str, dict] = {}
    for p in parts:
        for t, v in (p or {}).items():
            a = out.setdefault(t, {"capacity": 0, "pages": []})
            a["capacity"] += v["capacity"]
            a["pages"] += v["pages"]
    for t in out:
        out[t]["capacity"] = min(60, out[t]["capacity"])
        out[t]["pages"] = list(dict.fromkeys(out[t]["pages"]))
    return out or None


def reconcile(struct: dict | None, agent: dict | None, words: int) -> dict:
    """Neither side is trusted blindly: structure-bearing types are bounded by what the text visibly shows, a strong structural signal is not erased by a model's zero,
    and no type can sustain more questions than the lecture has words for."""
    max_cap = max(2, -(-words // 70))
    types = {}
    for c in QTYPE_ORDER:
        sv = ((struct or {}).get("types") or {}).get(c)
        av = (agent or {}).get(c)
        cap = av["capacity"] if av else (sv["capacity"] if sv else 0)
        if av and sv and c in STRUCT_BOUND:
            cap = min(cap, sv["capacity"] * 3 + 3)
        if av and sv and cap == 0 and sv["capacity"] >= 6:
            cap = 2
        if c in ("basic_recall", "understanding") and words >= 60:
            cap = max(cap, 1)
        cap = min(cap, max_cap)
        types[c] = {"capacity": cap, "level": level_of(cap), "by": "agent" if av else "rules", "pages": (av["pages"] if av and av["pages"] else (sv or {}).get("pages", []))}
    return {"types": types, "source": "agent" if agent else "rules"}


def attach_supports(objectives: list[dict], profile: dict) -> None:
    """"Adds what is supported": objectives overlapping the pages the profile names for a type carry it (enough of them to match its capacity); a type the AI agent found
    nothing for is taken off every objective, so the planner never builds on it."""
    for c in QTYPE_ORDER:
        t = profile["types"].get(c)
        if not t:
            continue
        if t["capacity"] <= 0:
            if t.get("by") == "agent":
                for o in objectives:
                    (o.get("supports") or {}).pop(c, None)
            continue
        need = min(t["capacity"], len(objectives)) - sum(1 for o in objectives if c in (o.get("supports") or {}))
        if need <= 0 or not t["pages"]:
            continue
        ps = set(t["pages"])
        cands = [(o, [p for p in o.get("pages", []) if p in ps]) for o in objectives]
        cands = [(o, ov) for o, ov in cands if ov and c not in o["supports"]]
        cands.sort(key=lambda x: -len(x[1]))
        for o, ov in cands[:need]:
            o["supports"][c] = {"pages": ov, "task": None}
    for o in objectives:
        if not o.get("supports"):
            o["supports"] = {"basic_recall": {"pages": o["pages"], "task": None}, "understanding": {"pages": o["pages"], "task": None}}
