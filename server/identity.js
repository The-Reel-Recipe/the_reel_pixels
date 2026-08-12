/* ═══════════════════════════════════════════════════════════════
   identity — who is asking, and what they have left

   Still IP-keyed: a cleared browser or a private window gets you
   nothing, and gets you nothing back either. Phase 2 moves the key
   onto a signed cookie and the ledger into SQLite; the shape of
   rowFor/allowanceOf is what the rest of the server talks to, so
   that swap stays local to this file.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const cfg = require('./config.js');

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

/* ── Per-caller ledger ────────────────────────────────────────── */

const ledger = new Map();             // key -> { used, refillAt, paint, handle, seen }
let ledgerTimer = null;

function saveLedger() {
  clearTimeout(ledgerTimer);
  ledgerTimer = setTimeout(() => {
    const keys = {};
    for (const [k, e] of ledger) keys[k] = e;
    fs.writeFile(cfg.LEDGER_FILE, JSON.stringify({ v: 2, cap: cfg.CAP, keys }), err => {
      if (err) console.warn('ledger: save failed —', err.message);
    });
  }, 250);
  if (ledgerTimer.unref) ledgerTimer.unref();
}
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.LEDGER_FILE, 'utf8'));
    for (const [key, e] of Object.entries(raw.keys || {})) {
      if (!Number.isFinite(e.used)) continue;
      // seen has to come back too, or a restored row is never idle-swept
      // (now - undefined is NaN, and NaN > IDLE_DROP is false forever)
      ledger.set(key, {
        used: e.used, refillAt: e.refillAt || 0, paint: e.paint || 0,
        handle: e.handle || handleFor(key), seen: e.seen || Date.now()
      });
    }
    console.log(`ledger: restored ${ledger.size} caller(s)`);
  } catch (e) { /* first run, or a mangled file — start clean */ }
}

/* Fetches the caller's row, applying an elapsed refill first so the rest of
   the code never has to think about expiry. */
function rowFor(key, now) {
  let e = ledger.get(key);
  if (!e) { e = { used: 0, refillAt: 0, paint: 0, handle: handleFor(key), seen: now }; ledger.set(key, e); }
  if (e.refillAt && now >= e.refillAt) { e.used = 0; e.refillAt = 0; }
  return e;
}
function allowanceOf(e, now) {
  return {
    cap: cfg.CAP, free: Math.max(0, cfg.CAP - e.used), paint: e.paint,
    refillAt: e.refillAt || 0,
    refillIn: e.refillAt ? Math.max(0, e.refillAt - now) : 0,
    refillMs: cfg.REFILL, handle: e.handle, now
  };
}
/* the monthly wipe hands everyone their free pixels back */
function resetAllowances() {
  for (const e of ledger.values()) { e.used = 0; e.refillAt = 0; }
}

setInterval(() => {
  const now = Date.now();
  let dropped = 0;
  for (const [k, e] of ledger) {
    if (e.refillAt && now >= e.refillAt) { e.used = 0; e.refillAt = 0; }
    if (!e.used && !e.refillAt && !e.paint && now - e.seen > cfg.IDLE_DROP) { ledger.delete(k); dropped++; }
  }
  if (dropped) saveLedger();
}, 10 * 60 * 1000).unref();

module.exports = {
  ipv6Prefix, callerKey, handleFor,
  ledger, loadLedger, saveLedger, rowFor, allowanceOf, resetAllowances
};
