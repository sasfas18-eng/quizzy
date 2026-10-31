#!/usr/bin/env bash
# Rebuild the web edition (+ the read-only demo under /demo/) and publish it to the gh-pages branch
# (GitHub Pages: Settings > Pages > Deploy from a branch > gh-pages / root).
# The deployed config.js (your Supabase URL + anon key) is PRESERVED; pass --reset-config to overwrite it with the empty template.
set -euo pipefail
root=$(git rev-parse --show-toplevel); out=$(mktemp -d); wt=$(mktemp -d)
python3 "$root/static-edition/build.py" "$out/site" --demo
git -C "$root" fetch -q origin gh-pages
git -C "$root" worktree add -q --detach "$wt" origin/gh-pages
if [ -f "$wt/config.js" ] && [ "${1:-}" != "--reset-config" ]; then cp "$wt/config.js" "$out/site/config.js"; fi
find "$wt" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$out/site/." "$wt/"
git -C "$wt" add -A
if git -C "$wt" diff --cached --quiet; then echo "nothing to deploy"; else
  git -C "$wt" -c user.name="${GIT_AUTHOR_NAME:-Quizzy}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@example.com}" commit -q -m "Deploy web edition $(git -C "$root" rev-parse --short HEAD)"
  git -C "$wt" push -q origin HEAD:gh-pages && echo "deployed"
fi
git -C "$root" worktree remove --force "$wt"
