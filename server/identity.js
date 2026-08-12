/* ═══════════════════════════════════════════════════════════════
   identity — who is asking, and what they have left

   Still IP-keyed, but the ledger is gone: a caller is now a real
   users row with an allowances row beside it, and the Map in here is
   only a write-through cache so the common path doesn't hit SQLite
   for every request. Phase 2 swaps the key for a signed cookie by
   rewriting keyToUser() and dropping legacy_keys — rowFor and
   allowanceOf keep their shape, so nothing above this file moves.

   writeAllowance() deliberately runs bare statements rather than its
   own transaction: wall.js calls it from inside the claim transaction,
   which is what makes §4.6 true (a burst of parallel claims cannot
   overspend, because the spend commits with the pixels or not at all).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config.js');
const { db, tx } = require('./db.js');

/* ── Who is asking ────────────────────────────────────────────── */

/* A caller holding an IPv6 /64 can walk through billions of addresses,
   so v6 is grouped on its prefix. v4 is used whole. */
function ipv6Prefix(ip) {
  const bare = ip.split('%')[0];                       // drop any zone id
  let groups;
  if (bare.includes('::')) {
    const [head, tail] = bare.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = bare.split(':');
  }
  return groups.slice(0, 4).map(g => (g || '0').padStart(4, '0')).join(':') + '::/64';
}

function callerKey(req) {
  let ip = req.socket.remoteAddress || '';
  if (cfg.TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0];
    if (fwd && fwd.trim()) ip = fwd.trim();
  }
  ip = ip.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');   // IPv4-mapped v6
  if (!ip) return 'unknown';
  return ip.includes(':') ? ipv6Prefix(ip) : ip;
}

/* Stable, non-identifying display name for a caller. */
function handleFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `Pixel fan #${(h >>> 0) % 9000 + 1000}`;
}

/* ── Statements ───────────────────────────────────────────────── */

const findKey = db.prepare(
  `SELECT u.id, u.handle, u.last_seen, a.used, a.refill_at, a.paint
     FROM legacy_keys k JOIN users u ON u.id = k.user_id
     LEFT JOIN allowances a ON a.user_id = u.id
    WHERE k.key = ?`);
const insUser = db.prepare(
  "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', ?, ?, ?)");
const insKey = db.prepare('INSERT INTO legacy_keys (key, user_id, created_at) VALUES (?, ?, ?)');
const insAllowance = db.prepare('INSERT INTO allowances (user_id) VALUES (?)');
const setAllowance = db.prepare(
  'UPDATE allowances SET used = ?, refill_at = ?, paint = ? WHERE user_id = ?');
const bumpPaint = db.prepare('UPDATE allowances SET paint = paint + ? WHERE user_id = ?');
const readAllowance = db.prepare('SELECT used, refill_at, paint FROM allowances WHERE user_id = ?');
const clearAllowances = db.prepare('UPDATE allowances SET used = 0, refill_at = 0');
const seenStmt = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

/* ── Per-caller row ───────────────────────────────────────────── */

/* key -> { id, used, refillAt, paint, handle, seen, wrote }
   A pure cache: every field also lives in SQLite, and dropping an entry
   costs one SELECT, so the idle sweep below can be as brutal as it likes. */
const cache = new Map();

function keyToUser(key, now) {
  return tx(() => {
    const found = findKey.get(key);
    if (found) return found;
    const id = Number(insUser.run(handleFor(key), now, now).lastInsertRowid);
    insKey.run(key, id, now);
    insAllowance.run(id);
    return { id, handle: handleFor(key), last_seen: now, used: 0, refill_at: 0, paint: 0 };
  });
}

/* Fetches the caller's row, applying an elapsed refill first so the rest of
   the code never has to think about expiry. */
function rowFor(key, now) {
  let e = cache.get(key);
  if (!e) {
    const u = keyToUser(key, now);
    e = {
      id: u.id, handle: u.handle, seen: u.last_seen || now, wrote: u.last_seen || 0,
      used: u.used || 0, refillAt: u.refill_at || 0, paint: u.paint || 0
    };
    cache.set(key, e);
  }
  if (e.refillAt && now >= e.refillAt) {
    e.used = 0; e.refillAt = 0;
    writeAllowance(e);
  }
  return e;
}

/* Bare UPDATE — no transaction of its own, so it joins whichever one the
   caller is already inside (see the header). */
function writeAllowance(e) {
  setAllowance.run(e.used, e.refillAt, e.paint, e.id);
}

function allowanceOf(e, now) {
  return {
    cap: cfg.CAP, free: Math.max(0, cfg.CAP - e.used), paint: e.paint,
    refillAt: e.refillAt || 0,
    refillIn: e.refillAt ? Math.max(0, e.refillAt - now) : 0,
    refillMs: cfg.REFILL, handle: e.handle, now
  };
}

/* last_seen is only interesting to the minute — a write per request would
   dirty a page on every poll of /api/allowance for nothing. */
function touch(e, now) {
  e.seen = now;
  if (now - e.wrote < 60000) return;
  e.wrote = now;
  seenStmt.run(now, e.id);
}

/* the monthly wipe hands everyone their free pixels back. Runs inside the
   reset transaction, so again: no transaction of its own. */
function resetAllowances() {
  clearAllowances.run();
  for (const e of cache.values()) { e.used = 0; e.refillAt = 0; }
}

function refill(e) {
  e.used = 0; e.refillAt = 0;
  tx(writeAllowance, e);
  return e;
}

/* the paint shop. Reads the row back so a concurrent write can't be lost. */
function creditPaint(e, n) {
  tx(() => {
    bumpPaint.run(n, e.id);
    e.paint = readAllowance.get(e.id).paint;
  });
  return e;
}

/* An idle row costs a Map entry and nothing else; SQLite keeps the truth. */
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) {
    if (e.refillAt && now >= e.refillAt) { e.used = 0; e.refillAt = 0; tx(writeAllowance, e); }
    if (now - e.seen > cfg.IDLE_DROP) cache.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  ipv6Prefix, callerKey, handleFor,
  cache, rowFor, allowanceOf, writeAllowance, touch, refill, creditPaint, resetAllowances
};
