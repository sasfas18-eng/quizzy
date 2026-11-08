#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist/server dist/.openai
cp worker/index.js dist/server/index.js
cp .openai/hosting.json dist/.openai/hosting.json
