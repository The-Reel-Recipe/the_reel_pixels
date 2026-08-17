/* ═══════════════════════════════════════════════════════════════
   config — every knob the process reads, parsed once

   Reads the environment, checks the shapes, and in production
   refuses to boot when a secret the running code actually needs is
   missing. Dev fills safe defaults instead and collects a warning
   for index.js to print, so requiring this file stays quiet.

   .env.example documents the lot.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const env = process.env;
const ROOT = path.join(__dirname, '..');
const ON_VERCEL = !!env.VERCEL;
const PROD = env.NODE_ENV === 'production';
const warnings = [];

const bad = msg => { throw new Error('config: ' + msg); };

/* ── shapes ───────────────────────────────────────────────────── */

function port(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) bad(`PORT must be 1-65535, got "${v}"`);
  return n;
}
/* comma-separated, blanks dropped */
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function ids(name, v) {
  return list(v).map(s => {
    if (!/^-?\d+$/.test(s)) bad(`${name} takes numeric telegram ids, got "${s}"`);
    return Number(s);
  });
}
function href(name, v, dflt) {
  if (v === undefined || v === '') return dflt;
  let u;
  try { u = new URL(v); } catch (e) { bad(`${name} is not a url: "${v}"`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`${name} must be http(s), got "${v}"`);
  return v.replace(/\/+$/, '');
}
function oneOf(name, v, allowed, dflt) {
  if (v === undefined || v === '') return dflt;
  if (!allowed.includes(v)) bad(`${name} must be one of ${allowed.join('|')}, got "${v}"`);
  return v;
}
function count(name, v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) bad(`${name} must be a whole number ≥ 0, got "${v}"`);
  return n;
}
/* A retention period, configured in whole days because that is the unit the
   privacy notice publishes it in, and returned in milliseconds because that
   is the unit everything else here speaks. Dividing back out is exact. */
const DAY = 24 * 60 * 60 * 1000;
function days(name, v, dflt) {
  const n = count(name, v, dflt);
  if (n < 1) bad(`${name} must be at least 1 day, got "${v}"`);
  return n * DAY;
}

/* tri-state: "1" on, "0" off, unset = whatever the deploy implies */
function flag(v, dflt) {
  if (v === '1') return true;
  if (v === '0') return false;
  return dflt;
}

/* ── secrets that gate a production boot ──────────────────────── */

/* `phase` is the plan phase that starts *reading* the value. A var is
   only enforced once the code needing it is in the tree — otherwise
   Phase 0 would demand a bot token for a server that has no bot yet,
   and every deploy between here and Phase 4 would refuse to start.
   Raise PHASE as each phase lands and the list enforces itself. */
const PHASE = 7;
const SECRETS = [
  { k: 'SESSION_SECRET', phase: 2, why: 'HMAC key for guest + brand cookies' },
  { k: 'TG_BOT_TOKEN', phase: 4, why: 'moderation bot' },
  { k: 'TG_CHAT_ID', phase: 4, why: 'moderation group' },
  { k: 'TG_WEBHOOK_SECRET', phase: 4, why: 'authenticates telegram callbacks' },
  { k: 'TG_MOD_IDS', phase: 4, why: 'who is allowed to press the buttons' },
  { k: 'PUBLIC_URL', phase: 4, why: 'webhook registration + links on cards' },
  { k: 'INSTAPAY_URL', phase: 5, why: 'where payers are sent' }
];

/* exported so a test can drive it with its own table */
function missingSecrets(src, phase, spec) {
  return (spec || SECRETS).filter(s => s.phase <= phase && !String(src[s.k] || '').trim());
}

const gaps = PROD ? missingSecrets(env, PHASE) : [];
if (gaps.length) {
  console.error('config: refusing to boot in production, missing:');
  for (const g of gaps) console.error(`  ${g.k}  —  ${g.why}`);
  bad('missing required env — ' + gaps.map(g => g.k).join(', '));
}

/* "Nothing goes on the public wall until a person has approved it" is the
   promise the whole product rests on, and two environment variables could
   quietly retire it: TG_MODE=off makes every submission approve itself on a
   timer, and an empty moderator list used to mean "anyone in the group".
   Both are legitimate in development and neither is survivable in
   production, so production refuses to start on either. */
if (PROD) {
  const mode = env.TG_MODE || 'webhook';
  if (mode === 'off') {
    bad('TG_MODE=off would auto-approve every submission — moderation is not optional in production');
  }
  if (!ids('TG_MOD_IDS', env.TG_MOD_IDS).length) {
    bad('TG_MOD_IDS is empty — nobody could approve anything, and an empty list must never mean everybody');
  }
}

/* ── values ───────────────────────────────────────────────────── */

/* `node server.js 5174` still works; anything non-numeric in argv[2]
   is somebody else's argument (the test runner's file, say). */
const argvPort = /^\d+$/.test(process.argv[2] || '') ? process.argv[2] : '';
/* Serverless ships a read-only bundle, so state goes to the temp dir
   there — per-instance, gone on a cold start. */
const STATE_DIR = path.resolve(env.STATE_DIR || (ON_VERCEL ? os.tmpdir() : ROOT));
/* Same story for the database and everything filed next to it. Vercel's
   bundle is read-only, so an unconfigured function gets a temp dir it can
   actually open — ephemeral, which is exactly why §1 of the plan moves the
   deploy to a VPS with a real volume. */
const DATA_DIR = path.resolve(env.DATA_DIR ||
  (ON_VERCEL ? path.join(os.tmpdir(), 's37-data') : path.join(ROOT, 'data')));

/* The version of the published documents, read from the same file the page
   generator fills in. Stamped on a user when they accept and on every order
   they place, so "which wording applied to S37-7F3K" has one answer that
   cannot drift from what was actually on the site.

   Falls back rather than throwing: an operator.json that is missing or
   half-edited must not stop the wall from serving. An order stamped
   'unversioned' is a gap in the record; a wall that will not boot is an
   outage, and only one of those is worth having. */
let operator = null;
function operatorFile() {
  if (operator) return operator;
  try {
    operator = JSON.parse(fs.readFileSync(path.join(ROOT, 'legal', 'operator.json'), 'utf8'));
  } catch (err) {
    warnings.push(`legal/operator.json unreadable (${err.code || err.message})`);
    operator = {};
  }
  return operator;
}
/* a value that may be a plain string or {en, ar} */
const plain = v => String((v && typeof v === 'object' ? v.en : v) || '').trim();

function termsVersion() {
  const s = plain(operatorFile().VERSION);
  if (s) return s;
  warnings.push('legal/operator.json has no VERSION — orders will be stamped "unversioned"');
  return 'unversioned';
}

/* The address printed in all six documents, so the app offers the same one
   rather than a second copy that can fall out of step with them. Empty is
   survivable: the client hides the contact links, the way it hides the
   policy links when the pages are not built. */
function contactEmail() {
  const s = plain(operatorFile()['CONTACT EMAIL']);
  if (!s) warnings.push('legal/operator.json has no CONTACT EMAIL — the app will offer no way to get in touch');
  return s;
}

const DEV_SECRET = 'dev-insecure-session-secret';
let SESSION_SECRET = String(env.SESSION_SECRET || '');
if (!SESSION_SECRET) {
  SESSION_SECRET = DEV_SECRET;
  warnings.push('SESSION_SECRET unset — using the dev default (cookies are forgeable)');
} else if (SESSION_SECRET.length < 16) {
  bad('SESSION_SECRET needs at least 16 characters');
}

module.exports = Object.freeze({
  ROOT, PROD, ON_VERCEL, PHASE, SECRETS, missingSecrets, warnings,

  PORT: port(env.PORT || argvPort, 5174),
  /* Vercel always terminates in front of the function, so its forwarded
     IP is the real one — anywhere else this stays opt-in, or anyone can
     spoof the header and mint themselves unlimited pixels. */
  TRUST_PROXY: env.TRUST_PROXY === '1' || ON_VERCEL,
  ALLOW_ORIGIN: env.ALLOW_ORIGIN || '',

  /* files */
  STATE_DIR,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'pixels.db'),
  ARCHIVE_DIR: path.join(DATA_DIR, 'archive'),     // one PNG per finished cycle
  BACKUP_DIR: path.join(DATA_DIR, 'backup'),       // nightly VACUUM INTO snapshots
  MIGRATIONS_DIR: path.join(ROOT, 'migrations'),
  /* prototype-era files. Nothing writes these any more; the wall importer
     reads .wall.bin once if it happens to be there and then leaves it be. */
  WALL_FILE: path.join(STATE_DIR, '.wall.bin'),
  SEED_FILE: path.join(ROOT, 'seed.bin'),          // committed starting artwork

  /* Wall shape and pricing. These are the defaults behind the runtime
     `config` table (settings.js) — the panel can move any of them without a
     deploy, and does not need one to change a price.

     Confirmed by Mohab, 2026-08-13: 2 EGP a pixel for paint, 5 for a brand
     logo. PLAN §6 had flagged the 10/10 in the prototype as unconfirmed
     against an older 2 EGP note; this settles it. Brand space costs more
     than paint on purpose — it is a month of prime wall, reserved ahead and
     promoted whole, rather than pixels that wipe with everything else.

     The packs keep the ladder they had: 10%, 20% and 30% off the per-pixel
     rate. The client derives the SAVE badges from price ÷ (paint × rate),
     so those percentages are computed from these numbers rather than
     written anywhere — change a pack and the badge follows. */
  W: 1000, H: 1000,
  /* Confirmed by Mohab, 2026-08-16: fifty at a time, back every hour. The
     first number is what a visitor can actually draw with — twenty is a
     scribble, fifty is a small thing you meant — and the second is what
     makes paint worth buying. Both are runtime-overridable from the panel
     (settings.js), so these are the answers a fresh install starts with. */
  CAP: 50,                                          // free pixels per caller
  REFILL: 60 * 60 * 1000,                           // …back this long after the last one goes
  PRICE_PAINT: 2, PRICE_COMPANY: 5,
  /* Packs are an amount and a discount, not a price. Written as prices they
     were a third copy of PRICE_PAINT: move the rate and every pack silently
     kept quoting the old one, with the client's SAVE badge — which divides
     price by amount × rate — reporting a discount nobody chose. The EGP is
     derived (settings.js), so a pack is "how much, and how much off". */
  PACK_OFFERS: { 25: 10, 100: 20, 500: 30 },        // paint amount -> % off
  IDLE_DROP: 24 * 60 * 60 * 1000,
  DELTA_MAX: 2000,                                  // bigger changes tell clients to refetch

  /* identity — §3. The caps move into the runtime `config` table in
     Phase 6 the same way the prices do; these are their defaults, with
     an env override so a suite (or a bad afternoon) can move them
     without a deploy. */
  IP_GUEST_CAP: count('IP_GUEST_CAP', env.IP_GUEST_CAP, 5),      // new identities per ip per day
  IP_CLAIM_CAP: count('IP_CLAIM_CAP', env.IP_CLAIM_CAP, 40),     // claim submissions per ip per day
  IP_SIGNUP_CAP: count('IP_SIGNUP_CAP', env.IP_SIGNUP_CAP, 3),   // brand signups per ip per day

  /* §9's token buckets, in requests per minute per address. Overridable for
     the same reason the caps above are: a suite that proves a daily cap
     works has to make forty claims, and it should be tripping the cap it is
     testing rather than the rate limiter in front of it. */
  RATE_READ: count('RATE_READ', env.RATE_READ, 240),
  RATE_WRITE: count('RATE_WRITE', env.RATE_WRITE, 30),
  RATE_AUTH: count('RATE_AUTH', env.RATE_AUTH, 5),
  /* A guest cookie is the only copy of who somebody is, so it outlives the
     wall it painted. Both are rolling — identity.resolve renews a cookie
     once it is past halfway — so these are "gone this long after your last
     visit", not "gone this long after you signed up". The brand figure was
     30 days, which is exactly the wrong number for a product whose cycle is
     a month: a brand that books every cycle would meet the login screen
     every cycle, on the visit where they were coming to spend money. */
  GUEST_TTL: 365 * 24 * 60 * 60 * 1000,
  BRAND_TTL: 180 * 24 * 60 * 60 * 1000,

  /* ── How long things are kept ────────────────────────────────
     The privacy notice publishes these as promises, so they are
     defined once, here, and retention.js is what makes them true.
     test/retention.test.js reads legal/operator.json and fails if
     the published number and the enforced one drift apart — the
     only way a promise stays honest is if breaking it breaks the
     build.

     RETAIN_IP is a floor as well as a ceiling: Anti-Cyber Crime
     Law 175/2018 obliges a service provider to retain the data
     identifying its users for 180 days. Shortening it is not a
     privacy improvement, it is a different offence.

     Where the notice says "months", a month is 30 days here. That
     makes 24 months 720 days rather than 730 — a few days shorter
     than the reading somebody might take off the page, which is the
     safe direction to be wrong in: we delete before the promise
     expires, never after. */
  RETAIN_IP: days('RETAIN_IP', env.RETAIN_IP, 180),
  /* A submission is the evidence for a moderation decision — the
     answer to "you deleted my drawing" and to a demand about what
     was on the wall in March. Two years outlives any plausible
     complaint window and is not "forever". */
  RETAIN_SUBMISSION: days('RETAIN_SUBMISSION', env.RETAIN_SUBMISSION, 720),
  /* Counted from the day a payment stopped moving, not from the day
     it was made: a screenshot settles "did the money arrive", and
     that question is closed once the payment is final. The payment
     row itself stays for the tax period — that is a different
     obligation with a different clock. */
  RETAIN_SCREENSHOT: days('RETAIN_SCREENSHOT', env.RETAIN_SCREENSHOT, 360),
  /* An account with no email, no submission and no payment is a
     cookie nobody came back for. Deleting it is the whole of what
     it means to hold no more than you need. */
  RETAIN_DORMANT: days('RETAIN_DORMANT', env.RETAIN_DORMANT, 360),
  /* Off by default everywhere but production: a suite that seeds a
     row dated last year should not race a sweeper for it. */
  RETENTION_SWEEP: flag(env.RETENTION_SWEEP, PROD),
  /* Secure would make the cookie invisible over plain http, which is
     every local dev session — on by default only where TLS is certain */
  COOKIE_SECURE: flag(env.COOKIE_SECURE, PROD),
  /* scrypt at the parameters node:crypto can afford synchronously:
     128·N·r = 16 MB and ~60 ms per hash on the target VPS */
  SCRYPT: { N: 16384, r: 8, p: 1, keylen: 32, saltlen: 32 },
  PASS_MIN: 10,
  /* Stamped on a user when they accept and on every order they place. */
  TERMS_VERSION: termsVersion(),
  /* Both read from legal/operator.json, so the app and the documents cannot
     end up naming different places to write to. */
  CONTACT_EMAIL: contactEmail(),
  DESC_MIN: 200,

  /* secrets + integrations (unused until their phase; parsed now so a
     typo surfaces at boot rather than three phases later) */
  SESSION_SECRET,
  TG_BOT_TOKEN: env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: env.TG_CHAT_ID || '',
  TG_WEBHOOK_SECRET: env.TG_WEBHOOK_SECRET || '',
  TG_MOD_IDS: ids('TG_MOD_IDS', env.TG_MOD_IDS),
  TG_MODE: oneOf('TG_MODE', env.TG_MODE, ['webhook', 'poll', 'off'], PROD ? 'webhook' : 'off'),
  /* TG_MODE=off has no moderator, so submissions approve themselves after
     this long (§5). Not zero: the pending state is the thing worth looking
     at in dev, and at 0 ms it would never be on screen. Tests set it to 0. */
  AUTO_APPROVE_MS: count('AUTO_APPROVE_MS', env.AUTO_APPROVE_MS, 2000),
  INSTAPAY_URL: href('INSTAPAY_URL', env.INSTAPAY_URL, ''),
  /* Shown next to the link so a payer who would rather type the handle into
     their own banking app than follow a link can. Same destination. */
  INSTAPAY_HANDLE: (env.INSTAPAY_HANDLE || '').trim(),
  PUBLIC_URL: href('PUBLIC_URL', env.PUBLIC_URL, ''),

  /* ── Brevo, for the codes that let somebody in ────────────────
     Unset means no email at all, and everything that would send one
     says so instead of pretending. Same shape as TG_MODE=off: a
     missing integration is a configuration the product understands,
     not a crash. */
  BREVO_API_KEY: (env.BREVO_API_KEY || '').trim(),
  BREVO_SENDER_EMAIL: (env.BREVO_SENDER_EMAIL || '').trim(),
  BREVO_SENDER_NAME: (env.BREVO_SENDER_NAME || 'S37').trim(),

  /* ── Google, for painters ─────────────────────────────────────
     The client secret is only ever used server-side, in the token
     exchange — it never reaches the browser. The id is public by
     design and the page needs it, so it travels in the snapshot.

     Both unset means the button is not rendered, the routes answer
     404, and nothing in the app mentions Google. That is the same
     rule the legal links follow: an affordance that cannot work is
     worse than one that is absent. */
  GOOGLE_CLIENT_ID: (env.GOOGLE_CLIENT_ID || '').trim(),
  GOOGLE_CLIENT_SECRET: (env.GOOGLE_CLIENT_SECRET || '').trim(),
  ADMIN_IP_ALLOW: list(env.ADMIN_IP_ALLOW)
});
