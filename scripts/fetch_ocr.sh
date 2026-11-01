#!/usr/bin/env bash
# Fetch the in-browser text recognition for SCANNED lectures (tesseract.js: Apache-2.0; language data: MIT) into static-edition/vendor/ocr.
# Not committed (≈16 MB of binaries): CI runs this before building the site. Versions are pinned and every archive is checked against its
# sha512 before use. A visitor's browser downloads these files only when a PDF has pages that are pictures; without them the site still works
# and says plainly that such pages cannot be read.
set -euo pipefail
root=$(git rev-parse --show-toplevel); dst="$root/static-edition/vendor/ocr"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
STAMP="tesseract.js-7.0.0 core-7.0.0 eng-1.0.0 ara-1.0.0"
if [ -f "$dst/VERSION" ] && [ "$(cat "$dst/VERSION")" = "$STAMP" ]; then echo "ocr: up to date ($STAMP)"; exit 0; fi
get() {   # url  sha512-integrity  name
  curl -fsSL --retry 4 --retry-delay 2 -o "$tmp/$3.tgz" "$1"
  local got; got="sha512-$(python3 -c 'import base64,hashlib,sys; print(base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode())' "$tmp/$3.tgz")"
  [ "$got" = "$2" ] || { echo "ocr: integrity check FAILED for $3" >&2; exit 1; }
  mkdir -p "$tmp/$3" && tar -xzf "$tmp/$3.tgz" -C "$tmp/$3"
}
R=https://registry.npmjs.org
get "$R/tesseract.js/-/tesseract.js-7.0.0.tgz" "sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==" js
get "$R/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz" "sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==" core
get "$R/@tesseract.js-data/eng/-/eng-1.0.0.tgz" "sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg==" eng
get "$R/@tesseract.js-data/ara/-/ara-1.0.0.tgz" "sha512-bB60Av6dsv9LRUrlaM6SgnAwjUpdbanw9Jf3mbhDCZAhX7Cp8u7YjI8EWfCvMhH3R2QJT/2EA8cijqPANOhwaA==" ara
rm -rf "$dst"; mkdir -p "$dst/lang"
cp "$tmp/js/package/dist/tesseract.min.js" "$tmp/js/package/dist/worker.min.js" "$dst/"
for v in lstm simd-lstm relaxedsimd-lstm; do cp "$tmp/core/package/tesseract-core-$v.wasm.js" "$dst/"; done      # the browser's own engine picks one: relaxed SIMD, SIMD, or plain
cp "$tmp/eng/package/4.0.0_best_int/eng.traineddata.gz" "$tmp/ara/package/4.0.0_best_int/ara.traineddata.gz" "$dst/lang/"
cp "$tmp/js/package/LICENSE.md" "$dst/LICENSE-tesseract.js.md" 2>/dev/null || cp "$tmp/js/package/LICENSE" "$dst/LICENSE-tesseract.js" 2>/dev/null || true
cp "$tmp/core/package/LICENSE" "$dst/LICENSE-tesseract.js-core" 2>/dev/null || true
echo "$STAMP" > "$dst/VERSION"; du -sh "$dst" | sed 's/^/ocr: /'
