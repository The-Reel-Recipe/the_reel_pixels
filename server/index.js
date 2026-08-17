/* ═══════════════════════════════════════════════════════════════
   S37 — SHAKHBAT 3AL 7EET · PIXEL WALL  ·  boot

     node server.js [port]

   Owns everything the client used to keep in localStorage: the wall,
   the next-cycle bookings, the brands, the monthly cycle, and the
   free-pixel allowance. The page renders what this sends and posts
   intents back — it decides nothing on its own.

   Runs two ways: `node server.js` locally, or as the Vercel function
   in api/[...path].js, which imports the handler exported here.

   env: see .env.example and config.js.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const cfg = require('./config.js');
const { S } = require('./settings.js');
const db = require('./db.js');
const wall = require('./wall.js');
const telegram = require('./telegram.js');
const payments = require('./payments.js');
const submissions = require('./submissions.js');
const retention = require('./retention.js');
const httpMod = require('./http.js');
const { handler } = httpMod;

/* Boot once per process. Requiring db.js has already opened the database and
   run any pending migrations by this point; all that's left is projecting the
   wall cache off it — and, on a virgin database, importing the seed first. */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  for (const w of cfg.warnings) console.warn('config:', w);
  wall.load();
  telegram.start();
  payments.startSweeper();
  /* The privacy notice publishes four retention periods; this is what
     makes them true rather than aspirational. Daily, and off outside
     production — see config.RETENTION_SWEEP. */
  retention.start();
  if (cfg.ON_VERCEL) console.log(`data dir    →  ${cfg.DATA_DIR} (per-instance; set DATA_DIR for durable storage)`);
}
boot();

/* ── Shutting down, and falling over (§11) ────────────────────── */

/* systemd sends SIGTERM on every deploy, so this path runs far more often
   than the crash one and is worth getting right: stop taking new work,
   hang up the event streams so browsers reconnect to the new process
   rather than sitting on a dead socket, stop the timers, and flush the WAL
   back into the database file so a restart — or a backup taken between the
   two — never sees a half-written page.

   Transactions need no handling here at all. They are synchronous (§4.2):
   if one were running, this handler would not be. */
let closing = false;
let server = null;

function shutdown(sig, code = 0) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} — shutting down`);

  if (server) server.close();
  for (const res of httpMod.clients) { try { res.end(); } catch (e) { /* already gone */ } }
  httpMod.clients.clear();
  telegram.stopWorker();
  telegram.stopPolling();
  payments.stopSweeper();
  retention.stop();
  submissions.cancelPending();

  try { db.close(); } catch (err) { console.error('shutdown: db.close failed —', err.message); }
  /* Give the sockets a moment to drain, then go regardless: a deploy that
     hangs waiting for one stuck connection is a deploy nobody trusts. */
  setTimeout(() => process.exit(code), 400).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

/* An uncaught throw leaves the process in a state nothing here can reason
   about, so the answer is to write down what happened and let systemd's
   Restart=always put up a clean one. The journal entry is the important
   half — a crash nobody can see afterwards happens twice. */
function fatal(kind, err) {
  const message = (err && err.stack) || String(err);
  console.error(`\n${kind}:`, message);
  try { db.logEvent('system', 'crash', { kind, error: String(err && err.message || err) }); }
  catch (e) { /* the database may be exactly what broke */ }
  shutdown(kind, 1);
}
process.on('uncaughtException', err => fatal('uncaughtException', err));
process.on('unhandledRejection', err => fatal('unhandledRejection', err));

function listen(port) {
  const p = port || cfg.PORT;
  server = http.createServer(handler);
  return server.listen(p, () => {
    console.log(`pixel wall  →  http://localhost:${p}`);
    console.log(`database    →  ${db.file}`);
    console.log(`wall        →  server-owned, ${wall.wall.live.size} live · ${wall.wall.reserved.size} booked`);
    console.log(`allowance   →  ${S.CAP} free pixels per visitor, refilling ${S.REFILL / 60000} min after they run out`);
    console.log(`identity    →  signed uid cookie${cfg.COOKIE_SECURE ? ' (Secure)' : ''} · ` +
      `${S.IP_GUEST_CAP} new guests / ${S.IP_CLAIM_CAP} claims / ${S.IP_SIGNUP_CAP} signups per IP per day`);
    console.log(`trust proxy →  ${cfg.TRUST_PROXY ? 'yes (CF-Connecting-IP / X-Forwarded-For)' : 'no (socket address)'}`);
    console.log(`admin       →  /admin${cfg.ADMIN_IP_ALLOW.length ? ` (from ${cfg.ADMIN_IP_ALLOW.join(', ')})` : ''}`);
  });
}

const app = (req, res) => { boot(); return handler(req, res); };
app.handler = handler;
app.boot = boot;
app.listen = listen;
module.exports = app;
