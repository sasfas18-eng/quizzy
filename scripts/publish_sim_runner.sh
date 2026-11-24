#!/usr/bin/env bash
# Publish the simulator's student page to the site: gh-pages share/sim/index.html (share/ is kept by every deploy, also while the site is closed).
set -euo pipefail
root=$(git rev-parse --show-toplevel); wt=$(mktemp -d)
git -C "$root" fetch -q origin gh-pages && git -C "$root" worktree add -q --detach "$wt" origin/gh-pages
node "$root/scripts/build_sim_runner.mjs" "$wt/share/sim" >/dev/null
git -C "$wt" add share/sim
if git -C "$wt" diff --cached --quiet; then echo "simulator page unchanged"; else
  git -C "$wt" -c user.name="${GIT_AUTHOR_NAME:-Quizzy}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@example.com}" commit -q -m "Simulator page for students (share/sim)" && git -C "$wt" push -q origin HEAD:gh-pages && echo "published share/sim/"; fi
git -C "$root" worktree remove --force "$wt"
