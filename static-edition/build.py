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
shutil.copy(root / "claude-edition" / "engine.js", out / "engine.js")
for f in ("stores.js", "pool.js", "supabase.js", "reader.js", "api-core.js"): shutil.copy(root / "shared" / f, out / f)
shutil.copytree(root / "shared" / "vendor" / "tesseract", out / "vendor" / "tesseract", dirs_exist_ok=True)   # OCR engine + ara/eng data (no network at run time)
for f in ("host.js", "config.js"): shutil.copy(here / f, out / f)
for f in ("pdf.min.js", "pdf.worker.min.js", "jszip.min.js"): shutil.copy(root / "claude-edition" / "vendor" / f, out / f)
css = out / "css" / "app.css"; css.write_text(css.read_text().replace("/static/fonts/", "../fonts/"))
idx = out / "index.html"; h = idx.read_text().replace('"/static/', '"./')
scripts = "".join(f'<script src="./{n}"></script>\n  ' for n in ("pdf.min.js", "jszip.min.js", "engine.js", "stores.js", "pool.js", "supabase.js", "reader.js", "config.js", "host.js", "api-core.js"))
h = h.replace('<script src="./vendor/katex/katex.min.js">', scripts + '<script src="./vendor/katex/katex.min.js">')
banner = """
  <script>window.addEventListener('DOMContentLoaded',function(){var b=document.createElement('div');b.id='ce-banner';b.className='noprint';b.style.cssText='background:#e3f3f1;color:#0b5e4e;padding:.45rem 1rem;text-align:center;font:600 .82rem system-ui;border-bottom:1px solid #9bd0c8;display:none';document.body.prepend(b);});</script>"""
h = h.replace("</body>", banner + "\n</body>")
idx.write_text(h)
(out / ".nojekyll").write_text("")
if "--demo" in sys.argv:
    subprocess.run([sys.executable, str(root / "scripts" / "build_demo.py"), str(out / "demo")], check=True)
print("built", out)
