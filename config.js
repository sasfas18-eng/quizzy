/* Quizzy web edition — deployment config (everything here is PUBLIC: a static site cannot keep a secret).
 *
 * 1) Accounts (optional). Leave both empty to run in device-only mode (no cloud accounts).
 *    Setup: docs/SETUP-PAGES.md  (create a free Supabase project, run supabase/schema.sql, paste the two values here).
 *
 * 2) Site-wide AI (optional). Without it every visitor pastes their own free key once ("ربط الذكاء الاصطناعي").
 *    With it, visitors need NOTHING: they upload a file and get questions. Because the key is readable by anyone who opens the
 *    site, use a FREE-TIER key and restrict it to this site's address (Google AI Studio / Cloud Console: "HTTP referrers").
 *    Example (Gemini free tier):
 *      llm: [{ name: 'Gemini', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
 *              model: 'gemini-2.5-flash', key: 'AIza…', rpm: 10 }],
 *    `kind` is 'openai' (any OpenAI-compatible API) or 'anthropic'; `rpm` paces requests under the provider's per-minute limit.
 *    Several entries are used together (requests are spread across them and move on when one hits its limit). */
window.QZ_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: '',  // Project Settings > API > "anon public" key
  llm: [],              // site-wide AI providers (see above)
};
