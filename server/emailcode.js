/* ═══════════════════════════════════════════════════════════════
   emailcode — six digits, five minutes, three guesses

   The door for brands. A painter's account comes from Google; a
   brand's comes from the application form, and the address on that
   form is the thing we can prove they hold. So: ask for the address,
   send a code to it, and let the code in.

   The security of this is not the code. Six digits is a million
   possibilities and an attacker does not get a million guesses — it
   is the *limits* that make it safe, and each one is here for a
   named attack:

     three wrong guesses and the code dies, so brute force gets
       three tries per code rather than per digit;

     one code at a time per address, superseded rather than added
       to, so asking twenty times does not give twenty live codes;

     five a window per address, so the route is not a way to post
       mail to a stranger repeatedly;

     and the per-IP auth budget in front of it, which is what stops
       somebody walking the alphabet of addresses.

   Stored hashed with the session secret, because a code is a
   credential for as long as it lives and a credential sitting in
   plain text is a credential in every backup of that database.

   One thing it deliberately does NOT do: say whether an account
   exists. Asking for a code always answers the same way. A route
   that says "no account with that address" is a route that tells
   you which of your customers' addresses are worth attacking.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const cfg = require('./config');
const dbm = require('./db');
const mail = require('./mail');

const db = dbm.db;
const logEvent = dbm.logEvent;

const LIFE_MS = 5 * 60 * 1000;        // how long a code works
const MAX_TRIES = 3;                  // wrong guesses before it dies
const PER_WINDOW = 5;                 // codes to one address per window
const WINDOW_MS = 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const norm = e => String(e || '').trim().toLowerCase().slice(0, 160);

/* Digits only, and uniform: crypto.randomInt is rejection-sampled, so no
   modulo bias. Leading zeros are kept — a code that is sometimes five
   characters is a code somebody mistypes. */
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/* Bound to the address as well as the secret, so a hash lifted from one
   row cannot be replayed against another. */
const hashOf = (code, email) =>
  crypto.createHmac('sha256', cfg.SESSION_SECRET).update(`${code}\0${email}`).digest('hex');

const selCode = db.prepare('SELECT * FROM email_codes WHERE email = ?');
const putCode = db.prepare(
  `INSERT INTO email_codes (email, hash, expires_at, attempts, sent, window_at, created_at)
   VALUES (@email, @hash, @expires_at, 0, @sent, @window_at, @now)
   ON CONFLICT(email) DO UPDATE SET
     hash = @hash, expires_at = @expires_at, attempts = 0,
     sent = @sent, window_at = @window_at, created_at = @now`);
const dropCode = db.prepare('DELETE FROM email_codes WHERE email = ?');
const bumpAttempt = db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?');
const sweepExpired = db.prepare('DELETE FROM email_codes WHERE expires_at < ?');

/* The same answer whether or not anything was sent. */
const SENT = {
  ok: true,
  message: 'If that address can sign in, a code is on its way. It works for 5 minutes.'
};

function request(email, lang, now = Date.now()) {
  const to = norm(email);
  if (!EMAIL_RE.test(to)) {
    return { status: 400, error: 'invalid', fields: { email: 'That does not look like an email address.' } };
  }
  if (!mail.on()) {
    return {
      status: 503, error: 'email-off',
      message: 'Signing in by email is not available right now. Try again shortly.'
    };
  }

  sweepExpired.run(now);
  const row = selCode.get(to);

  /* A window that has run out starts again; one still open counts up. */
  const fresh = !row || now - row.window_at > WINDOW_MS;
  const sent = fresh ? 1 : row.sent + 1;
  if (!fresh && sent > PER_WINDOW) {
    /* Answered as success on purpose — see the header. The limit is real,
       it is just not something this route confirms to a stranger. */
    logEvent('system', 'code-throttled', { email: to }, now);
    return SENT;
  }

  const code = newCode();
  dbm.tx(issue, to, code, sent, fresh ? now : row.window_at, now, lang);
  return SENT;
}

/* Named so db.tx caches the wrapped transaction. The row and the queued
   email commit together: a code that exists with no mail carrying it is a
   person locked out, and mail carrying a code with no row is a code that
   cannot work. */
function issue(email, code, sent, windowAt, now, lang) {
  putCode.run({
    email, hash: hashOf(code, email),
    expires_at: now + LIFE_MS, sent, window_at: windowAt, now
  });
  mail.sendCode(email, code, Math.round(LIFE_MS / 60000), lang, now);
  logEvent('system', 'code-sent', { email, sent }, now);
}

const BAD = {
  status: 400, error: 'bad-code',
  fields: { code: 'That code is wrong or has expired. Ask for a new one.' }
};

/* Returns { email } when the code was right, or a refusal body. Consuming
   is unconditional on success: a code is good exactly once. */
function verify(email, code, now = Date.now()) {
  const to = norm(email);
  const given = String(code || '').trim();
  if (!/^\d{6}$/.test(given)) return BAD;

  const row = selCode.get(to);
  if (!row) return BAD;
  if (row.expires_at < now) { dropCode.run(to); return BAD; }
  if (row.attempts >= MAX_TRIES) { dropCode.run(to); return BAD; }

  const want = Buffer.from(row.hash, 'hex');
  const got = Buffer.from(hashOf(given, to), 'hex');
  /* timingSafeEqual throws on a length mismatch; both are sha256 so they
     cannot differ, but the guard costs nothing and the throw would be a 500 */
  const ok = want.length === got.length && crypto.timingSafeEqual(want, got);

  if (!ok) {
    bumpAttempt.run(to);
    /* Tell them how many are left — it is not information an attacker can
       use (they know how many they have had) and it is the difference
       between "wrong" and "you have one more go". */
    const left = MAX_TRIES - (row.attempts + 1);
    return left > 0
      ? { status: 400, error: 'bad-code',
          fields: { code: `That code is wrong — ${left} ${left === 1 ? 'try' : 'tries'} left.` } }
      : BAD;
  }

  dropCode.run(to);
  return { ok: true, email: to };
}

module.exports = {
  request, verify, newCode, hashOf, norm,
  LIFE_MS, MAX_TRIES, PER_WINDOW, WINDOW_MS,
  sweepExpired: now => sweepExpired.run(now).changes
};
