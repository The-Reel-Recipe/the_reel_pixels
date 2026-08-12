/* ═══════════════════════════════════════════════════════════════
   wall — the pixels, the wire format, the monthly cycle

   Two maps (live now, reserved for next month) plus the interned
   owner table, the binary envelope both directions speak, and the
   mutations that touch them. Phase 1 makes `cells` in SQLite the
   truth and leaves these maps as a cache projected off it — the
   snapshot bytes must not move when that happens.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const cfg = require('./config.js');
const identity = require('./identity.js');

const { W, H } = cfg;

const cycleStart = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const cycleEnd = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };

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
/* After a wholesale replacement the owner table is mostly dead entries. */
function compactOwners() {
  const remap = new Map(), owners = [];
  const move = m => {
    for (const p of m.values()) {
      let id = remap.get(p.o);
      if (id === undefined) { id = owners.length; owners.push(wall.owners[p.o]); remap.set(p.o, id); }
      p.o = id;
    }
  };
  move(wall.live); move(wall.reserved);
  wall.owners = owners;
  wall.ownerIds = new Map(owners.map((o, i) => [o.n + '\0' + o.t, i]));
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

function snapshotFor(key, now) {
  const e = identity.rowFor(key, now);
  const meta = {
    v: 1, cycle: wall.cycle, cycleEnd: cycleEnd(now), rev: wall.rev,
    owners: wall.owners,
    brands: Object.fromEntries(wall.brands),
    nextBrands: Object.fromEntries(wall.nextBrands),
    me: e.handle,
    dev: cfg.DEV,                        // the page hides the demo controls when this is off
    prices: { paint: cfg.PRICE_PAINT, company: cfg.PRICE_COMPANY, packs: cfg.PACKS },
    allowance: identity.allowanceOf(e, now)
  };
  return encodeEnvelope(meta, pack(wall.live), pack(wall.reserved));
}

/* ── Persistence ──────────────────────────────────────────────── */

let wallTimer = null;
function saveWall() {
  clearTimeout(wallTimer);
  wallTimer = setTimeout(() => {
    const meta = {
      v: 1, cycle: wall.cycle, owners: wall.owners,
      brands: Object.fromEntries(wall.brands), nextBrands: Object.fromEntries(wall.nextBrands)
    };
    fs.writeFile(cfg.WALL_FILE, encodeEnvelope(meta, pack(wall.live), pack(wall.reserved)), err => {
      if (err) console.warn('wall: save failed —', err.message);
    });
  }, 400);
  if (wallTimer.unref) wallTimer.unref();
}
/* Reads saved state, falling back to the artwork committed as seed.bin.
   On a serverless host the saved copy lives in a per-instance temp dir, so a
   cold start lands on the seed rather than an empty grid — good enough for a
   demo, but pixels painted between cold starts do not survive. Point
   STATE_DIR at something durable (a mounted volume, or swap these two
   functions for a KV/Blob store) to make the wall permanent. */
function loadWall() {
  try {
    const fromSeed = !fs.existsSync(cfg.WALL_FILE);
    const { meta, a, b } = decodeEnvelope(fs.readFileSync(fromSeed ? cfg.SEED_FILE : cfg.WALL_FILE));
    // the seed carries whatever cycle it was captured in; adopt the current
    // one instead, or checkCycle would "reset" it away on the first request
    wall.cycle = fromSeed ? cycleStart(Date.now()) : (meta.cycle || cycleStart(Date.now()));
    wall.owners = meta.owners || [];
    wall.ownerIds = new Map(wall.owners.map((o, i) => [o.n + '\0' + o.t, i]));
    wall.brands = new Map(Object.entries(meta.brands || {}));
    wall.nextBrands = new Map(Object.entries(meta.nextBrands || {}));
    for (const [idx, c, o] of a) wall.live.set(idx, { c, o });
    for (const [idx, c, o] of b) wall.reserved.set(idx, { c, o });
    console.log(`wall: ${fromSeed ? 'seeded' : 'restored'} ${wall.live.size} live · ${wall.reserved.size} booked`);
    return true;
  } catch (e) { return false; }
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

/* The wall wipes on the 1st; whatever was prepaid takes its place. */
function checkCycle(now) {
  // "has this cycle actually elapsed", not "is the calendar month different" —
  // the dev reset parks wall.cycle in the next month, and an inequality test
  // would then re-fire on the very next request and wipe what it just promoted
  if (now < cycleEnd(wall.cycle)) return false;
  const cs = cycleStart(now);
  wall.live = wall.reserved;
  wall.reserved = new Map();
  wall.brands = wall.nextBrands;
  wall.nextBrands = new Map();
  wall.cycle = cs;
  compactOwners();
  identity.resetAllowances();
  saveWall(); identity.saveLedger();
  broadcast({ t: 'reset' });
  console.log(`reset: new cycle ${new Date(cs).toISOString().slice(0, 7)} — ${wall.live.size} prepaid pixels went live`);
  return true;
}
setInterval(() => checkCycle(Date.now()), 30000).unref();

function claimPixels(key, entries, now) {
  const e = identity.rowFor(key, now);
  const want = entries.filter(([idx]) => validIdx(idx) && !wall.live.has(idx));
  const occupied = entries.length - want.length;
  const free = Math.max(0, Math.min(want.length, cfg.CAP - e.used));
  const paid = Math.max(0, Math.min(e.paint, want.length - free));
  const take = want.slice(0, free + paid);

  const oid = ownerId(e.handle, 'u');
  for (const [idx, c] of take) wall.live.set(idx, { c, o: oid });
  e.used += free;
  e.paint -= paid;
  if (e.used >= cfg.CAP && !e.refillAt) e.refillAt = now + cfg.REFILL;

  if (take.length) {
    saveWall(); identity.saveLedger();
    publish({ t: 'paint', layer: 'live', o: { id: oid, n: e.handle, ty: 'u' },
      px: take.map(([idx, c]) => [idx, c]) }, take.length);
  } else if (free || paid) identity.saveLedger();

  return {
    placed: take.length, placedIdx: take.map(([idx]) => idx),
    usedFree: free, usedPaint: paid, occupied,
    short: want.length - take.length,
    ...identity.allowanceOf(e, now)
  };
}

function bookBrand(key, meta, entries, now) {
  const name = String(meta.name || 'YOUR BRAND').slice(0, 24).toUpperCase();
  const want = entries.filter(([idx]) => validIdx(idx) && !wall.reserved.has(idx));
  const skipped = entries.length - want.length;
  if (!want.length) return { booked: 0, skipped, cost: 0 };

  const oid = ownerId(name, 'c');
  for (const [idx, c] of want) wall.reserved.set(idx, { c, o: oid });
  if (meta.url) wall.nextBrands.set(name, { url: String(meta.url), cta: String(meta.cta || 'VISIT SITE').slice(0, 18) });

  saveWall();
  publish({ t: 'paint', layer: 'res', o: { id: oid, n: name, ty: 'c' },
    brand: wall.nextBrands.get(name) || null, px: want.map(([idx, c]) => [idx, c]) }, want.length);
  return { booked: want.length, skipped, cost: want.length * cfg.PRICE_COMPANY, goesLive: cycleEnd(now) };
}

/* ── Prototype affordances (behind DEV, deleted in Phase 7) ───── */

/* the artwork is drawn with canvas in the browser, so the demo seed is
   uploaded rather than generated here */
function seedFrom(meta, a, b) {
  wall.live = new Map(); wall.reserved = new Map();
  wall.owners = meta.owners || []; wall.ownerIds = new Map(wall.owners.map((o, i) => [o.n + '\0' + o.t, i]));
  wall.brands = new Map(Object.entries(meta.brands || {}));
  wall.nextBrands = new Map(Object.entries(meta.nextBrands || {}));
  for (const [idx, c, o] of a) if (validIdx(idx)) wall.live.set(idx, { c, o });
  for (const [idx, c, o] of b) if (validIdx(idx)) wall.reserved.set(idx, { c, o });
  compactOwners(); saveWall();
  broadcast({ t: 'reset' });
  return { live: wall.live.size, booked: wall.reserved.size };
}
function wipe() {
  wall.live = new Map(); wall.reserved = new Map();
  wall.brands = new Map(); wall.nextBrands = new Map();
  wall.owners = []; wall.ownerIds = new Map();
  saveWall(); broadcast({ t: 'reset' });
  return { live: 0, booked: 0 };
}
function rollCycle(now) {
  wall.cycle = cycleStart(cycleEnd(now));   // pretend we're past the 1st
  wall.live = wall.reserved; wall.reserved = new Map();
  wall.brands = wall.nextBrands; wall.nextBrands = new Map();
  compactOwners();
  identity.resetAllowances();
  saveWall(); identity.saveLedger(); broadcast({ t: 'reset' });
  return { live: wall.live.size, booked: 0 };
}

module.exports = {
  wall, cycleStart, cycleEnd, validIdx, ownerId, compactOwners,
  ENTRY, encodeEnvelope, decodeEnvelope, snapshotFor,
  saveWall, loadWall, setSink, broadcast, publish,
  checkCycle, claimPixels, bookBrand, seedFrom, wipe, rollCycle
};
