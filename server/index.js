/* ═══════════════════════════════════════════════════════════════
   THE REEL RECIPE — PIXEL WALL  ·  boot

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
const identity = require('./identity.js');
const wall = require('./wall.js');
const { handler } = require('./http.js');

/* Boot once per process — on a serverless host that means once per cold
   start, which is exactly when the seed needs to be read back in. */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  for (const w of cfg.warnings) console.warn('config:', w);
  identity.loadLedger();
  if (!wall.loadWall()) console.log('wall: empty — the page will seed the demo artwork on first load');
  if (cfg.ON_VERCEL) console.log(`state dir   →  ${cfg.STATE_DIR} (per-instance; set STATE_DIR for durable storage)`);
}
boot();

function listen(port) {
  const p = port || cfg.PORT;
  return http.createServer(handler).listen(p, () => {
    console.log(`pixel wall  →  http://localhost:${p}`);
    console.log(`wall        →  server-owned, ${wall.wall.live.size} live · ${wall.wall.reserved.size} booked`);
    console.log(`allowance   →  ${cfg.CAP} free pixels per IP, refilling ${cfg.REFILL / 60000} min after they run out`);
    console.log(`trust proxy →  ${cfg.TRUST_PROXY ? 'yes (CF-Connecting-IP / X-Forwarded-For)' : 'no (socket address)'}`);
    if (cfg.DEV) console.log('dev routes  →  /api/dev/* enabled (DEV=0 to disable)');
  });
}

const app = (req, res) => { boot(); return handler(req, res); };
app.handler = handler;
app.boot = boot;
app.listen = listen;
module.exports = app;
