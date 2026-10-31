/* Quizzy web edition — deployment config. Both values are PUBLIC by design (the anon key only allows what the database's
 * Row Level Security allows). Leave empty to run in device-only mode (no cloud accounts).
 * Setup: docs/SETUP-PAGES.md  (create a free Supabase project, run supabase/schema.sql, paste the two values here). */
window.QZ_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: '',  // Project Settings > API > "anon public" key
};
