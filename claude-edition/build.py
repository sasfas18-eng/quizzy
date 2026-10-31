#!/usr/bin/env python3
"""Build the Claude edition (static files for a claude.ai artifact): python3 build.py [out]  (run from claude-edition/)"""
import shutil, sys
from pathlib import Path
here = Path(__file__).resolve().parent; root = here.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else here / "dist")
if out.exists(): shutil.rmtree(out)
shutil.copytree(root / "frontend", out)
for f in ("engine.js", "host.js"): shutil.copy(here / f, out / f)
for f in ("stores.js", "reader.js", "api-core.js"): shutil.copy(root / "shared" / f, out / f)
shutil.copytree(root / "shared" / "vendor" / "tesseract", out / "vendor" / "tesseract", dirs_exist_ok=True)   # OCR engine + ara/eng data (no network at run time)
for f in ("pdf.min.js", "pdf.worker.min.js", "jszip.min.js"): shutil.copy(here / "vendor" / f, out / f)
css = out / "css" / "app.css"; css.write_text(css.read_text().replace("/static/fonts/", "../fonts/"))
idx = out / "index.html"; h = idx.read_text().replace('"/static/', '"./')
h = h.replace('<script src="./vendor/katex/katex.min.js">', '<script src="./pdf.min.js"></script>\n  <script src="./jszip.min.js"></script>\n  <script src="./engine.js"></script>\n  <script src="./stores.js"></script>\n  <script src="./reader.js"></script>\n  <script src="./host.js"></script>\n  <script src="./api-core.js"></script>\n  <script src="./vendor/katex/katex.min.js">')
banner = """
  <script>window.addEventListener('DOMContentLoaded',function(){var b=document.createElement('div');b.id='ce-banner';b.className='noprint';b.textContent='نسخة Claude';b.style.cssText='background:#e3f3f1;color:#0b5e4e;padding:.45rem 1rem;text-align:center;font:600 .82rem system-ui;border-bottom:1px solid #9bd0c8';document.body.prepend(b);});</script>"""
h = h.replace("</body>", banner + "\n</body>")
idx.write_text(h)
print("built", out)
