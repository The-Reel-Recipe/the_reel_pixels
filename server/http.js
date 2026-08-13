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

/* ── Security headers (§11) ───────────────────────────────────── */

/* The two typefaces are Google-hosted unless somebody has run
   `npm run fonts`, which pulls them into assets/fonts/ and rewrites the
   link in index.html. Self-hosting is preferred — it drops a third party
   from the critical path and closes the only hole in this policy — so the
   policy is computed from what is actually on disk rather than pinned to
   whichever choice was made the day it was written. */
const SELF_HOSTED_FONTS = fs.existsSync(path.join(ROOT, 'assets', 'fonts'));
const FONT_SRC = SELF_HOSTED_FONTS
  ? "font-src 'self'"
  : "font-src 'self' https://fonts.gstatic.com";
const STYLE_SRC = SELF_HOSTED_FONTS
  /* 'unsafe-inline' stays either way: the canvas renderer sets inline
     styles, and nonce-ing every one of them buys nothing while script-src
     is already locked to 'self'. */
  ? "style-src 'self' 'unsafe-inline'"
  : "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  STYLE_SRC,
  FONT_SRC,
  /* data: for the history thumbnails and the crop preview, both of which
     are canvases the page drew itself */
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  /* frame-ancestors covers this for anything modern; the header is for what
     is not, and costs 25 bytes */
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin'
};
/* Only over TLS, and only in production: sending HSTS from a plain-http dev
   server would pin localhost to https in the developer's browser. */
if (cfg.PROD && cfg.COOKIE_SECURE) {
  SECURITY['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
}

/* ── Replies ──────────────────────────────────────────────────── */

/* Only set when ALLOW_ORIGIN is configured — a statically hosted copy of the
   page (GitHub Pages, a CDN) pointing at this API needs it, nothing else
   does, and §11 says a single-origin deploy leaves it unset. */
function corsHeaders(extra) {
  const h = Object.assign({ 'cache-control': 'no-store' }, SECURITY, extra);
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

/* ── Rate limiting (§9) ───────────────────────────────────────── */

/* A token bucket per caller. In memory and per process, which is exactly
   right for a design that is one process by construction (§4.1) — and it
   means a flood costs a Map entry rather than a row.

   The key is the IP, not the cookie: anyone rate-limited by their own
   cookie would simply throw it away, and the whole point is to make a
   flood expensive for whoever is sending it. */
const BUCKETS = new Map();
const LIMITS = {
  /* signing up, signing in, and asking for a payment order are the three
     places a script gets something for its trouble */
  auth: { rate: cfg.RATE_AUTH, per: 60000, burst: cfg.RATE_AUTH },
  write: { rate: cfg.RATE_WRITE, per: 60000, burst: Math.ceil(cfg.RATE_WRITE * 1.4) },
  read: { rate: cfg.RATE_READ, per: 60000, burst: Math.ceil(cfg.RATE_READ * 1.25) }
};

function limitFor(urlPath) {
  if (urlPath.startsWith('/api/auth/') || urlPath === '/api/admin/login' ||
      urlPath === '/api/paint/order' || urlPath.startsWith('/api/payments/')) return 'auth';
  if (urlPath === '/api/claim' || urlPath === '/api/book') return 'write';
  return 'read';
}

function takeToken(key, kind, now) {
  const limit = LIMITS[kind];
  const id = `${kind}:${key}`;
  let b = BUCKETS.get(id);
  if (!b) { b = { tokens: limit.burst, at: now }; BUCKETS.set(id, b); }
  b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / limit.per) * limit.rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
/* Buckets refill on their own, so an idle one is indistinguishable from a
   fresh one — dropping it is free. */
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of BUCKETS) if (now - b.at > 10 * 60 * 1000) BUCKETS.delete(id);
}, 5 * 60 * 1000).unref();

const TOO_FAST = {
  error: 'slow-down',
  message: 'That is a lot of requests very quickly. Give it a moment and try again.'
};

/* §9 wants a 413 rather than a dropped connection, which means the socket
   has to survive long enough to carry one — destroying the request the
   moment it goes over the limit gives the caller an ECONNRESET and no idea
   why. So: stop accumulating immediately (the memory is the thing being
   protected), reject with a status the handler can turn into an answer,
   and let that answer decide when the socket goes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413, tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', err => { if (!over) reject(err); });
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
      res.writeHead(200, corsHeaders({
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="wall-${layer}.png"`
      }));
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
        res.writeHead(200, corsHeaders({
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="payments.csv"'
        }));
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
      res.writeHead(200, corsHeaders({
        'content-type': TYPES[path.extname(p.screenshot_path).toLowerCase()] || 'image/png',
        'content-disposition': 'inline'
      }));
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

  /* §9. What an uptime monitor polls, so it answers whether the process can
     still do its job rather than only that it can answer — a server whose
     database has gone away still serves 200s otherwise. Not under /api/, so
     it has to come before the static branch; exempt from the rate limiter,
     because a monitor throttled into a 429 pages somebody at 3am about
     nothing. */
  if (urlPath === '/healthz') {
    const at = Date.now();
    let ok = true, dbState = 'ok';
    try { db.db.prepare('SELECT 1').get(); }
    catch (err) { ok = false; dbState = err.message; }
    const out = telegram.status();
    return sendJson(res, ok ? 200 : 503, {
      ok, db: dbState,
      wall: wall.wall.live.size,
      pending: submissions.pendingCount(),
      outbox: out.n,
      outboxOldestMs: out.oldest ? at - out.oldest : 0,
      /* §11's alert condition, computed here so the monitor does not have
         to know what fifteen minutes means */
      outboxStuck: !!(out.n > 0 && out.oldest && (at - out.oldest) > 15 * 60 * 1000),
      sse: clients.size,
      maintenance: settings.S.MAINTENANCE,
      uptimeMs: Math.round(process.uptime() * 1000)
    });
  }

  if (!urlPath.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return serveStatic(req, res, urlPath);
  }

  const now = Date.now();
  wall.checkCycle(now);

  /* Ahead of everything but the webhook and the panel, and ahead of reading
     any body — a refusal should be cheaper than the request that earned it.
     The event stream is exempt: it is one long-lived connection, and
     counting it against a per-minute budget would drop reconnects. */
  if (urlPath !== '/api/stream') {
    const kind = limitFor(urlPath);
    if (!takeToken(identity.callerKey(req), kind, now)) {
      res.setHeader('retry-after', '30');
      return sendJson(res, 429, TOO_FAST);
    }
  }

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
      res.writeHead(200, corsHeaders({ 'content-type': 'application/octet-stream' }));
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

    /* /api/dev/* used to live here: refill, reseed, wipe and roll-the-cycle,
       unauthenticated, behind a DEV flag. §11 says deleted rather than
       switched off, and it is right — an unauthenticated route that wipes
       the wall is one environment variable away from being a very bad
       afternoon, and every one of those four now exists in the admin panel
       behind a password, a TOTP code and a typed confirmation phrase. */

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err.tooLarge) {
      /* The caller is very likely still sending. Destroying the socket here
         is what the old code did and it lands as an ECONNRESET with no
         explanation; waiting for 'finish' is no better, because that fires
         when the response reaches the OS rather than the client. So: drain
         the rest of the body into the bin (nothing is being buffered any
         more — readBody stopped at the limit), answer, and ask for the
         connection to close afterwards, which Node does cleanly. */
      req.resume();
      res.writeHead(413, corsHeaders({ 'content-type': TYPES['.json'], connection: 'close' }));
      return res.end(JSON.stringify({
        error: 'too-large',
        message: 'That request was bigger than this endpoint accepts.'
      }));
    }
    console.warn(`api ${urlPath}:`, err.message);
    return sendJson(res, 400, { error: err.message });
  }
}

module.exports = { handler, clients, emit, send, sendJson, readBody, serveStatic, corsHeaders, TYPES };
