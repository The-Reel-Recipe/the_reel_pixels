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
const { S } = require('./settings.js');
const identity = require('./identity.js');
const wall = require('./wall.js');
const submissions = require('./submissions.js');
const payments = require('./payments.js');
const uploads = require('./uploads.js');
const telegram = require('./telegram.js');
const admin = require('./admin.js');
const settings = require('./settings.js');
const db = require('./db.js');
const { logEvent } = require('./db.js');

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

/* The public front-end, named rather than deduced.

   This used to serve anything under the project root that was not
   dot-prefixed and not inside DATA_DIR, which meant GET /server/config.js
   handed over the source — no secrets in it (they come from the
   environment) but a free map of the thing for anyone poking at it, and
   /package.json, /migrations/*.sql and /test/* alongside. A denylist of
   everything private is a list you can forget to add to; the set of files
   a browser actually needs is four entries and a directory. */
const PUBLIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/favicon.ico']);
const PUBLIC_DIRS = ['/assets/'];

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, 'text/plain', 'Bad path'); }
  rel = rel.replace(/\\/g, '/');
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

  const allowed = PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some(d => rel.startsWith(d));
  if (!allowed) return send(res, 404, 'text/plain', 'Not found');

  const file = path.resolve(ROOT, '.' + rel);
  /* Belt and braces behind the allowlist: an encoded ../ that survived
     decodeURIComponent still cannot land outside the project, and nothing
     dot-prefixed is served whatever route it arrived by. */
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
  if (path.relative(ROOT, file).split(path.sep).some(p => p.startsWith('.'))) {
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

/* ── The admin panel (§7) ─────────────────────────────────────── */

/* Everything here answers JSON and nothing here re-implements a state
   machine: approve is submissions.approve, verify is payments.verify, and
   the guards those already carry are the guards this gets. What the panel
   adds is the things Telegram cannot do — takedowns, region wipes, the
   ledger, the config, the audit trail — and being reachable when the bot
   is not. */
const ADMIN_DIR = path.join(ROOT, 'admin');

/* What maintenance mode closes. Deliberately a list rather than "any POST":
   logging in and out are not changes to the wall, and locking somebody out
   of their own account to do a deploy would be rude. */
const WRITES = new Set(['/api/claim', '/api/book', '/api/paint/order']);

async function adminBody(req, limit = 256 << 10) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch (err) { return {}; }
}

function sendFileFrom(res, dir, name) {
  const file = path.resolve(dir, '.' + path.posix.normalize('/' + name));
  if (file !== dir && !file.startsWith(dir + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}

async function adminRoutes(req, res, urlPath, now) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  /* The login screen is the only thing an anonymous caller may have. The
     panel proper — its script and its stylesheet — needs a session, so an
     unauthenticated scrape gets a form and nothing else (§11). */
  if (urlPath === '/admin' || urlPath === '/admin/') return sendFileFrom(res, ADMIN_DIR, 'index.html');
  if (urlPath.startsWith('/admin/')) {
    if (!admin.sessionFrom(req, now)) return send(res, 403, 'text/plain', 'Sign in first.');
    return sendFileFrom(res, ADMIN_DIR, urlPath.slice('/admin/'.length));
  }

  /* ── the door ── */
  if (urlPath === '/api/admin/login' && req.method === 'POST') {
    const ip = identity.callerKey(req);
    const r = admin.login(ip, await adminBody(req, 4096), now);
    if (!r.ok) return sendJson(res, r.status, { error: r.error, message: r.message });
    res.setHeader('set-cookie', r.cookie);
    return sendJson(res, 200, { ok: true, username: r.admin.username });
  }
  if (urlPath === '/api/admin/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', admin.logout());
    return sendJson(res, 200, { ok: true });
  }

  const g = admin.guard(req, now);
  if (g.fail) return sendJson(res, g.fail.status, g.fail);
  const actor = g.actor;

  /* Anything that changes something takes a reason where one is meaningful;
     `reason` is threaded through rather than invented per route. */
  const body = req.method === 'GET' ? {} : await adminBody(req);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const idIn = urlPath.match(/\/(\d+)(?:\/[a-z-]+)?(?:\.png)?$/);
  const id = idIn ? Number(idIn[1]) : 0;

  try {
    /* ── who am I ── */
    if (urlPath === '/api/admin/me') {
      return sendJson(res, 200, { username: g.admin.username, since: g.admin.last_login });
    }

    /* ── dashboard ── */
    if (urlPath === '/api/admin/overview') return sendJson(res, 200, admin.overview(now));

    /* ── moderation ── */
    if (urlPath === '/api/admin/queue') return sendJson(res, 200, { rows: admin.queue() });

    if (urlPath.match(/^\/api\/admin\/preview\/\d+\.png$/)) {
      const sub = submissions.get(id);
      if (!sub || !sub.preview_path) return send(res, 404, 'text/plain', 'Not found');
      return sendFileFrom(res, path.dirname(sub.preview_path), path.basename(sub.preview_path));
    }

    const decide = urlPath.match(/^\/api\/admin\/submissions\/(\d+)\/(approve|reject|takedown)$/);
    if (decide && req.method === 'POST') {
      const sid = Number(decide[1]);
      const r = decide[2] === 'approve' ? submissions.approve(sid, actor, now)
        : decide[2] === 'reject' ? submissions.reject(sid, actor, reason || 'Rejected by a moderator', now)
          : submissions.takedown(sid, actor, reason || 'Taken down', now);
      return sendJson(res, r.ok ? 200 : 409, r);
    }
    /* bulk, for a queue that has got away from everyone */
    if (urlPath === '/api/admin/submissions/bulk' && req.method === 'POST') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(Number) : [];
      const done = ids.map(sid => (body.action === 'approve'
        ? submissions.approve(sid, actor, now)
        : submissions.reject(sid, actor, reason || 'Rejected by a moderator', now)));
      return sendJson(res, 200, { done: done.filter(r => r.ok).length, of: ids.length });
    }

    /* ── the wall ── */
    if (urlPath === '/api/admin/wall/pixel') {
      return sendJson(res, 200, admin.pixelAt(Number(q.get('idx'))));
    }
    if (urlPath === '/api/admin/wall/export.png') {
      const layer = q.get('layer') === 'next' ? 'next' : 'live';
      const px = [...(layer === 'live' ? wall.wall.live : wall.wall.reserved)].map(([i, p]) => [i, p.c]);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="wall-${layer}.png"`,
        'cache-control': 'no-store'
      });
      return res.end(admin.renderWall(px));
    }
    if (urlPath === '/api/admin/wall/erase-region' && req.method === 'POST') {
      return sendJson(res, 200, admin.eraseRegion(body.rect || {}, actor, reason, now));
    }
    if (urlPath === '/api/admin/wall/reset' && req.method === 'POST') {
      const r = admin.forceReset(body.phrase, actor, now);
      return sendJson(res, r.error ? 400 : 200, r);
    }
    if (urlPath === '/api/admin/wall/reseed' && req.method === 'POST') {
      const r = admin.forceReseed(body.phrase, actor, now);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    /* ── users ── */
    if (urlPath === '/api/admin/users') {
      return sendJson(res, 200, { rows: admin.users(q.get('q'), Number(q.get('limit')) || 40) });
    }
    const userAct = urlPath.match(/^\/api\/admin\/users\/(\d+)\/(ban|unban|adjust)$/);
    if (userAct && req.method === 'POST') {
      const uid = Number(userAct[1]);
      const r = userAct[2] === 'adjust'
        ? admin.adjust(uid, body, actor, reason, now)
        : admin.setBan(uid, userAct[2] === 'ban', actor, reason, now);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    /* ── brands ── */
    if (urlPath === '/api/admin/brands') return sendJson(res, 200, { rows: admin.brands() });
    const brandAct = urlPath.match(/^\/api\/admin\/brands\/(\d+)\/(approve|reject|revoke)$/);
    if (brandAct && req.method === 'POST') {
      const uid = Number(brandAct[1]);
      const status = brandAct[2] === 'approve' ? 'approved'
        : brandAct[2] === 'reject' ? 'rejected' : 'revoked';
      const r = identity.decideBrand(uid, status, actor, reason || null, now);
      if (r.ok) telegram.editBrandDecision(uid, r.status, actor, now);
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    /* ── payments ── */
    if (urlPath === '/api/admin/payments') {
      const filter = { status: q.get('status'), kind: q.get('kind'), q: q.get('q') };
      if (q.get('format') === 'csv') {
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="payments.csv"',
          'cache-control': 'no-store'
        });
        return res.end(admin.paymentsCsv(filter));
      }
      return sendJson(res, 200, {
        rows: admin.paymentList(filter, Number(q.get('limit')) || 100),
        reconcile: admin.reconcile()
      });
    }
    if (urlPath.match(/^\/api\/admin\/payments\/\d+\/screenshot$/)) {
      const p = payments.get(id);
      if (!p || !p.screenshot_path || !fs.existsSync(p.screenshot_path)) {
        return send(res, 404, 'text/plain', 'Not found');
      }
      /* nosniff and an explicit type: the file was sanitised on the way in,
         and it is still not going to be interpreted as anything but a picture */
      res.writeHead(200, {
        'content-type': TYPES[path.extname(p.screenshot_path).toLowerCase()] || 'image/png',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      });
      return res.end(fs.readFileSync(p.screenshot_path));
    }
    const payAct = urlPath.match(/^\/api\/admin\/payments\/(\d+)\/(verify|reject|refunded|override)$/);
    if (payAct && req.method === 'POST') {
      const pid = Number(payAct[1]);
      const r = payAct[2] === 'verify' ? payments.verify(pid, actor, now)
        : payAct[2] === 'reject' ? payments.reject(pid, actor, now)
          : payAct[2] === 'refunded' ? payments.markRefunded(pid, actor, now)
            : admin.override(pid, body.to, actor, reason, now);
      return sendJson(res, r.ok ? 200 : (r.error ? 400 : 409), r);
    }

    /* ── config ── */
    if (urlPath === '/api/admin/config' && req.method === 'GET') {
      return sendJson(res, 200, { rows: settings.describe() });
    }
    if (urlPath === '/api/admin/config' && req.method === 'PUT') {
      const r = body.reset
        ? settings.reset(body.key, actor, now)
        : settings.set(body.key, body.value, actor, now);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    /* ── audit ── */
    if (urlPath === '/api/admin/events') {
      return sendJson(res, 200, {
        rows: admin.events({ actor: q.get('actor'), action: q.get('action'), since: q.get('since') },
          Number(q.get('limit')) || 200),
        actions: admin.actionList()
      });
    }

    /* ── system ── */
    if (urlPath === '/api/admin/system') return sendJson(res, 200, admin.systemInfo(now));
    if (urlPath === '/api/admin/system/backup' && req.method === 'POST') {
      const r = require('../tools/backup-nightly.js').runBackup();
      logEvent(actor, 'manual-backup', { file: r.file, bytes: r.bytes }, now);
      return sendJson(res, 200, r);
    }
    if (urlPath === '/api/admin/system/outbox-retry' && req.method === 'POST') {
      const n = db.db.prepare('UPDATE tg_outbox SET next_try = 0' +
        (body.id ? ' WHERE id = ?' : '')).run(...(body.id ? [Number(body.id)] : [])).changes;
      telegram.drain();
      logEvent(actor, 'outbox-retry', { rows: n, id: body.id || null }, now);
      return sendJson(res, 200, { ok: true, retried: n });
    }
    if (urlPath === '/api/admin/system/outbox-drop' && req.method === 'POST') {
      const n = db.db.prepare('DELETE FROM tg_outbox WHERE id = ?').run(Number(body.id)).changes;
      logEvent(actor, 'outbox-drop', { id: Number(body.id), reason }, now);
      return sendJson(res, 200, { ok: true, dropped: n });
    }
    if (urlPath === '/api/admin/system/worker-restart' && req.method === 'POST') {
      telegram.stopWorker(); telegram.startWorker();
      logEvent(actor, 'worker-restart', {}, now);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/admin/system/revoke' && req.method === 'POST') {
      const r = admin.revokeSessions(g.admin.id, actor, now);
      res.setHeader('set-cookie', admin.clearCookie());
      return sendJson(res, 200, r);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.warn(`admin ${urlPath}:`, err.message);
    return sendJson(res, 500, { error: 'server', message: err.message });
  }
}

/* ── Routes ───────────────────────────────────────────────────── */

async function handler(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS' && cfg.ALLOW_ORIGIN) {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  /* The panel, and the panel's door. Ahead of the static branch because
     /admin is a route rather than a file, and ahead of identity because an
     admin is not a visitor: a moderation session should not be handed a
     guest cookie or spend the office connection's daily budget of them. */
  if (urlPath === '/admin' || urlPath.startsWith('/admin/') || urlPath.startsWith('/api/admin/')) {
    return adminRoutes(req, res, urlPath, Date.now());
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

    /* Maintenance mode (§7.2). Reads keep working — the wall stays up and
       readable — and anything that would change it says so kindly. */
    if (settings.S.MAINTENANCE && WRITES.has(urlPath)) {
      return sendJson(res, 503, {
        error: 'maintenance',
        message: 'The wall is being worked on — reading is fine, painting is back shortly.'
      });
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
      if (r.sid) {
        /* The cells are held; the money is not in yet. The order carries the
           same 48h hold, and letting it lapse is what puts the pixels back
           (§6, brand bookings). */
        const order = db.tx(() => payments.createOrder(row.id, 'brand_booking',
          { px: r.booked, sid: r.sid }, now));
        r.payment = payments.instructionsFor(order);
        submissions.afterCreate(r.sid);
      }
      return sendJson(res, 200, r);
    }

    /* ── paying (§6) ── */

    /* Buying paint is an order, not a purchase: nothing is credited until a
       teammate has seen the money arrive in their own InstaPay app. */
    if (urlPath === '/api/paint/order' && req.method === 'POST') {
      const { pack } = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      if (!S.PACKS[pack]) return sendJson(res, 400, { error: 'unknown pack' });
      const order = db.tx(() => payments.createOrder(row.id, 'paint_pack', { pack: Number(pack) }, now));
      return sendJson(res, 200, payments.instructionsFor(order));
    }

    const proof = urlPath.match(/^\/api\/payments\/(\d+)\/(proof|screenshot)$/);
    if (proof && req.method === 'POST') {
      const id = Number(proof[1]);
      if (proof[2] === 'screenshot') {
        const raw = await readBody(req, uploads.MAX_BYTES + 1024);
        const stored = uploads.store(raw, `p${id}`);
        if (stored.error) return sendJson(res, 400, stored);
        const r = payments.attachScreenshot(id, row.id, stored.file, now);
        if (r.error) return sendJson(res, r.status, r);
        return sendJson(res, 200, { ok: true, bytes: stored.bytes });
      }
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      const r = payments.submitProof(id, row.id, body, now);
      if (r.error) return sendJson(res, r.status, r);
      return sendJson(res, 200, r);
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
