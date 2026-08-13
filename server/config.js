/* ═══════════════════════════════════════════════════════════════
   config — every knob the process reads, parsed once

   Reads the environment, checks the shapes, and in production
   refuses to boot when a secret the running code actually needs is
   missing. Dev fills safe defaults instead and collects a warning
   for index.js to print, so requiring this file stays quiet.

   .env.example documents the lot.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

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
const PHASE = 2;
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
  DEV: env.DEV !== '0',
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

  /* wall shape and pricing — these move into the runtime `config`
     table in Phase 6; the values here become its defaults */
  W: 1000, H: 1000,
  CAP: 20,                                          // free pixels per caller
  REFILL: 30 * 60 * 1000,                           // …back this long after the last one goes
  PRICE_PAINT: 10, PRICE_COMPANY: 10,
  PACKS: { 25: 225, 100: 800, 500: 3500 },          // paint amount -> EGP
  IDLE_DROP: 24 * 60 * 60 * 1000,
  DELTA_MAX: 2000,                                  // bigger changes tell clients to refetch

  /* identity — §3. The caps move into the runtime `config` table in
     Phase 6 the same way the prices do; these are their defaults, with
     an env override so a suite (or a bad afternoon) can move them
     without a deploy. */
  IP_GUEST_CAP: count('IP_GUEST_CAP', env.IP_GUEST_CAP, 5),      // new identities per ip per day
  IP_CLAIM_CAP: count('IP_CLAIM_CAP', env.IP_CLAIM_CAP, 40),     // claim submissions per ip per day
  IP_SIGNUP_CAP: count('IP_SIGNUP_CAP', env.IP_SIGNUP_CAP, 3),   // brand signups per ip per day
  /* a guest cookie is the only copy of who somebody is, so it outlives
     the wall it painted; a brand session is a login and expires like one */
  GUEST_TTL: 365 * 24 * 60 * 60 * 1000,
  BRAND_TTL: 30 * 24 * 60 * 60 * 1000,
  /* Secure would make the cookie invisible over plain http, which is
     every local dev session — on by default only where TLS is certain */
  COOKIE_SECURE: flag(env.COOKIE_SECURE, PROD),
  /* scrypt at the parameters node:crypto can afford synchronously:
     128·N·r = 16 MB and ~60 ms per hash on the target VPS */
  SCRYPT: { N: 16384, r: 8, p: 1, keylen: 32, saltlen: 32 },
  PASS_MIN: 10,
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
  ADMIN_IP_ALLOW: list(env.ADMIN_IP_ALLOW)
});
