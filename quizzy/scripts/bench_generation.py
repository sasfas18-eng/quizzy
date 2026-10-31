#!/usr/bin/env python3
"""Generation-pipeline benchmark with SIMULATED model latency (no API key needed).

Wraps the test provider and sleeps per call type, so wall-time reflects how well the pipeline overlaps work, how many
sequential round trips sit on the critical path, and how many calls it spends. Usage (from quizzy/backend):
    PYTHONPATH=. QUIZZY_ALLOW_FAKE_LLM=1 python ../scripts/bench_generation.py [count] [scale]
`scale` multiplies the latencies (default 1.0 = gen 2.0s, analyze 1.5s, verify 1.0s, explain 1.0s per call)."""
import os, sys, threading, time

os.environ.setdefault("QUIZZY_ALLOW_FAKE_LLM", "1")
from app.services import generator
from app.services.fake_llm import FakeProvider
from app.services.planner import build_plan
from app.services.support import analyze_support

COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 20
SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
LAT = {"analyze": 1.5, "generate": 2.0, "verify": 1.0, "explain": 1.0, "cards": 1.5}


class Latency(FakeProvider):
    def __init__(self):
        super().__init__()
        self.calls = {}
        self.lock = threading.Lock()

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        kind = "explain" if task.startswith(("explain", "verify_explanation")) else "verify" if task.startswith("verify") else task
        with self.lock:
            self.calls[kind] = self.calls.get(kind, 0) + 1
        time.sleep(LAT.get(kind, 1.0) * SCALE)
        return super().json_call(task, system, prompt, payload, max_tokens)


_N = ["glucose", "membrane", "receptor", "enzyme", "protein", "ligand", "channel", "vesicle", "ribosome", "nucleus", "mitochondrion", "cytoskeleton", "hormone", "antibody", "neuron",
      "synapse", "capillary", "alveolus", "nephron", "tubule", "platelet", "fibrin", "collagen", "osteoblast", "myosin", "actin", "sarcomere", "dendrite", "axon", "lymph",
      "cortex", "thalamus", "retina", "cochlea", "follicle", "ovum", "plasma", "insulin", "glucagon", "cortisol", "thyroxine", "oxytocin", "bile", "pepsin", "lipase", "amylase"]
_A = ["rapid", "gradual", "selective", "reversible", "cooperative", "inhibitory", "excitatory", "oxidative", "hydrophobic", "catalytic", "peripheral", "systemic", "adaptive", "regulatory"]
_V = ["stabilises", "amplifies", "suppresses", "transports", "degrades", "binds", "activates", "phosphorylates", "synthesises", "filters", "recruits", "modulates"]


def make_source(n_pages=16):
    pages = []
    for i in range(n_pages):
        w = lambda k: _N[(i * 7 + k * 3) % len(_N)]
        a = lambda k: _A[(i * 5 + k) % len(_A)]
        v = lambda k: _V[(i * 3 + k * 5) % len(_V)]
        lines = [f"Topic {i + 1}: {w(0).title()} dynamics",
                 f"{w(0).title()} is the {a(0)} component that {v(0)} {w(1)} within {w(2)} tissue during {a(1)} activity.",
                 f"Regulation of {w(3)} depends on {a(2)} {w(4)} signals because {w(5)} {v(1)} the {w(6)} pathway.",
                 f"Disruption of {w(7)} leads to {a(3)} changes in {w(8)} output and {w(9)} stability.",
                 f"Measurement of {w(10)} uses {a(4)} protocols whereas screening of {w(11)} uses simplified approximations.",
                 f"The {a(5)} {w(12)} {v(2)} {w(13)} and {v(3)} the {w(14)} threshold in every sample."]
        if i % 3 == 0:
            lines += [f"The {w(0)} cycle proceeds in four steps:", f"1. {w(1).title()} detection occurs at stage {i}.", f"2. {w(2).title()} relay reaches the integrating centre.",
                      f"3. {w(3).title()} response adjusts the output level.", f"4. {w(4).title()} feedback restores the baseline state."]
        pages.append({"ref": f"d1p{i + 1}", "doc_id": "d", "doc_title": "Bench", "page_no": i + 1, "text": "\n".join(lines), "status": "ok", "image_count": 0})
    return {"pages": pages, "excluded": [], "docs": []}


def main():
    prov = Latency()
    src = make_source()
    st = {"count": COUNT, "focus": "balanced", "field": "science", "language": "en", "difficulty": "mixed", "external_mode": "source_only"}
    t0 = time.perf_counter()
    analysis = generator.analyse(prov, src, st)
    t1 = time.perf_counter()
    heur = analyze_support([p["text"] for p in src["pages"]], "science")
    plan = build_plan(analysis, st, heur)
    t2 = time.perf_counter()
    res = generator.generate_questions(prov, plan, src, st, lambda s, p: None)
    t3 = time.perf_counter()
    total_calls = sum(prov.calls.values())
    print(f"requested={COUNT} planned={plan['feasible_count']} delivered={len(res['accepted'])} dropped={len(res['dropped'])}")
    print(f"analysis={t1 - t0:5.1f}s  generation={t3 - t2:5.1f}s  TOTAL={t3 - t0:5.1f}s  (latency scale {SCALE})")
    print(f"llm calls: {total_calls}  {prov.calls}  -> {total_calls / max(1, len(res['accepted'])):.2f} calls/question")


main()
