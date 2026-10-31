#!/usr/bin/env python3
"""Stamp a built site so a browser can never mix two versions of it.

GitHub Pages lets browsers keep every file for 10 minutes. After a deploy, a visitor could therefore run NEW html with OLD scripts (or the reverse) and see a
broken page until the cache expires. This puts the content hash of the whole site (`?v=<hash>`) on every local script/stylesheet URL in the html files and on every
relative module import in js/*.js: a new version has new URLs, so the browser fetches the new files together. Same content -> same stamp (no pointless cache churn).
Run it LAST (after config.js is final):   python3 scripts/stamp_site.py <site dir>
"""
import hashlib
import re
import sys
from pathlib import Path


def stamp(site: Path) -> str:
    files = sorted(p for p in site.rglob("*") if p.is_file() and p.suffix in (".js", ".css", ".html", ".json"))
    h = hashlib.sha1()
    for p in files:
        h.update(p.relative_to(site).as_posix().encode())
        h.update(p.read_bytes())
    v = h.hexdigest()[:10]
    attr = re.compile(r'''((?:src|href)=["'])(\.{1,2}/[^"'?#]+\.(?:js|css))(["'])''')
    imp = re.compile(r'''((?:from|import)\s*\(?\s*["'])(\.{1,2}/[^"'?#]+\.js)(["'])''')
    for p in files:
        if p.suffix == ".html":
            s = p.read_text(encoding="utf-8")
            s2 = attr.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={v}{m.group(3)}", s)
        elif p.suffix == ".js" and p.parent.name == "js":          # the app's ES modules (js/main.js imports ./core.js ...)
            s = p.read_text(encoding="utf-8")
            s2 = imp.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={v}{m.group(3)}", s)
        else:
            continue
        if s2 != s:
            p.write_text(s2, encoding="utf-8")
    return v


if __name__ == "__main__":
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_dir():
        sys.exit("usage: stamp_site.py <site dir>")
    print("stamped", stamp(Path(sys.argv[1])))
