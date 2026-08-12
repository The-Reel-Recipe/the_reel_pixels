/* ═══════════════════════════════════════════════════════════════
   wall — the pixels, the wire format, the monthly cycle

   SQLite owns the pixels now. The two maps (live now, reserved for
   next month) and the interned owner table are a cache projected off
   `cells` at boot and kept in step by the mutations below — nothing
   reads them to decide anything, they exist so a snapshot is a walk
   over memory instead of 19,000 rows.

   Every mutation is one synchronous transaction (§4.2). The cells PK
   (cycle, layer, idx) is the backstop (§4.3): two callers racing for
   the same pixel both run INSERT OR IGNORE, and exactly one of them
   sees changes === 1. The maps are only touched after the commit, so
   a rolled-back claim leaves no trace in memory either.

   Everything still auto-approves in this phase — submissions land
   'approved' and cells land 'live'. Phase 3 is where they arrive
   pending and wait for a moderator.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const identity = require('./identity.js');
const seed = require('./seed.js');
const { db, tx, getMeta, setMeta, logEvent } = require('./db.js');
const { writePng } = require('../tools/export-wall-png.js');

const { W, H } = cfg;

const cycleStart = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const cycleEnd = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };
/* local months, not UTC — a cycle starts at midnight where the wall lives,
   and toISOString() would file January's archive under December */
const monthKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/* live/reserved hold idx -> { c: 0xRRGGBB, o: ownerId }. Owner names are
   interned so a 160k-pixel logo costs one string, not 160k. */
const wall = {
  cycle: cycleStart(Date.now()),
  live: new Map(),
  reserved: new Map(),
  owners: [],                          // [{ n, t }]  index = ownerId
  ownerIds: new Map(),                 // "NAME\0type" -> ownerId  (NUL: no name holds one)
  brands: new Map(),                   // live sponsor links
  nextBrands: new Map(),               // …waiting on the queue
  rev: 0
};

function ownerId(name, type) {
  const k = name + '\0' + type;
  let id = wall.ownerIds.get(k);
  if (id === undefined) {
    id = wall.owners.length;
    wall.owners.push({ n: name, t: type });
    wall.ownerIds.set(k, id);
  }
  return id;
}
const validIdx = i => Number.isInteger(i) && i >= 0 && i < W * H;
const pack = m => { const out = new Array(m.size); let i = 0; for (const [idx, p] of m) out[i++] = [idx, p.c, p.o]; return out; };

/* ── Wire format ──────────────────────────────────────────────── */
/* [u32 metaLen][meta JSON][u32 aCount][a…][u32 bCount][b…]
   entry = u32 idx · u8 r · u8 g · u8 b · u16 ownerId   (9 bytes)
   One envelope for every direction: snapshot down, claim/book/seed up. */
const ENTRY = 9;

function encodeEnvelope(meta, a, b = []) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const buf = Buffer.allocUnsafe(4 + json.length + 4 + a.length * ENTRY + 4 + b.length * ENTRY);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  for (const list of [a, b]) {
    buf.writeUInt32LE(list.length, o); o += 4;
    for (const [idx, c, own] of list) {
      buf.writeUInt32LE(idx, o); o += 4;
      buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
      buf.writeUInt16LE(own, o); o += 2;
    }
  }
  return buf;
}
function decodeEnvelope(buf) {
  if (buf.length < 12) throw new Error('short envelope');
  let o = 0;
  const metaLen = buf.readUInt32LE(o); o += 4;
  if (metaLen > 1 << 20 || o + metaLen > buf.length) throw new Error('bad meta length');
  const meta = JSON.parse(buf.toString('utf8', o, o + metaLen)); o += metaLen;
  const readList = () => {
    const n = buf.readUInt32LE(o); o += 4;
    if (n > W * H || o + n * ENTRY > buf.length) throw new Error('bad entry count');
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = buf.readUInt32LE(o);
      const c = (buf[o + 4] << 16) | (buf[o + 5] << 8) | buf[o + 6];
      const own = buf.readUInt16LE(o + 7);
      o += ENTRY;
      out[i] = [idx, c, own];
    }
    return out;
  };
  return { meta, a: readList(), b: readList() };
}

/* `e` is the caller's identity row (see identity.resolve) — the snapshot is
   personal from here on: their handle, their standing as a brand, their
   allowance, and from Phase 3 their own pending pixels. */
function snapshotFor(e, now) {
  const meta = {
    v: 1, cycle: wall.cycle, cycleEnd: cycleEnd(now), rev: wall.rev,
    owners: wall.owners,
    brands: Object.fromEntries(wall.brands),
    nextBrands: Object.fromEntries(wall.nextBrands),
    me: identity.meta(e),
    dev: cfg.DEV,                        // the page hides the demo controls when this is off
    prices: { paint: cfg.PRICE_PAINT, company: cfg.PRICE_COMPANY, packs: cfg.PACKS },
    allowance: identity.allowanceOf(e, now)
  };
  return encodeEnvelope(meta, pack(wall.live), pack(wall.reserved));
}

/* ── Statements ───────────────────────────────────────────────── */

const selCells = db.prepare(
  "SELECT layer, idx, color, submission_id FROM cells WHERE cycle = ? AND state = 'live' ORDER BY layer, idx");
const selSubs = db.prepare(
  `SELECT s.id, s.layer, s.brand_name, s.brand_url, s.brand_cta, u.handle
     FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.cycle = ? ORDER BY s.id`);
const countCells = db.prepare('SELECT COUNT(*) n FROM cells WHERE cycle = ?');

const insSub = db.prepare(
  `INSERT INTO submissions (user_id, type, cycle, layer, px_count, bbox, pixels,
     brand_name, brand_url, brand_cta, status, created_at, decided_at, decided_by)
   VALUES (?, ?, ?, ?, 0, '[]', x'', ?, ?, ?, 'approved', ?, ?, 'system')`);
const fillSub = db.prepare('UPDATE submissions SET px_count = ?, bbox = ?, pixels = ? WHERE id = ?');
const dropSub = db.prepare('DELETE FROM submissions WHERE id = ?');
const insCell = db.prepare(
  `INSERT OR IGNORE INTO cells (cycle, layer, idx, color, submission_id, user_id, state)
   VALUES (?, ?, ?, ?, ?, ?, 'live')`);
const dropLive = db.prepare("DELETE FROM cells WHERE cycle = ? AND layer = 'live'");
const promoteCells = db.prepare(
  "UPDATE cells SET cycle = ?, layer = 'live' WHERE cycle = ? AND layer = 'next'");
const promoteSubs = db.prepare(
  "UPDATE submissions SET cycle = ?, layer = 'live' WHERE cycle = ? AND layer = 'next'");

/* ── Cache ────────────────────────────────────────────────────── */

/* Owner ids are handed out in submission order, not pixel order: an
   imported seed keeps the owner table the envelope shipped with, and a
   fresh claim interns its owner exactly where the live server did. Only
   submissions that still hold cells get an id, which is what the old
   compactOwners() was for. */
function rebuildCache() {
  const cells = selCells.all(wall.cycle);
  const alive = new Set(cells.map(c => c.submission_id));

  wall.live = new Map(); wall.reserved = new Map();
  wall.owners = []; wall.ownerIds = new Map();
  wall.brands = new Map(); wall.nextBrands = new Map();

  const owner = new Map();               // submission id -> ownerId
  for (const s of selSubs.all(wall.cycle)) {
    if (!alive.has(s.id)) continue;
    const name = s.brand_name || s.handle;
    owner.set(s.id, ownerId(name, s.brand_name ? 'c' : 'u'));
    if (s.brand_name && s.brand_url) {
      (s.layer === 'live' ? wall.brands : wall.nextBrands)
        .set(name, { url: s.brand_url, cta: s.brand_cta || 'VISIT SITE' });
    }
  }
  for (const c of cells) {
    (c.layer === 'live' ? wall.live : wall.reserved)
      .set(c.idx, { c: c.color, o: owner.get(c.submission_id) || 0 });
  }
  return wall;
}

/* ── Boot ─────────────────────────────────────────────────────── */

/* A virgin database adopts the committed artwork — or, on a machine that
   ran the file-backed prototype, whatever .wall.bin was left holding.
   That file is read and then left exactly where it was: it is the user's
   copy of their wall, not ours to delete. */
function importOnce(now) {
  const legacy = fs.existsSync(cfg.WALL_FILE);
  const file = legacy ? cfg.WALL_FILE : cfg.SEED_FILE;
  if (!fs.existsSync(file)) { setMeta('seed_source', 'none'); return null; }

  let decoded;
  try { decoded = decodeEnvelope(fs.readFileSync(file)); }
  catch (err) {
    console.warn(`wall: ${path.basename(file)} is unreadable — ${err.message}`);
    setMeta('seed_source', 'none');
    return null;
  }
  /* the seed carries whatever cycle it was captured in; adopt the current
     one instead, or checkCycle would "reset" it away on the first request.
     A .wall.bin is real state and keeps its own — an old one rolls over on
     the next tick, exactly as it did before. */
  wall.cycle = legacy ? (decoded.meta.cycle || cycleStart(now)) : cycleStart(now);
  return seed.importEnvelope(decoded.meta, decoded.a, decoded.b, wall.cycle, now,
    legacy ? '.wall.bin' : 'seed.bin');
}

function load(now = Date.now()) {
  const stored = Number(getMeta('cycle') || 0);
  wall.cycle = stored || cycleStart(now);

  let imported = null;
  if (!getMeta('seed_source') && countCells.get(wall.cycle).n === 0) imported = importOnce(now);
  setMeta('cycle', wall.cycle);

  rebuildCache();
  console.log(`wall: ${imported ? 'seeded from ' + getMeta('seed_source') : 'restored'} ` +
    `${wall.live.size} live · ${wall.reserved.size} booked`);
  return wall;
}

/* ── Live updates ─────────────────────────────────────────────── */

/* The SSE hub lives in http.js and wires itself in here at load, so the
   wall never has to know a request object exists. */
let sink = () => {};
const setSink = fn => { sink = fn; };

function broadcast(evt) {
  evt.rev = ++wall.rev;
  evt.taken = wall.live.size;
  evt.booked = wall.reserved.size;
  sink(evt);
}
/* Small changes ride along in the event; a 160k-pixel logo does not. */
function publish(evt, count) {
  broadcast(count > cfg.DELTA_MAX ? { t: 'sync' } : evt);
}

/* ── Mutations ────────────────────────────────────────────────── */

/* One transaction: the submission, its cells, the allowance it spent and
   the journal entry all commit together or none of them do (§4.2, §4.6). */
function claimTx(e, want, now) {
  const freeQuota = Math.max(0, Math.min(want.length, cfg.CAP - e.used));
  const paidQuota = Math.max(0, Math.min(e.paint, want.length - freeQuota));
  const take = want.slice(0, freeQuota + paidQuota);
  if (!take.length) return null;

  const sid = Number(insSub.run(e.id, paidQuota ? 'paint' : 'free', wall.cycle, 'live',
    null, null, null, now, now).lastInsertRowid);

  const placed = [];
  for (const [idx, c] of take) {
    if (insCell.run(wall.cycle, 'live', idx, c, sid, e.id).changes) placed.push([idx, c]);
  }
  if (!placed.length) { dropSub.run(sid); return null; }
  fillSub.run(placed.length, JSON.stringify(seed.bboxOf(placed)), seed.packPixels(placed), sid);

  const usedFree = Math.min(placed.length, freeQuota);
  const usedPaint = placed.length - usedFree;
  const after = {
    id: e.id,
    used: e.used + usedFree,
    paint: e.paint - usedPaint,
    refillAt: e.refillAt
  };
  if (after.used >= cfg.CAP && !after.refillAt) after.refillAt = now + cfg.REFILL;
  identity.writeAllowance(after);

  logEvent(`user:${e.id}`, 'claim',
    { sid, px: placed.length, free: usedFree, paint: usedPaint, lost: take.length - placed.length }, now);
  return { sid, placed, usedFree, usedPaint, after };
}

function claimPixels(e, entries, now) {
  const want = entries.filter(([idx]) => validIdx(idx) && !wall.live.has(idx));
  let occupied = entries.length - want.length;
  const wanted = Math.min(want.length, Math.max(0, cfg.CAP - e.used) + e.paint);

  const r = want.length ? tx(claimTx, e, want, now) : null;
  if (!r) {
    return {
      placed: 0, placedIdx: [], usedFree: 0, usedPaint: 0,
      occupied: occupied + wanted, short: want.length - wanted,
      ...identity.allowanceOf(e, now)
    };
  }

  /* committed — the cache and the caller's cached row can follow */
  e.used = r.after.used; e.paint = r.after.paint; e.refillAt = r.after.refillAt;
  const oid = ownerId(e.handle, 'u');
  for (const [idx, c] of r.placed) wall.live.set(idx, { c, o: oid });
  occupied += wanted - r.placed.length;      // lost to the PK backstop = taken by someone else

  publish({ t: 'paint', layer: 'live', o: { id: oid, n: e.handle, ty: 'u' },
    px: r.placed }, r.placed.length);

  return {
    placed: r.placed.length, placedIdx: r.placed.map(([idx]) => idx),
    usedFree: r.usedFree, usedPaint: r.usedPaint, occupied,
    short: want.length - wanted,
    ...identity.allowanceOf(e, now)
  };
}

function bookTx(e, name, meta, want, now) {
  const url = meta.url ? String(meta.url) : null;
  const cta = String(meta.cta || 'VISIT SITE').slice(0, 18);
  const sid = Number(insSub.run(e.id, 'brand', wall.cycle, 'next',
    name, url, url ? cta : null, now, now).lastInsertRowid);

  const placed = [];
  for (const [idx, c] of want) {
    if (insCell.run(wall.cycle, 'next', idx, c, sid, e.id).changes) placed.push([idx, c]);
  }
  if (!placed.length) { dropSub.run(sid); return null; }
  fillSub.run(placed.length, JSON.stringify(seed.bboxOf(placed)), seed.packPixels(placed), sid);

  logEvent(`user:${e.id}`, 'book', { sid, name, px: placed.length, url }, now);
  return { sid, placed, url, cta };
}

/* `e` is the approved brand's own user — http.js won't call this for anyone
   else (§3), so the submission and the cells are filed against the account
   that will be invoiced, not against whoever happened to be at the keyboard. */
function bookBrand(e, meta, entries, now) {
  const name = String(meta.name || e.handle || 'YOUR BRAND').slice(0, 24).toUpperCase();
  const want = entries.filter(([idx]) => validIdx(idx) && !wall.reserved.has(idx));
  let skipped = entries.length - want.length;
  if (!want.length) return { booked: 0, skipped, cost: 0 };

  const r = tx(bookTx, e, name, meta, want, now);
  if (!r) return { booked: 0, skipped: entries.length, cost: 0 };

  const oid = ownerId(name, 'c');
  for (const [idx, c] of r.placed) wall.reserved.set(idx, { c, o: oid });
  if (r.url) wall.nextBrands.set(name, { url: r.url, cta: r.cta });
  skipped += want.length - r.placed.length;

  publish({ t: 'paint', layer: 'res', o: { id: oid, n: name, ty: 'c' },
    brand: wall.nextBrands.get(name) || null, px: r.placed }, r.placed.length);
  return { booked: r.placed.length, skipped, cost: r.placed.length * cfg.PRICE_COMPANY, goesLive: cycleEnd(now) };
}

/* ── The monthly wipe ─────────────────────────────────────────── */

/* The outgoing wall is filed as a PNG before anything is deleted (§4.7,
   §10.3) — that render is the only copy of the month as it looked, so it
   happens outside the transaction and a failure to write it is loud but
   not fatal. Then, atomically: the live layer goes, next is promoted into
   its place under the new cycle, and everyone's free pixels come back. */
function archiveWall(cycle) {
  if (!wall.live.size) return null;
  const file = path.join(cfg.ARCHIVE_DIR, `${monthKey(cycle)}.png`);
  try {
    const px = new Array(wall.live.size); let i = 0;
    for (const [idx, p] of wall.live) px[i++] = [idx, p.c];
    writePng(file, px);
    return file;
  } catch (err) {
    console.warn('reset: could not archive the outgoing wall —', err.message);
    return null;
  }
}

function resetCycle(now, to) {
  const from = wall.cycle;
  const archive = archiveWall(from);

  const promoted = tx(() => {
    dropLive.run(from);
    const n = promoteCells.run(to, from).changes;
    promoteSubs.run(to, from);
    identity.resetAllowances();
    setMeta('cycle', to);
    logEvent('system', 'reset', { from, to, promoted: n, archive }, now);
    return n;
  });

  wall.cycle = to;
  rebuildCache();
  broadcast({ t: 'reset' });
  console.log(`reset: new cycle ${monthKey(to)} — ${promoted} prepaid pixels went live` +
    (archive ? ` · archived ${path.basename(archive)}` : ''));
  return { live: wall.live.size, booked: wall.reserved.size, promoted, archive };
}

/* The wall wipes on the 1st; whatever was prepaid takes its place. */
function checkCycle(now) {
  // "has this cycle actually elapsed", not "is the calendar month different" —
  // the dev reset parks wall.cycle in the next month, and an inequality test
  // would then re-fire on the very next request and wipe what it just promoted
  if (now < cycleEnd(wall.cycle)) return false;
  resetCycle(now, cycleStart(now));
  return true;
}
setInterval(() => checkCycle(Date.now()), 30000).unref();

/* ── Prototype affordances (behind DEV, deleted in Phase 7) ───── */

/* the artwork is drawn with canvas in the browser, so the demo seed is
   uploaded rather than generated here */
function seedFrom(meta, a, b, now = Date.now()) {
  seed.replaceCycle(meta, a, b, wall.cycle, now, 'dev');
  rebuildCache();
  broadcast({ t: 'reset' });
  return { live: wall.live.size, booked: wall.reserved.size };
}
function wipe(now = Date.now()) {
  seed.wipeCycle(wall.cycle, now);
  rebuildCache();
  broadcast({ t: 'reset' });
  return { live: 0, booked: 0 };
}
function rollCycle(now) {
  // pretend we're past the 1st. The archive path stays out of the reply —
  // it's a server filesystem path, and the demo button only wants the count
  const { live, booked, promoted } = resetCycle(now, cycleStart(cycleEnd(now)));
  return { live, booked, promoted };
}

module.exports = {
  wall, cycleStart, cycleEnd, monthKey, validIdx, ownerId,
  ENTRY, encodeEnvelope, decodeEnvelope, snapshotFor,
  load, rebuildCache, setSink, broadcast, publish,
  checkCycle, resetCycle, claimPixels, bookBrand,
  seedFrom, wipe, rollCycle, archiveWall
};
