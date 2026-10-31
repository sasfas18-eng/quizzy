#!/usr/bin/env python3
"""Build the static GitHub-Pages demo into <out> (default: ./demo-site). Run from quizzy/."""
import re, shutil, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1] if len(sys.argv) > 1 else root / "demo-site")
if out.exists(): shutil.rmtree(out)
shutil.copytree(root / "frontend", out, dirs_exist_ok=False)
for f in ("data.json", "mock.js", "quiz-demo.pdf"): shutil.copy(root / "demo" / f, out / f)
css = out / "css" / "app.css"; css.write_text(css.read_text().replace("/static/fonts/", "../fonts/"))
idx = out / "index.html"; h = idx.read_text().replace('"/static/', '"./')
h = h.replace('<script src="./vendor/katex/katex.min.js">', '<script src="./mock.js"></script>\n  <script src="./vendor/katex/katex.min.js">')
idx.write_text(h)
(out / ".nojekyll").write_text("")
print("built", out)
