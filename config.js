/* Quizzy web edition — deployment config (everything here is PUBLIC: a static site cannot keep a secret).
 *
 * Quizzes are made LOCALLY in each visitor's browser (no AI service, no key, no cost).
 *
 * 1) Accounts (optional). Leave both empty to run in device-only mode (no cloud accounts).
 *    Setup: docs/SETUP-PAGES.md  (create a free Supabase project, run supabase/schema.sql, paste the two values here).
 *
 * 2) relay (optional): AI-written quizzes for EVERY visitor, with no key in the site. Set `relay` to the address of your Cloudflare Worker
 *    (relay/cloudflare-worker.mjs) that holds a FREE Gemini key SERVER-side. Only the Worker's address is public; the key never touches the site.
 *    Empty = every quiz is built locally in the browser (free, no AI). Setup: docs/SETUP-AI.md.
 *
 * 3) chromeAiToken: leave it EMPTY. Chrome's BUILT-IN model (the Prompt API, used on the device at zero cost to check and polish questions) is
 *    stable on websites since Chrome 148 (May 2026) and needs no origin-trial token. The field stays only for a possible future Chrome trial. */
window.QZ_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: '',  // Project Settings > API > "anon public" key
  relay: '',            // optional: https://quizzy-relay.<you>.workers.dev  (see 2) — the key stays on the Worker, never here)
  relayModel: '',       // optional: the Gemini model, e.g. gemini-2.0-flash (default when empty)
  chromeAiToken: '',    // not needed since Chrome 148, see 3)
};
