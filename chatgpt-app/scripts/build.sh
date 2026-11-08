#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist/server dist/.openai
# one file for the host: the owner's rules (shared/owner_rules.js) are inlined where worker/index.js imports them
python3 - <<'PY'
from pathlib import Path
src = Path("worker/index.js").read_text(); rules = Path("../shared/owner_rules.js").read_text()
line = next(l for l in src.splitlines() if l.startswith('import "./owner_rules.js";'))
Path("dist/server/index.js").write_text(src.replace(line, "// ---- inlined from shared/owner_rules.js\n" + rules + "\n// ---- end of the owner's rules", 1))
PY
cp .openai/hosting.json dist/.openai/hosting.json
