/* ═══════════════════════════════════════════════════════════════
   settings — the knobs, editable without a deploy

   PLAN §2 and §7.2: prices, caps and maintenance mode live in the
   `config` table, with the values in config.js as their defaults. A
   row overrides the default, every change is audited, and nothing
   restarts — which matters because the alternative is that changing
   a price means a deploy, and a deploy means the wall is down for a
   minute over a number.

   Reads are hot, so the table is cached in memory and the cache is
   rebuilt on write. One process (§4.1), so there is nobody to
   invalidate but ourselves.

   Every value is validated on the way in, by type and by range. The
   panel is the only writer and it is behind TOTP, but a price of
   "-5" or a cap of Infinity is a bad afternoon regardless of who
   typed it.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config.js');
const { db, logEvent } = require('./db.js');

/* ── The schema ───────────────────────────────────────────────── */

const int = (min, max) => v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be a whole number ${min}–${max}`);
  return n;
};
const bool = v => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  throw new Error('must be true or false');
};
/* packs are { paintAmount: priceEgp }, and both halves have to be sane */
const packs = v => {
  const obj = typeof v === 'string' ? JSON.parse(v) : v;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('must be an object');
  const out = {};
  const keys = Object.keys(obj);
  if (!keys.length || keys.length > 8) throw new Error('needs between 1 and 8 packs');
  for (const k of keys) {
    const amount = int(1, 1000000)(k);
    out[amount] = int(1, 10000000)(obj[k]);
  }
  return out;
};

const SPEC = {
  price_paint:   { of: int(1, 100000), why: 'EGP per pixel of paint' },
  price_company: { of: int(1, 100000), why: 'EGP per pixel of brand logo' },
  packs:         { of: packs, why: 'paint amount → EGP' },
  cap:           { of: int(0, 100000), why: 'free pixels per person per batch' },
  refill_ms:     { of: int(0, 30 * 24 * 3600 * 1000), why: 'how long until the free batch comes back' },
  ip_guest_cap:  { of: int(0, 100000), why: 'new identities per IP per day' },
  ip_claim_cap:  { of: int(0, 1000000), why: 'claims per IP per day' },
  ip_signup_cap: { of: int(0, 10000), why: 'brand applications per IP per day' },
  hold_ttl:      { of: int(60000, 30 * 24 * 3600 * 1000), why: 'how long an unpaid order holds its pixels' },
  maintenance:   { of: bool, why: 'the wall reads fine, claims say “back soon”' }
};

/* config.js is where a fresh install's answers come from — the table only
   ever holds what somebody has deliberately changed. */
const DEFAULTS = {
  price_paint: cfg.PRICE_PAINT,
  price_company: cfg.PRICE_COMPANY,
  packs: cfg.PACKS,
  cap: cfg.CAP,
  refill_ms: cfg.REFILL,
  ip_guest_cap: cfg.IP_GUEST_CAP,
  ip_claim_cap: cfg.IP_CLAIM_CAP,
  ip_signup_cap: cfg.IP_SIGNUP_CAP,
  hold_ttl: 48 * 3600 * 1000,
  maintenance: false
};

/* ── The cache ────────────────────────────────────────────────── */

const selAll = db.prepare('SELECT k, v, updated_at, updated_by FROM config');
const upsert = db.prepare(
  `INSERT INTO config (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at,
                                  updated_by = excluded.updated_by`);
const wipe = db.prepare('DELETE FROM config WHERE k = ?');

let values = {}, meta = {};

function load() {
  values = { ...DEFAULTS };
  meta = {};
  for (const row of selAll.all()) {
    const spec = SPEC[row.k];
    if (!spec) continue;                        // a key from a newer version, or a typo
    try {
      values[row.k] = spec.of(JSON.parse(row.v));
      meta[row.k] = { at: row.updated_at, by: row.updated_by };
    } catch (err) {
      console.warn(`settings: ignoring stored ${row.k} — ${err.message}`);
    }
  }
  return values;
}
load();

const get = k => values[k];
const all = () => ({ ...values });

/* What the panel renders: the value, where it came from, and what it is
   for — so nobody has to read this file to change a price. */
function describe() {
  return Object.keys(SPEC).map(k => ({
    key: k,
    value: values[k],
    default: DEFAULTS[k],
    overridden: Object.prototype.hasOwnProperty.call(meta, k),
    updatedAt: (meta[k] || {}).at || null,
    updatedBy: (meta[k] || {}).by || null,
    why: SPEC[k].why
  }));
}

function set(k, raw, actor, now = Date.now()) {
  const spec = SPEC[k];
  if (!spec) return { error: 'unknown-key', message: `There is no setting called “${k}”.` };
  let value;
  try { value = spec.of(raw); }
  catch (err) { return { error: 'invalid', message: `${k} ${err.message}.` }; }

  const before = values[k];
  upsert.run(k, JSON.stringify(value), now, actor);
  load();
  logEvent(actor, 'config-set', { key: k, from: before, to: value }, now);
  return { ok: true, key: k, value, was: before };
}

/* Back to the code's own answer. Distinct from setting it *to* the default:
   this drops the row, so a later change to config.js is picked up. */
function reset(k, actor, now = Date.now()) {
  if (!SPEC[k]) return { error: 'unknown-key' };
  const before = values[k];
  wipe.run(k);
  load();
  logEvent(actor, 'config-reset', { key: k, from: before, to: values[k] }, now);
  return { ok: true, key: k, value: values[k], was: before };
}

/* Read like a constant at the call sites that used to read cfg — the point
   of this file is that `S.CAP` is as cheap as `cfg.CAP` was. */
const S = {
  get PRICE_PAINT() { return values.price_paint; },
  get PRICE_COMPANY() { return values.price_company; },
  get PACKS() { return values.packs; },
  get CAP() { return values.cap; },
  get REFILL() { return values.refill_ms; },
  get IP_GUEST_CAP() { return values.ip_guest_cap; },
  get IP_CLAIM_CAP() { return values.ip_claim_cap; },
  get IP_SIGNUP_CAP() { return values.ip_signup_cap; },
  get HOLD_TTL() { return values.hold_ttl; },
  get MAINTENANCE() { return values.maintenance; }
};

module.exports = { S, get, set, all, reset, describe, load, DEFAULTS, SPEC };
