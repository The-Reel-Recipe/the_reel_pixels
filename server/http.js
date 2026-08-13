/* ═══════════════════════════════════════════════════════════════
   http — the router, the static files, the SSE hub

   One handler for both ways this runs: `node server.js` locally and
   the Vercel function in api/[...path].js. Static serving only ever
   fires locally — on Vercel the CDN gets there first.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const identity = require('./identity.js');
const wall = require('./wall.js');
const submissions = require('./submissions.js');
const telegram = require('./telegram.js');

const ROOT = cfg.ROOT;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/* ── Replies ──────────────────────────────────────────────────── */

/* Only set when ALLOW_ORIGIN is configured — a statically hosted copy of the
   page (GitHub Pages, a CDN) pointing at this API needs it, nothing else does. */
function corsHeaders(extra) {
  const h = Object.assign({ 'cache-control': 'no-store' }, extra);
  if (cfg.ALLOW_ORIGIN) {
    h['access-control-allow-origin'] = cfg.ALLOW_ORIGIN;
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-allow-methods'] = 'GET,POST,OPTIONS';
    h.vary = 'Origin';
  }
  return h;
}
function send(res, code, type, body) {
  res.writeHead(code, corsHeaders({ 'content-type': type }));
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, TYPES['.json'], JSON.stringify(obj));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, 'text/plain', 'Bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel.replace(/\\/g, '/'));
  // no climbing out of the project, and nothing dot-prefixed (that covers
  // .git and any prototype-era .wall.bin / .allowance.json still lying about)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
  if (path.relative(ROOT, file).split(path.sep).some(p => p.startsWith('.'))) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  // DATA_DIR defaults to ./data, which is inside the root and not dot-prefixed
  // — without this the database, its WAL and the payment screenshots to come
  // would all be a plain GET away
  if (file === cfg.DATA_DIR || file.startsWith(cfg.DATA_DIR + path.sep)) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}

/* ── Live updates (SSE) ───────────────────────────────────────── */

const clients = new Set();
function emit(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
}
wall.setSink(emit);

setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } }
}, 25000).unref();

/* ── Routes ───────────────────────────────────────────────────── */

async function handler(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS' && cfg.ALLOW_ORIGIN) {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (!urlPath.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return serveStatic(req, res, urlPath);
  }

  const now = Date.now();
  wall.checkCycle(now);

  /* Before identity: Telegram is not a visitor and must not be handed a
     guest cookie, spend an IP's budget of them, or be turned away because
     the moderators' office connection has minted five today. */
  if (urlPath === '/api/tg/webhook') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
    if (!telegram.secretOk(req.headers['x-telegram-bot-api-secret-token'])) {
      return send(res, 403, 'text/plain', 'Forbidden');
    }
    let update;
    try { update = JSON.parse((await readBody(req, 64 << 10)).toString('utf8')); }
    catch (err) { return sendJson(res, 400, { error: 'bad update' }); }
    /* Answer immediately and work afterwards. Telegram retries anything it
       does not get a 200 for within seconds, and a redelivered callback is
       a second tap — harmless by §4.5, but pointless. */
    sendJson(res, 200, { ok: true });
    telegram.onUpdate(update).catch(err => console.warn('telegram update:', err.message));
    return;
  }

  /* Who is asking (§3). A caller without a valid cookie gets a fresh guest
     identity and the Set-Cookie that carries it — attached here rather than
     per route, so every reply on the minting request keeps it, envelope and
     event stream included. An IP that has spent its guest budget for the day
     gets no identity at all, and there is nothing personal to serve without
     one. */
  const ses = identity.resolve(req, now, { mint: !urlPath.startsWith('/api/auth/') });
  if (ses.cookie) res.setHeader('set-cookie', ses.cookie);
  if (ses.capped) return sendJson(res, 429, ses.capped);
  const row = ses.e;                      // null only on the auth routes
  if (row) identity.touch(row, now);

  try {
    // everything the page needs to draw itself, in one shot
    if (urlPath === '/api/wall' && req.method === 'GET') {
      const buf = wall.snapshotFor(row, now);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(buf);
    }

    if (urlPath === '/api/allowance' && req.method === 'GET') {
      return sendJson(res, 200, identity.allowanceOf(row, now));
    }

    if (urlPath === '/api/stream' && req.method === 'GET') {
      // serverless functions are killed at their max duration, so the client
      // treats a dropped stream as "refetch and reconnect" rather than an error
      res.writeHead(200, corsHeaders({
        'content-type': 'text/event-stream',
        connection: 'keep-alive', 'x-accel-buffering': 'no'
      }));
      res.write(`retry: 3000\n\n`);
      // tell the client where we are, so a routine reconnect only refetches
      // the wall when it actually missed something
      res.write(`data: ${JSON.stringify({ t: 'hello', rev: wall.wall.rev })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (urlPath === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, identity.me(row, now));
    }

    /* Everything this caller has ever sent for review, newest first — the
       one place a pending submission stops being a shimmer on the canvas
       and becomes something with a status and a reason. */
    if (urlPath === '/api/me/history' && req.method === 'GET') {
      const q = new URLSearchParams((req.url || '').split('?')[1] || '');
      return sendJson(res, 200, submissions.historyFor(row.id, {
        limit: q.get('limit'), offset: q.get('offset')
      }));
    }

    /* ── accounts ── */
    if (urlPath === '/api/auth/signup' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 << 10)).toString('utf8'));
      const r = identity.signup(ses.ip, body, now);
      if (r.error) return sendJson(res, r.status, { error: r.error, fields: r.fields, message: r.message });
      telegram.cardForBrand(r.e.id, now);               // a person reads every one (§3)
      res.setHeader('set-cookie', r.cookie);            // the application signs them in
      return sendJson(res, 200, identity.me(r.e, now));
    }

    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      const r = identity.login(body, now);
      if (r.error) return sendJson(res, r.status, { error: r.error, message: r.message });
      /* the guest identity keeps its own pixels and history — this is a
         different account, not a promotion of the old one */
      res.setHeader('set-cookie', r.cookie);
      return sendJson(res, 200, identity.me(r.e, now));
    }

    if (urlPath === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', identity.clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (urlPath === '/api/claim' && req.method === 'POST') {
      // checked before the body is read: the cap exists to make a flood cheap
      const capped = identity.takeClaim(ses.ip, row, now);
      if (capped) return sendJson(res, 429, capped);
      const { a } = wall.decodeEnvelope(await readBody(req, 1 << 20));
      const r = wall.claimPixels(row, a, now);
      /* Nothing is on the wall yet — this is where it gets queued for a
         moderator, or, with no bot configured, approves itself shortly. */
      submissions.afterCreate(r.sid);
      return sendJson(res, 200, r);
    }

    if (urlPath === '/api/book' && req.method === 'POST') {
      // approved brands only (§3) — the reason code is what the client renders
      const gate = identity.bookGate(row);
      if (gate) return sendJson(res, 403, gate);
      const { meta, a } = wall.decodeEnvelope(await readBody(req, 16 << 20));
      const r = wall.bookBrand(row, meta, a, now);
      submissions.afterCreate(r.sid);
      return sendJson(res, 200, r);
    }

    if (urlPath === '/api/paint' && req.method === 'POST') {
      const { pack } = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      const price = cfg.PACKS[pack];
      if (!price) return sendJson(res, 400, { error: 'unknown pack' });
      identity.creditPaint(row, Number(pack));
      return sendJson(res, 200, { bought: Number(pack), price, ...identity.allowanceOf(row, now) });
    }

    /* ── prototype affordances — turn the lot off with DEV=0 ── */
    if (urlPath.startsWith('/api/dev/')) {
      if (!cfg.DEV) return sendJson(res, 404, { error: 'not found' });

      if (urlPath === '/api/dev/refill' && req.method === 'POST') {
        identity.refill(row);
        return sendJson(res, 200, identity.allowanceOf(row, now));
      }
      if (urlPath === '/api/dev/reseed' && req.method === 'POST') {
        return sendJson(res, 200, wall.reseed(now));
      }
      if (urlPath === '/api/dev/wipe' && req.method === 'POST') {
        return sendJson(res, 200, wall.wipe());
      }
      if (urlPath === '/api/dev/reset' && req.method === 'POST') {
        return sendJson(res, 200, wall.rollCycle(now));
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.warn(`api ${urlPath}:`, err.message);
    return sendJson(res, 400, { error: err.message });
  }
}

module.exports = { handler, clients, emit, send, sendJson, readBody, serveStatic, corsHeaders, TYPES };
