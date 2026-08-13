/* ═══════════════════════════════════════════════════════════════
   persistence test — the promises Phase 1 makes

   The contract suite proves the wire didn't move. This one proves
   the things that only became true once SQLite owned the pixels:
   a cell can be sold exactly once, an allowance can't be overspent
   by a burst, a claim outlives the process that took it, booting
   twice doesn't import the seed twice, and the monthly reset
   promotes, archives and refills in one transaction.

   DATA_DIR sits inside the (gitignored) data/ directory on purpose:
   it puts the database under the static root, which is where the
   serveStatic guard has to hold.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-persist-'));
const STATE_DIR = path.join(TMP, 'state');          // empty: no .wall.bin to inherit
const DATA_DIR = path.join(ROOT, 'data', `test-${process.pid}`);
fs.mkdirSync(STATE_DIR, { recursive: true });

process.env.STATE_DIR = STATE_DIR;
process.env.DATA_DIR = DATA_DIR;
/* This file fires ~60 claims from one address to prove the race and burst
   properties — well past the 40/day an IP gets in real life (§3). The cap
   itself is what identity.test.js is for; here it would only be measuring
   the test's own appetite. */
process.env.IP_CLAIM_CAP = '1000';
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ALLOW_ORIGIN;

const app = require('../server.js');
const dbm = require('../server/db.js');
const wall = require('../server/wall.js');
const cfg = require('../server/config.js');

/* Read out of the file rather than remembered — see contract.test.js. */
function seedCounts(file) {
  const buf = fs.readFileSync(file);
  let o = 4 + buf.readUInt32LE(0);              // past [u32 metaLen][meta]
  const live = buf.readUInt32LE(o); o += 4 + live * 9;
  return { live, booked: buf.readUInt32LE(o) };
}
const { live: SEED_LIVE, booked: SEED_BOOKED } = seedCounts(cfg.SEED_FILE);

/* ── envelope + request helpers ───────────────────────────────── */

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

const server = http.createServer(app);
let base = '';

/* One cookie jar for the file: identity rides on a signed cookie now, and
   these tests are all about one caller spending one allowance. */
const jar = new Map();
function req(method, url, body, type) {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'content-type': type || 'application/json' } : {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = http.request(base + url, { method, headers }, res => {
      for (const line of res.headers['set-cookie'] || []) {
        const pair = line.split(';')[0], eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const getJson = async (m, u, b, t) => {
  const r = await req(m, u, b, t);
  return { code: r.code, json: JSON.parse(r.body.toString('utf8')) };
};
const claim = px => getJson('POST', '/api/claim',
  encodeEnvelope({}, px), 'application/octet-stream');

/* the user id inside the jar's cookie — `<id>.<exp>.<sig>` (§3) */
const meId = () => Number(String(jar.get('uid') || '').split('.')[0]);

const cellsAt = idx => dbm.db.prepare(
  "SELECT COUNT(*) n FROM cells WHERE cycle = ? AND layer = 'live' AND idx = ?"
).get(wall.wall.cycle, idx).n;

/* A blank stretch of wall the seed never touches, handed out in slices so
   each test paints somewhere nobody else did. */
let nextFree = 700000;
function freeRange(n) {
  const out = [];
  while (out.length < n) {
    const idx = nextFree++;
    if (!wall.wall.live.has(idx)) out.push(idx);
  }
  return out;
}

/* ── a real second process, sharing the database ──────────────── */

/* WAL is what makes this safe: the child opens the same file while the
   parent still holds it, sees everything committed, and neither blocks.
   It is also the honest way to test durability — nothing in the parent's
   memory can carry the answer across. */
function bootChild(env) {
  const script = `
    require(${JSON.stringify(path.join(ROOT, 'server.js'))});
    const w = require(${JSON.stringify(path.join(ROOT, 'server', 'wall.js'))});
    const d = require(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
    const one = s => d.db.prepare(s).get().n;
    const probe = (process.env.PROBE || '').split(',').filter(Boolean).map(Number);
    console.log('###' + JSON.stringify({
      live: w.wall.live.size, booked: w.wall.reserved.size,
      users: one('SELECT COUNT(*) n FROM users'),
      subs: one('SELECT COUNT(*) n FROM submissions'),
      cells: one('SELECT COUNT(*) n FROM cells'),
      seedSource: d.getMeta('seed_source'),
      found: probe.filter(i => w.wall.live.has(i)),
      colors: probe.map(i => (w.wall.live.get(i) || {}).c)
    }));
    d.close();
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, STATE_DIR, DATA_DIR, ...env }
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('###'));
  assert.ok(line, `child produced no result\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(3));
}

test.before(() => new Promise(done => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
}));
test.after(() => {
  server.close();
  dbm.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ── boot ─────────────────────────────────────────────────────── */

test('a clean DATA_DIR migrates and imports the seed once', () => {
  /* 003 is missing on purpose: it drops legacy_keys, it is marked `-- @manual`
     in its first line, and the runner is required to hold it back until the
     cutover applies it by name (see server/db.js). */
  const applied = dbm.db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
  assert.deepEqual(applied.map(r => r.name),
    ['001_init.sql', '002_legacy_keys.sql', '004_identity.sql']);
  assert.deepEqual(dbm.migrate().deferred, ['003_drop_legacy_keys.sql'], 'the manual one ran anyway');
  assert.ok(dbm.db.prepare(
    "SELECT 1 n FROM sqlite_master WHERE type = 'table' AND name = 'legacy_keys'").get(),
  'legacy_keys is still needed — a visitor who has not been back yet is on it');

  assert.equal(wall.wall.live.size, SEED_LIVE);
  assert.equal(wall.wall.reserved.size, SEED_BOOKED);
  assert.equal(dbm.getMeta('seed_source'), 'seed.bin');

  /* one submission per owner per layer, one users row each plus `system` */
  const subs = dbm.db.prepare('SELECT COUNT(*) n FROM submissions').get().n;
  assert.equal(subs, wall.wall.owners.length);
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM cells').get().n, SEED_LIVE + SEED_BOOKED);
  assert.equal(dbm.db.prepare("SELECT COUNT(*) n FROM users WHERE handle = 'system'").get().n, 1);

  const ev = dbm.db.prepare("SELECT actor, action FROM events WHERE action = 'seed-import'").all();
  assert.deepEqual(ev, [{ actor: 'system', action: 'seed-import' }]);
});

test('booting again over the same database imports nothing', () => {
  const before = bootChild();
  const after = bootChild();
  assert.deepEqual(after, before, 'a second boot changed the row counts');
  assert.equal(after.live, SEED_LIVE);
  assert.equal(after.booked, SEED_BOOKED);
  assert.equal(after.seedSource, 'seed.bin');
  assert.equal(after.subs, wall.wall.owners.length, 'duplicate submissions');
});

/* ── §4.3 the cells primary key is the backstop ───────────────── */

test('the cells primary key refuses a second sale of the same pixel', () => {
  const [idx] = freeRange(1);
  const sid = dbm.db.prepare('SELECT id FROM submissions LIMIT 1').get().id;
  const uid = dbm.db.prepare('SELECT user_id FROM submissions WHERE id = ?').get(sid).user_id;
  const ins = dbm.db.prepare(
    `INSERT OR IGNORE INTO cells (cycle, layer, idx, color, submission_id, user_id, state)
     VALUES (?, 'live', ?, ?, ?, ?, 'live')`);

  let first, second, kept;
  try {
    dbm.tx(() => {
      first = ins.run(wall.wall.cycle, idx, 0x111111, sid, uid).changes;
      second = ins.run(wall.wall.cycle, idx, 0x222222, sid, uid).changes;
      kept = dbm.db.prepare(
        "SELECT color FROM cells WHERE cycle = ? AND layer = 'live' AND idx = ?"
      ).get(wall.wall.cycle, idx).color;
      throw new Error('rollback');          // leave the wall as we found it
    });
    assert.fail('the transaction should have thrown');
  } catch (err) {
    if (err.message !== 'rollback') throw err;
  }

  assert.equal(first, 1, 'first insert wins');
  assert.equal(second, 0, 'second is ignored, not an error');
  assert.equal(kept, 0x111111, 'the winner keeps the colour');
  assert.equal(cellsAt(idx), 0, 'and the rollback took even the winner back out');
});

test('two concurrent claims for the same pixel — exactly one wins', async () => {
  await getJson('POST', '/api/dev/refill');
  const [idx] = freeRange(1);

  const countSubs = () => dbm.db.prepare('SELECT COUNT(*) n FROM submissions').get().n;
  const before = countSubs();

  const [a, b] = await Promise.all([
    claim([[idx, 0xff0000]]),
    claim([[idx, 0x0000ff]])
  ]);

  const won = [a, b].filter(r => r.json.placed === 1);
  const lost = [a, b].filter(r => r.json.placed === 0);
  assert.equal(won.length, 1, 'both claims took the pixel');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].json.occupied, 1, 'the loser is told why');
  assert.equal(lost[0].json.short, 0);

  assert.equal(cellsAt(idx), 1, 'one row, one owner, no double sale');
  assert.equal(wall.wall.live.get(idx).c, a.json.placed === 1 ? 0xff0000 : 0x0000ff);

  /* the loser's transaction rolled all the way back — no orphan submission
     row, and the pixel it didn't get isn't billed to it either */
  assert.equal(countSubs(), before + 1);
  const cell = dbm.db.prepare(
    "SELECT submission_id FROM cells WHERE cycle = ? AND layer = 'live' AND idx = ?"
  ).get(wall.wall.cycle, idx);
  const sub = dbm.db.prepare('SELECT px_count, status FROM submissions WHERE id = ?').get(cell.submission_id);
  assert.deepEqual(sub, { px_count: 1, status: 'approved' });
  assert.equal(lost[0].json.free, won[0].json.free, 'a lost race costs nothing');
});

/* ── §4.6 an allowance can't be overspent by a burst ──────────── */

test('50 parallel claims never exceed the cap plus paint', async () => {
  await getJson('POST', '/api/dev/refill');
  const bought = await getJson('POST', '/api/paint', JSON.stringify({ pack: 25 }));
  assert.equal(bought.code, 200);

  const budget = bought.json.free + bought.json.paint;
  const idxs = freeRange(50);
  const results = await Promise.all(idxs.map(i => claim([[i, 0x00ff88]])));

  const placed = results.reduce((n, r) => n + r.json.placed, 0);
  assert.equal(placed, Math.min(50, budget), 'spent exactly the budget, no more');

  const after = await getJson('GET', '/api/allowance');
  assert.equal(after.json.free, 0, 'free pixels exhausted');
  assert.equal(after.json.paint, Math.max(0, budget - placed));
  assert.ok(after.json.refillAt > 0, 'the refill clock started');

  /* the DB agrees — the allowance and the cells committed together */
  const live = idxs.filter(i => cellsAt(i) === 1).length;
  assert.equal(live, placed);
  /* the caller is the cookie in the jar, not the connection — read the row
     back through the same identity the requests carried */
  const row = dbm.db.prepare('SELECT used, paint FROM allowances WHERE user_id = ?').get(meId());
  assert.equal(row.used, cfg.CAP);
  assert.equal(row.paint, after.json.paint);
});

/* ── §10 the pixels outlive the process ───────────────────────── */

test('claims survive a restart — a fresh process sees them', async () => {
  await getJson('POST', '/api/dev/refill');
  const idxs = freeRange(4);
  const r = await claim(idxs.map(i => [i, 0x7f00ff]));
  assert.equal(r.json.placed, 4);

  const child = bootChild({ PROBE: idxs.join(',') });
  assert.deepEqual(child.found, idxs, 'a new process rebuilt the wall without them');
  assert.deepEqual(child.colors, idxs.map(() => 0x7f00ff), 'colours came back wrong');
  assert.equal(child.live, wall.wall.live.size);
});

/* ── §4.7 the monthly reset ───────────────────────────────────── */

/* A fresh wall has nothing booked on it — the seed used to ship a fake
   Samsung reservation and this test quietly leaned on it. Book our own, so
   what is being tested is the promote mechanic and not the fixture. Goes
   through wall.bookBrand rather than POST /api/book because the brand gate
   is identity.test.js's subject, not this file's. */
function bookNextLayer(n) {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('brand', ?, ?, ?)"
  ).run('NILE SODA CO.', now, now).lastInsertRowid);
  const px = freeRange(n).map(i => [i, 0x2255ff]);
  const r = wall.bookBrand({ id: uid, handle: 'NILE SODA CO.' },
    { name: 'NILE SODA CO.', url: 'https://nile-soda.example' }, px, now);
  assert.equal(r.booked, n, 'the fixture booking did not land');
  return n;
}

test('a cycle reset promotes, archives and refills', async () => {
  const booked = bookNextLayer(120);
  const someBooked = [...wall.wall.reserved.keys()][0];
  const outgoing = wall.wall.cycle;

  await claim(freeRange(2).map(i => [i, 0x123456]));   // leave an allowance to reset
  const spent = await getJson('GET', '/api/allowance');
  assert.ok(spent.json.free < cfg.CAP);

  const r = await getJson('POST', '/api/dev/reset');
  assert.equal(r.code, 200);
  assert.equal(r.json.live, booked, 'the prepaid layer is the new wall');
  assert.equal(r.json.booked, 0);

  assert.equal(wall.wall.live.size, booked);
  assert.equal(wall.wall.reserved.size, 0);
  assert.ok(wall.wall.live.has(someBooked), 'a booked pixel went live');
  assert.ok(wall.wall.cycle > outgoing, 'the cycle moved on');

  const png = path.join(cfg.ARCHIVE_DIR, `${wall.monthKey(outgoing)}.png`);
  assert.ok(fs.existsSync(png), `no archive at ${png}`);
  const head = fs.readFileSync(png).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');

  const back = await getJson('GET', '/api/allowance');
  assert.equal(back.json.free, cfg.CAP, 'free pixels handed back');
  assert.equal(back.json.refillAt, 0);
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM allowances WHERE used > 0').get().n, 0);

  /* the outgoing wall is gone from cells, the promoted rows carry the new cycle */
  assert.equal(dbm.db.prepare(
    "SELECT COUNT(*) n FROM cells WHERE cycle = ? AND layer = 'live'").get(outgoing).n, 0);
  assert.equal(dbm.db.prepare(
    "SELECT COUNT(*) n FROM cells WHERE cycle = ? AND layer = 'live'").get(wall.wall.cycle).n, booked);
  const ev = dbm.db.prepare("SELECT payload FROM events WHERE action = 'reset'").get();
  assert.equal(JSON.parse(ev.payload).promoted, booked);
});

/* ── the database is not a static file ────────────────────────── */

test('the data directory is never served', async () => {
  const rel = path.relative(ROOT, cfg.DB_FILE).split(path.sep).join('/');
  assert.ok(!rel.startsWith('..'), 'this test only means something inside the root');
  for (const p of [`/${rel}`, `/${path.dirname(rel)}/`, `/${rel}-wal`]) {
    assert.equal((await req('GET', p)).code, 404, p);
  }
});
