/* ═══════════════════════════════════════════════════════════════
   S37 — SHAKHBAT 3AL 7EET · PIXEL WALL
   1000×1000 canvas · 20 free pixels per person, refilling every 30 min
   prepaid PAINT and brand pre-orders priced by the server

   The wall runs in monthly cycles: at 00:00 on the 1st everything
   painted on it is wiped, free and painted alike. Only brand
   pre-orders survive that — they aren't on the wall at all
   beforehand, they sit in the `reserved` queue and get promoted
   onto the fresh wall by the reset.

   None of that is decided here. server.js owns the wall, the queue,
   the cycle and the per-IP allowance; this file draws what it sends
   and posts intents back. The Maps below are a local mirror kept in
   step by the /api/stream event feed, not a source of truth — with
   no server reachable there is no wall, and the page says so.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── Constants ── */
const W = 1000, H = 1000;
/* The server owns this — it is a runtime setting the panel can move, so
   the snapshot overwrites it before anything is quoted. The value here is
   only what the page would use if it somehow rendered before its first
   /api/wall, which it does not. */
let PRICE_COMPANY = 5;
const CAP = 20;                       // free pixels per person, per batch
const DAY = 86400000;
const LS_KEY = 's37.help';            // the one thing still ours to remember

/* Every one of these has to read on white paper, which is what rules the
   pale UI pink out and puts the heavier rose in its place. Brand family
   first, then a full spread, then the inks. */
const PALETTE = [
  '#D81B60', '#F06292', '#AD1457', '#7B2D4B', '#E23B2E', '#FF8C42',
  '#FFD23F', '#22C55E', '#14B8A6', '#59C2FF', '#2E6BE6', '#8B5CF6',
  '#2B1620', '#6E5A62', '#B9A6AD', '#ECE4E7'
];

/* ── State ── */
const pixels = new Map();             // idx -> {c,o,t}  — live wall, this cycle
const reserved = new Map();           // idx -> {c,o,t}  — brand bookings, up at the next reset
/* Ours, claimed, and waiting on a moderator. The server sends these only to
   the person who owns them, so this map is never anybody else's pixels — it
   is the shimmer that says "sent, not up yet". */
const pending = new Map();            // idx -> color
const sel = new Map();                // idx -> color (preview basket)
const yours = new Set();              // idx of committed pixels owned by YOU
const brands = new Map();             // owner name -> {url, cta} for clickable sponsor logos
const nextBrands = new Map();         // same, for logos still waiting in the queue
let paint = 0;                        // prepaid pixel credits (server-held)
let freeUsed = 0;                     // free pixels spent out of the current batch
let refillAt = 0;                     // when the batch comes back (0 = not waiting)
let cycle = 0;                        // start of the cycle currently on the wall
let myHandle = '';                    // what the server calls this caller
/* who the cookie says we are — {kind:'guest'|'brand', handle, brandStatus}.
   The server decides it; the pre-order button reads it to know whether to
   open the booking flow or the application form. */
let me = { kind: 'guest', handle: '', brandStatus: null };
let helpSeen = false;
let taken = 0;
let selColor = PALETTE[0];

const idx = (x, y) => y * W + x;
const fmt = n => n.toLocaleString('en-US');
const hex = c => '#' + c.toString(16).padStart(6, '0');
const rgbInt = h => parseInt(h.slice(1), 16);

/* ── Server ──
   `skew` lines the server's clock up with ours so countdowns don't drift on a
   machine with a wrong clock. Every timestamp in this file is server time. */
const api = { on: false, skew: 0, rev: 0 };
const serverNow = () => Date.now() + api.skew;

/* Where the API lives. Same origin when the page is served by server.js;
   ?api=https://… or <meta name="pixel-api"> to point a statically hosted
   page (GitHub Pages, a CDN) at a server running somewhere else. */
const API_BASE = (new URLSearchParams(location.search).get('api') ||
  (document.querySelector('meta[name="pixel-api"]') || {}).content || '').replace(/\/+$/, '');

async function apiJson(path, body) {
  const res = await fetch(API_BASE + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  } : undefined);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* Wire format, matching server.js:
     [u32 metaLen][meta JSON][u32 aCount][a…][u32 bCount][b…]
     entry = u32 idx · u8 r · u8 g · u8 b · u16 ownerId   (9 bytes)
   A 160k-pixel logo is 1.4 MB this way and would be 4 MB as JSON. */
const ENTRY = 9;
function encodeEnvelope(meta, a, b = []) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const buf = new ArrayBuffer(4 + json.length + 4 + a.length * ENTRY + 4 + b.length * ENTRY);
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let o = 0;
  dv.setUint32(o, json.length, true); o += 4;
  bytes.set(json, o); o += json.length;
  for (const list of [a, b]) {
    dv.setUint32(o, list.length, true); o += 4;
    for (const [i, c, own] of list) {
      dv.setUint32(o, i, true); o += 4;
      bytes[o++] = (c >> 16) & 255; bytes[o++] = (c >> 8) & 255; bytes[o++] = c & 255;
      dv.setUint16(o, own || 0, true); o += 2;
    }
  }
  return buf;
}
function decodeEnvelope(buf) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let o = 0;
  const metaLen = dv.getUint32(o, true); o += 4;
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + metaLen))); o += metaLen;
  const readList = () => {
    const n = dv.getUint32(o, true); o += 4;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [dv.getUint32(o, true), (bytes[o + 4] << 16) | (bytes[o + 5] << 8) | bytes[o + 6], dv.getUint16(o + 7, true)];
      o += ENTRY;
    }
    return out;
  };
  return { meta, a: readList(), b: readList() };
}
/* A refused request usually has something to say — which cap was hit, which
   field was wrong, why the booking is closed — so the body comes back on the
   error rather than being thrown away with the status code. */
async function readError(path, res) {
  const err = new Error(`${path} → ${res.status}`);
  err.code = res.status;
  try { err.data = await res.json(); } catch (e) { err.data = {}; }
  return err;
}
async function apiEnvelope(path, meta, a, b) {
  const res = await fetch(API_BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' },
    body: encodeEnvelope(meta, a, b)
  });
  if (!res.ok) throw await readError(path, res);
  return res.json();
}
/* POST that treats a 4xx as an answer, not an accident — the auth forms
   render the server's own field errors. */
async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty or not json */ }
  return { ok: res.ok, code: res.status, data: data || {} };
}

function applyAllowance(d) {
  api.skew = d.now - Date.now();
  freeUsed = Math.max(0, CAP - d.free);
  refillAt = d.refillAt || 0;
  paint = d.paint || 0;
  if (d.handle) myHandle = d.handle;
}

/* ── Monthly cycle ── */
const cycleStart = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const cycleEnd   = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };
const monthName  = t => new Date(t).toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
const shortDate  = t => new Date(t).toLocaleDateString('en-US', { day: 'numeric', month: 'short' }).toUpperCase();
/* Every countdown targets the end of the cycle the *wall* is in — which the
   server tells us — not whatever month this machine's calendar says. */
const cycleEndsAt = () => cycleEnd(cycle);
/* the cycle the prepaid queue is booked for = the one starting at the next reset */
const nextCycleName = () => monthName(cycleEndsAt());
function countdown(ms) {
  if (ms <= 0) return '0h';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600000);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Only http(s) links with a real hostname may be attached to pixels.
   Blocks javascript:/data: URLs, and the URL parser's habit of happily
   accepting "hello" or percent-encoding "not a url!!" into a hostname. */
const HOSTNAME_RE = /^(localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})$/i;
function safeUrl(raw) {
  const s = (raw || '').trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return HOSTNAME_RE.test(u.hostname) ? u.href : null;
  } catch (e) { return null; }
}
const brandOf = p => (p && p.t === 'c') ? brands.get(p.o) : null;

/* ── DOM ── */
const $ = id => document.getElementById(id);

/* One of the drawn icons (tools/make-icons.js), as markup. The symbols are
   inlined at the top of index.html, so this is a reference rather than a
   fetch and it inherits whatever colour it lands in.
   Only ever interpolated into innerHTML — a textContent would print it. */
const ic = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const wrap = $('canvasWrap'), cvs = $('wall'), ctx = cvs.getContext('2d');
const mm = $('minimap'), mmctx = mm.getContext('2d');
const coordsEl = $('coords'), tooltipEl = $('tooltip');

/* ── Offscreen boards ── */
const board = document.createElement('canvas');   board.width = W; board.height = H;
const bctx = board.getContext('2d');
const prevCvs = document.createElement('canvas'); prevCvs.width = W; prevCvs.height = H;
const pctx = prevCvs.getContext('2d');
/* the prepaid queue — drawn washed-out over the wall so you can see what's
   coming, then blitted onto the real board when the reset promotes it */
const nextCvs = document.createElement('canvas'); nextCvs.width = W; nextCvs.height = H;
const nctx = nextCvs.getContext('2d');
/* awaiting approval — drawn over the wall with a pulse, and only ever ours */
const pendCvs = document.createElement('canvas'); pendCvs.width = W; pendCvs.height = H;
const pdctx = pendCvs.getContext('2d');
const thumb = document.createElement('canvas');   thumb.width = 148; thumb.height = 148;
const thctx = thumb.getContext('2d');
let thumbDirty = true;

/* ── View ── */
const view = { s: 1, ox: 0, oy: 0 };
let fitScale = 1, userMovedView = false;
let cw = 0, ch = 0, dpr = 1;

function resizeCanvas() {
  const r = wrap.getBoundingClientRect();
  cw = Math.max(50, r.width); ch = Math.max(50, r.height);
  dpr = window.devicePixelRatio || 1;
  cvs.width = Math.round(cw * dpr); cvs.height = Math.round(ch * dpr);
  const ms = 148; mm.width = ms * dpr; mm.height = ms * dpr;
  if (!userMovedView) fit(); else clampView();
}
function fit() {
  fitScale = Math.min(cw / W, ch / H) * 0.94;
  view.s = fitScale;
  view.ox = (cw - W * view.s) / 2;
  view.oy = (ch - H * view.s) / 2;
  userMovedView = false;
}
function clampView() {
  fitScale = Math.min(cw / W, ch / H) * 0.94;
  view.s = Math.min(60, Math.max(fitScale * 0.8, view.s));
  const bw = W * view.s, bh = H * view.s, m = 70;
  view.ox = Math.min(Math.max(view.ox, Math.min(cw - bw - m, (cw - bw) / 2)), Math.max(m, (cw - bw) / 2));
  view.oy = Math.min(Math.max(view.oy, Math.min(ch - bh - m, (ch - bh) / 2)), Math.max(m, (ch - bh) / 2));
}
function zoomAt(cx, cy, f) {
  const wx = (cx - view.ox) / view.s, wy = (cy - view.oy) / view.s;
  view.s = Math.min(60, Math.max(fitScale * 0.8, view.s * f));
  view.ox = cx - wx * view.s; view.oy = cy - wy * view.s;
  userMovedView = true; clampView();
}
const cellAt = (px, py) => {
  const x = Math.floor((px - view.ox) / view.s), y = Math.floor((py - view.oy) / view.s);
  return (x >= 0 && y >= 0 && x < W && y < H) ? { x, y } : null;
};

/* ── Pixel ops ── */
/* `defer` skips the per-pixel fill so a big batch can be blitted in one
   drawImage — a 400×400 logo is 160k pixels and fillRect-per-pixel stalls. */
function addPixel(i, p, defer) {
  if (pixels.has(i)) removePixel(i);
  pixels.set(i, p);
  taken++;
  if (p.o === myHandle) yours.add(i);
  if (!defer) {
    bctx.fillStyle = p.c;
    bctx.fillRect(i % W, (i / W) | 0, 1, 1);
  }
  thumbDirty = true;
}
function removePixel(i) {
  const p = pixels.get(i); if (!p) return;
  pixels.delete(i);
  taken--;
  yours.delete(i);
  bctx.clearRect(i % W, (i / W) | 0, 1, 1);
  thumbDirty = true;
}
/* Prepaid pixels never touch the live board — they only exist on nextCvs
   until a reset promotes them. */
function addReserved(i, p, defer) {
  reserved.set(i, p);
  if (!defer) {
    nctx.fillStyle = p.c;
    nctx.fillRect(i % W, (i / W) | 0, 1, 1);
  }
  thumbDirty = true;
}
/* Same idea for the ones still waiting on a decision: a board of their own,
   never the live one, so an approval is a move between layers and a
   rejection is a clear. */
function addPending(i, c, defer) {
  pending.set(i, c);
  if (!defer) { pdctx.fillStyle = c; pdctx.fillRect(i % W, (i / W) | 0, 1, 1); }
}
function removePending(i) {
  if (!pending.delete(i)) return;
  pdctx.clearRect(i % W, (i / W) | 0, 1, 1);
}

/* ── Loading the wall ──
   One request bootstraps everything: both pixel layers, the brand links, the
   cycle, and this caller's allowance. Also the recovery path — any time we
   might have missed an event, we just ask for the whole thing again. */
async function loadWall() {
  const res = await fetch(API_BASE + '/api/wall');
  if (!res.ok) throw await readError('/api/wall', res);
  const { meta, a, b } = decodeEnvelope(await res.arrayBuffer());

  pixels.clear(); reserved.clear(); yours.clear(); pending.clear();
  brands.clear(); nextBrands.clear();
  taken = 0;
  bctx.clearRect(0, 0, W, H);
  nctx.clearRect(0, 0, W, H);
  pdctx.clearRect(0, 0, W, H);

  api.on = true; api.rev = meta.rev || 0;
  cycle = meta.cycle;
  applyAllowance(meta.allowance);
  setMe(meta.me);
  if (meta.prices) {
    PRICE_COMPANY = meta.prices.company;               // the ghost's running total reads this
    applyPrices(meta.prices);
  }
  for (const [name, brand] of Object.entries(meta.brands || {})) {
    const safe = safeUrl(brand.url);
    if (safe) brands.set(name, { url: safe, cta: brand.cta || 'VISIT SITE' });
  }
  for (const [name, brand] of Object.entries(meta.nextBrands || {})) {
    const safe = safeUrl(brand.url);
    if (safe) nextBrands.set(name, { url: safe, cta: brand.cta || 'VISIT SITE' });
  }

  const owners = meta.owners || [];
  const own = id => owners[id] || { n: '—', t: 'u' };
  // defer the per-pixel fill and blit both layers once at the end
  for (const [i, c, o] of a) { const w = own(o); addPixel(i, { c: hex(c), o: w.n, t: w.t }, true); }
  for (const [i, c, o] of b) { const w = own(o); addReserved(i, { c: hex(c), o: w.n, t: w.t }, true); }
  // ours alone, and in the meta rather than the pixel body — see server/wall.js
  const mine = meta.pending || { live: [], next: [] };
  for (const list of [mine.live || [], mine.next || []]) {
    for (const [i, c] of list) addPending(i, hex(c), true);
  }
  repaintBoards();
  updateAll();
}
/* Rebuild both offscreen boards from the maps — cheaper than a fillRect per
   pixel when a whole snapshot lands at once. */
function repaintBoards() {
  const img = (m, target) => {
    const d = target.createImageData(W, H), px = d.data;
    for (const [i, p] of m) {
      const c = rgbInt(p.c), o = i * 4;
      px[o] = (c >> 16) & 255; px[o + 1] = (c >> 8) & 255; px[o + 2] = c & 255; px[o + 3] = 255;
    }
    target.putImageData(d, 0, 0);
  };
  bctx.clearRect(0, 0, W, H); img(pixels, bctx);
  nctx.clearRect(0, 0, W, H); img(reserved, nctx);
  pdctx.clearRect(0, 0, W, H);
  for (const [i, c] of pending) { pdctx.fillStyle = c; pdctx.fillRect(i % W, (i / W) | 0, 1, 1); }
  thumbDirty = true;
}

/* ── Live updates ──
   Everyone painting on the wall shows up here. Deltas arrive inline; anything
   too big to ship that way (a brand logo is up to 160k pixels) arrives as a
   nudge to refetch, as does a reset or a reconnect after a gap. */
let resyncTimer = null;
function resync(reason) {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    loadWall().catch(e => console.warn('resync failed:', e.message));
  }, 120);
  if (reason) console.debug('resync:', reason);
}
function openStream() {
  const es = new EventSource(API_BASE + '/api/stream');
  es.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.t === 'hello') {
      // A serverless host kills the stream at the function's max duration, so
      // reconnects are routine. Refetch only when the server moved on without
      // us — otherwise every reconnect would re-download the whole wall.
      if (d.rev !== api.rev) resync(`missed ${d.rev - api.rev} update(s)`);
      api.rev = d.rev;
      return;
    }
    if (d.rev) api.rev = d.rev;
    if (d.t === 'paint') {
      const target = d.layer === 'res' ? addReserved : addPixel;
      for (const [i, c] of d.px) {
        // if this was ours, it has just stopped being pending and started
        // being wall — take it off the shimmer layer on the way past
        removePending(i);
        target(i, { c: hex(c), o: d.o.n, t: d.o.ty });
      }
      if (d.brand && d.o.ty === 'c') {
        const safe = safeUrl(d.brand.url);
        if (safe) (d.layer === 'res' ? nextBrands : brands).set(d.o.n, { url: safe, cta: d.brand.cta });
      }
      // another tab on this connection spent our allowance — don't wait for the poll
      if (d.o.ty === 'u' && d.o.n === myHandle) syncAllowance();
      updateStats();
    } else if (d.t === 'paint-remove') {
      // a rejection or a takedown of something that was already up
      for (const i of d.px) {
        if (d.layer === 'res') { reserved.delete(i); nctx.clearRect(i % W, (i / W) | 0, 1, 1); }
        else removePixel(i);
        removePending(i);
      }
      thumbDirty = true;
      updateStats();
    } else if (d.t === 'mod') {
      // a decision landed. Only ours are in the history we hold, and only
      // ours can be on the pending layer, so anything else is a no-op.
      onDecision(d.sid, d.status, d.px);
    } else if (d.t === 'pay') {
      onPayment(d.pid, d.status);
    } else if (d.t === 'reset') {
      resync('reset');
      toast(`${ic('reset')} The wall reset — prepaid pixels are up on a fresh cycle.`, { cls: 'warn', dur: 5200 });
    } else if (d.t === 'sync') {
      resync('bulk change');
    }
  };
  // EventSource reconnects on its own, and the hello above decides whether
  // anything was actually missed — nothing to do here.
  es.onerror = () => {};
  return es;
}

/* ── Offline ──
   The wall lives on the server now, so there is no degraded mode to fall
   back to. Say so plainly rather than showing an empty grid that looks real. */
function serverDown(err) {
  api.on = false;
  console.error('pixel wall: server unreachable —', err && err.message);
  /* …or reachable and saying no. A shared connection that has minted its
     five identities for the day gets the wall withheld, which is nothing
     like the server being off — say which one it is. */
  const capped = err && err.code === 429 && err.data && err.data.message;
  const note = $('offlineNote');
  if (capped) {
    note.querySelector('b').textContent = t('off.capped');
    /* the known cap speaks the page's language; anything else is a raw
       server sentence, which is English — mark it so RTL doesn't garble it */
    const p = note.querySelector('p');
    if (err.data.error === 'ip-guest-cap') {
      p.textContent = t('off.cappedBody');
      p.removeAttribute('dir'); p.removeAttribute('lang');
    } else {
      p.textContent = err.data.message;
      p.setAttribute('dir', 'ltr'); p.setAttribute('lang', 'en');
    }
    note.querySelector('code').hidden = true;
  }
  note.hidden = false;
  $('btnCheckout').disabled = true;
  $('btnCompany').disabled = true;
  $('btnPaintShop').disabled = true;
}

/* ── Free allowance ── */
/* You get CAP free pixels; the moment you spend the last one a 30-minute
   timer starts, and when it lands the batch is back. Paint buys pixels past
   the batch — those go up on this wall too, and the reset wipes them with
   everything else. Only brand pre-orders are held over for the next cycle.

   The counter itself is not ours to keep — server.js owns it, keyed on the
   caller's IP, and /api/claim is what actually decides how many free pixels
   you get. What lives here is a mirror of that answer plus the countdown. */
const freeLeft = () => Math.max(0, CAP - freeUsed);
const waitingOnRefill = () => refillAt > serverNow();
const refillLeft = () => Math.max(0, refillAt - serverNow());

async function syncAllowance() {
  try { applyAllowance(await apiJson('/api/allowance')); updateAll(); }
  catch (e) { console.warn('allowance sync failed:', e.message); }
}
/* Our clock says the batch is due — clear it optimistically so the counter
   doesn't sit at 0:00, then let the server confirm. */
function checkRefill(silent) {
  if (!refillAt || serverNow() < refillAt) return false;
  freeUsed = 0; refillAt = 0;
  updateAll();
  syncAllowance();
  if (!silent) toast(`${ic('timer')} ${t('toast.refilled', { n: CAP })}`);
  return true;
}
const allowance = () => freeLeft() + paint;
function capReached() { return sel.size >= allowance(); }
function togglePreview(x, y) {
  const i = idx(x, y);
  if (sel.has(i)) {
    if (sel.get(i) === selColor) { sel.delete(i); pctx.clearRect(x, y, 1, 1); }
    else { sel.set(i, selColor); pctx.fillStyle = selColor; pctx.fillRect(x, y, 1, 1); }
  } else {
    if (capReached()) return capHit();
    sel.set(i, selColor);
    pctx.fillStyle = selColor; pctx.fillRect(x, y, 1, 1);
  }
  updateSelUI();
}
function eraseAt(x, y) {
  const i = idx(x, y);
  if (sel.has(i)) { sel.delete(i); pctx.clearRect(x, y, 1, 1); updateSelUI(); }
}
function clearSel() {
  sel.clear(); pctx.clearRect(0, 0, W, H); updateSelUI();
}
function capHit() {
  const c = $('selCounter');
  c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
  const msg = freeLeft() > 0
    ? t('toast.capAll', { n: fmt(allowance()) })
    : t('toast.capWait', { n: CAP, t: mmss(refillLeft()) });
  toast(msg, { cls: 'warn', action: { label: t('act.buyPaint'), fn: () => openModal('modalPaint') } });
}

/* ── UI updates ── */
function updateStats() {
  $('statTaken').textContent = fmt(taken);
  $('statNext').textContent = fmt(reserved.size);
  $('statYours').textContent = fmt(yours.size);
  $('statPaint').textContent = fmt(paint);
  // the badge counts pixels, not batches — "6 waiting" means something to
  // somebody watching their own shimmer, "1 waiting" does not. It lives on
  // the nav's ME door now, mirrored inside the sheet it opens.
  const badge = $('statPending');
  badge.hidden = pending.size === 0;
  badge.textContent = fmt(pending.size);
  const mirror = $('statPendingMe');
  if (mirror) { mirror.hidden = pending.size === 0; mirror.textContent = fmt(pending.size); }
  updateClock();
}
function updateClock() {
  /* before the first snapshot lands, `cycle` is still 0 and the maths
     below would claim the wall resets on Feb 1 1970 — say nothing
     instead of something false. The free-pixel line below needs no
     cycle, so it keeps rendering either way. */
  if (!cycle) {
    $('statReset').textContent = '—';
    $('cycleNext').textContent = t('cycle.next', { d: '—' });
  } else {
    const end = cycleEndsAt();
    $('statReset').textContent = countdown(end - serverNow());
    $('cycleNext').textContent = t('cycle.next', { d: shortDate(end) });
  }
  $('freeLine').innerHTML = waitingOnRefill()
    ? t('free.waiting', { t: mmss(refillLeft()), n: CAP })
    : t('free.left', { left: freeLeft(), n: CAP });
}
function updateSelUI() {
  const n = sel.size;
  const counter = $('selCounter');
  const full = n >= allowance();
  // out of free pixels with no paint to fall back on — the counter turns into
  // the refill clock, since 0/0 tells you nothing you want to know
  const stalled = full && allowance() === 0 && waitingOnRefill();
  // innerHTML because the stalled state carries an icon; the two values in
  // it are a formatted clock and two integers, so there is nothing to escape
  counter.innerHTML = stalled
    ? `${ic('timer')} ${mmss(refillLeft())}`
    : `${n}/${allowance()}`;
  counter.classList.toggle('full', full && !stalled);
  counter.classList.toggle('waiting', stalled);
  counter.classList.toggle('infinite', !full && paint > 0);
  const btn = $('btnCheckout');
  $('btnClear').disabled = n === 0;
  if (n === 0) { btn.disabled = true; btn.textContent = t('dock.tap'); return; }
  btn.disabled = false;
  const free = Math.min(n, freeLeft()), paid = n - free;
  if (paid === 0) btn.textContent = t('dock.claimFree', { n });
  else if (free === 0) btn.textContent = t('dock.claimPaint', { n, paid });
  else btn.textContent = t('dock.claimMix', { n, free, paid });
}
function updateAll() { updateStats(); updateSelUI(); }

/* ── Toasts ── */
function toast(html, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (opts.cls ? ' ' + opts.cls : '');
  const span = document.createElement('span'); span.innerHTML = html; t.appendChild(span);
  if (opts.action) {
    const b = document.createElement('button'); b.textContent = opts.action.label;
    b.onclick = () => { opts.action.fn(); dismiss(); }; t.appendChild(b);
  }
  $('toasts').appendChild(t);
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 320); };
  setTimeout(dismiss, opts.dur || 3600);
}

/* ── Modals ──
   Sheets stack: opening one from inside another (the paint shop from a cap
   toast, the brand door from MORE) has to put the new one in front, and DOM
   order alone decides that otherwise — which on a phone reads as the tap
   having done nothing at all. */
let sheetZ = 50;
function openModal(id) {
  const ov = $(id);
  if (ov.hidden) ov.style.zIndex = ++sheetZ;
  ov.hidden = false;
}
function closeModal(id) {
  const ov = $(id);
  ov.hidden = true;
  ov.style.zIndex = '';
  /* nothing left open — start the next stack from the floor again */
  if (!document.querySelector('.overlay:not([hidden])')) sheetZ = 50;
}
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('pointerdown', e => { if (e.target === ov) closeModal(ov.id); });
  ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
    closeModal(ov.id);
    if (ov.id === 'modalHelp' && !helpSeen) {
      helpSeen = true;
      try { localStorage.setItem(LS_KEY, '1'); } catch (e) { /* private mode — just show it again */ }
    }
  }));
});

/* ── Palette ── */
function buildPalette() {
  const pal = $('palette');
  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.title = c;
    b.onclick = () => setColor(c, b);
    pal.appendChild(b);
  });
  /* no custom swatch here any more: the colour input in the dock is a real
     visible control, and proxying a .click() at a hidden one is exactly what
     mobile browsers decline to honour */
  setColor(selColor, pal.firstChild);
}
function setColor(c, swatchEl) {
  selColor = c;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
  if (swatchEl) swatchEl.classList.add('sel');
  /* the input's own value is the current-colour display */
  $('customColor').value = /^#[0-9a-f]{6}$/i.test(c) ? c : '#D81B60';
}
$('customColor').addEventListener('input', e => setColor(e.target.value, null));

/* ── Checkout ── */
$('btnCheckout').onclick = () => {
  const n = sel.size; if (!n) return;
  const free = Math.min(n, freeLeft()), paid = n - free;
  $('coPixels').textContent = fmt(n);
  $('coFree').textContent = fmt(free);
  $('coPaintRow').hidden = paid === 0;
  $('coPaint').textContent = `−${fmt(paid)}`;
  $('coTotal').textContent = paid > 0 ? `0 EGP · ${fmt(paid)} ${t('common.paint')}` : t('co.freeWord');
  $('coFine').innerHTML = (paid > 0 ? t('co.finePaint') : t('co.fineFree')) + ' ' +
    t('co.fineTail', { d: shortDate(cycleEndsAt()) });
  const btn = $('btnPay');
  btn.disabled = false;
  btn.textContent = paid > 0 ? t('co.sendPaint', { paid: fmt(paid) }) : t('co.send');
  $('coBody').hidden = false; $('coSuccess').hidden = true;
  openModal('modalCheckout');
};
$('btnPay').onclick = () => {
  const btn = $('btnPay');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = t('co.busy');
  const commit = async () => {
    try {
      // The server decides all of this: which cells are still free ground,
      // how many this IP gets for nothing, and how much paint it spends. It
      // may place fewer than the modal quoted — another tab, another device
      // on this connection, or somebody else taking the ground first — so
      // everything below works off `placedIdx`, not off what we asked for.
      const d = await apiEnvelope('/api/claim', {}, [...sel].map(([i, c]) => [i, rgbInt(c), 0]));
      applyAllowance(d);

      /* Claimed is not painted any more — these move from the basket to the
         pending layer and sit there until a moderator says yes. */
      for (const i of d.placedIdx) {
        const c = sel.get(i); if (c === undefined) continue;
        addPending(i, c);
        sel.delete(i);                                  // the rest stay in the basket
        pctx.clearRect(i % W, (i / W) | 0, 1, 1);
      }
      if (d.sid) knownSubs.add(d.sid);
      if (d.occupied) {                                 // taken while we were choosing
        for (const [i] of [...sel]) {
          if (!pixels.has(i)) continue;
          sel.delete(i); pctx.clearRect(i % W, (i / W) | 0, 1, 1);
        }
      }
      updateAll();

      $('coBody').hidden = true;
      $('coSuccessMsg').textContent = t('co.sent', { n: fmt(d.placed) });
      $('coSuccessSub').textContent = t('co.sentSub');
      $('coSuccess').hidden = false;
      if (d.occupied) {
        toast(t('toast.occupied', { n: fmt(d.occupied) }), { cls: 'warn' });
      }
      if (d.short > 0) {
        toast(t('toast.short', { n: fmt(d.short) }) +
          (waitingOnRefill() ? ' ' + t('toast.shortWait', { t: mmss(refillLeft()) }) : ''),
          { cls: 'warn', action: { label: t('act.buyPaint'), fn: () => openModal('modalPaint') } });
      }
      setTimeout(() => closeModal('modalCheckout'), 1700);
    } catch (err) {
      btn.disabled = false; btn.textContent = label;
      // a daily cap has something specific to say; anything else doesn't
      const said = err.data && err.data.message;
      toast(said || t('toast.wrong'), { cls: said ? 'warn' : 'err', dur: said ? 6000 : 3600 });
      if (!said) resync('claim failed');
    }
  };
  // hidden/backgrounded pages throttle timers up to 60s — commit instantly there
  if (document.hidden) commit(); else setTimeout(commit, 1100);
};
$('btnClear').onclick = () => { clearSel(); };

/* ── Paint shop ── */
$('btnPaintShop').onclick = () => openModal('modalPaint');
/* Every price on the page, written from the wall snapshot.

   None of it is in the markup: the admin panel can change a rate without a
   deploy (PLAN §7.2), so a page carrying a hard-coded figure would be
   quoting a price the server will not honour — and the first anyone would
   know is a checkout that disagrees with the button that opened it. The
   packs are built here for the same reason, and the SAVE badges are derived
   rather than written, so a pack and its discount cannot drift apart. */
function applyPrices(prices) {
  /* remembered so a language switch can re-render the packs it built */
  if (prices) lastPrices = prices; else prices = lastPrices;
  if (!prices) return;
  for (const el of document.querySelectorAll('.px-rate')) el.textContent = fmt(prices.paint);
  for (const el of document.querySelectorAll('.co-rate')) el.textContent = fmt(prices.company);

  const host = $('packs');
  if (!host) return;
  host.textContent = '';
  const packs = Object.entries(prices.packs || {})
    .map(([amount, price]) => [Number(amount), Number(price)])
    .sort((a, b) => a[0] - b[0]);

  // the middle one is the one most people take, so it is the one flagged
  const popular = packs.length > 2 ? Math.floor(packs.length / 2) : -1;

  packs.forEach(([amount, price], i) => {
    const save = Math.round((1 - price / (amount * prices.paint)) * 100);
    const b = document.createElement('button');
    b.className = 'pack' + (i === popular ? ' pack-pop' : '');
    b.dataset.paint = amount;
    b.innerHTML =
      (i === popular ? `<i class="pk-tag">${t('ps.popular')}</i>` : '') +
      `<b class="pk-amt">${fmt(amount)}</b><span class="pk-unit">${t('common.paint')}</span>` +
      `<span class="pk-price">${fmt(price)} EGP</span>` +
      `<span class="pk-save">${save > 0 ? t('ps.save', { pct: save }) : `${fmt(prices.paint)} EGP/PX`}</span>`;
    b.onclick = () => buyPack(b, amount);
    host.appendChild(b);
  });
}

async function buyPack(btn, amount) {
  btn.disabled = true;
  try {
    const order = await apiJson('/api/paint/order', { pack: amount });
    closeModal('modalPaint');
    openPay(order, `${fmt(amount)} paint`);
  } catch (e) {
    toast(t('toast.shopDown'), { cls: 'err' });
  } finally { btn.disabled = false; }
}

/* ═══════════ INSTAPAY ═══════════
   InstaPay has no merchant API, so there is no callback that says the money
   arrived and nothing here can pretend otherwise. What the page can do is
   make the transfer easy to get right — the amount, the destination and a
   short code for the note — and then take the payer's word for it well
   enough that a person can check it against their own app. */

const pay = { order: null, what: '', shot: null, busy: false };

function openPay(order, what) {
  pay.order = order; pay.what = what || ''; pay.shot = null; pay.busy = false;
  knownPayments.add(order.paymentId);
  const egp = fmt(order.amountEgp);
  $('pyAmount').textContent = `${egp} EGP`;
  $('pyTo').textContent = order.handle || 'the InstaPay link below';
  $('pyCode').textContent = order.code;
  $('pyLink').href = order.url || '#';
  $('pyLink').hidden = !order.url;

  const qr = $('pyQrWrap');
  // the official QR encodes an IPN payload — it is the user's own file or it
  // is nothing, because a regenerated one would send money somewhere else
  if (order.qr) { $('pyQr').src = order.qr; qr.hidden = false; } else { qr.hidden = true; }

  $('pyHold').textContent = order.holdExpires
    ? `Your spot is held until ${new Date(order.holdExpires).toLocaleString('en-US',
      { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`
    : `This order stays open for ${order.holdHours} hours.`;

  $('pyRef').value = ''; $('pyFrom').value = '';
  $('pyShotName').textContent = 'No file chosen';
  for (const id of ['errPyRef', 'errPyFrom', 'errPyShot', 'errPy']) $(id).hidden = true;
  $('pyForm').hidden = false; $('pySent').hidden = true;
  $('pySubmit').disabled = false; $('pySubmit').textContent = 'I’VE SENT IT';
  openModal('modalPay');
}

$('pyCopy').onclick = async () => {
  const code = $('pyCode').textContent;
  try {
    await navigator.clipboard.writeText(code);
    $('pyCopy').textContent = 'COPIED';
    setTimeout(() => { $('pyCopy').textContent = 'COPY'; }, 1600);
  } catch (e) {
    // clipboard is blocked on insecure origins and in some embedded browsers
    toast(`Copy it by hand: <b>${code}</b>`, { dur: 6000 });
  }
};

$('pyShotPick').onclick = () => $('pyShot').click();
$('pyShot').onchange = () => {
  const f = $('pyShot').files[0];
  pay.shot = f || null;
  $('pyShotName').textContent = f ? f.name : 'No file chosen';
  $('errPyShot').hidden = true;
  // the server enforces this too; failing here saves a 5MB upload to be told so
  if (f && f.size > 5 << 20) {
    pay.shot = null;
    showErr('errPyShot', 'That image is over 5 MB — a screenshot should be well under.');
  }
};

$('pyProof').onsubmit = async e => {
  e.preventDefault();
  if (pay.busy || !pay.order) return;
  for (const id of ['errPyRef', 'errPyFrom', 'errPy']) $(id).hidden = true;

  pay.busy = true;
  const btn = $('pySubmit');
  btn.disabled = true; btn.textContent = 'SENDING…';
  try {
    /* Screenshot first, so the card the moderator gets has the picture on it
       rather than arriving a second later without one. A failure here is not
       fatal — the reference is the part that matters. */
    if (pay.shot) {
      const up = await fetch(`${API_BASE}/api/payments/${pay.order.paymentId}/screenshot`, {
        method: 'POST', headers: { 'content-type': pay.shot.type || 'image/png' }, body: pay.shot
      });
      if (!up.ok) {
        const d = await up.json().catch(() => ({}));
        showErr('errPyShot', d.message || 'That image could not be read — carry on without it.');
      }
    }
    const r = await apiPost(`/api/payments/${pay.order.paymentId}/proof`, {
      instapay_ref: $('pyRef').value, payer_handle: $('pyFrom').value
    });
    if (!r.ok) {
      const f = r.data.fields || {};
      if (f.instapay_ref) showErr('errPyRef', f.instapay_ref);
      if (f.payer_handle) showErr('errPyFrom', f.payer_handle);
      if (!f.instapay_ref && !f.payer_handle) showErr('errPy', r.data.message || 'That did not go through — try again.');
      return;
    }
    $('pyForm').hidden = true;
    $('pySentSub').textContent = pay.what
      ? `We are checking for your transfer. ${pay.what} lands the moment it is confirmed, and MY PIXELS tracks it.`
      : 'We are checking for your transfer. You will see it land in MY PIXELS.';
    $('pySent').hidden = false;
    loadHistory(false);
  } catch (err) {
    showErr('errPy', 'Could not reach the server — try again in a moment.');
  } finally {
    pay.busy = false;
    btn.disabled = false; btn.textContent = 'I’VE SENT IT';
  }
};

$('pySentGo').onclick = () => { closeModal('modalPay'); openHistory(); };

/* ── Help ── */
$('btnHelp').onclick = () => openModal('modalHelp');

/* ═══════════ MY PIXELS ═══════════
   Nothing goes on the wall unreviewed, which means "claimed" and "up" are
   two different things and the gap between them needs somewhere to live.
   This is it: every batch, its status, and — when a moderator turned one
   down — the reason they gave. */

const HS_PAGE = 12;
/* submission ids we know are ours. The `mod` SSE event is broadcast to
   everyone, so this is what turns it into "was that mine?" without asking
   the server on every decision anyone gets. */
const knownSubs = new Set();
/* …and the same for payment ids, which arrive on the `pay` event */
const knownPayments = new Set();
const history = { rows: [], total: 0, loaded: 0, open: false, busy: false };

/* Built at render time rather than held as constants, so a language
   switch re-renders the list in the new tongue with no special casing. */
const HS_CHIP_CLS = { pending: 'wait', approved: 'live', rejected: 'bad', expired: 'dim' };
const HS_CHIP_IC = { pending: 'loader', approved: 'check', rejected: 'cross', expired: 'timer' };
function chipFor(row) {
  const status = HS_CHIP_CLS[row.status] ? row.status : 'pending';
  const kind = row.type === 'pack' ? 'pack' : 'sub';
  return {
    cls: HS_CHIP_CLS[status],
    label: `${ic(HS_CHIP_IC[status])} ${t(`hs.${kind}.${status}`)}`
  };
}
/* `pack` is the odd one out: money with no pixels behind it yet, because
   paint is only drawn when it is spent. It still belongs in this list —
   the checkout tells the buyer to look for it here. */
const HS_TYPE_IC = { free: 'brush', paint: 'paint', brand: 'brand', pack: 'card' };
const hsType = type =>
  `${ic(HS_TYPE_IC[type] || 'brush')} ${t(`hs.type.${type}`, null, type)}`;
/* a paid row says where the money got to as well as where the pixels did */
const hsPay = status => t(`hs.pay.${status}`, null, status);

/* The server sends at most 256 sampled pixels per row (see thumbOf), which
   is plenty at this size and bounded whether the batch was 4 pixels or a
   160,000-pixel logo. */
function thumbCanvas(row) {
  const c = document.createElement('canvas');
  const w = Math.max(1, row.bbox[2] - row.bbox[0] + 1);
  const h = Math.max(1, row.bbox[3] - row.bbox[1] + 1);
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  for (const [dx, dy, col] of row.thumb || []) {
    g.fillStyle = hex(col);
    g.fillRect(dx, dy, 1, 1);
  }
  c.className = 'hs-thumb';
  // let the box decide the display size; the bitmap stays 1px per pixel
  c.style.aspectRatio = `${w} / ${h}`;
  return c;
}

function historyRow(row) {
  const el = document.createElement('div');
  el.className = 'hs-row';
  const chip = chipFor(row);

  const box = document.createElement('div');
  box.className = 'hs-thumb-box';
  box.appendChild(thumbCanvas(row));
  el.appendChild(box);

  const body = document.createElement('div');
  body.className = 'hs-body';
  const head = document.createElement('div');
  head.className = 'hs-head';
  head.innerHTML = `<b>${hsType(row.type)}</b>` +
    (row.type === 'pack' ? '' : `<span class="hs-px">${fmt(row.px)} px</span>`) +
    `<span class="hs-chip hs-${chip.cls}">${chip.label}</span>`;
  body.appendChild(head);

  const note = document.createElement('div');
  note.className = 'hs-note';
  const when = new Date(row.at).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US',
    { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  let text = when;
  if (row.brand) text += ` · ${row.brand}`;
  if (row.type === 'pack') text += ` · ${fmt(row.px)} ${t('common.paintLower')}`;
  if (row.layer === 'next') text += ` · ${t('hs.nextCycle')}`;
  if (row.payment) {
    text += ` · ${hsPay(row.payment.status)}`;
    if (row.payment.amount) text += ` (${fmt(Math.round(row.payment.amount / 100))} EGP)`;
  }
  note.textContent = text;
  body.appendChild(note);

  if (row.reason) {
    const why = document.createElement('div');
    why.className = 'hs-why';
    why.textContent = row.reason;
    body.appendChild(why);
  }
  el.appendChild(body);
  return el;
}

function renderHistory() {
  const list = $('hsList');
  list.textContent = '';
  for (const row of history.rows) list.appendChild(historyRow(row));
  const empty = $('hsEmpty');
  empty.hidden = history.rows.length > 0;
  if (!empty.hidden) empty.textContent = t('hs.empty');
  $('hsMore').hidden = history.rows.length >= history.total;
}

async function loadHistory(more) {
  if (history.busy) return;
  history.busy = true;
  try {
    const offset = more ? history.rows.length : 0;
    const d = await apiJson(`/api/me/history?limit=${HS_PAGE}&offset=${offset}`);
    history.rows = more ? history.rows.concat(d.rows) : d.rows;
    history.total = d.total;
    for (const r of history.rows) {
      if (r.sid) knownSubs.add(r.sid);          // a pack row has no submission
      if (r.payment) knownPayments.add(r.payment.id);
    }
    renderHistory();
  } catch (e) {
    $('hsEmpty').hidden = false;
    $('hsEmpty').textContent = t('toast.unreachable');
  } finally { history.busy = false; }
}

/* A decision landed somewhere. If it is one of ours, the wall needs
   refetching (our pending pixels either became wall or vanished) and the
   allowance may have moved with it. */
let decisionTimer = null;
function onDecision(sid, status, px) {
  if (!knownSubs.has(sid)) return;
  /* Turned down: the shimmer comes off the wall now, not on the next
     reload. These cells were never public, so no paint-remove is coming
     for them — this event is the whole notification. */
  if (px && px.length) {
    for (const i of px) removePending(i);
    thumbDirty = true;
    updateStats();
  }
  clearTimeout(decisionTimer);
  decisionTimer = setTimeout(() => {
    syncAllowance();
    if (history.open) loadHistory(false);
  }, 150);
  bumpAlerts();
  if (status === 'rejected' || status === 'expired') {
    toast(t(status === 'rejected' ? 'toast.subRejected' : 'toast.subExpired'),
      { cls: 'warn', dur: 6000, action: { label: t('act.myPixels'), fn: openHistory } });
  } else if (status === 'approved') {
    toast(`${ic('celebrate')} ${t('toast.subApproved')}`);
  }
}

/* Money moved. Like `mod`, this goes to everyone and means nothing to
   anybody but the payer — the paint balance is the tell, so the allowance
   refetch is what actually updates the page. */
function onPayment(pid, status) {
  if (!knownPayments.has(pid)) return;
  syncAllowance();
  if (history.open) loadHistory(false);
  bumpAlerts();
  if (status === 'verified') {
    toast(`${ic('paint')} ${t('toast.payVerified')}`);
  } else if (status === 'rejected' || status === 'expired') {
    toast(t(status === 'rejected' ? 'toast.payRejected' : 'toast.payExpired'),
      { cls: 'warn', dur: 7000, action: { label: t('act.myPixels'), fn: openHistory } });
  } else if (status === 'refunded') {
    toast(`${ic('refund')} ${t('toast.payRefunded')}`);
  }
}

function openHistory() {
  history.open = true;
  openModal('modalHistory');
  loadHistory(false);
}
$('btnHistory').onclick = openHistory;
$('hsMore').onclick = () => loadHistory(true);
$('modalHistory').addEventListener('click', e => {
  if (e.target.hasAttribute('data-close') || e.target.id === 'modalHistory') history.open = false;
});

/* ═══════════ BRAND ACCOUNT ═══════════
   Painting needs nobody's permission — the cookie the server hands out on
   the first request is the whole of a guest identity. Booking logo space
   does: a brand applies with real business details, a person reads the
   application, and only an approved account can open the pre-order flow.
   The server enforces every word of that; this is the screen for it. */

const BRAND_STATUS_IC = { pending: 'loader', approved: 'check', rejected: 'cross' };

const isBrand = () => me.kind === 'brand';
const canBook = () => isBrand() && me.brandStatus === 'approved';

function setMe(d) {
  if (d && typeof d === 'object') {
    me = {
      kind: d.kind || 'guest', handle: d.handle || '',
      brandStatus: d.brandStatus || null,
      /* the painter upgrade (§3): a guest with an email is a signed-in
         painter — same identity, reachable from other devices */
      registered: !!d.registered, email: d.email || null
    };
  }
  renderAuth();
  renderMe();
}

/* Asks the server who we are. The wall snapshot already says, so this is
   for the moments between snapshots — after a decision lands, or after a
   request comes back saying the account no longer holds what it did. */
async function refreshMe() {
  try {
    const d = await apiJson('/api/me');
    setMe(d);
    if (d.allowance) applyAllowance(d.allowance);
    updateAll();
  } catch (e) { console.warn('identity refresh failed:', e.message); }
}

/* Everything that changes when the account does, in one place. */
function renderAuth() {
  const status = BRAND_STATUS_IC[me.brandStatus] ? me.brandStatus : null;
  $('authWho').textContent = me.handle || '—';
  $('authChip').innerHTML = status
    ? `${ic(BRAND_STATUS_IC[status])} ${t('brand.chip.' + status)}` : '—';
  $('authChip').className = 'status-chip ' + (me.brandStatus || '');
  $('authNote').textContent = status ? t('brand.note.' + status) : '';
  $('btnGoBook').hidden = !canBook();

  $('cpBrand').hidden = !canBook();
  $('cpBrandName').textContent = me.handle || '—';

  const btn = $('btnCompany');
  btn.classList.toggle('needs-account', isBrand() && !canBook());
  btn.title = canBook() ? t('brand.titleBook')
    : isBrand() ? t('brand.titlePending') : t('brand.titleApply');
}

/* The account door serves two crowds through one sheet. `ctx` picks the
   voice: 'painter' offers CREATE / LOG IN for keeping a guest identity,
   'brand' offers APPLY / LOG IN for booking logo space. Any brand session
   lands on the status pane regardless. */
let authCtx = 'brand';
function openAuth(tab, ctx) {
  if (ctx) authCtx = ctx;
  if (isBrand()) authCtx = 'brand';
  const pane = tab || (isBrand() ? 'status' : (authCtx === 'painter' ? 'register' : 'signup'));
  const painter = authCtx === 'painter';

  $('paneRegister').hidden = pane !== 'register';
  $('paneSignup').hidden = pane !== 'signup';
  $('paneLogin').hidden = pane !== 'login';
  $('paneStatus').hidden = pane !== 'status';
  $('authTabs').hidden = pane === 'status';
  $('tabSignup').hidden = painter;
  $('tabRegister').hidden = !painter;
  $('tabSignup').classList.toggle('sel', pane === 'signup');
  $('tabRegister').classList.toggle('sel', pane === 'register');
  $('tabLogin').classList.toggle('sel', pane === 'login');

  $('auTitleText').textContent = painter ? t('au.titlePainter') : t('au.titleBrand');
  $('auSub').textContent = pane === 'status' ? t('au.subStatus')
    : painter ? t('au.subPainter') : t('au.subBrand');
  openModal('modalAuth');
}
$('tabSignup').onclick = () => openAuth('signup');
$('tabRegister').onclick = () => openAuth('register');
$('tabLogin').onclick = () => openAuth('login');

/* signup field id -> the server's name for it, which is also the key it
   reports errors under */
const SIGNUP_FIELDS = {
  suName: 'business_name', suCategory: 'category', suContact: 'contact_name',
  suPhone: 'phone', suEmail: 'email', suPass: 'password', suSite: 'website',
  suSocials: 'socials', suInstapay: 'instapay_handle', suReg: 'reg_number', suDesc: 'description'
};
const errIdFor = id => 'err' + id[0].toUpperCase() + id.slice(1);

function clearSignupErrors() {
  for (const id of Object.keys(SIGNUP_FIELDS)) {
    const err = $(errIdFor(id));
    if (err) err.hidden = true;
    $(id).classList.remove('bad');
  }
  $('errSignup').hidden = true;
}
/* The server is the only validator that counts, so its answer is what the
   form renders — field by field where it named one, at the foot where it
   didn't (a rate limit, say). */
function showSignupErrors(data) {
  const fields = data.fields || {};
  let first = null;
  for (const [id, name] of Object.entries(SIGNUP_FIELDS)) {
    if (!fields[name]) continue;
    const err = $(errIdFor(id));
    if (err) showErr(errIdFor(id), fields[name]);
    $(id).classList.add('bad');
    if (!first) first = id;
  }
  /* anything the server flagged that this form has no box for, plus the
     messages that aren't about a field at all (a rate limit, say) */
  const spare = Object.entries(fields)
    .filter(([name]) => !Object.values(SIGNUP_FIELDS).includes(name))
    .map(([, msg]) => msg);
  const rest = [data.message, ...spare].filter(Boolean).join(' ');
  if (rest) showErr('errSignup', rest);
  if (first) $(first).focus();
}

const DESC_MIN = 200;
$('suDesc').addEventListener('input', () => {
  const n = $('suDesc').value.trim().length;
  const el = $('suDescCount');
  el.textContent = n >= DESC_MIN ? `${fmt(n)} characters` : `${fmt(n)} / ${DESC_MIN} minimum`;
  el.classList.toggle('ok', n >= DESC_MIN);
});

$('paneSignup').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btnSignup');
  clearSignupErrors();
  const body = {};
  for (const [id, name] of Object.entries(SIGNUP_FIELDS)) body[name] = $(id).value;
  body.socials = $('suSocials').value.split('\n').map(s => s.trim()).filter(Boolean);

  btn.disabled = true; btn.textContent = t('au.busy');
  try {
    const r = await apiPost('/api/auth/signup', body);
    if (!r.ok) { showSignupErrors(r.data); return; }
    setMe(r.data);
    if (r.data.allowance) applyAllowance(r.data.allowance);
    await loadWall();                    // the account is a different caller now
    openAuth('status');
    toast(`${ic('brand')} ${t('toast.applied')}`, { dur: 5200 });
  } catch (err) {
    showErr('errSignup', t('toast.unreachable'));
  } finally {
    btn.disabled = false; btn.textContent = t('au.applyCta');
  }
});

$('paneLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btnLogin');
  clearErr('errLogin');
  btn.disabled = true; btn.textContent = t('au.checking');
  try {
    const r = await apiPost('/api/auth/login', { email: $('liEmail').value, password: $('liPass').value });
    if (!r.ok) { showErr('errLogin', r.data.message || t('au.badCreds')); return; }
    $('liPass').value = '';
    setMe(r.data);
    if (r.data.allowance) applyAllowance(r.data.allowance);
    await loadWall();
    loadAlerts();
    /* a painter goes back to the wall they came for; a brand goes on with
       the booking business the login was in the way of */
    if (me.kind === 'guest') {
      closeModal('modalAuth'); closeModal('modalMe');
      toast(`${ic('check')} ${t('toast.welcomeBack', { name: me.handle })}`);
    } else if (canBook()) { closeModal('modalAuth'); openCompany(); }
    else openAuth('status');
  } catch (err) {
    showErr('errLogin', t('toast.unreachable'));
  } finally {
    btn.disabled = false; btn.textContent = t('au.loginCta');
  }
});

/* Logging out drops the account cookie; the next request mints a plain
   guest again, so the wall is reloaded to pick up whose pixels are whose. */
async function logout() {
  try { await apiPost('/api/auth/logout'); } catch (e) { /* the cookie goes either way */ }
  try { await loadWall(); } catch (e) { /* offline handling already covers this */ }
  closeModal('modalAuth'); closeModal('modalCompany'); closeModal('modalMe');
  loadAlerts();
  toast(t('toast.loggedOut'));
}
$('btnLogout').onclick = logout;
$('cpBrandOut').onclick = logout;
$('btnGoBook').onclick = () => { closeModal('modalAuth'); openCompany(); };

/* ═══════════ COMPANY PRE-ORDER ═══════════ */
const MIN_PX = 8, MAX_PX = 400, SRC_MAX = 560;

let cpCells = null;
let placing = null;                    // {w,h,cells,name,ghost,url,cta}
let ghostPos = null, ghostValid = false;

/* Source image editing state */
const src = {
  raw: null,        // <canvas> of the uploaded image at working resolution
  work: null,       // raw + background removal applied
  crop: null,       // {x,y,w,h} in source pixels
  hadAlpha: false,
  name: ''
};

/* ── Background remover (experimental) ───────────────────────────────
   Flood-fills from the image border, keeping only colours within
   `tol` of the dominant edge colour, then feathers the boundary so the
   cut doesn't leave a hard halo.                                      */
function removeBackground(from, tol) {
  const w = from.width, h = from.height, n = w * h;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(from, 0, 0);
  const img = octx.getImageData(0, 0, w, h), d = img.data;

  // dominant border colour, via a coarse 3-bit-per-channel histogram
  const hist = new Map();
  const noteEdge = i => {
    const k = i * 4;
    if (d[k + 3] < 8) return;
    const key = (d[k] >> 5 << 6) | (d[k + 1] >> 5 << 3) | (d[k + 2] >> 5);
    const e = hist.get(key) || [0, 0, 0, 0];
    e[0] += d[k]; e[1] += d[k + 1]; e[2] += d[k + 2]; e[3]++;
    hist.set(key, e);
  };
  for (let x = 0; x < w; x++) { noteEdge(x); noteEdge((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { noteEdge(y * w); noteEdge(y * w + w - 1); }
  let best = null;
  for (const e of hist.values()) if (!best || e[3] > best[3]) best = e;
  if (!best) return out;
  const br = best[0] / best[3], bg_ = best[1] / best[3], bb = best[2] / best[3];

  const distTo = (i, r, g, b) => {
    const k = i * 4;
    return Math.sqrt((d[k] - r) ** 2 + (d[k + 1] - g) ** 2 + (d[k + 2] - b) ** 2);
  };
  const dist = i => distTo(i, br, bg_, bb);
  const distWhite = i => distTo(i, 255, 255, 255);

  // flood fill inward from every border pixel that matches the background
  const state = new Uint8Array(n);          // 1 = background
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = i => { if (!state[i] && dist(i) <= tol) { state[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  // the wall itself is white, so white anywhere in the logo — including
  // enclosed areas the flood fill can't reach — is invisible once placed.
  // Drop it rather than charge for it.
  for (let i = 0; i < n; i++) {
    if (state[i] || d[i * 4 + 3] < 8) continue;
    if (distWhite(i) <= tol) state[i] = 1;
  }

  // cut the background, then feather kept pixels that touch it
  const feather = tol * 0.55;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (state[i]) { d[k + 3] = 0; continue; }
    const x = i % w, y = (i / w) | 0;
    const edge = (x > 0 && state[i - 1]) || (x < w - 1 && state[i + 1]) ||
                 (y > 0 && state[i - w]) || (y < h - 1 && state[i + w]);
    if (!edge) continue;
    const t = (Math.min(dist(i), distWhite(i)) - tol) / feather;
    if (t < 1) d[k + 3] = Math.round(d[k + 3] * Math.max(0, t));
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ── Source loading ── */
function loadSource(img, label) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) { showErr('errFile', 'That image could not be read.'); return; }
  const s = Math.min(1, SRC_MAX / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(iw * s));
  c.height = Math.max(1, Math.round(ih * s));
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(img, 0, 0, c.width, c.height);

  // does it already carry real transparency?
  const d = cc.getImageData(0, 0, c.width, c.height).data;
  let clear = 0;
  for (let k = 3; k < d.length; k += 4) if (d[k] < 128) clear++;
  src.raw = c;
  src.hadAlpha = clear > c.width * c.height * 0.02;
  src.name = label || '';
  clearErr('errFile');

  // opaque images (JPG/WebP) need the remover — switch it on by default
  $('bgRemove').checked = !src.hadAlpha;
  $('bgOpts').hidden = !$('bgRemove').checked;
  $('cpEditor').hidden = false;
  applyBg();
  resetCrop();
  if (!src.hadAlpha) {
    toast(`${ic('warn')} Opaque image detected — <b>background remover</b> switched on. Check the preview.`, { cls: 'warn', dur: 5200 });
  }
}
function applyBg() {
  if (!src.raw) return;
  src.work = $('bgRemove').checked
    ? removeBackground(src.raw, +$('bgTol').value)
    : src.raw;
  drawSource();
  rebuildCpPreview();
}

/* ── Crop ── */
function clampCrop() {
  const W0 = src.raw.width, H0 = src.raw.height, c = src.crop;
  c.w = Math.max(4, Math.min(c.w, W0));
  c.h = Math.max(4, Math.min(c.h, H0));
  c.x = Math.max(0, Math.min(c.x, W0 - c.w));
  c.y = Math.max(0, Math.min(c.y, H0 - c.h));
}
/* The crop owns the logo's shape. Output size follows it — never the
   other way round, so changing size or budget leaves the crop alone. */
function cropAspect() {
  if (src.crop && src.crop.h > 0) return src.crop.w / src.crop.h;
  return clampSize($('cpW').value) / clampSize($('cpH').value);
}
const ratioLocked = () => $('cpRatioLock').classList.contains('is-on');

/* re-derive the output height from the crop, keeping the chosen width */
function syncOutputToCrop() {
  showCropRatio();
  if (ratioLocked() && src.crop) {
    $('cpH').value = clampSize(clampSize($('cpW').value) / cropAspect());
  }
  markPreset();
  rebuildCpPreview();
}
function showCropRatio() {
  const el = $('cropRatioVal'); if (!el) return;
  el.textContent = src.crop ? cropAspect().toFixed(2) + ' : 1' : '—';
}
function resetCrop() {
  if (!src.raw) { rebuildCpPreview(); return; }
  src.crop = { x: 0, y: 0, w: src.raw.width, h: src.raw.height };
  clampCrop(); drawSource(); syncOutputToCrop();
}
function autoCrop() {
  if (!src.work) return;
  const w = src.work.width, h = src.work.height;
  const d = src.work.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 24) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { toast('Nothing opaque left to crop to — lower the tolerance.', { cls: 'warn' }); return; }
  const pad = 1;
  const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
  const cw = Math.min(w - cx, maxX - minX + 1 + pad * 2);
  const ch = Math.min(h - cy, maxY - minY + 1 + pad * 2);
  src.crop = { x: cx, y: cy, w: cw, h: ch };
  clampCrop(); drawSource(); syncOutputToCrop();
}
function drawSource() {
  if (!src.work) return;
  const c = $('cpSrc');
  c.width = src.work.width; c.height = src.work.height;
  const cc = c.getContext('2d');
  cc.clearRect(0, 0, c.width, c.height);
  cc.drawImage(src.work, 0, 0);
  positionCropBox();
}
function positionCropBox() {
  if (!src.crop || !src.raw) return;
  const box = $('cropBox'), c = src.crop;
  box.style.left   = (c.x / src.raw.width * 100) + '%';
  box.style.top    = (c.y / src.raw.height * 100) + '%';
  box.style.width  = (c.w / src.raw.width * 100) + '%';
  box.style.height = (c.h / src.raw.height * 100) + '%';
}

/* crop drag: move the box, or resize from any of the 8 handles */
(function initCropDrag() {
  const wrap = $('cropWrap'), box = $('cropBox');
  let drag = null;
  const toSrc = e => {
    const r = wrap.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * src.raw.width,
      y: (e.clientY - r.top) / r.height * src.raw.height
    };
  };
  wrap.addEventListener('pointerdown', e => {
    if (!src.raw) return;
    const handle = e.target.closest('.ch');
    const p = toSrc(e);
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    if (handle) drag = { mode: 'resize', h: handle.dataset.h, start: { ...src.crop } };
    else if (e.target.closest('.crop-box')) drag = { mode: 'move', ox: p.x - src.crop.x, oy: p.y - src.crop.y };
    else { src.crop = { x: p.x, y: p.y, w: 4, h: 4 }; drag = { mode: 'resize', h: 'se', start: { ...src.crop } }; }
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag || !src.raw) return;
    const p = toSrc(e), c = src.crop;
    if (drag.mode === 'move') { c.x = p.x - drag.ox; c.y = p.y - drag.oy; }
    else {
      const s = drag.start, right = s.x + s.w, bottom = s.y + s.h, h = drag.h;
      if (h.includes('e')) c.w = p.x - c.x;
      if (h.includes('s')) c.h = p.y - c.y;
      if (h.includes('w')) { c.x = Math.min(p.x, right - 4); c.w = right - c.x; }
      if (h.includes('n')) { c.y = Math.min(p.y, bottom - 4); c.h = bottom - c.y; }
      c.w = Math.max(4, c.w); c.h = Math.max(4, c.h);
    }
    clampCrop(); positionCropBox(); showCropRatio(); rebuildCpPreview();
  });
  const end = () => { if (drag) { drag = null; syncOutputToCrop(); } };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
})();

/* ── Pixelation ── */
function buildCells(source, crop, w, h) {
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tc = t.getContext('2d', { willReadFrequently: true });
  const s = Math.min(w / crop.w, h / crop.h);
  const dw = crop.w * s, dh = crop.h * s;
  tc.imageSmoothingEnabled = true;
  tc.imageSmoothingQuality = 'high';
  tc.drawImage(source, crop.x, crop.y, crop.w, crop.h, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const data = tc.getImageData(0, 0, w, h).data, cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    if (data[k + 3] < 128) continue;
    cells.push([x, y, '#' + ((1 << 24) | (data[k] << 16) | (data[k + 1] << 8) | data[k + 2]).toString(16).slice(1)]);
  }
  return cells;
}
function rebuildCpPreview() {
  const w = clampSize($('cpW').value), h = clampSize($('cpH').value);
  const c = $('cpCanvas'), cc = c.getContext('2d');
  c.width = 260; c.height = Math.max(90, Math.round(260 * h / w));
  cc.clearRect(0, 0, c.width, c.height);
  if (!src.work || !src.crop) {
    cpCells = null;
    $('cpCount').textContent = '0';
    $('cpCost').textContent = '0 EGP';
    $('cpEmpty').hidden = false;
    updatePriceReadout();
    validateCompany();
    return;
  }
  $('cpEmpty').hidden = true;
  cpCells = buildCells(src.work, src.crop, w, h);
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tc = t.getContext('2d');
  for (const [x, y, col] of cpCells) { tc.fillStyle = col; tc.fillRect(x, y, 1, 1); }
  const s = Math.min(c.width / w, c.height / h);
  cc.imageSmoothingEnabled = false;
  cc.drawImage(t, (c.width - w * s) / 2, (c.height - h * s) / 2, w * s, h * s);
  $('cpCount').textContent = fmt(cpCells.length);
  $('cpCost').textContent = `${fmt(cpCells.length * PRICE_COMPANY)} EGP`;
  lastFill = cpCells.length / (w * h) || 1;
  updatePriceReadout();
  validateCompany();
}

/* ── Live price + budget slider ───────────────────────────────────────
   Cost is charged per painted pixel, not per box, so the budget maths
   uses the logo's measured fill ratio (transparent areas are free).   */
const BUDGET_MIN = 500, BUDGET_MAX = 250000, BUDGET_CURVE = 2.2;
let lastFill = 1;            // painted cells ÷ box area, from the last render
let budgetDragging = false;  // don't move the thumb out from under the cursor

const budgetFromSlider = p =>
  Math.round((BUDGET_MIN + (BUDGET_MAX - BUDGET_MIN) * Math.pow(p / 1000, BUDGET_CURVE)) / 100) * 100;
const sliderFromBudget = b =>
  Math.round(1000 * Math.pow(Math.min(1, Math.max(0, (b - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN))), 1 / BUDGET_CURVE));

function currentCost() {
  const w = clampSize($('cpW').value), h = clampSize($('cpH').value);
  const cells = cpCells ? cpCells.length : Math.round(w * h * lastFill);
  return cells * PRICE_COMPANY;
}
/* the readout always shows what you'd actually pay, never the target */
function updatePriceReadout() {
  const w = clampSize($('cpW').value), h = clampSize($('cpH').value);
  const cost = currentCost();
  $('cpSizePrice').textContent = fmt(cost);
  $('cpBudgetVal').textContent = fmt(cost);
  $('cpSizeSub').textContent = cpCells
    ? `${w}×${h} · ${fmt(cpCells.length)} painted px @ ${PRICE_COMPANY} EGP/PX`
    : `${w}×${h} — pick a logo for an exact price`;
  if (!budgetDragging) $('cpBudget').value = sliderFromBudget(cost);
}
/* budget → output resolution. Always at the logo's own ratio, and the
   crop is never modified — only how finely that crop is rendered. */
function applyBudget() {
  const budget = budgetFromSlider(+$('cpBudget').value);
  const a = Math.max(0.05, cropAspect());
  const fill = Math.min(1, Math.max(0.05, lastFill || 1));
  const area = budget / PRICE_COMPANY / fill;              // box area the budget buys
  let w = clampSize(Math.sqrt(area * a));
  let h = clampSize(w / a);
  if (h >= MAX_PX) w = clampSize(h * a);                   // keep the ratio after clamping
  $('cpW').value = w; $('cpH').value = h;
  markPreset();
  rebuildCpPreview();
  validateCompany();
}
$('cpBudget').addEventListener('pointerdown', () => { budgetDragging = true; });
$('cpBudget').addEventListener('input', applyBudget);
$('cpBudget').addEventListener('change', () => { budgetDragging = false; updatePriceReadout(); });
window.addEventListener('pointerup', () => {
  if (budgetDragging) { budgetDragging = false; updatePriceReadout(); }
});

/* ── Size fields: steppers, ratio lock, validation ── */
const clampSize = v => Math.min(MAX_PX, Math.max(MIN_PX, Math.round(+v) || MIN_PX));

/* Output resolution only — the crop is never touched here. */
function syncSize(changed) {
  if (ratioLocked()) {
    const a = cropAspect();
    if (changed === 'w') $('cpH').value = clampSize(clampSize($('cpW').value) / a);
    else if (changed === 'h') $('cpW').value = clampSize(clampSize($('cpH').value) * a);
  }
  markPreset();
  rebuildCpPreview();
}
function markPreset() {
  const w = clampSize($('cpW').value), h = clampSize($('cpH').value);
  document.querySelectorAll('.size-presets button').forEach(b =>
    b.classList.toggle('sel', +b.dataset.w === w && +b.dataset.h === h));
}
['cpW', 'cpH'].forEach(id => {
  const el = $(id), which = id === 'cpW' ? 'w' : 'h';
  el.addEventListener('input', () => { if (el.value !== '' && +el.value >= MIN_PX) syncSize(which); validateCompany(); });
  el.addEventListener('blur', () => { el.value = clampSize(el.value); syncSize(which); });
});
document.querySelectorAll('.st-btn').forEach(b => b.addEventListener('click', () => {
  const el = $(b.closest('.stepper').dataset.target);
  el.value = clampSize(+el.value + (+b.dataset.step));
  syncSize(el.id === 'cpW' ? 'w' : 'h');
  validateCompany();
}));
$('cpRatioLock').onclick = () => {
  const btn = $('cpRatioLock');
  const on = !btn.classList.contains('is-on');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  if (on) syncOutputToCrop(); else rebuildCpPreview();
  toast(on
    ? `${ic('lock')} Output locked to the logo’s ratio.`
    : `${ic('unlock')} Ratio unlocked — set width and height freely (the logo is letterboxed).`,
    { dur: 2400 });
};
document.querySelectorAll('.size-presets button').forEach(b => b.addEventListener('click', () => {
  // when locked, a preset picks the width and the logo's ratio sets the height
  $('cpW').value = b.dataset.w;
  if (ratioLocked() && src.crop) $('cpH').value = clampSize(+b.dataset.w / cropAspect());
  else $('cpH').value = b.dataset.h;
  markPreset();
  rebuildCpPreview();
  validateCompany();
}));

/* ── Validation ── */
function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
function clearErr(id) { $(id).hidden = true; }
function validateCompany() {
  let ok = true;

  const nameEl = $('cpName'), name = nameEl.value.trim();
  if (name && name.length < 2) { nameEl.classList.add('bad'); showErr('errName', 'Company name needs at least 2 characters.'); ok = false; }
  else { nameEl.classList.remove('bad'); clearErr('errName'); }

  const w = +$('cpW').value, h = +$('cpH').value;
  const sizeBad = !(w >= MIN_PX && w <= MAX_PX && h >= MIN_PX && h <= MAX_PX);
  document.querySelectorAll('.stepper').forEach(s => s.classList.toggle('bad', sizeBad));
  if (sizeBad) { showErr('errSize', `Width and height must be between ${MIN_PX} and ${MAX_PX} pixels.`); ok = false; }
  else clearErr('errSize');

  const linkEl = $('cpLink'), raw = linkEl.value.trim();
  const url = safeUrl(raw);
  linkEl.classList.toggle('bad', !!raw && !url);
  linkEl.classList.toggle('ok', !!url);
  if (raw && !url) { showErr('errLink', 'Enter a valid web address, e.g. nile-soda.com/promo'); ok = false; }
  else clearErr('errLink');

  if (!src.work) { ok = false; }
  else if (cpCells && cpCells.length === 0) { showErr('errFile', 'Nothing left to paint — lower the tolerance or turn the remover off.'); ok = false; }
  else clearErr('errFile');

  $('btnPlaceLogo').disabled = !ok;
  return ok;
}
['cpName', 'cpLink', 'cpCta'].forEach(id => $(id).addEventListener('input', validateCompany));

/* ── Wiring ── */
function openCompany() { markPreset(); rebuildCpPreview(); openModal('modalCompany'); }
/* The button is the door to the whole brand flow. An approved account walks
   straight in; anyone else lands on the application form, or on the note
   saying where their application got to. */
$('btnCompany').onclick = () => {
  closeModal('modalMore');
  if (canBook()) openCompany(); else openAuth(null, 'brand');
};
$('cpPick').onclick = () => $('cpFile').click();
$('cpFile').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  if (!/^image\//.test(f.type)) { showErr('errFile', 'That file is not an image.'); return; }
  $('cpFileName').textContent = f.name;
  $('cpFileName').classList.add('has');
  if (!/png|svg/i.test(f.type)) toast(`${ic('warn')} <b>PNG preferred</b> — this format has no transparency.`, { cls: 'warn', dur: 4200 });
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => { loadSource(img, f.name); URL.revokeObjectURL(url); };
  img.onerror = () => { showErr('errFile', 'That image could not be loaded.'); URL.revokeObjectURL(url); };
  img.src = url;
});
$('cpSample').onclick = async () => {
  if (!logoImg.naturalWidth) {
    // never block on decode() — it can stall indefinitely in a hidden tab
    await Promise.race([logoImg.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  }
  if (!logoImg.naturalWidth) { showErr('errFile', 'Sample logo is still loading — try again.'); return; }
  $('cpFileName').textContent = 'logo-icon.png (sample)';
  $('cpFileName').classList.add('has');
  loadSource(logoImg, 'logo-icon.png');
};
$('bgRemove').addEventListener('change', () => { $('bgOpts').hidden = !$('bgRemove').checked; applyBg(); });
$('bgTol').addEventListener('input', () => { $('tolVal').textContent = $('bgTol').value; applyBg(); });
$('cropAuto').onclick = autoCrop;
$('cropReset').onclick = resetCrop;

$('btnPlaceLogo').onclick = () => {
  if (!validateCompany() || !cpCells || !cpCells.length) return;
  const w = clampSize($('cpW').value), h = clampSize($('cpH').value);
  const name = ($('cpName').value.trim() || 'YOUR BRAND').toUpperCase();
  const url = safeUrl($('cpLink').value);
  const cta = ($('cpCta').value.trim() || 'VISIT SITE').toUpperCase();
  const ghost = document.createElement('canvas'); ghost.width = w; ghost.height = h;
  const gc = ghost.getContext('2d');
  for (const [x, y, col] of cpCells) { gc.fillStyle = col; gc.fillRect(x, y, 1, 1); }
  placing = { w, h, cells: cpCells, name, ghost, url, cta };
  ghostPos = null;
  closeModal('modalCompany'); closeModal('modalMore');
  cvs.classList.add('placing');
  document.body.classList.add('placing');   // the chrome steps aside for the spot-pick
  $('placementHint').hidden = false;
};
function cancelPlacing() {
  placing = null; ghostPos = null;
  cvs.classList.remove('placing');
  document.body.classList.remove('placing');
  $('placementHint').hidden = true;
}
/* Pre-orders are booked against next cycle's wall, so the only thing in the
   way is what somebody else already prepaid — never the live pixels, which
   the reset wipes anyway. A small overlap is allowed: those cells are skipped
   (never overwritten) and never charged for. Beyond OVERLAP_MAX is rejected. */
const OVERLAP_MAX = 0.02;
let ghostOverlap = 0;

function countOverlap(gx, gy, cells, bail) {
  let n = 0;
  for (const [dx, dy] of cells) {
    if (reserved.has(idx(gx + dx, gy + dy))) { n++; if (bail && n > bail) return n; }
  }
  return n;
}
function overlapBudget(cells) { return Math.floor(cells.length * OVERLAP_MAX); }

function updateGhost(cell) {
  if (!placing || !cell) { ghostPos = null; return; }
  const gx = Math.min(W - placing.w, Math.max(0, cell.x - (placing.w >> 1)));
  const gy = Math.min(H - placing.h, Math.max(0, cell.y - (placing.h >> 1)));
  ghostPos = { x: gx, y: gy };
  const budget = overlapBudget(placing.cells);
  ghostOverlap = countOverlap(gx, gy, placing.cells, budget);
  ghostValid = ghostOverlap <= budget;
  const el = $('phOverlap');
  if (el) {
    el.textContent = ghostOverlap ? `${fmt(ghostOverlap)} booked px here` : 'clear';
    el.className = ghostValid ? 'ok' : 'bad';
  }
}
/* scan the wall for the emptiest position that fits */
function findFreeSpot() {
  if (!placing) return;
  const budget = overlapBudget(placing.cells);
  const stepX = Math.max(8, placing.w >> 1), stepY = Math.max(8, placing.h >> 1);
  let best = null;
  for (let gy = 0; gy <= H - placing.h; gy += stepY) {
    for (let gx = 0; gx <= W - placing.w; gx += stepX) {
      const n = countOverlap(gx, gy, placing.cells, budget);
      if (n <= budget) { best = { gx, gy, n }; break; }
      if (!best || n < best.n) best = { gx, gy, n };
    }
    if (best && best.n <= budget) break;
  }
  if (!best) return;
  ghostPos = { x: best.gx, y: best.gy };
  ghostOverlap = best.n;
  ghostValid = best.n <= budget;
  // centre the view on the proposed spot
  view.s = Math.max(fitScale, Math.min(8, (cw * 0.6) / placing.w));
  view.ox = cw / 2 - (best.gx + placing.w / 2) * view.s;
  view.oy = ch / 2 - (best.gy + placing.h / 2) * view.s;
  userMovedView = true; clampView();
  const el = $('phOverlap');
  if (el) { el.textContent = ghostValid ? 'clear' : `${fmt(best.n)} booked px here`; el.className = ghostValid ? 'ok' : 'bad'; }
  toast(ghostValid
    ? `${ic('search')} Found a spot at <b>${best.gx}, ${best.gy}</b> — click to book it.`
    : `${nextCycleName()} is filling up — the emptiest spot still has ${fmt(best.n)} booked pixels.`,
    { cls: ghostValid ? '' : 'warn' });
}
$('btnFindSpot').onclick = findFreeSpot;
let pendingPlace = null;             // snapshot taken when the spot is clicked —
                                     // pointerleave/ESC after that can't break payment
function tryPlace() {
  if (!placing || !ghostPos) return;
  if (!ghostValid) {
    toast(`Too crowded here — <b>${fmt(ghostOverlap)}</b> pixels are already booked. Try FIND FREE SPOT.`,
      { cls: 'err', action: { label: 'FIND SPOT', fn: findFreeSpot } });
    return;
  }
  const { x: gx, y: gy } = ghostPos;
  // only cells landing on unbooked ground are reserved, and only those are billed
  const cells = placing.cells.filter(([dx, dy]) => !reserved.has(idx(gx + dx, gy + dy)));
  const skipped = placing.cells.length - cells.length;
  if (!cells.length) { toast('Nothing to book here — every pixel is already taken.', { cls: 'err' }); return; }

  const ghost = document.createElement('canvas');
  ghost.width = placing.w; ghost.height = placing.h;
  const gc = ghost.getContext('2d');
  for (const [dx, dy, col] of cells) { gc.fillStyle = col; gc.fillRect(dx, dy, 1, 1); }

  pendingPlace = { cells, name: placing.name, url: placing.url, cta: placing.cta, ghost, gx, gy };
  $('cfName').textContent = pendingPlace.name;
  $('cfPixels').textContent = fmt(cells.length);
  $('cfSkipRow').hidden = skipped === 0;
  $('cfSkip').textContent = fmt(skipped);
  $('cfLinkRow').hidden = !pendingPlace.url;
  if (pendingPlace.url) $('cfLink').textContent = pendingPlace.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('cfGoLive').textContent = `${shortDate(cycleEndsAt())} · ${nextCycleName()}`;
  $('cfTotal').textContent = `${fmt(cells.length * PRICE_COMPANY)} EGP`;
  const btn = $('btnConfirmPlace'); btn.disabled = false; btn.textContent = 'BOOK & PAY';
  openModal('modalConfirm');
}
$('btnConfirmPlace').onclick = () => {
  if (!pendingPlace) return;
  const btn = $('btnConfirmPlace');
  btn.disabled = true; btn.textContent = 'PROCESSING…';
  const commit = async () => {
    try {
      const { cells, name, url, cta, gx, gy } = pendingPlace;
      // up to 160k cells — the binary envelope keeps this at ~1.4 MB
      const d = await apiEnvelope('/api/book', { name, url, cta },
        cells.map(([dx, dy, col]) => [idx(gx + dx, gy + dy), rgbInt(col), 0]));
      pendingPlace = null;
      closeModal('modalConfirm');
      if (d.sid) knownSubs.add(d.sid);
      for (const [dx, dy, col] of cells) addPending(idx(gx + dx, gy + dy), col);
      updateAll();
      if (d.skipped) toast(`${fmt(d.skipped)} pixels were already booked and were skipped — you weren't charged for them.`, { cls: 'warn' });
      cancelPlacing();
      /* The spot is held, not bought. Straight into the transfer, because a
         booking nobody pays for is 48 hours of dead ground. */
      if (d.payment) openPay(d.payment, `${name}’s spot`);
      else toast(`${ic('brand')} <b>${name}</b> is booked — it goes live on ${shortDate(d.goesLive)}.`, { dur: 5200 });
    } catch (err) {
      btn.disabled = false; btn.textContent = 'BOOK & PAY';
      /* the account stopped being allowed to book between opening the flow
         and confirming it — approval revoked, or a session that outlived it */
      if (err.data && err.data.error === 'brand-required') {
        closeModal('modalConfirm');
        cancelPlacing();
        await refreshMe();
        toast(err.data.message, { cls: 'warn', dur: 6000 });
        openAuth();
        return;
      }
      toast('Something went wrong — please try again.', { cls: 'err' });
    }
  };
  // hidden/backgrounded pages throttle timers up to 60s — commit instantly there
  if (document.hidden) commit(); else setTimeout(commit, 900);
};

/* ═══════════ INPUT ═══════════ */
const pointers = new Map();
let panState = null, pinchState = null;
let hover = null;                      // {x,y}
let tooltipCell = -1, tooltipTimer = null;
let yoursFlashUntil = 0;
let brushMode = false, eraseMode = false, spaceHeld = false;
let stroke = null;                     // {last:{x,y}, warned, erase}

/* Tool switching. Brush and eraser share the stroke machinery — the only
   difference is which function each cell goes through — so `brushMode`
   stays true for both and `eraseMode` picks the verb. */
function setTool(t) {
  brushMode = t === 'brush' || t === 'erase';
  eraseMode = t === 'erase';
  $('toolPan').classList.toggle('sel', t === 'pan');
  $('toolBrush').classList.toggle('sel', t === 'brush');
  $('toolErase').classList.toggle('sel', eraseMode);
}
$('toolBrush').onclick = () => setTool('brush');
$('toolPan').onclick = () => setTool('pan');
$('toolErase').onclick = () => setTool('erase');

/* Brush stroke painting */
function lineCells(x0, y0, x1, y1, fn) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function brushPaint(x, y) {
  const i = idx(x, y);
  if (pixels.has(i)) return;                         // committed — untouchable
  if (sel.has(i)) {
    if (sel.get(i) === selColor) return;
    sel.set(i, selColor); pctx.fillStyle = selColor; pctx.fillRect(x, y, 1, 1);
  } else {
    if (capReached()) { if (stroke && !stroke.warned) { capHit(); stroke.warned = true; } return; }
    sel.set(i, selColor); pctx.fillStyle = selColor; pctx.fillRect(x, y, 1, 1);
  }
  updateSelUI();
}
function brushErase(x, y) { eraseAt(x, y); }
function strokeTo(cell) {
  if (!stroke || !cell) return;
  const fn = stroke.erase ? brushErase : brushPaint;
  if (stroke.last) lineCells(stroke.last.x, stroke.last.y, cell.x, cell.y, fn);
  else fn(cell.x, cell.y);
  stroke.last = cell;
}

cvs.addEventListener('pointerdown', e => {
  try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchState = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    panState = null; stroke = null;
    return;
  }
  if (pointers.size !== 1) return;
  const cell = cellAt(e.offsetX, e.offsetY);
  const wantsBrush = brushMode && !placing && !spaceHeld && e.button !== 1;
  if (wantsBrush && (e.button === 0 || e.button === 2)) {
    // hold-to-paint: start painting right under the mouse
    if (e.button === 0 && cell && pixels.has(idx(cell.x, cell.y))) { showTooltip(cell, e, true); }
    stroke = { last: null, warned: false, erase: eraseMode || e.button === 2 };
    if (cell) strokeTo(cell);
    hideTooltipSoon();
    return;
  }
  panState = { sx: e.offsetX, sy: e.offsetY, ox: view.ox, oy: view.oy, moved: false, btn: e.button };
});
cvs.addEventListener('pointermove', e => {
  const pt = pointers.get(e.pointerId);
  if (pt) { pt.x = e.offsetX; pt.y = e.offsetY; }
  if (pinchState && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinchState.d > 0) zoomAt(mx, my, d / pinchState.d);
    view.ox += mx - pinchState.mx; view.oy += my - pinchState.my; clampView();
    pinchState = { d, mx, my };
    hideTooltip();
    return;
  }
  hover = cellAt(e.offsetX, e.offsetY);
  coordsEl.textContent = hover ? `${hover.x}, ${hover.y}` : '—';
  cvs.classList.toggle('linked', !placing && !brushMode && !!hover && !!brandOf(pixels.get(idx(hover.x, hover.y))));
  if (stroke) { strokeTo(hover); return; }
  if (panState && pointers.has(e.pointerId)) {
    const dx = e.offsetX - panState.sx, dy = e.offsetY - panState.sy;
    if (!panState.moved && Math.hypot(dx, dy) > 4) { panState.moved = true; cvs.classList.add('panning'); hideTooltip(); }
    if (panState.moved) {
      view.ox = panState.ox + dx; view.oy = panState.oy + dy;
      userMovedView = true; clampView();
    }
  }
  if (placing) updateGhost(hover);
  else if (!panState || !panState.moved) maybeTooltip(e);
});
function endPointer(e) {
  try { if (pointers.has(e.pointerId)) cvs.releasePointerCapture(e.pointerId); } catch (err) {}
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchState = null;
  if (stroke && e.type === 'pointerup') stroke = null;
  else if (stroke) stroke = null;
  if (panState && !panState.moved && e.type === 'pointerup') {
    const cell = cellAt(e.offsetX, e.offsetY);
    if (cell) {
      if (placing) { updateGhost(cell); tryPlace(); }
      else if (panState.btn === 2) eraseAt(cell.x, cell.y);
      else if (panState.btn === 0) tapCell(cell, e);
    }
  }
  if (pointers.size === 0) { panState = null; cvs.classList.remove('panning'); }
}
cvs.addEventListener('pointerup', endPointer);
cvs.addEventListener('pointercancel', endPointer);
cvs.addEventListener('pointerleave', () => { hover = null; coordsEl.textContent = '—'; hideTooltip(); if (placing) ghostPos = null; });
cvs.addEventListener('contextmenu', e => e.preventDefault());
function hideTooltipSoon() { clearTimeout(tooltipTimer); tooltipTimer = setTimeout(hideTooltip, 1400); }

wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cvs.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  if (e.ctrlKey || e.metaKey) {
    // trackpad pinch (browsers report it as ctrl+wheel) — zoom at cursor
    zoomAt(cx, cy, Math.pow(1.0035, -e.deltaY));
  } else if (e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 100 && e.deltaX === 0)) {
    // classic mouse wheel (line mode, or big single-axis pixel notches) — zoom
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(cx, cy, Math.pow(1.0018, -dy));
  } else {
    // trackpad two-finger scroll — pan horizontally & vertically
    view.ox -= e.deltaX; view.oy -= e.deltaY;
    userMovedView = true; clampView();
  }
  hideTooltip();
}, { passive: false });

function tapCell(cell, e) {
  const i = idx(cell.x, cell.y);
  const p = pixels.get(i);
  if (p) {
    const b = brandOf(p);
    if (b) {                              // sponsor CTA — open their link
      window.open(b.url, '_blank', 'noopener,noreferrer');
      toast(`${ic('link')} Opening <b>${p.o}</b> — ${b.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`);
      return;
    }
    showTooltip(cell, e, true);
    return;
  }
  togglePreview(cell.x, cell.y);
}

/* Tooltip */
function maybeTooltip(e) {
  if (!hover) return hideTooltip();
  const i = idx(hover.x, hover.y);
  if (!pixels.has(i) && !reserved.has(i)) return hideTooltip();
  if (i !== tooltipCell) showTooltip(hover, e, false);
  else positionTooltip(e);
}
function showTooltip(cell, e, pinned) {
  const i = idx(cell.x, cell.y);
  const p = pixels.get(i) || reserved.get(i); if (!p) return;
  const booked = !pixels.has(i);
  tooltipCell = i;
  const mine = p.o === myHandle && p.t === 'u';
  const icon = ic(booked ? 'lock' : p.t === 'c' ? 'brand' : mine ? 'star' : 'person');
  const who = mine ? '<span class="tt-you">YOU</span>' : p.o;
  const b = booked ? null : brandOf(p);
  const cta = b ? `<span class="tt-cta">${b.cta} ${ic('arrow-right')}</span>` : '';
  const when = booked
    ? `goes live ${shortDate(cycleEndsAt())}`
    : `clears ${shortDate(cycleEndsAt())}`;
  tooltipEl.innerHTML = `<b>${icon} ${who}</b><span class="tt-exp">(${cell.x}, ${cell.y}) · ${when}</span>${cta}`;
  tooltipEl.hidden = false;
  positionTooltip(e);
  if (pinned) { clearTimeout(tooltipTimer); tooltipTimer = setTimeout(hideTooltip, 2200); }
}
function positionTooltip(e) {
  const r = wrap.getBoundingClientRect();
  let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
  x = Math.min(x, r.width - tooltipEl.offsetWidth - 10);
  y = Math.min(y, r.height - tooltipEl.offsetHeight - 10);
  tooltipEl.style.left = x + 'px'; tooltipEl.style.top = y + 'px';
}
function hideTooltip() { tooltipEl.hidden = true; tooltipCell = -1; }

/* Zoom buttons + keys */
$('zoomIn').onclick = () => zoomAt(cw / 2, ch / 2, 1.6);
$('zoomOut').onclick = () => zoomAt(cw / 2, ch / 2, 1 / 1.6);
$('zoomFit').onclick = () => fit();
window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'Escape') {
    if (placing) return cancelPlacing();
    document.querySelectorAll('.overlay:not([hidden])').forEach(o => closeModal(o.id));
    return;
  }
  if (e.key === '+' || e.key === '=') zoomAt(cw / 2, ch / 2, 1.6);
  else if (e.key === '-') zoomAt(cw / 2, ch / 2, 1 / 1.6);
  else if (e.key === '0') fit();
  else if (e.key === 'b' || e.key === 'B') setTool('brush');
  else if (e.key === 'v' || e.key === 'V') setTool('pan');
  else if (e.key === 'e' || e.key === 'E') setTool('erase');
  else if (e.key === ' ') { spaceHeld = true; e.preventDefault(); }
  else if (e.key.startsWith('Arrow')) {
    const d = 100;
    if (e.key === 'ArrowLeft') view.ox += d; if (e.key === 'ArrowRight') view.ox -= d;
    if (e.key === 'ArrowUp') view.oy += d; if (e.key === 'ArrowDown') view.oy -= d;
    userMovedView = true; clampView();
  }
});
window.addEventListener('keyup', e => { if (e.key === ' ') spaceHeld = false; });

/* Minimap */
let mmDrag = false;
function mmJump(e) {
  const r = mm.getBoundingClientRect();
  const wx = (e.clientX - r.left) / r.width * W, wy = (e.clientY - r.top) / r.height * H;
  view.ox = cw / 2 - wx * view.s; view.oy = ch / 2 - wy * view.s;
  userMovedView = true; clampView();
}
mm.addEventListener('pointerdown', e => { mmDrag = true; mm.setPointerCapture(e.pointerId); mmJump(e); });
mm.addEventListener('pointermove', e => { if (mmDrag) mmJump(e); });
mm.addEventListener('pointerup', () => mmDrag = false);

/* Yours highlight */
$('yoursStat').onclick = () => {
  if (!yours.size) return toast('You don’t own any pixels yet — claim some!', { cls: 'warn' });
  yoursFlashUntil = performance.now() + 2200;
};

/* ═══════════ RENDER LOOP ═══════════ */
function loop(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const { s, ox, oy } = view;
  const bw = W * s, bh = H * s;

  // board shadow + white base
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(ox + 8, oy + 8, bw, bh);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(ox, oy, bw, bh);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(board, ox, oy, bw, bh);

  // prepaid queue — faint, so it reads as "coming after the reset", not as taken
  if (reserved.size) {
    ctx.globalAlpha = 0.26;
    ctx.drawImage(nextCvs, ox, oy, bw, bh);
    ctx.globalAlpha = 1;
  }

  // ours, sent, waiting on a moderator. Slower and shallower than the
  // preview pulse below, so "I have not sent this yet" and "I have sent
  // this and it is being looked at" never read as the same thing.
  if (pending.size) {
    ctx.globalAlpha = 0.42 + 0.24 * Math.sin(t / 520);
    ctx.drawImage(pendCvs, ox, oy, bw, bh);
    ctx.globalAlpha = 1;
  }

  // visible world range
  const x0 = Math.max(0, Math.floor(-ox / s)), x1 = Math.min(W, Math.ceil((cw - ox) / s));
  const y0 = Math.max(0, Math.floor(-oy / s)), y1 = Math.min(H, Math.ceil((ch - oy) / s));

  // major grid (every 50 cells)
  if (bw > 500) {
    ctx.strokeStyle = 'rgba(25,25,60,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let gx = Math.ceil(x0 / 50) * 50; gx <= x1; gx += 50) { const px = Math.round(ox + gx * s) + 0.5; ctx.moveTo(px, oy + y0 * s); ctx.lineTo(px, oy + y1 * s); }
    for (let gy = Math.ceil(y0 / 50) * 50; gy <= y1; gy += 50) { const py = Math.round(oy + gy * s) + 0.5; ctx.moveTo(ox + x0 * s, py); ctx.lineTo(ox + x1 * s, py); }
    ctx.stroke();
  }
  // fine grid when zoomed
  if (s >= 7) {
    const a = Math.min(0.14, (s - 7) * 0.02 + 0.05);
    ctx.strokeStyle = `rgba(25,25,60,${a})`; ctx.lineWidth = 1; ctx.beginPath();
    for (let gx = x0; gx <= x1; gx++) { const px = Math.round(ox + gx * s) + 0.5; ctx.moveTo(px, oy + y0 * s); ctx.lineTo(px, oy + y1 * s); }
    for (let gy = y0; gy <= y1; gy++) { const py = Math.round(oy + gy * s) + 0.5; ctx.moveTo(ox + x0 * s, py); ctx.lineTo(ox + x1 * s, py); }
    ctx.stroke();
  }

  // preview pixels (pulse)
  if (sel.size) {
    ctx.globalAlpha = 0.72 + 0.28 * Math.sin(t / 240);
    ctx.drawImage(prevCvs, ox, oy, bw, bh);
    ctx.globalAlpha = 1;
    if (s >= 8) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
      for (const i of sel.keys()) {
        const x = i % W, y = (i / W) | 0;
        if (x < x0 - 1 || x > x1 || y < y0 - 1 || y > y1) continue;
        ctx.strokeRect(ox + x * s + 1.5, oy + y * s + 1.5, s - 3, s - 3);
      }
    }
  }

  // "yours" flash
  if (yoursFlashUntil > t && yours.size) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 110);
    ctx.strokeStyle = `rgba(216,27,96,${0.35 + 0.6 * pulse})`;
    ctx.lineWidth = Math.max(1.5, s * 0.18);
    let n = 0;
    for (const i of yours) {
      if (++n > 6000) break;
      const x = i % W, y = (i / W) | 0;
      ctx.strokeRect(ox + x * s - 1, oy + y * s - 1, s + 2, s + 2);
    }
  }

  // placement ghost
  if (placing && ghostPos) {
    const { x: gx, y: gy } = ghostPos, gw = placing.w * s, gh = placing.h * s;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(placing.ghost, ox + gx * s, oy + gy * s, gw, gh);
    ctx.globalAlpha = 1;
    if (!ghostValid) { ctx.fillStyle = 'rgba(230,57,70,0.35)'; ctx.fillRect(ox + gx * s, oy + gy * s, gw, gh); }
    ctx.strokeStyle = ghostValid ? '#D81B60' : '#E23B2E';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + gx * s - 1, oy + gy * s - 1, gw + 2, gh + 2);
  }

  // hover cell
  if (hover && !placing && (!panState || !panState.moved)) {
    ctx.strokeStyle = 'rgba(216,27,96,0.95)';
    ctx.lineWidth = Math.max(1.5, Math.min(3, s * 0.15));
    ctx.strokeRect(ox + hover.x * s - 1, oy + hover.y * s - 1, s + 2, s + 2);
  }

  // board frame
  ctx.strokeStyle = 'rgba(70,70,110,0.9)'; ctx.lineWidth = 2;
  ctx.strokeRect(ox - 1, oy - 1, bw + 2, bh + 2);

  // minimap
  if (thumbDirty) {
    thctx.fillStyle = '#fff'; thctx.fillRect(0, 0, 148, 148);
    thctx.imageSmoothingEnabled = true;
    thctx.drawImage(board, 0, 0, 148, 148);
    if (reserved.size) {
      thctx.globalAlpha = 0.26;
      thctx.drawImage(nextCvs, 0, 0, 148, 148);
      thctx.globalAlpha = 1;
    }
    thumbDirty = false;
  }
  mmctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mmctx.drawImage(thumb, 0, 0);
  const vx = (-ox / s) / W * 148, vy = (-oy / s) / H * 148;
  const vw = (cw / s) / W * 148, vh = (ch / s) / H * 148;
  mmctx.strokeStyle = '#D81B60'; mmctx.lineWidth = 2;
  mmctx.strokeRect(Math.max(1, vx), Math.max(1, vy), Math.min(146, vw), Math.min(146, vh));

  requestAnimationFrame(loop);
}

/* The sample logo for the brand pre-order flow. The wall's own starting
   artwork used to be composed here with canvas and uploaded on first boot;
   it lives in seed.bin now (tools/make-brand.js), which is why ~150 lines of
   badge drawing went with it — all of it existed to fake sponsor logos. */
const logoImg = new Image(); logoImg.src = 'assets/logo-icon.png';

/* ═══════════ INIT ═══════════ */
(async function init() {
  try { helpSeen = localStorage.getItem(LS_KEY) === '1'; } catch (e) { /* private mode */ }
  buildPalette();
  resizeCanvas();
  new ResizeObserver(resizeCanvas).observe(wrap);
  requestAnimationFrame(loop);

  try {
    await loadWall();
    // an empty wall needs nothing from us any more: a virgin database adopts
    // seed.bin on its way up, so by the time this resolves the artwork is
    // already there (or the wall is genuinely empty, which is also an answer)
    openStream();
  } catch (e) {
    serverDown(e);
  }

  fit();
  updateAll();
  renderMe();
  loadAlerts();
  // 1s so the refill clock actually counts down instead of jumping
  let ticks = 0;
  setInterval(() => {
    if (!api.on) return;
    if (checkRefill(false)) return;
    // re-check now and then: another tab or device on this connection may have
    // spent pixels we never saw
    if (++ticks % 30 === 0) syncAllowance();
    updateClock(); updateSelUI();
  }, 1000);
  if (!helpSeen) openModal('modalHelp');
})();

/* ═══════════ THE GLASS SHELL ═══════════
   Everything below is the mobile-first chrome: the five-door nav, the
   Me / Alerts / More sheets, the painter account door, and the two
   tongues the page speaks. It lives after init() on purpose — every
   function here is called at event time or after the first await, by
   which point the whole script has long been evaluated. */

/* ── the two tongues ──────────────────────────────────────────── */

const L = {
  en: {
    'off.capped': 'TOO MANY VISITORS FROM YOUR CONNECTION',
    'off.cappedBody': 'This connection has minted its five new identities for today. If you have painted here before, allow cookies and reload — your pixels are still yours.',
    'al.error': 'Could not load the news — close and open the bell again in a moment.',
    'toast.refilled': 'Your <b>{n} free pixels</b> are back — keep painting.',
    'toast.capAll': "That's all <b>{n} pixels</b> you have. Buy PAINT for more.",
    'toast.capWait': 'Your <b>{n} free pixels</b> are used up — back in <b>{t}</b>. Buy PAINT to skip the wait.',
    'act.buyPaint': 'BUY PAINT', 'act.myPixels': 'MY PIXELS',
    'cycle.next': 'NEXT RESET {d}',
    'free.waiting': 'Free pixels used up — <b class="accent">{t}</b> until your next {n}.',
    'free.left': '<b class="accent">{left}</b> free pixels left — a fresh {n} lands 30 min after you run out.',
    'dock.tap': 'TAP TO PAINT',
    'dock.claimFree': 'SEND {n} · FREE',
    'dock.claimPaint': 'SEND {n} PX · {paid} PAINT',
    'dock.claimMix': 'SEND {n} PX · {free} FREE + {paid} PAINT',
    'dock.clear': 'CLEAR', 'dock.custom': 'Pick any color',
    'common.paint': 'PAINT', 'common.paintLower': 'paint',
    'common.optional': 'OPTIONAL', 'common.choosefile': 'CHOOSE FILE',
    'common.nofile': 'No file chosen', 'common.egppx': 'EGP/PX',
    'co.title': 'CLAIM YOUR PIXELS', 'co.selected': 'PIXELS SELECTED',
    'co.free': 'FREE PIXELS USED', 'co.paint': 'PAINT APPLIED', 'co.topay': 'TO PAY',
    'co.freeWord': 'FREE', 'co.cta': 'CLAIM', 'co.busy': 'PROCESSING…',
    'co.finePaint': 'The paint is already paid for — nothing is charged now.',
    'co.fineFree': 'Free pixels cost nothing.',
    'co.fineTail': 'Every pixel is checked by a person before it goes on the wall. Once it does, it stays until the reset on {d}.',
    'co.send': 'SEND FOR REVIEW', 'co.sendPaint': 'SEND FOR REVIEW · {paid} PAINT',
    'co.sent': '{n} PIXELS SENT FOR REVIEW',
    'co.sentSub': 'A person checks every pixel before it goes up — usually minutes. Yours shimmer on the wall until then, and MY PIXELS tracks them.',
    'toast.occupied': '{n} pixels were claimed by someone else first — dropped from your basket.',
    'toast.short': "{n} pixels left in your basket — you're out of free pixels.",
    'toast.shortWait': 'Back in <b>{t}</b>.',
    'toast.wrong': 'Something went wrong — please try again.',
    'toast.unreachable': 'Could not reach the server — try again in a moment.',
    'toast.shopDown': 'The paint shop is unreachable — try again.',
    'ps.popular': 'POPULAR', 'ps.save': 'SAVE {pct}%',
    'hs.sub.pending': 'WAITING', 'hs.sub.approved': 'ON THE WALL',
    'hs.sub.rejected': 'TURNED DOWN', 'hs.sub.expired': 'EXPIRED',
    'hs.pack.pending': 'CHECKING', 'hs.pack.approved': 'PAINT ADDED',
    'hs.pack.rejected': 'NOT RECEIVED', 'hs.pack.expired': 'EXPIRED',
    'hs.type.free': 'FREE', 'hs.type.paint': 'PAINT', 'hs.type.brand': 'BRAND', 'hs.type.pack': 'PAINT PACK',
    'hs.pay.awaiting_transfer': 'awaiting your transfer', 'hs.pay.submitted': 'checking your transfer',
    'hs.pay.verified': 'payment confirmed', 'hs.pay.rejected': 'payment not received',
    'hs.pay.refund_due': 'refund on the way', 'hs.pay.refunded': 'refunded', 'hs.pay.expired': 'order expired',
    'hs.nextCycle': 'next cycle',
    'hs.empty': 'Nothing sent yet. Pick a colour, tap some pixels, and they will show up here.',
    'toast.subRejected': 'One of your batches was turned down — open <b>MY PIXELS</b> for the reason.',
    'toast.subExpired': 'A batch expired before it was reviewed — see <b>MY PIXELS</b>.',
    'toast.subApproved': 'Your pixels are on the wall.',
    'toast.payVerified': 'Payment confirmed — your paint is in.',
    'toast.payRejected': 'We could not find that transfer. Open <b>MY PIXELS</b> and try the reference again.',
    'toast.payExpired': 'An order expired before the transfer arrived.',
    'toast.payRefunded': 'Your refund has been sent.',
    'brand.chip.pending': 'UNDER REVIEW', 'brand.chip.approved': 'APPROVED', 'brand.chip.rejected': 'NOT APPROVED',
    'brand.note.pending': 'Your application is with the team. We read every one by hand — usually the same day. You will get an email the moment it is approved.',
    'brand.note.approved': "You are cleared to book logo space on next month's wall.",
    'brand.note.rejected': 'We could not verify this business from the details given. Reply to the email we sent if you think that is wrong.',
    'brand.titleBook': "Pre-order a logo spot on next month's wall",
    'brand.titlePending': 'Your brand application is still being reviewed',
    'brand.titleApply': 'Brands book logo space — apply once, then pre-order any month',
    'au.titlePainter': 'YOUR ACCOUNT', 'au.titleBrand': 'BRAND ACCOUNT',
    'au.subStatus': 'Where your brand application stands.',
    'au.subPainter': 'Keep your pixels, paint and history on any device. Painting stays free either way.',
    'au.subBrand': 'Logo spots are for real businesses, so a person reads every application. It takes two minutes and you only do it once.',
    'au.busy': 'SENDING…', 'au.checking': 'CHECKING…', 'au.badCreds': 'Wrong email or password.',
    'au.applyCta': 'APPLY FOR A BRAND ACCOUNT', 'au.loginCta': 'LOG IN', 'au.createCta': 'CREATE MY ACCOUNT',
    'au.apply': 'APPLY', 'au.create': 'CREATE', 'au.login': 'LOG IN',
    'au.registerNote': 'Your pixels, paint and history stay exactly as they are — this just gives them an email and a password so you can sign in anywhere.',
    'au.email': 'EMAIL', 'au.pass': 'PASSWORD', 'au.passPh': '10 characters or more',
    'au.bizname': 'BUSINESS NAME', 'au.category': 'CATEGORY', 'au.contact': 'CONTACT NAME',
    'au.phone': 'PHONE', 'au.site': 'WEBSITE',
    'au.siteHint': 'A website <b>or</b> a social account is required — that is how we check you are real.',
    'au.social': 'SOCIAL ACCOUNTS', 'au.socialHint': 'One per line.',
    'au.instapay': 'INSTAPAY HANDLE', 'au.instapayHint': 'Where a refund goes if a booking is turned down.',
    'au.reg': 'COMMERCIAL REG / TAX ID', 'au.desc': 'WHAT THE BUSINESS DOES',
    'au.descPh': 'What you sell, who you sell it to, how long you have been going, where you are based.',
    'au.applyFine': 'We use this to check the business is real and to send booking receipts. Nothing here goes on the wall.',
    'au.loginFine': 'Painting as a guest needs no account at all.',
    'au.book': 'START A PRE-ORDER',
    'toast.applied': '<b>Application sent.</b> We will email you as soon as it is reviewed.',
    'toast.welcomeBack': 'Welcome back, <b>{name}</b> — your pixels are right where you left them.',
    'toast.loggedOut': 'Logged out — you are painting as a guest again.',
    'toast.registered': '<b>Account created.</b> Your pixels now follow you anywhere you sign in.',
    'nav.wall': 'WALL', 'nav.alerts': 'ALERTS', 'nav.me': 'ME', 'nav.more': 'MORE', 'nav.paint': 'Paint',
    'chip.guest': 'GUEST', 'chip.painter': 'SIGNED IN', 'chip.brand': 'BRAND',
    'me.title': 'ME', 'me.history': 'MY PIXELS', 'me.yours': 'ON THE WALL',
    'me.yoursTitle': 'Highlight your pixels on the wall',
    'me.paint': 'PAINT', 'me.buy': 'BUY',
    'me.guestNote': 'You are painting as a guest. Make a free account to keep your pixels, paint and history on any device.',
    'me.create': 'CREATE ACCOUNT', 'me.login': 'LOG IN', 'me.signedin': 'Signed in as',
    'me.logout': 'LOG OUT', 'me.brandNote': 'This is a brand account.', 'me.brandDoor': 'BRAND ACCOUNT',
    'mo.title': 'MORE', 'mo.brand': 'BRAND PRE-ORDER', 'fab.brand': 'BRAND', 'mo.brandSub': "Your logo on next month's wall",
    'mo.shop': 'PAINT SHOP', 'mo.how': 'HOW IT WORKS', 'mo.lang': 'اللغة · LANGUAGE',
    'mo.taken': 'PIXELS TAKEN', 'mo.next': 'BOOKED NEXT CYCLE',
    'mo.about': '1,000,000 pixels, wiped clean on the 1st of every month.',
    'al.title': 'ALERTS',
    'al.sub': 'Decisions on your pixels, your payments and your application — newest first.',
    'al.empty': 'Nothing yet. Paint something and the news lands here.',
    'al.submission.approved': '{n} pixels are on the wall',
    'al.submission.rejected': 'A batch of {n} was turned down',
    'al.submission.expired': 'A batch of {n} expired',
    'al.payment.verified': 'Payment confirmed', 'al.payment.rejected': 'Payment not received',
    'al.payment.refund_due': 'Refund on the way', 'al.payment.refunded': 'Refund sent',
    'al.payment.expired': 'Order expired',
    'al.brand.approved': 'Your brand is approved', 'al.brand.rejected': 'Application not approved',
    'time.now': 'now', 'time.m': '{n}m', 'time.h': '{n}h', 'time.d': '{n}d',
    'help.title': 'THE PIXEL WALL', 'help.sub': '1,000,000 pixels. One wall. Wiped clean every month.',
    'help.s1': 'PICK & PAINT',
    'help.s1p': 'Choose a colour and tap up to <b>20 empty pixels</b> to preview your art on the wall.',
    'help.s2': 'SEND THEM FOR REVIEW',
    'help.s2p': 'Your 20 pixels cost <b>nothing</b>. A person checks every batch before it goes up — usually minutes. Yours shimmer until then.',
    'help.s3': 'WAIT 30 MINUTES',
    'help.s3p': 'Used all 20? A fresh <b>20 free pixels</b> land <b>30 minutes</b> later. Come back and keep going.',
    'help.s4': 'THE 1st WIPES IT',
    'help.s4p': 'On the <b>1st of every month</b> the whole wall resets to white and everyone starts over.',
    'help.n1': 'Switch to <b>BRUSH</b> to paint continuously while holding down.',
    'help.n2': 'No patience? Buy <b>PAINT</b> at <span class="px-rate">—</span> EGP/PX — it paints past the free 20 right now.',
    'help.n3': 'Brands <b>pre-order logo space</b> at <span class="co-rate">—</span> EGP/PX for the <b>next</b> cycle.',
    'help.cta': 'START PAINTING',
    'py.title': 'PAY WITH INSTAPAY', 'py.send': 'SEND', 'py.to': 'Send it to',
    'py.code': 'Put this in the transfer note — it is how we match your payment:',
    'py.copy': 'COPY', 'py.back': 'Come back here and tell us the reference from your receipt.',
    'py.open': 'OPEN INSTAPAY', 'py.scan': 'or scan',
    'py.proof': 'Sent it? Tell us the reference and a person will confirm it, usually within the hour.',
    'py.ref': 'TRANSACTION REFERENCE', 'py.refPh': 'from your InstaPay receipt',
    'py.from': 'THE HANDLE YOU PAID FROM', 'py.fromHint': 'If anything goes wrong, this is where the refund goes.',
    'py.shot': 'SCREENSHOT', 'py.shotHint': 'Speeds it up. We strip location data before storing it.',
    'py.sent': "I'VE SENT IT", 'py.team': 'WITH THE TEAM', 'py.gohistory': 'OPEN MY PIXELS',
    'hs.title': 'MY PIXELS',
    'hs.sub': 'Every batch you have sent, newest first. A person checks each one before it goes on the wall — usually within minutes.',
    'hs.more': 'LOAD OLDER',
    'ps.title': 'PAINT SHOP',
    'ps.sub': 'Paint = prepaid pixels at <b><span class="px-rate">—</span> EGP/PX</b>. It takes you straight past the 20 free ones with no 30-minute wait.',
    'ps.fine': 'Paid by InstaPay and confirmed by a person — usually within the hour. Paint never expires. If a batch is turned down, the paint comes straight back.',
    'zoom.in': 'Zoom in (+)', 'zoom.out': 'Zoom out (−)', 'zoom.fit': 'Fit whole wall (0)',
    'tool.pan': 'Move — drag to pan, tap to place one pixel (V)',
    'tool.brush': 'Brush — hold and drag to paint (B)',
    'tool.erase': 'Eraser — hold and drag to rub pixels out (E)',
    'place.hint': "PICK YOUR SPOT ON NEXT MONTH'S WALL · <span class=\"ok\">GREEN = FREE</span> · <span class=\"bad\">RED = BOOKED</span>",
    'place.find': 'FIND FREE SPOT',
    'cp.title': 'BRAND PRE-ORDER',
    'cp.sub': 'Book a spot for your logo at <b><span class="co-rate">—</span> EGP/PX</b>. Pre-orders are prepaid for the <b>next cycle</b> — your logo goes up the moment the wall resets and owns that spot for the whole month.',
    'cp.approved': 'APPROVED BRAND', 'cp.name': 'COMPANY NAME', 'cp.size': 'SIZE (PIXELS)',
    'cp.budget': 'FIT TO BUDGET',
    'cp.budgetHint': "Drag to set what you want to spend — only the output resolution changes, always at the logo's own ratio.",
    'cp.logo': 'LOGO IMAGE', 'cp.sample': 'SAMPLE', 'cp.png': 'PNG preferred.',
    'cp.pngHint': 'A transparent PNG gives the sharpest result.',
    'cp.cta': 'CTA LINK', 'cp.ctaHint': 'Anyone who taps your logo on the wall opens this link.',
    'cp.ctalabel': 'CTA LABEL', 'cp.source': 'SOURCE', 'cp.drag': 'drag to crop',
    'cp.autocrop': 'AUTO CROP', 'cp.reset': 'RESET', 'cp.ratio': 'RATIO',
    'cp.removebg': 'REMOVE BACKGROUND', 'cp.exp': 'EXPERIMENTAL', 'cp.tolerance': 'TOLERANCE',
    'cp.tolHint': 'Removes the background colour around the edges and any white inside the logo — the wall is white, so white pixels would be invisible.',
    'cp.preview': 'PIXEL PREVIEW', 'cp.paintable': 'paintable pixels',
    'cp.empty': 'Choose a logo image to see how it will look on the wall.',
    'cp.pick': 'PICK YOUR SPOT',
    'cf.title': 'CONFIRM PRE-ORDER', 'cf.company': 'COMPANY', 'cf.pixels': 'PIXELS',
    'cf.golive': 'GOES LIVE', 'cf.skipped': 'SKIPPED (BOOKED)', 'cf.link': 'CTA LINK',
    'cf.hold': 'Your spot is held for 48 hours while the transfer comes through.',
    'cf.fine': 'Your logo is reviewed like every other pixel. If it is turned down, the payment is refunded to the InstaPay handle you paid from.',
    'cf.cta': 'BOOK & PAY'
  },

  ar: {
    'off.capped': 'زوّار كتير أوي من نفس الشبكة',
    'off.cappedBody': 'الشبكة دي خلّصت الخمس هويات الجديدة بتاعتها النهارده. لو شخبطت هنا قبل كده، اسمح بالكوكيز واعمل ريلود — بكسلاتك لسه بتاعتك.',
    'al.error': 'الأخبار مش راضية تحمّل — اقفل الجرس وافتحه تاني كمان شوية.',
    'toast.refilled': 'رجعولك <b>{n} بكسل ببلاش</b> — كمّل شخبطة.',
    'toast.capAll': 'خلّصت كل <b>{n} بكسل</b> عندك. اشتري بوية وكمّل.',
    'toast.capWait': 'خلّصت الـ<b>{n} بكسل</b> المجانية — هيرجعوا بعد <b>{t}</b>. اشتري بوية وما تستناش.',
    'act.buyPaint': 'اشتري بوية', 'act.myPixels': 'بكسلاتي',
    'cycle.next': 'المسح الجاي {d}',
    'free.waiting': 'خلّصت المجاني — فاضل <b class="accent">{t}</b> على الـ{n} الجداد.',
    'free.left': 'فاضلك <b class="accent">{left}</b> بكسل ببلاش — بيرجعوا {n} بعد ما تخلصهم بنص ساعة.',
    'dock.tap': 'دوس وشخبط',
    'dock.claimFree': 'ابعت {n} · ببلاش',
    'dock.claimPaint': 'ابعت {n} بكسل · {paid} بوية',
    'dock.claimMix': 'ابعت {n} بكسل · {free} ببلاش + {paid} بوية',
    'dock.clear': 'امسح', 'dock.custom': 'اختار أي لون',
    'common.paint': 'بوية', 'common.paintLower': 'بوية',
    'common.optional': 'اختياري', 'common.choosefile': 'اختار ملف',
    'common.nofile': 'مفيش ملف متختار', 'common.egppx': 'جنيه/بكسل',
    'co.title': 'ثبّت بكسلاتك', 'co.selected': 'البكسلات المتختارة',
    'co.free': 'من المجاني', 'co.paint': 'من البوية', 'co.topay': 'المطلوب',
    'co.freeWord': 'ببلاش', 'co.cta': 'ثبّت', 'co.busy': 'ثواني…',
    'co.finePaint': 'البوية مدفوعة من الأول — مفيش فلوس دلوقتي.',
    'co.fineFree': 'البكسلات المجانية ببلاش فعلاً.',
    'co.fineTail': 'كل بكسل بيعدّي على حد بيراجعه قبل ما يطلع الحيط. أول ما يطلع بيفضل لحد المسح يوم {d}.',
    'co.send': 'ابعت للمراجعة', 'co.sendPaint': 'ابعت للمراجعة · {paid} بوية',
    'co.sent': 'اتبعت {n} بكسل للمراجعة',
    'co.sentSub': 'حد بيبص على كل بكسل قبل ما يطلع — غالبًا دقايق. بتاعتك بتلمع على الحيط لحد ما تتراجع، وتلاقيها في «بكسلاتي».',
    'toast.occupied': 'حد سبقك على {n} بكسل — اتشالوا من سلتك.',
    'toast.short': 'فاضل {n} بكسل في سلتك — المجاني خلص.',
    'toast.shortWait': 'هيرجع بعد <b>{t}</b>.',
    'toast.wrong': 'في حاجة ضربت — جرّب تاني.',
    'toast.unreachable': 'السيرفر مش رادّ — جرّب كمان شوية.',
    'toast.shopDown': 'محل البوية مش رادّ — جرّب تاني.',
    'ps.popular': 'الأكثر طلبًا', 'ps.save': 'وفّر {pct}%',
    'hs.sub.pending': 'مستنية', 'hs.sub.approved': 'على الحيط',
    'hs.sub.rejected': 'اترفضت', 'hs.sub.expired': 'انتهت',
    'hs.pack.pending': 'بنراجعها', 'hs.pack.approved': 'البوية وصلت',
    'hs.pack.rejected': 'الفلوس ما وصلتش', 'hs.pack.expired': 'انتهت',
    'hs.type.free': 'مجاني', 'hs.type.paint': 'بوية', 'hs.type.brand': 'براند', 'hs.type.pack': 'باكيت بوية',
    'hs.pay.awaiting_transfer': 'مستنيين تحويلك', 'hs.pay.submitted': 'بنراجع تحويلك',
    'hs.pay.verified': 'الدفع اتأكد', 'hs.pay.rejected': 'الفلوس ما وصلتش',
    'hs.pay.refund_due': 'الاسترداد في الطريق', 'hs.pay.refunded': 'اتردّت', 'hs.pay.expired': 'الطلب انتهى',
    'hs.nextCycle': 'الشهر الجاي',
    'hs.empty': 'لسه مبعتش حاجة. اختار لون، دوس على بكسلات، وهتلاقيها هنا.',
    'toast.subRejected': 'دفعة من بكسلاتك اترفضت — افتح <b>بكسلاتي</b> تعرف السبب.',
    'toast.subExpired': 'دفعة انتهت قبل ما تتراجع — بص على <b>بكسلاتي</b>.',
    'toast.subApproved': 'بكسلاتك بقت على الحيط.',
    'toast.payVerified': 'الدفع اتأكد — البوية وصلت.',
    'toast.payRejected': 'ما لقيناش التحويل ده. افتح <b>بكسلاتي</b> وجرّب الرقم المرجعي تاني.',
    'toast.payExpired': 'طلب انتهى قبل ما التحويل يوصل.',
    'toast.payRefunded': 'فلوسك اتردّت.',
    'brand.chip.pending': 'تحت المراجعة', 'brand.chip.approved': 'اتوافق عليه', 'brand.chip.rejected': 'ما اتوافقش',
    'brand.note.pending': 'طلبك عند الفريق. بنقرا كل طلب بنفسنا — غالبًا نفس اليوم. هيوصلك إيميل أول ما يتوافق عليه.',
    'brand.note.approved': 'تمام — تقدر تحجز مكان اللوجو على حيط الشهر الجاي.',
    'brand.note.rejected': 'ما قدرناش نتأكد من البيزنس من البيانات دي. ردّ على الإيميل لو شايف إن في غلطة.',
    'brand.titleBook': 'احجز مكان لوجو على حيط الشهر الجاي',
    'brand.titlePending': 'طلب البراند لسه بيتراجع',
    'brand.titleApply': 'البراندات بتحجز مكان — قدّم مرة واحدة واحجز أي شهر',
    'au.titlePainter': 'حسابك', 'au.titleBrand': 'حساب براند',
    'au.subStatus': 'طلب البراند بتاعك وصل لفين.',
    'au.subPainter': 'خلّي بكسلاتك وبويتك وتاريخك معاك على أي موبايل. الشخبطة ببلاش في الحالتين.',
    'au.subBrand': 'أماكن اللوجو للبيزنس الحقيقي، فحد بيقرا كل طلب بنفسه. دقيقتين وبتعملها مرة واحدة بس.',
    'au.busy': 'ثواني…', 'au.checking': 'بنتأكد…', 'au.badCreds': 'الإيميل أو الباسورد غلط.',
    'au.applyCta': 'قدّم كبراند', 'au.loginCta': 'ادخل', 'au.createCta': 'اعمل حسابي',
    'au.apply': 'قدّم', 'au.create': 'حساب جديد', 'au.login': 'ادخل',
    'au.registerNote': 'بكسلاتك وبويتك وتاريخك بيفضلوا زي ما هما — بس بنديهم إيميل وباسورد عشان تدخل من أي حتة.',
    'au.email': 'الإيميل', 'au.pass': 'الباسورد', 'au.passPh': '١٠ حروف أو أكتر',
    'au.bizname': 'اسم البيزنس', 'au.category': 'المجال', 'au.contact': 'اسم المسؤول',
    'au.phone': 'التليفون', 'au.site': 'الموقع',
    'au.siteHint': 'لازم موقع <b>أو</b> حساب سوشيال — دي طريقتنا نتأكد إنك حقيقي.',
    'au.social': 'حسابات السوشيال', 'au.socialHint': 'واحد في كل سطر.',
    'au.instapay': 'حساب إنستاباي', 'au.instapayHint': 'لو حجز اترفض، الفلوس بترجع هنا.',
    'au.reg': 'سجل تجاري / رقم ضريبي', 'au.desc': 'البيزنس بيعمل إيه',
    'au.descPh': 'بتبيع إيه، لمين، بقالك قد إيه، وفين.',
    'au.applyFine': 'بنستخدم ده عشان نتأكد إن البيزنس حقيقي ونبعت إيصالات الحجز. مفيش حاجة منه بتطلع الحيط.',
    'au.loginFine': 'الشخبطة كضيف مش محتاجة حساب أصلاً.',
    'au.book': 'ابدأ حجز',
    'toast.applied': '<b>الطلب اتبعت.</b> هنبعتلك إيميل أول ما يتراجع.',
    'toast.welcomeBack': 'أهلاً بيك تاني يا <b>{name}</b> — بكسلاتك زي ما سيبتها.',
    'toast.loggedOut': 'خرجت — بترسم كضيف تاني.',
    'toast.registered': '<b>الحساب اتعمل.</b> بكسلاتك بقت بتمشي معاك في أي حتة تدخل منها.',
    'nav.wall': 'الحيط', 'nav.alerts': 'الأخبار', 'nav.me': 'أنا', 'nav.more': 'كمان', 'nav.paint': 'شخبط',
    'chip.guest': 'ضيف', 'chip.painter': 'داخل بحسابه', 'chip.brand': 'براند',
    'me.title': 'أنا', 'me.history': 'بكسلاتي', 'me.yours': 'على الحيط',
    'me.yoursTitle': 'نوّر بكسلاتك على الحيط',
    'me.paint': 'بوية', 'me.buy': 'اشتري',
    'me.guestNote': 'انت بترسم كضيف. اعمل حساب ببلاش عشان بكسلاتك وبويتك وتاريخك يفضلوا معاك على أي موبايل.',
    'me.create': 'اعمل حساب', 'me.login': 'ادخل', 'me.signedin': 'داخل باسم',
    'me.logout': 'اخرج', 'me.brandNote': 'ده حساب براند.', 'me.brandDoor': 'حساب البراند',
    'mo.title': 'كمان', 'mo.brand': 'حجز براند', 'fab.brand': 'براند', 'mo.brandSub': 'لوجو شركتك على حيط الشهر الجاي',
    'mo.shop': 'محل البوية', 'mo.how': 'بيشتغل إزاي؟', 'mo.lang': 'اللغة · LANGUAGE',
    'mo.taken': 'بكسلات متاخدة', 'mo.next': 'محجوز للشهر الجاي',
    'mo.about': 'مليون بكسل، بيتمسحوا أول كل شهر.',
    'al.title': 'الأخبار',
    'al.sub': 'قرارات بكسلاتك وفلوسك وطلبك — الأجدد الأول.',
    'al.empty': 'لسه مفيش حاجة. اشخبط حاجة والأخبار هتوصل هنا.',
    'al.submission.approved': '{n} بكسل طلعوا الحيط',
    'al.submission.rejected': 'دفعة {n} بكسل اترفضت',
    'al.submission.expired': 'دفعة {n} بكسل انتهت',
    'al.payment.verified': 'الدفع اتأكد', 'al.payment.rejected': 'الفلوس ما وصلتش',
    'al.payment.refund_due': 'الاسترداد في الطريق', 'al.payment.refunded': 'الفلوس اتردّت',
    'al.payment.expired': 'الطلب انتهى',
    'al.brand.approved': 'البراند اتوافق عليه', 'al.brand.rejected': 'الطلب ما اتوافقش',
    'time.now': 'دلوقتي', 'time.m': '{n} د', 'time.h': '{n} س', 'time.d': '{n} يوم',
    'help.title': 'حيط البكسلات', 'help.sub': 'مليون بكسل. حيط واحد. بيتمسح كل شهر.',
    'help.s1': 'اختار ولوّن',
    'help.s1p': 'اختار لون ودوس على لحد <b>٢٠ بكسل فاضيين</b> تشوف رسمتك على الحيط.',
    'help.s2': 'ابعتهم للمراجعة',
    'help.s2p': 'الـ٢٠ بكسل <b>ببلاش</b>. حد بيبص على كل دفعة قبل ما تطلع — غالبًا دقايق. بتاعتك بتلمع لحد ما تتراجع.',
    'help.s3': 'استنى نص ساعة',
    'help.s3p': 'خلّصت الـ٢٠؟ <b>٢٠ جداد ببلاش</b> بينزلوا بعد <b>٣٠ دقيقة</b>. ارجع وكمّل.',
    'help.s4': 'يوم ١ بيمسح كله',
    'help.s4p': 'في <b>أول كل شهر</b> الحيط كله بيرجع أبيض والكل بيبدأ من الأول.',
    'help.n1': 'حوّل على <b>الفرشة</b> تلوّن من غير ما تشيل صوابعك.',
    'help.n2': 'مش قادر تستنى؟ اشتري <b>بوية</b> بـ<span class="px-rate">—</span> جنيه للبكسل — بتعدّيك الـ٢٠ المجانية فورًا.',
    'help.n3': 'البراندات <b>بتحجز مكان اللوجو</b> بـ<span class="co-rate">—</span> جنيه للبكسل على حيط <b>الشهر الجاي</b>.',
    'help.cta': 'يلا نشخبط',
    'py.title': 'ادفع بإنستاباي', 'py.send': 'ابعت', 'py.to': 'ابعتها على',
    'py.code': 'حط الكود ده في ملاحظة التحويل — ده اللي بنلاقي بيه دفعتك:',
    'py.copy': 'انسخ', 'py.back': 'ارجع هنا وقولنا الرقم المرجعي من الإيصال.',
    'py.open': 'افتح إنستاباي', 'py.scan': 'أو امسح',
    'py.proof': 'بعتّها؟ قولنا الرقم المرجعي وحد هيأكدها، غالبًا خلال ساعة.',
    'py.ref': 'الرقم المرجعي', 'py.refPh': 'من إيصال إنستاباي',
    'py.from': 'الحساب اللي دفعت منه', 'py.fromHint': 'لو حصلت مشكلة، الفلوس بترجع هنا.',
    'py.shot': 'سكرين شوت', 'py.shotHint': 'بتسرّع الموضوع. بنشيل بيانات الموقع قبل الحفظ.',
    'py.sent': 'بعتّها', 'py.team': 'وصلت للفريق', 'py.gohistory': 'افتح بكسلاتي',
    'hs.title': 'بكسلاتي',
    'hs.sub': 'كل دفعة بعتّها، الأجدد الأول. حد بيبص على كل واحدة قبل ما تطلع الحيط — غالبًا دقايق.',
    'hs.more': 'حمّل الأقدم',
    'ps.title': 'محل البوية',
    'ps.sub': 'البوية = بكسلات مدفوعة مقدّمًا بـ<b><span class="px-rate">—</span> جنيه للواحدة</b>. بتعدّيك الـ٢٠ المجانية من غير انتظار.',
    'ps.fine': 'الدفع بإنستاباي وحد بيأكده — غالبًا خلال ساعة. البوية ما بتنتهيش. لو دفعة اترفضت، البوية بترجعلك فورًا.',
    'zoom.in': 'قرّب (+)', 'zoom.out': 'بعّد (−)', 'zoom.fit': 'الحيط كله (0)',
    'tool.pan': 'تحريك — اسحب تتنقل، دوس تحط بكسل (V)',
    'tool.brush': 'فرشة — دوس واسحب تلوّن (B)',
    'tool.erase': 'أستيكة — دوس واسحب تمسح (E)',
    'place.hint': 'اختار مكانك على حيط الشهر الجاي · <span class="ok">الأخضر = فاضي</span> · <span class="bad">الأحمر = محجوز</span>',
    'place.find': 'دوّر على مكان فاضي',
    'cp.title': 'حجز براند',
    'cp.sub': 'احجز مكان للوجو بـ<b><span class="co-rate">—</span> جنيه للبكسل</b>. الحجز مدفوع مقدّمًا <b>للشهر الجاي</b> — اللوجو بيطلع لحظة ما الحيط يتمسح والمكان بيبقى ملكك الشهر كله.',
    'cp.approved': 'براند موافق عليه', 'cp.name': 'اسم الشركة', 'cp.size': 'الحجم (بكسل)',
    'cp.budget': 'على قد ميزانيتك',
    'cp.budgetHint': 'اسحب وحدد هتدفع قد إيه — الدقة بس اللي بتتغير، وعلى نسبة اللوجو نفسها.',
    'cp.logo': 'صورة اللوجو', 'cp.sample': 'مثال', 'cp.png': 'الأفضل PNG.',
    'cp.pngHint': 'صورة PNG شفافة بتدي أنضف نتيجة.',
    'cp.cta': 'لينك الزيارة', 'cp.ctaHint': 'أي حد يدوس على اللوجو بيفتح اللينك ده.',
    'cp.ctalabel': 'كلمة الزرار', 'cp.source': 'الأصل', 'cp.drag': 'اسحب للقص',
    'cp.autocrop': 'قص تلقائي', 'cp.reset': 'رجّع', 'cp.ratio': 'النسبة',
    'cp.removebg': 'شيل الخلفية', 'cp.exp': 'تجريبي', 'cp.tolerance': 'الحساسية',
    'cp.tolHint': 'بيشيل لون الخلفية من الحواف وأي أبيض جوة اللوجو — الحيط أبيض، فالبكسل الأبيض مش هيبان.',
    'cp.preview': 'شكلها بالبكسل', 'cp.paintable': 'بكسل هيتلوّن',
    'cp.empty': 'اختار صورة اللوجو تشوف شكلها على الحيط.',
    'cp.pick': 'اختار مكانك',
    'cf.title': 'أكّد الحجز', 'cf.company': 'الشركة', 'cf.pixels': 'البكسلات',
    'cf.golive': 'بيطلع يوم', 'cf.skipped': 'اتشال (محجوز)', 'cf.link': 'اللينك',
    'cf.hold': 'مكانك محجوز ٤٨ ساعة لحد ما التحويل يوصل.',
    'cf.fine': 'اللوجو بيتراجع زي أي بكسل. لو اترفض، الفلوس بترجع لحساب إنستاباي اللي دفعت منه.',
    'cf.cta': 'احجز وادفع'
  }
};

let lang = 'en';
let lastPrices = null;

function t(key, vars, fallback) {
  let s = (L[lang] && L[lang][key]) ?? L.en[key] ?? fallback ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function sweepI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

function setLang(next) {
  lang = next === 'ar' ? 'ar' : 'en';
  try { localStorage.setItem('s37.lang', lang); } catch (e) { /* private mode */ }
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $('langToggleLabel').textContent = lang === 'ar' ? 'EN' : 'ع';
  $('langNowLabel').textContent = lang === 'ar' ? 'العربية' : 'EN';
  sweepI18n();
  /* everything the dictionaries feed at render time, re-fed */
  updateAll(); renderAuth(); renderMe(); renderAlerts();
  applyPrices();
  if (history.rows.length || history.open) renderHistory();
  const shot = $('pyShotName'), file = $('cpFileName');
  if (!shot.classList.contains('has')) shot.textContent = t('common.nofile');
  if (!file.classList.contains('has')) file.textContent = t('common.nofile');
}
$('langToggle').onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');
$('langToggleMore').onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');

/* ── the five doors ───────────────────────────────────────────── */

const NAV_SHEETS = { navAlerts: 'modalAlerts', navMe: 'modalMe', navMore: 'modalMore' };

function syncNavSel() {
  let open = null;
  for (const [nav, sheet] of Object.entries(NAV_SHEETS)) if (!$(sheet).hidden) open = nav;
  for (const id of ['navWall', 'navAlerts', 'navMe', 'navMore']) {
    $(id).classList.toggle('sel', open ? id === open : id === 'navWall');
  }
  $('navWall').toggleAttribute('aria-current', !open);
}
function closeNavSheets() {
  for (const sheet of Object.values(NAV_SHEETS)) closeModal(sheet);
  syncNavSel();
}

$('navWall').onclick = () => {
  document.querySelectorAll('.overlay:not([hidden])').forEach(ov => closeModal(ov.id));
  history.open = false;
  syncNavSel();
};
$('navAlerts').onclick = () => {
  if (!$('modalAlerts').hidden) return closeNavSheets();
  closeNavSheets();
  openModal('modalAlerts');
  loadAlerts(true);
  syncNavSel();
};
$('navMe').onclick = () => {
  if (!$('modalMe').hidden) return closeNavSheets();
  closeNavSheets();
  renderMe();
  openModal('modalMe');
  syncNavSel();
};
$('navMore').onclick = () => {
  if (!$('modalMore').hidden) return closeNavSheets();
  closeNavSheets();
  openModal('modalMore');
  syncNavSel();
};
/* backdrop taps, the X and ESC all hide the sheet without telling the nav —
   watching `hidden` keeps the lit door honest however the sheet went away */
for (const sheet of Object.values(NAV_SHEETS)) {
  new MutationObserver(syncNavSel)
    .observe($(sheet), { attributes: true, attributeFilter: ['hidden'] });
}

/* the raised brush: paint mode on/off — the dock follows */
$('navPaint').onclick = () => {
  const off = document.body.classList.toggle('no-paint');
  $('navPaint').setAttribute('aria-pressed', String(!off));
  if (!off) closeNavSheets();
};

/* ── me ───────────────────────────────────────────────────────── */

function renderMe() {
  const el = $('meHandle');
  if (!el) return;
  el.textContent = myHandle || me.handle || '—';
  const chip = $('meChip');
  const kind = isBrand() ? 'brand' : (me.registered ? 'painter' : 'guest');
  chip.textContent = t('chip.' + kind);
  chip.className = 'status-chip ' + (isBrand() ? (me.brandStatus || '') : (me.registered ? 'approved' : ''));
  $('meGuest').hidden = kind !== 'guest';
  $('meRegistered').hidden = kind !== 'painter';
  $('meBrand').hidden = kind !== 'brand';
  $('meEmail').textContent = me.email || '—';
}

$('btnOpenRegister').onclick = () => openAuth('register', 'painter');
$('btnOpenLogin').onclick = () => openAuth('login', 'painter');
$('btnLogoutMe').onclick = logout;
$('btnBrandDoor').onclick = () => openAuth(null, 'brand');
$('yoursStat').addEventListener('click', () => closeModal('modalMe'));
$('moreShop').onclick = () => { closeModal('modalMore'); openModal('modalPaint'); };
$('brandFab').onclick = () => $('btnCompany').click();

/* create-account submit — the guest keeps everything, gains a password */
$('paneRegister').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btnRegister');
  for (const id of ['errRgEmail', 'errRgPass', 'errRegister']) $(id).hidden = true;
  $('rgEmail').classList.remove('bad'); $('rgPass').classList.remove('bad');
  btn.disabled = true; btn.textContent = t('au.busy');
  try {
    const r = await apiPost('/api/auth/register',
      { email: $('rgEmail').value, password: $('rgPass').value });
    if (!r.ok) {
      const f = r.data.fields || {};
      if (f.email) { showErr('errRgEmail', f.email); $('rgEmail').classList.add('bad'); }
      if (f.password) { showErr('errRgPass', f.password); $('rgPass').classList.add('bad'); }
      if (r.data.message && !f.email && !f.password) showErr('errRegister', r.data.message);
      return;
    }
    $('rgPass').value = '';
    setMe(r.data);
    if (r.data.allowance) applyAllowance(r.data.allowance);
    closeModal('modalAuth'); closeModal('modalMe');
    toast(`${ic('check')} ${t('toast.registered')}`, { dur: 5200 });
  } catch (err) {
    showErr('errRegister', t('toast.unreachable'));
  } finally {
    btn.disabled = false; btn.textContent = t('au.createCta');
  }
});

/* ── the bell ─────────────────────────────────────────────────── */

const alerts = { rows: [], unseen: 0, seenAt: 0 };

function renderAlertBadge() {
  const b = $('navAlertBadge');
  b.hidden = alerts.unseen <= 0;
  b.textContent = alerts.unseen > 99 ? '99+' : String(alerts.unseen);
}
/* a live decision arrived over SSE — the door lights up before any refetch */
function bumpAlerts() {
  alerts.unseen++;
  renderAlertBadge();
}

const AL_ICON = {
  'submission.approved': ['check', 'good'], 'submission.rejected': ['cross', 'bad'],
  'submission.expired': ['timer', 'warn'],
  'payment.verified': ['check', 'good'], 'payment.rejected': ['cross', 'bad'],
  'payment.refund_due': ['refund', 'warn'], 'payment.refunded': ['refund', 'good'],
  'payment.expired': ['timer', 'warn'],
  'brand.approved': ['check', 'good'], 'brand.rejected': ['cross', 'bad']
};

function relTime(ts) {
  const s = Math.max(0, (serverNow() - ts) / 1000);
  if (s < 90) return t('time.now');
  if (s < 3600) return t('time.m', { n: Math.round(s / 60) });
  if (s < 86400) return t('time.h', { n: Math.round(s / 3600) });
  return t('time.d', { n: Math.round(s / 86400) });
}

function renderAlerts() {
  const list = $('alertList');
  if (!list) return;
  list.textContent = '';
  for (const row of alerts.rows) {
    const kind = `${row.src === 'submission' ? 'submission' : row.src}.${row.status}`;
    const [icon, mood] = AL_ICON[kind] || ['warn', 'warn'];
    const el = document.createElement('div');
    el.className = 'al-row' + (row.t > alerts.seenAt ? ' unseen' : '');

    const ico = document.createElement('span');
    ico.className = `al-icon ${mood}`;
    ico.innerHTML = ic(icon);
    el.appendChild(ico);

    const body = document.createElement('div');
    body.className = 'al-body';
    const title = document.createElement('b');
    title.textContent = t(`al.${kind}`, { n: fmt(row.n || 0) }, row.status);
    body.appendChild(title);
    const bits = [];
    if (row.src === 'payment') {
      if (row.detail) bits.push(row.detail);
      if (row.amount) bits.push(`${fmt(Math.round(row.amount / 100))} EGP`);
    } else if (row.detail) bits.push(row.detail);
    if (bits.length) {
      const p = document.createElement('p');
      p.textContent = bits.join(' · ');
      body.appendChild(p);
    }
    el.appendChild(body);

    const when = document.createElement('span');
    when.className = 'al-time';
    when.textContent = relTime(row.t);
    el.appendChild(when);
    list.appendChild(el);
  }
  const empty = $('alertEmpty');
  empty.hidden = alerts.rows.length > 0;
  if (!empty.hidden) empty.textContent = t('al.empty');
}

async function loadAlerts(markSeen) {
  try {
    const d = await apiJson('/api/me/notifications?limit=40');
    alerts.rows = d.rows; alerts.unseen = d.unseen; alerts.seenAt = d.seenAt;
    renderAlerts(); renderAlertBadge();
    if (markSeen && d.unseen > 0) {
      await apiPost('/api/me/notifications/seen');
      alerts.unseen = 0;
      renderAlertBadge();
    }
  } catch (e) {
    /* an empty sheet with no explanation is a void, not an empty state */
    const empty = $('alertEmpty');
    if (empty && alerts.rows.length === 0) {
      empty.hidden = false;
      empty.textContent = t('al.error');
    }
  }
}

/* ── boot the shell ───────────────────────────────────────────── */

(function initShell() {
  let saved = 'en';
  try { saved = localStorage.getItem('s37.lang') || 'en'; } catch (e) { /* private mode */ }
  if (saved === 'ar') setLang('ar');
  else { $('langToggleLabel').textContent = 'ع'; $('langNowLabel').textContent = 'EN'; }
  syncNavSel();
  renderMe();
})();
