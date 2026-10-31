#!/usr/bin/env python3
"""Set the relay fields of a site's config.js WITHOUT touching anything else in it (Supabase values etc. are kept).

    python3 scripts/patch_config.py <config.js> relay=https://quizzy-ai.name.workers.dev relayModel=claude-sonnet-5-5 relayRpm=20

Only the three relay fields are accepted and each is validated (an https address with no path; a claude-* model id; a small integer) so
nothing but a public address and a model name can ever be written. `relay=` (empty) switches the relay off. A key never goes in here."""
import json
import re
import sys

RULES = {
    "relay": (lambda v: v == "" or re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d{2,5})?/?", v) is not None, str),
    "relayModel": (lambda v: re.fullmatch(r"claude-[a-z0-9-]{3,40}", v) is not None, str),
    "relayRpm": (lambda v: v.isdigit() and 1 <= int(v) <= 600, int),
}


def patch(text: str, updates: dict) -> str:
    for key, raw in updates.items():
        if key not in RULES:
            raise SystemExit(f"unknown field: {key} (allowed: {', '.join(RULES)})")
        ok, cast = RULES[key]
        if not ok(raw):
            raise SystemExit(f"refusing {key}={raw!r}: not a valid value")
        value = json.dumps(cast(raw).rstrip("/") if cast is str and key == "relay" else cast(raw))
        line = re.compile(rf"^([ \t]*){key}[ \t]*:[^\n]*$", re.M)
        if line.search(text):
            text = line.sub(lambda m: f"{m.group(1)}{key}: {value},", text, count=1)
        else:
            head = re.search(r"window\.QZ_CONFIG\s*=\s*\{[ \t]*\n", text)
            if not head:
                raise SystemExit("config.js has no `window.QZ_CONFIG = {` block to extend")
            text = text[: head.end()] + f"  {key}: {value},\n" + text[head.end():]
    return text


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    updates = dict(a.split("=", 1) for a in sys.argv[2:])
    with open(path, encoding="utf-8") as f:
        src = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(patch(src, updates))
    print("config.js updated:", ", ".join(f"{k}={v}" for k, v in updates.items()))
