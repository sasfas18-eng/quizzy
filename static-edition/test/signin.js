// Shared by the browser tests of the static edition. A site WITHOUT cloud accounts asks for an e-mail and a password (accounts on this device). A test that is not about signing in starts like a returning
// visitor: an account is already there and signed in. It is seeded with the same salted PBKDF2-SHA256 hash the page makes (so signing in again with the same e-mail / password works), and it adopts the
// device's first store (quizzy_web_v1) exactly as the first real account does. The seed is written ONLY when the browser has no accounts yet, so a sign-out stays signed out across reloads.
const crypto = require('crypto');
const EMAIL = 'sara@uni.edu', PASSWORD = 'password-1', NAME = 'سارة';
function seedAccount(ctx, { email = EMAIL, password = PASSWORD, name = NAME, signedIn = true } = {}) {
  const salt = crypto.randomBytes(16), iter = 150000, hash = crypto.pbkdf2Sync(password, salt, iter, 32, 'sha256');
  const seed = { accounts: { [email.toLowerCase()]: { id: 'seeded0001', email, name, salt: salt.toString('base64'), iter, hash: hash.toString('base64'), db: 'quizzy_web_v1', created: Date.now() } }, current: signedIn ? email.toLowerCase() : null };
  return ctx.addInitScript((s) => { try { if (!localStorage.getItem('quizzy_acc_v1')) localStorage.setItem('quizzy_acc_v1', JSON.stringify(s)); } catch (e) { /* storage blocked */ } }, seed);
}
module.exports = { seedAccount, EMAIL, PASSWORD, NAME };
