#!/usr/bin/env bash
# Fetch the composer's OPEN on-device model for EVERY browser (Safari, Firefox, Chrome, phones) into static-edition/vendor/semantic:
#   - transformers.js (Apache-2.0) with its WebAssembly engine (onnxruntime-web, MIT), from npm, version pinned, archive checked against its sha512;
#   - the sentence model all-MiniLM-L6-v2 (Apache-2.0, ~23 MB quantized), from Hugging Face at a pinned revision, every file checked against its sha256.
# Not committed (binaries): CI runs this before building the site, and the site serves the files itself (same origin: no key, no server, no cost).
# A visitor's browser downloads them once (when it makes a quiz) and keeps them; without them the site works exactly as before.
# QZ_SEMANTIC_MODEL_DIR=<dir with config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx> uses a local copy of the model instead
# (still checked against the same sha256 values).
set -euo pipefail
root=$(git rev-parse --show-toplevel); dst="$root/static-edition/vendor/semantic"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
TF=3.8.1; MODEL=Xenova/all-MiniLM-L6-v2; REV="${QZ_SEMANTIC_REV:-main}"
STAMP="transformers.js-$TF $MODEL@$REV"
if [ -f "$dst/VERSION" ] && [ "$(cat "$dst/VERSION")" = "$STAMP" ] && [ -f "$dst/models/$MODEL/onnx/model_quantized.onnx" ]; then echo "semantic: up to date ($STAMP)"; exit 0; fi
sha512() { python3 -c 'import base64,hashlib,sys; print("sha512-"+base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode())' "$1"; }
sha256() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
# 1) the library and its engine
curl -fsSL --retry 4 --retry-delay 2 -o "$tmp/tf.tgz" "https://registry.npmjs.org/@huggingface/transformers/-/transformers-$TF.tgz"
[ "$(sha512 "$tmp/tf.tgz")" = "sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==" ] || { echo "semantic: integrity check FAILED for transformers.js" >&2; exit 1; }
mkdir -p "$tmp/tf" && tar -xzf "$tmp/tf.tgz" -C "$tmp/tf"
rm -rf "$dst"; mkdir -p "$dst/models/$MODEL/onnx"
cp "$tmp/tf/package/dist/transformers.min.js" "$tmp/tf/package/dist/ort-wasm-simd-threaded.jsep.mjs" "$tmp/tf/package/dist/ort-wasm-simd-threaded.jsep.wasm" "$dst/"
cp "$tmp/tf/package/LICENSE" "$dst/LICENSE-transformers.js" 2>/dev/null || true
# 2) the model (sha256 of each file; the first run on a new revision prints them so they can be pinned below)
declare -A PIN=(
  [config.json]="${QZ_PIN_CONFIG:-}" [tokenizer.json]="${QZ_PIN_TOKENIZER:-}" [tokenizer_config.json]="${QZ_PIN_TOKCFG:-}" [onnx/model_quantized.onnx]="${QZ_PIN_ONNX:-}"
)
ok=1
for f in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
  out="$dst/models/$MODEL/$f"
  if [ -n "${QZ_SEMANTIC_MODEL_DIR:-}" ]; then cp "$QZ_SEMANTIC_MODEL_DIR/$f" "$out"
  elif ! curl -fsSL --retry 4 --retry-delay 2 -o "$out" "https://huggingface.co/$MODEL/resolve/$REV/$f"; then echo "semantic: could not download $f (the site works without the model)" >&2; ok=0; break; fi
  got=$(sha256 "$out"); echo "semantic: $f sha256 $got"
  if [ -n "${PIN[$f]}" ] && [ "${PIN[$f]}" != "$got" ]; then echo "semantic: sha256 MISMATCH for $f" >&2; exit 1; fi
done
if [ "$ok" != 1 ]; then rm -rf "$dst/models"; echo "semantic: library only (no model)"; fi
echo "$STAMP" > "$dst/VERSION"; du -sh "$dst" | sed 's/^/semantic: /'
