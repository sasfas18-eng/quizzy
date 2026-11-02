/* Quizzy web edition — deployment config (everything here is PUBLIC: a static site cannot keep a secret).
 *
 * Quizzes are made LOCALLY in each visitor's browser (no AI service, no key, no cost).
 *
 * 1) Accounts (optional). Leave both empty to run in device-only mode (no cloud accounts).
 *    Setup: docs/SETUP-PAGES.md  (create a free Supabase project, run supabase/schema.sql, paste the two values here).
 *
 * 2) chromeAiToken (optional): a free Chrome origin-trial token for this site's address (Chrome Origin Trials > Prompt API). It lets Chrome on a capable
 *    desktop use its BUILT-IN model (on the device, zero cost) to check and polish questions. Not a secret. Empty = the generator works without it. */
window.QZ_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: '',  // Project Settings > API > "anon public" key
  chromeAiToken: '',    // optional, see 2)
};
