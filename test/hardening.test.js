/* ═══════════════════════════════════════════════════════════════
   hardening test — the §11 checklist, as assertions

   A checklist in a plan is a thing somebody ticks. These are the
   items worth having a test hold onto instead, because they are all
   things that come back: a route quietly re-added, a header dropped
   during a refactor, a limit raised for a deploy and never lowered.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-hardening-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
process.env.TG_MODE = 'webhook';
/* the real §9 numbers — this file is the one that checks they bite */
delete process.env.RATE_READ;
delete process.env.RATE_WRITE;
delete process.env.RATE_AUTH;
delete process.env.VERCEL;

const app = require('../server.js');
const dbm = require('../server/db.js');
const cfg = require('../server/config.js');
const submissions = require('../server/submissions.js');
const payments = require('../server/payments.js');

const server = http.createServer(app);
let base = '';

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'x-forwarded-for': opts.ip || '203.0.113.200' }, opts.headers || {});
    const r = http.request(base + url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  submissions.cancelPending(); payments.stopSweeper();
  server.close(); dbm.close();
});

/* ── headers ──────────────────────────────────────────────────── */

test('every reply carries the security headers', async () => {
  for (const url of ['/', '/api/wall', '/does-not-exist']) {
    const r = await req('GET', url, { ip: '203.0.113.201' });
    const h = r.headers;
    assert.ok(h['content-security-policy'], `${url}: no CSP`);
    assert.equal(h['x-content-type-options'], 'nosniff', url);
    assert.equal(h['x-frame-options'], 'DENY', url);
    assert.match(h['referrer-policy'], /strict-origin/, url);
    assert.ok(h['permissions-policy'], `${url}: no permissions policy`);
    assert.equal(h['cache-control'], 'no-store', url);
  }
});

test('the policy allows nothing it does not have to', async () => {
  const csp = (await req('GET', '/')).headers['content-security-policy'];
  const dir = Object.fromEntries(csp.split(';').map(s => {
    const bits = s.trim().split(/\s+/);
    return [bits[0], bits.slice(1)];
  }));

  assert.deepEqual(dir['default-src'], ["'self'"]);
  assert.deepEqual(dir['script-src'], ["'self'"], 'no inline script, no CDN');
  assert.deepEqual(dir['object-src'], ["'none'"]);
  assert.deepEqual(dir['base-uri'], ["'none'"]);
  assert.deepEqual(dir['frame-ancestors'], ["'none'"]);
  assert.deepEqual(dir['connect-src'], ["'self'"]);
  assert.deepEqual(dir['form-action'], ["'self'"]);
  assert.ok(dir['img-src'].includes('data:'), 'the history thumbnails are canvas data URIs');

  /* Google is named only while the fonts are still theirs. `npm run fonts`
     pulls them in-house and this becomes 'self' with no code change —
     which is the assertion, not the current state. */
  const selfHosted = fs.existsSync(path.join(ROOT, 'assets', 'fonts'));
  if (selfHosted) {
    assert.deepEqual(dir['font-src'], ["'self'"], 'the fonts are local now');
    assert.ok(!csp.includes('googleapis'), 'so nothing should still name Google');
  } else {
    assert.ok(dir['font-src'].includes('https://fonts.gstatic.com'),
      'the page still loads them from Google — run `npm run fonts`');
  }
});

test('HSTS is only sent where it is true', async () => {
  /* This process is not production and not on TLS, so promising a browser
     that it is would pin localhost to https for a year. */
  const r = await req('GET', '/');
  assert.equal(r.headers['strict-transport-security'], undefined);
  assert.equal(cfg.PROD, false, 'the condition this is asserting about');
});

/* ── §11: the dev routes are gone, not disabled ───────────────── */

test('the prototype routes are deleted', async () => {
  for (const p of ['/api/dev/refill', '/api/dev/reset', '/api/dev/wipe',
    '/api/dev/seed', '/api/dev/reseed']) {
    const r = await req('POST', p, { ip: '203.0.113.202' });
    assert.equal(r.code, 404, `${p} answered ${r.code}`);
  }
  /* and not merely behind a flag somebody can flip back */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8');
  assert.equal(/urlPath\.startsWith\('\/api\/dev\//.test(src), false,
    'the dev router is still in the source');
  assert.equal(cfg.DEV, undefined, 'and so is the flag that gated it');
});

test('the demo controls are out of the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  for (const [name, src] of [['index.html', html], ['app.js', js], ['styles.css', css]]) {
    assert.equal(/demo-pill|demoTime|demoRefill|demoWipe|devCall/.test(src), false,
      `${name} still mentions the demo controls`);
  }
});

test('the interface has no emoji left in it', () => {
  /* Emoji render as somebody else's artwork, differently per platform, and
     cannot take a colour — every one of them is a drawn icon now
     (tools/make-icons.js). This is the guard against one creeping back in
     with the next toast. */
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]|&#1[0-9]{4,5};/u;
  for (const f of ['index.html', 'app.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      /* the box-drawing rules in the comment headers are not emoji */
      const bare = line.replace(/[═─│┌┐└┘·—…’‘“”×≈≤≥±→]/g, '');
      assert.equal(emoji.test(bare), false, `${f}:${i + 1} — ${line.trim().slice(0, 70)}`);
    });
  }
});

test('every icon comes from the sprite, not from a hand-drawn path', () => {
  /* Two survived the first sweep — a caret and an animated padlock — and
     looked exactly like what they were: a different hand, next to a
     library set. */
  for (const f of ['index.html', 'app.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const inline = [...src.matchAll(/<svg(?![^>]*><use)[^>]*>[\s\S]{0,400}?<\/svg>/g)]
      .filter(m => !m[0].includes('<use'));
    assert.equal(inline.length, 0,
      `${f} draws its own SVG: ${(inline[0] || [''])[0].slice(0, 90)}`);
  }
});

test('icons are sized in pixels, never inherited from type', () => {
  /* Half this interface is set in a pixel font at 7–8px. An icon sized in
     em came out 9px in the action bar, which for 24×24 pixel art is four
     grey smudges — and how small the label happens to be has nothing to do
     with how big the icon needs to be. */
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const base = css.match(/^\.ic \{[\s\S]*?\}/m);
  assert.ok(base, 'no .ic rule at all');
  assert.match(base[0], /width:\s*\d+px/, '.ic must have a pixel width');
  assert.equal(/width:\s*[\d.]+r?em/.test(base[0]), false, '.ic is em-sized again');

  for (const rule of css.match(/[^\n{}]*\.ic\b[^{}]*\{[^}]*\}/g) || []) {
    const w = rule.match(/width:\s*([\d.]+)(px|r?em)/);
    if (!w) continue;
    assert.equal(w[2], 'px', `icon width in ${w[2]}: ${rule.split('{')[0].trim()}`);
    assert.ok(Number(w[1]) >= 11, `${w[1]}px is too small to read: ${rule.split('{')[0].trim()}`);
  }
});

test('every icon a page asks for is one the sprite defines', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const defined = new Set([...html.matchAll(/<symbol id="i-([a-z-]+)"/g)].map(m => m[1]));
  assert.ok(defined.size >= 20, `only ${defined.size} icons in the sprite`);

  const used = new Set([
    ...[...html.matchAll(/href="#i-([a-z-]+)"/g)].map(m => m[1]),
    ...[...js.matchAll(/\bic\('([a-z-]+)'\)/g)].map(m => m[1])
  ]);
  assert.ok(used.size > 0, 'no icons are referenced at all');
  for (const name of used) assert.ok(defined.has(name), `#i-${name} is used but not drawn`);
});

test('no borrowed trademarks survive anywhere', () => {
  const files = ['index.html', 'app.js', 'styles.css', 'package.json'];
  const banned = /coca.?cola|pepsi|\bnike\b|mcdonald|samsung|reel.?recipe|thereelrecipe/i;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal(banned.test(src), false, `${f} still names somebody else's brand`);
  }
  /* the committed artwork carried five of them until the rebrand */
  const seed = fs.readFileSync(path.join(ROOT, 'seed.bin'));
  const meta = JSON.parse(seed.toString('utf8', 4, 4 + seed.readUInt32LE(0)));
  assert.deepEqual(meta.brands, {});
  assert.deepEqual(meta.nextBrands, {});
  for (const o of meta.owners) assert.equal(banned.test(o.n), false, `owner ${o.n}`);
});

/* ── §9: the buckets bite ─────────────────────────────────────── */

test('a flood of reads is throttled', async () => {
  const ip = '203.0.113.210';
  let limited = 0;
  /* comfortably past the read burst, which is RATE_READ * 1.25 */
  for (let i = 0; i < cfg.RATE_READ * 2; i++) {
    const r = await req('GET', '/api/allowance', { ip });
    if (r.code === 429) { limited++; if (limited > 2) break; }
  }
  assert.ok(limited > 0, 'nothing was throttled');
});

test('the auth bucket is much tighter than the read one', async () => {
  const ip = '203.0.113.211';
  let ok = 0;
  for (let i = 0; i < cfg.RATE_AUTH + 4; i++) {
    const r = await req('POST', '/api/auth/login', {
      ip, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password' })
    });
    if (r.code !== 429) ok++;
  }
  assert.ok(ok <= cfg.RATE_AUTH, `${ok} attempts got through, budget is ${cfg.RATE_AUTH}`);
  assert.ok(cfg.RATE_AUTH < cfg.RATE_READ);
});

test('the event stream is not rate limited', async () => {
  /* it is one long-lived connection per tab; counting it per minute would
     drop reconnects on a flaky phone */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8');
  assert.match(src, /urlPath !== '\/api\/stream'/);
});

/* ── §9: the health endpoint ──────────────────────────────────── */

test('healthz says something true, and is not throttled', async () => {
  const ip = '203.0.113.212';
  let last;
  for (let i = 0; i < 60; i++) last = await req('GET', '/healthz', { ip });
  assert.equal(last.code, 200, 'a monitor should never be throttled into a page');

  const d = JSON.parse(last.body.toString('utf8'));
  assert.equal(d.ok, true);
  assert.equal(d.db, 'ok');
  assert.equal(typeof d.wall, 'number');
  assert.equal(typeof d.outbox, 'number');
  assert.equal(d.outboxStuck, false);
  assert.equal(d.maintenance, false);
  assert.ok(d.uptimeMs > 0);
});

/* ── §11: bodies have limits ──────────────────────────────────── */

test('an oversize body gets a 413, not a dropped connection', async () => {
  const r = await req('POST', '/api/auth/login', {
    ip: '203.0.113.213',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(64 * 1024, 'x')          // the login limit is 4 KB
  });
  /* §9 asks for the status. It matters: an ECONNRESET is indistinguishable
     from the server having fallen over, and somebody will debug it as one. */
  assert.equal(r.code, 413);
  assert.equal(JSON.parse(r.body.toString('utf8')).error, 'too-large');
});

/* ── the shape of the deploy ──────────────────────────────────── */

test('the lockfile is committed and the runtime is pinned', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'no lockfile');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.engines.node, /^22/, 'node is not pinned to an LTS major');
  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim().startsWith('22'), true);
  /* two dependencies, both argued for in PLAN §1 */
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['better-sqlite3', 'pngjs']);
});

test('.env.example documents every secret the boot demands', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const s of cfg.SECRETS) {
    assert.match(example, new RegExp(`^${s.k}=`, 'm'), `${s.k} is undocumented`);
  }
  /* and no actual secret has been pasted into it */
  assert.equal(/^SESSION_SECRET=.+$/m.test(example), false, 'a real secret is in .env.example');
  assert.equal(/^TG_BOT_TOKEN=.+$/m.test(example), false, 'a real bot token is in .env.example');
});
