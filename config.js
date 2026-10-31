/* Quizzy web edition — deployment config (everything here is PUBLIC: a static site cannot keep a secret).
 *
 * 1) Accounts (optional). Leave both empty to run in device-only mode (no cloud accounts).
 *    Setup: docs/SETUP-PAGES.md  (create a free Supabase project, run supabase/schema.sql, paste the two values here).
 *
 * 2) AI for EVERY visitor (optional). Without it, visitors get the local generator (simpler questions, no key, no limits) and only the
 *    OPERATOR (page #/operator) can connect a key — on that one device.
 *    THE SAFE WAY TO SHARE A PAID KEY (Claude): `relay` — the address of your own relay (relay/cloudflare-worker.mjs, free Cloudflare Worker,
 *    guide: docs/SETUP-AI.md). The key stays on the relay; this file only holds the relay's ADDRESS, which is not a secret.
 *       relay: 'https://quizzy-ai.YOUR-NAME.workers.dev',
 *       relayModel: 'claude-opus-5-5',      // claude-opus-5-5 (strongest, most expensive) · claude-sonnet-5-5 · claude-haiku-5-5 (cheapest) — also allowed by the relay's ALLOWED_MODELS
 *       relayRpm: 20,                        // requests per minute per visitor's browser
 *    NEVER put a paid API key in this file or anywhere in the repository: it becomes public (and Anthropic revokes keys found in public repos).
 *
 * 3) `llm` (advanced, discouraged): provider entries WITH the key inside — the key is readable by anyone who opens the site, so only a
 *    FREE-TIER key restricted to this site's address (Google AI Studio: "HTTP referrers") makes sense. Example (Gemini free tier):
 *      llm: [{ name: 'Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', key: 'AIza…', rpm: 9 }],
 *    `kind` is 'gemini', 'openai' (Groq, OpenRouter…) or 'anthropic'; `rpm` paces requests under the provider's per-minute limit. */
window.QZ_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: '',  // Project Settings > API > "anon public" key
  relay: '',            // the relay's address (see above); empty = no site-wide AI
  relayModel: 'claude-opus-5-5',
  relayRpm: 20,
  llm: [],              // advanced: public provider entries (see above)
};
