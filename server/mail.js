/* ═══════════════════════════════════════════════════════════════
   mail — the one place an email leaves this process

   Brevo's HTTP transactional API, nothing else. No SMTP client, no
   dependency: one POST with an api-key header, which is the whole
   integration.

   Two rules, both learned from telegram.js next door.

   Sending never blocks the request that caused it. A sign-in code
   goes into a queue and a worker drains it, so Brevo being slow or
   down means the code arrives late rather than the sign-in failing.
   The difference matters most in the case where it is most likely:
   somebody trying to get in while the provider is having a bad
   afternoon.

   And an unconfigured integration is a configuration, not a crash.
   With no BREVO_API_KEY this module is off — `on()` is false, every
   send is a no-op that says so, and the routes that would offer an
   emailed code do not offer one. The app has run without email
   since it was written; it must keep running without it.

   What this deliberately does NOT do is retry forever. A Telegram
   card is a moderation task that has to survive; a sign-in code is
   worthless four minutes after it was asked for. Three attempts
   inside its own lifetime, then it is dropped, because the person
   waiting has already asked for another one.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config');
const dbm = require('./db');

const db = dbm.db;
const logEvent = dbm.logEvent;

const API = 'https://api.brevo.com/v3/smtp/email';

const on = () => !!(cfg.BREVO_API_KEY && cfg.BREVO_SENDER_EMAIL);

/* ── The queue ────────────────────────────────────────────────────
   The same outbox shape the Telegram worker uses, in its own table so
   a backlog of one cannot delay the other. `about` is what the row is
   for, and it is what makes a supersede cheap: asking for a second
   code drops the first from the queue rather than racing it. */

const insMail = db.prepare(
  `INSERT INTO mail_outbox (about, to_email, subject, html, text, next_try, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`);
const nextDue = db.prepare('SELECT * FROM mail_outbox WHERE next_try <= ? ORDER BY id LIMIT 1');
const bumpTry = db.prepare('UPDATE mail_outbox SET attempts = attempts + 1, next_try = ? WHERE id = ?');
const dropMail = db.prepare('DELETE FROM mail_outbox WHERE id = ?');
const dropAbout = db.prepare('DELETE FROM mail_outbox WHERE about = ?');
const depth = db.prepare('SELECT COUNT(*) n, MIN(created_at) oldest FROM mail_outbox');

const TRIES = 3;

/* No transaction of its own: callers are inside one, which is what makes
   "the code row and the email that carries it commit together" true. */
function enqueue(msg, now = Date.now()) {
  if (!on()) return null;
  if (msg.about) dropAbout.run(msg.about);
  return Number(insMail.run(
    msg.about || null, msg.to, msg.subject, msg.html, msg.text || null, now, now).lastInsertRowid);
}

/* ── Sending ──────────────────────────────────────────────────── */

async function send(msg) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'api-key': cfg.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { email: cfg.BREVO_SENDER_EMAIL, name: cfg.BREVO_SENDER_NAME },
      to: [{ email: msg.to_email }],
      subject: msg.subject,
      htmlContent: msg.html,
      ...(msg.text ? { textContent: msg.text } : {})
    })
  });
  if (res.ok) return true;

  const body = await res.json().catch(() => ({}));
  const err = new Error(`brevo ${res.status}: ${body.message || body.code || 'failed'}`);
  err.code = res.status;
  /* 400 is a bad address or an unverified sender — trying again changes
     nothing. 401 means the key is wrong or the account has an IP allowlist
     the container is not on, which also will not fix itself. */
  err.permanent = res.status === 400 || res.status === 401;
  throw err;
}

let timer = null, running = false;

async function drainOne(now) {
  const row = nextDue.get(now);
  if (!row) return false;
  try {
    await send(row);
    dropMail.run(row.id);
  } catch (err) {
    const done = err.permanent || row.attempts + 1 >= TRIES;
    if (done) {
      dropMail.run(row.id);
      /* Loud, and in the journal: an email nobody can send is somebody
         who cannot get in, and it is invisible from the outside. */
      console.error('mail: giving up —', err.message);
      logEvent('system', 'mail-failed',
        { about: row.about, error: err.message, attempts: row.attempts + 1 }, now);
    } else {
      bumpTry.run(now + 4000 * (row.attempts + 1), row.id);
      if (row.attempts === 0) console.warn('mail:', err.message, '— retrying');
    }
  }
  return true;
}

async function drain() {
  if (running || !on()) return;
  running = true;
  try {
    for (let i = 0; i < 10; i++) if (!await drainOne(Date.now())) break;
  } finally { running = false; }
}

function startWorker() {
  if (timer || !on()) return null;
  timer = setInterval(drain, 1000);
  timer.unref();
  return timer;
}
function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }

/* ── What we actually send ────────────────────────────────────────
   One template, because there is one message: here is your code.

   Plain, inlined, and short on purpose. A sign-in code that lands in
   spam is a person who cannot get in, and the things that put mail in
   spam are images, link-heavy bodies and clever markup. The code is in
   the subject line as well as the body so a phone's notification is
   enough — most people never open the message. */

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function codeMessage(code, minutes, lang) {
  const ar = lang === 'ar';
  const subject = ar ? `${code} — كود الدخول إلى S37` : `${code} — your S37 sign-in code`;
  const dir = ar ? 'rtl' : 'ltr';
  const lines = ar
    ? { lead: 'كود الدخول بتاعك:', life: `الكود ده صالح ${minutes} دقيقة.`,
        no: 'لو مش إنت اللي طلبته، تجاهل الرسالة دي — محدش يقدر يدخل من غير الكود.' }
    : { lead: 'Your sign-in code:', life: `It works for ${minutes} minutes.`,
        no: 'If you did not ask for this, ignore it — nobody can get in without the code.' };

  const html =
    `<div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;` +
    `font-size:16px;line-height:1.6;color:#1a1a1a;max-width:32rem">` +
    `<p style="margin:0 0 12px">${esc(lines.lead)}</p>` +
    `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:.18em">${esc(code)}</p>` +
    `<p style="margin:0 0 8px;color:#555">${esc(lines.life)}</p>` +
    `<p style="margin:0;color:#555">${esc(lines.no)}</p>` +
    `<p style="margin:20px 0 0;color:#888;font-size:13px">S37 · شخبط على الحيط</p>` +
    `</div>`;

  const text = `${lines.lead}\n\n${code}\n\n${lines.life}\n${lines.no}\n\nS37`;
  return { subject, html, text };
}

/* Queued against `code:<email>`, so a second request supersedes the first
   rather than sending two codes that race each other into an inbox. */
function sendCode(email, code, minutes, lang, now = Date.now()) {
  const m = codeMessage(code, minutes, lang);
  return enqueue({ about: `code:${email}`, to: email, subject: m.subject, html: m.html, text: m.text }, now);
}

module.exports = {
  on, enqueue, send, drain, drainOne, startWorker, stopWorker,
  sendCode, codeMessage,
  status: () => depth.get()
};
