#!/usr/bin/env python3
"""python3 scripts/bake_forms_profile.py <profile.json> [source label]

Writes shared/forms_profile.js - the forms profile shipped with every edition - from what the development track learned (the owner's
`fprofile` document, exported as JSON). Only the cells are kept, and each is checked against the forms plan, so nothing outside it can be
baked in: one of the ten fixed types, a form 0-3 (the four fixed forms), a known kind of lecture, counts within FL.MAX (30) with ok <= n,
failures only of the known kinds. Anything else is refused, not silently dropped."""
import json, sys
from pathlib import Path

TYPES = {'basic_recall', 'understanding', 'mechanisms', 'application', 'critical_thinking', 'scenarios', 'compare_contrast', 'best_answer', 'not_except', 'sequence'}
DENS = {'heavy', 'medium', 'light'}
FAMS = {'giveaway', 'options_same', 'options_meta', 'options_weak', 'ambiguous', 'evidence', 'negation', 'order', 'repeat', 'format', 'unfit', 'other'}
MAX = 30


def cells_of(doc):
    cells = doc.get('cells') if isinstance(doc, dict) else None
    if not isinstance(cells, dict) or not cells: raise SystemExit('no cells in this profile')
    out = {}
    for key, c in sorted(cells.items()):
        t, f, d = (key.split('|') + ['', '', ''])[:3]
        if t not in TYPES or f not in ('0', '1', '2', '3') or d not in DENS: raise SystemExit(f'not a cell of the forms plan: {key}')
        n, ok, fails = int(c.get('n', 0)), int(c.get('ok', 0)), c.get('f') or {}
        if not (0 <= ok <= n <= MAX): raise SystemExit(f'{key}: counts out of bounds (n={n}, ok={ok})')
        bad = set(fails) - FAMS
        if bad: raise SystemExit(f'{key}: unknown failure kinds {sorted(bad)}')
        out[key] = {'n': n, 'ok': ok, 'f': {k: int(v) for k, v in sorted(fails.items()) if int(v) > 0}}
    return out


def main():
    if len(sys.argv) < 2: raise SystemExit(__doc__)
    doc = json.loads(Path(sys.argv[1]).read_text())
    cells = cells_of(doc.get('data', doc) if isinstance(doc, dict) else doc)
    label = sys.argv[2] if len(sys.argv) > 2 else 'development track'
    root = Path(__file__).resolve().parent.parent; dst = root / 'shared' / 'forms_profile.js'
    head = dst.read_text().split('window.QZ_FORMS_PROFILE')[0]
    body = json.dumps({'v': 1, 'cells': cells, 'source': label}, ensure_ascii=False, separators=(',', ':'))
    dst.write_text(head.replace(' Empty: no run exported yet.', '') + 'window.QZ_FORMS_PROFILE = ' + body + ';\n')
    n = sum(c['n'] for c in cells.values())
    print(f'{dst.relative_to(root)}: {len(cells)} cells, {n} first attempts ({label})')


if __name__ == '__main__':
    main()
