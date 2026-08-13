/* ═══════════════════════════════════════════════════════════════
   contract test — the wire the client already speaks

   Boots the exported handler in-process on an ephemeral port and
   checks the envelope byte-for-byte against the committed seed, so
   the Phase 0 module split (and everything after it) can't quietly
   change what app.js receives.

   STATE_DIR and DATA_DIR are fresh temp dirs: no .wall.bin and no
   database, so the server migrates, imports seed.bin and serves that
   — and nothing the test paints touches the repo or a previous run.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/* has to be set before server.js is required — it reads env at load */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-test-'));
const STATE_DIR = path.join(TMP, 'state');
fs.mkdirSync(STATE_DIR);
process.env.STATE_DIR = STATE_DIR;
process.env.DATA_DIR = path.join(TMP, 'data');
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ALLOW_ORIGIN;

const app = require('../server.js');
const db = require('../server/db.js');

/* What seed.bin holds — the numbers the whole test file hangs off. Read
   rather than remembered: the artwork is a generated artifact now
   (tools/make-brand.js), and a hard-coded count turned every change to the
   mark into five failing assertions about nothing. */
function seedCounts(file) {
  const buf = fs.readFileSync(file);
  let o = 4 + buf.readUInt32LE(0);              // past [u32 metaLen][meta]
  const live = buf.readUInt32LE(o); o += 4 + live * 9;
  return { live, booked: buf.readUInt32LE(o) };
}
const { live: SEED_LIVE, booked: SEED_BOOKED } =
  seedCounts(path.join(__dirname, '..', 'seed.bin'));

/* ── envelope codec (copied from app.js, deliberately) ────────── */
/* The client's decoder, not the server's — if the two ever drift
   this test is what notices. */
const ENTRY = 9;
function encodeEnvelope(meta, a, b = []) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const buf = Buffer.alloc(4 + json.length + 4 + a.length * ENTRY + 4 + b.length * ENTRY);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  for (const list of [a, b]) {
    buf.writeUInt32LE(list.length, o); o += 4;
    for (const [i, c, own] of list) {
      buf.writeUInt32LE(i, o); o += 4;
      buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
      buf.writeUInt16LE(own || 0, o); o += 2;
    }
  }
  return buf;
}
function decodeEnvelope(buf) {
  let o = 0;
  const metaLen = buf.readUInt32LE(o); o += 4;
  const meta = JSON.parse(buf.toString('utf8', o, o + metaLen)); o += metaLen;
  const bodyAt = o;
  const readList = () => {
    const n = buf.readUInt32LE(o); o += 4;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [buf.readUInt32LE(o), (buf[o + 4] << 16) | (buf[o + 5] << 8) | buf[o + 6], buf.readUInt16LE(o + 7)];
      o += ENTRY;
    }
    return out;
  };
  return { meta, a: readList(), b: readList(), bodyAt };
}
/* meta carries clocks (now, cycleEnd, refillAt); the pixel payload
   doesn't, so it's the part worth hashing.

   Sorted by index first, which Phase 0 did not need to do. The wall is
   now a projection of the `cells` table and comes back in primary-key
   order, where seed.bin stores its entries grouped by owner — same
   pixels, same colours, same owner ids, different order on the wire.
   The client builds a Map out of them and never looks at the order, so
   the contract is the *set*, and comparing it as one is what keeps this
   test honest instead of re-baselining it every time the read path
   changes. Order-sensitivity would also break the moment two claims
   land in a different sequence, which says nothing about the wire. */
const bodyHash = buf => {
  const { a, b } = decodeEnvelope(buf);
  const byIdx = list => list.slice().sort((x, y) => x[0] - y[0]);
  return crypto.createHash('sha256')
    .update(encodeEnvelope({}, byIdx(a), byIdx(b))).digest('hex').slice(0, 16);
};
/* the same hash taken straight off the committed file, so the assertion
   below is anchored to seed.bin rather than to whatever the server said
   the day the constant was written */
const SEED_HASH = bodyHash(fs.readFileSync(path.join(__dirname, '..', 'seed.bin')));

/* ── in-process server ────────────────────────────────────────── */

const server = http.createServer(app);
let base = '';

/* Phase 2 moved identity from the caller's IP onto a signed cookie, so the
   suite has to keep one like a browser does: without a jar every request
   would mint a fresh guest, the allowance assertions below would each be
   about a different person, and the sixth would hit the per-IP cap. */
const jar = new Map();
const jarHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(res) {
  for (const line of res.headers['set-cookie'] || []) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function req(method, url, body, type) {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'content-type': type || 'application/json' } : {};
    if (jar.size) headers.cookie = jarHeader();
    const r = http.request(base + url, { method, headers }, res => {
      keepCookies(res);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        code: res.statusCode, type: res.headers['content-type'],
        setCookie: res.headers['set-cookie'] || [], body: Buffer.concat(chunks)
      }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const getJson = async (m, u, b, t) => {
  const r = await req(m, u, b, t);
  return { code: r.code, json: JSON.parse(r.body.toString('utf8')) };
};

test.before(() => new Promise(done => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
}));
test.after(() => {
  server.close();
  db.close();                              // Windows won't unlink an open .db
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ── the snapshot ─────────────────────────────────────────────── */

let seedBody = '';

test('GET /api/wall serves the seed as a decodable envelope', async () => {
  const r = await req('GET', '/api/wall');
  assert.equal(r.code, 200);
  assert.equal(r.type, 'application/octet-stream');

  const { meta, a, b } = decodeEnvelope(r.body);
  assert.equal(a.length, SEED_LIVE, 'live pixels');
  assert.equal(b.length, SEED_BOOKED, 'booked pixels');

  assert.equal(meta.v, 1);
  assert.equal(typeof meta.cycle, 'number');
  assert.ok(meta.cycleEnd > meta.cycle, 'cycle window');
  assert.equal(meta.rev, 0);
  assert.ok(Array.isArray(meta.owners) && meta.owners.length, 'owner table');
  assert.equal(meta.dev, true);
  assert.deepEqual(meta.prices, { paint: 10, company: 10, packs: { 25: 225, 100: 800, 500: 3500 } });
  /* meta.me carried just the display name until Phase 2; it is the caller's
     whole standing now, because the page routes the pre-order button off it
     (guest / brand, and how the application went). app.js never read the old
     string — it takes the handle from meta.allowance — so nothing on the wire
     that the client uses actually moved. */
  assert.equal(meta.me.kind, 'guest');
  assert.equal(meta.me.brandStatus, null);
  assert.match(meta.me.handle, /^Pixel fan #\d{4}$/);
  assert.equal(meta.allowance.cap, 20);
  assert.equal(meta.allowance.free, 20);
  assert.equal(meta.allowance.paint, 0);
  assert.equal(meta.allowance.refillMs, 30 * 60 * 1000);
  assert.equal(meta.allowance.handle, meta.me.handle);
  assert.equal(typeof meta.brands, 'object');
  assert.equal(typeof meta.nextBrands, 'object');

  /* every entry addressable and in range */
  for (const [idx, c, own] of a.slice(0, 500)) {
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < 1000 * 1000);
    assert.ok(c >= 0 && c <= 0xffffff);
    assert.ok(meta.owners[own], 'owner id resolves');
  }

  seedBody = bodyHash(r.body);
  /* Bump this deliberately, never to make the suite green: it is the tripwire
     that says the committed artwork moved. Last set when the wall was
     rebranded to S37 and the five unlicensed sponsor logos came out of it. */
  assert.equal(SEED_HASH, 'f17635c8109f630b', 'seed.bin itself changed');
  assert.equal(seedBody, SEED_HASH, 'pixel payload drifted from the seed');

  /* the owner table is index-addressed by every entry above, so it has to
     survive the round trip through users/submissions exactly */
  const seedMeta = decodeEnvelope(fs.readFileSync(path.join(__dirname, '..', 'seed.bin'))).meta;
  assert.deepEqual(meta.owners, seedMeta.owners, 'owner table');
  assert.deepEqual(meta.brands, seedMeta.brands);
  assert.deepEqual(meta.nextBrands, seedMeta.nextBrands);
});

test('round-trips through the client codec unchanged', async () => {
  const r = await req('GET', '/api/wall');
  const { meta, a, b } = decodeEnvelope(r.body);
  const again = decodeEnvelope(encodeEnvelope(meta, a, b));
  assert.equal(again.a.length, a.length);
  assert.deepEqual(again.a[0], a[0]);
  assert.deepEqual(again.b[b.length - 1], b[b.length - 1]);
});

/* ── claiming ─────────────────────────────────────────────────── */

test('POST /api/claim paints, spends free pixels and shows up in the snapshot', async () => {
  const before = decodeEnvelope((await req('GET', '/api/wall')).body);
  const taken = new Set(before.a.map(([idx]) => idx));

  const want = [];
  for (let idx = 500500; want.length < 3; idx++) if (!taken.has(idx)) want.push([idx, 0xff00ff, 0]);

  const r = await getJson('POST', '/api/claim',
    encodeEnvelope({}, want), 'application/octet-stream');
  assert.equal(r.code, 200);
  assert.equal(r.json.placed, 3);
  assert.deepEqual(r.json.placedIdx, want.map(([idx]) => idx));
  assert.equal(r.json.usedFree, 3);
  assert.equal(r.json.usedPaint, 0);
  assert.equal(r.json.occupied, 0);
  assert.equal(r.json.short, 0);
  assert.equal(r.json.free, 17);
  assert.equal(r.json.cap, 20);

  const after = decodeEnvelope((await req('GET', '/api/wall')).body);
  assert.equal(after.a.length, SEED_LIVE + 3);
  assert.equal(after.meta.rev, 1, 'a paint bumps the revision');
  const painted = new Map(after.a.map(([idx, c, o]) => [idx, [c, o]]));
  for (const [idx] of want) assert.equal(painted.get(idx)[0], 0xff00ff);
  assert.equal(after.meta.owners[painted.get(want[0][0])[1]].t, 'u', 'owned as a user');

  /* claiming an occupied cell is reported, not fatal */
  const again = await getJson('POST', '/api/claim',
    encodeEnvelope({}, [want[0]]), 'application/octet-stream');
  assert.equal(again.json.placed, 0);
  assert.equal(again.json.occupied, 1);
  assert.equal(again.json.free, 17, 'a rejected claim costs nothing');
});

test('GET /api/allowance matches what the claim reported', async () => {
  const r = await getJson('GET', '/api/allowance');
  assert.equal(r.code, 200);
  assert.equal(r.json.free, 17);
  assert.equal(r.json.cap, 20);
  assert.equal(r.json.paint, 0);
  assert.match(r.json.handle, /^Pixel fan #\d{4}$/);
});

test('POST /api/dev/refill hands the free pixels back', async () => {
  const r = await getJson('POST', '/api/dev/refill');
  assert.equal(r.code, 200);
  assert.equal(r.json.free, 20);
  assert.equal(r.json.refillAt, 0);
  assert.equal(r.json.refillIn, 0);
});

/* ── the page itself ──────────────────────────────────────────── */

test('serves the static page', async () => {
  const r = await req('GET', '/');
  assert.equal(r.code, 200);
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.match(r.body.toString('utf8'), /<canvas/i);

  const js = await req('GET', '/app.js');
  assert.equal(js.code, 200);
  assert.equal(js.type, 'text/javascript; charset=utf-8');
});

test('refuses to serve state files or climb out of the root', async () => {
  for (const p of ['/.wall.bin', '/.allowance.json', '/.git/config']) {
    assert.equal((await req('GET', p)).code, 404, p);
  }
  assert.equal((await req('GET', '/nope.txt')).code, 404);
  assert.equal((await req('POST', '/index.html')).code, 405);
});

test('unknown api routes are json 404s', async () => {
  const r = await getJson('GET', '/api/nothing');
  assert.equal(r.code, 404);
  assert.deepEqual(r.json, { error: 'not found' });
});
