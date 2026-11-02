#!/usr/bin/env bash
# Rebuild the web edition (+ the read-only demo under /demo/) and publish it to the gh-pages branch
# (GitHub Pages: Settings > Pages > Deploy from a branch > gh-pages / root).
# The deployed config.js's public values (Supabase URL + anon key, Chrome token) are KEPT in the new template; pass --reset-config to start from the empty template.
set -euo pipefail
root=$(git rev-parse --show-toplevel); out=$(mktemp -d); wt=$(mktemp -d)
python3 "$root/static-edition/build.py" "$out/site" --demo
# which version is live, and when it was built (also guarantees every deploy really publishes something, so the publishing path itself is exercised)
printf '{"commit":"%s","built":"%s"}\n' "$(git -C "$root" rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/site/version.json"
git -C "$root" fetch -q origin gh-pages
git -C "$root" worktree add -q --detach "$wt" origin/gh-pages
if [ -f "$wt/config.js" ] && [ "${1:-}" != "--reset-config" ]; then python3 "$root/scripts/patch_config.py" --carry "$wt/config.js" "$out/site/config.js"; fi
# optional: the Chrome origin-trial token that lets Chrome's BUILT-IN model (on the device, zero cost) check and polish questions:  QZ_CHROME_AI_TOKEN=... bash scripts/deploy_pages.sh
upd=(); [ -n "${QZ_CHROME_AI_TOKEN:-}" ] && upd+=("chromeAiToken=$QZ_CHROME_AI_TOKEN")
# optional: ACCOUNTS (Supabase) - the project's URL and its PUBLIC anon/publishable key, nothing else; a service_role / secret key is refused by patch_config.py (and never printed):
#   QZ_SUPABASE_URL=https://abcd.supabase.co QZ_SUPABASE_ANON_KEY=eyJ... bash scripts/deploy_pages.sh   (in CI: repository variables of the same names)
[ -n "${QZ_SUPABASE_URL:-}" ] && upd+=("supabaseUrl=$QZ_SUPABASE_URL"); [ -n "${QZ_SUPABASE_ANON_KEY:-}" ] && upd+=("supabaseAnonKey=$QZ_SUPABASE_ANON_KEY")
if [ "${#upd[@]}" -gt 0 ]; then python3 "$root/scripts/patch_config.py" "$out/site/config.js" "${upd[@]}"; fi
python3 "$root/scripts/stamp_site.py" "$out/site"        # LAST: config.js is final now; browsers keep Pages files 10 minutes, so every version gets its own URLs
find "$wt" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$out/site/." "$wt/"
git -C "$wt" add -A
if git -C "$wt" diff --cached --quiet; then echo "nothing to deploy"; else
  git -C "$wt" -c user.name="${GIT_AUTHOR_NAME:-Quizzy}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@example.com}" commit -q -m "Deploy web edition $(git -C "$root" rev-parse --short HEAD)"
  git -C "$wt" push -q origin HEAD:gh-pages && echo "deployed"
fi
git -C "$root" worktree remove --force "$wt"
