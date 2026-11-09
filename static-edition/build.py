#!/usr/bin/env python3
"""Build the web edition (static files for GitHub Pages / any static host):
    python3 static-edition/build.py [out_dir] [--demo]      (default out: static-edition/dist; --demo also builds ./demo/ read-only demo)"""
import shutil, subprocess, sys
from pathlib import Path

here = Path(__file__).resolve().parent; root = here.parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
out = Path(args[0]) if args else here / "dist"
if out.exists(): shutil.rmtree(out)
shutil.copytree(root / "frontend", out)
for f in ("engine.js", "rules.js"): shutil.copy(root / "claude-edition" / f, out / f)
for f in ("stores.js", "supabase.js", "owner_rules.js", "forms_profile.js", "api-core.js"): shutil.copy(root / "shared" / f, out / f)
for f in ("host.js", "config.js"): shutil.copy(here / f, out / f)
for f in ("pdf.min.js", "pdf.worker.min.js", "jszip.min.js"): shutil.copy(root / "claude-edition" / "vendor" / f, out / f)
ocr = here / "vendor" / "ocr"      # in-browser reading of scanned pages (scripts/fetch_ocr.sh); without it scanned pages are explained, not read
if (ocr / "VERSION").exists(): shutil.copytree(ocr, out / "vendor" / "ocr", dirs_exist_ok=True)
sem = here / "vendor" / "semantic"      # the composer's open on-device model for every browser (scripts/fetch_semantic.sh); without it the site works as before
if (sem / "VERSION").exists(): shutil.copytree(sem, out / "vendor" / "semantic", dirs_exist_ok=True)
css = out / "css" / "app.css"; css.write_text(css.read_text().replace("/static/fonts/", "../fonts/"))
idx = out / "index.html"; h = idx.read_text().replace('"/static/', '"./')
scripts = "".join(f'<script src="./{n}"></script>\n  ' for n in ("engine.js", "rules.js", "stores.js", "supabase.js", "owner_rules.js", "config.js", "host.js", "forms_profile.js", "api-core.js"))
h = h.replace('<script src="./vendor/katex/katex.min.js">', scripts + '<script src="./vendor/katex/katex.min.js">')
# KaTeX is loaded on demand (core.js typeset) the first time an equation is shown: not on every visit
h = h.replace('<script src="./vendor/katex/katex.min.js"></script>', '').replace('<script src="./vendor/katex/auto-render.min.js"></script>', '')
banner = """
  <script>window.addEventListener('DOMContentLoaded',function(){var b=document.createElement('div');b.id='ce-banner';b.className='noprint';b.style.cssText='background:#e3f3f1;color:#0b5e4e;padding:.45rem 1rem;text-align:center;font:600 .82rem system-ui;border-bottom:1px solid #9bd0c8;display:none';(document.getElementById('col')||document.body).prepend(b);});</script>"""
h = h.replace("</body>", banner + "\n</body>")
idx.write_text(h)
(out / ".nojekyll").write_text("")
if "--demo" in sys.argv:
    subprocess.run([sys.executable, str(root / "scripts" / "build_demo.py"), str(out / "demo")], check=True)
print("built", out)
