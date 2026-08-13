/* ═══════════════════════════════════════════════════════════════
   moderation test — the promises Phase 3 makes

   Nothing reaches the wall without a decision (PLAN §5), so this file
   is about the gap between claiming and appearing: that the ground is
   held the instant somebody clicks (§4.4), that only the claimant can
   see what they are waiting on, that a decision is idempotent however
   many times a moderator taps it (§4.5), and that a wipe settles
   everything still waiting rather than dropping it on the floor (§4,
   pending-at-reset).

   TG_MODE=webhook throughout: with no bot attached nothing decides
   anything on its own, which is what makes these assertions
   repeatable. The auto-approve path TG_MODE=off provides is the last
   test in the file and runs in its own process, because it is a
   different configuration of the same server.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-moderation-'));
const STATE_DIR = path.join(TMP, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

process.env.STATE_DIR = STATE_DIR;
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';                  // one process, several visitors
process.env.TG_MODE = 'webhook';                // nothing decides by itself
process.env.IP_CLAIM_CAP = '1000';
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ALLOW_ORIGIN;

const app = require('../server.js');
const dbm = require('../server/db.js');
const wall = require('../server/wall.js');
const submissions = require('../server/submissions.js');
const identity = require('../server/identity.js');
const cfg = require('../server/config.js');

/* ── helpers ──────────────────────────────────────────────────── */

const ENTRY = 9;
function encodeEnvelope(meta, a) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const buf = Buffer.alloc(4 + json.length + 4 + a.length * ENTRY + 4);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  buf.writeUInt32LE(a.length, o); o += 4;
  for (const [i, c] of a) {
    buf.writeUInt32LE(i, o); o += 4;
    buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}
function decodeEnvelope(buf) {
  let o = 0;
  const n = buf.readUInt32LE(o); o += 4;
  const meta = JSON.parse(buf.toString('utf8', o, o + n)); o += n;
  const read = () => {
    const c = buf.readUInt32LE(o); o += 4;
    const out = [];
    for (let i = 0; i < c; i++) {
      out.push([buf.readUInt32LE(o), (buf[o + 4] << 16) | (buf[o + 5] << 8) | buf[o + 6]]);
      o += ENTRY;
    }
    return out;
  };
  return { meta, a: read(), b: read() };
}

const server = http.createServer(app);
let base = '';

const visitor = ip => ({ ip, jar: new Map() });

function req(who, method, url, body, type) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-forwarded-for': who.ip };
    if (body) headers['content-type'] = type || 'application/json';
    if (who.jar.size) headers.cookie = [...who.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = http.request(base + url, { method, headers }, res => {
      for (const line of res.headers['set-cookie'] || []) {
        const pair = line.split(';')[0], eq = pair.indexOf('=');
        if (eq > 0) who.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const json = async (who, method, url, body) => {
  const r = await req(who, method, url, body ? JSON.stringify(body) : null);
  return { code: r.code, json: JSON.parse(r.body.toString('utf8')) };
};
const snapshot = async who => decodeEnvelope((await req(who, 'GET', '/api/wall')).body);
const claim = (who, px) => json2(who, '/api/claim', encodeEnvelope({}, px));
async function json2(who, url, buf) {
  const r = await req(who, 'POST', url, buf, 'application/octet-stream');
  return { code: r.code, json: JSON.parse(r.body.toString('utf8')) };
}

const uidOf = who => Number(String(who.jar.get('uid') || '').split('.')[0].replace(/^b/, ''));

/* free ground, avoiding anything already held on either layer in any state */
let nextFree = 300000;
function freeRange(n) {
  const out = [];
  while (out.length < n) {
    const idx = nextFree++;
    if (!wall.wall.live.has(idx) && !wall.wall.pending.live.has(idx)) out.push(idx);
  }
  return out;
}
const statusOf = sid =>
  dbm.db.prepare('SELECT status FROM submissions WHERE id = ?').get(sid).status;
const cellCount = sid =>
  dbm.db.prepare('SELECT COUNT(*) n FROM cells WHERE submission_id = ?').get(sid).n;

/* the SSE hub, without a socket: http.js keeps the client set, so a fake
   response object is enough to read what would have gone down the wire */
const httpMod = require('../server/http.js');
function listen() {
  const seen = [];
  const fake = { write: line => { if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6))); } };
  httpMod.clients.add(fake);
  return { seen, stop: () => httpMod.clients.delete(fake) };
}

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { submissions.cancelPending(); server.close(); dbm.close(); });

/* ── §4.4 the ground is held at submit time ───────────────────── */

test('a claim is held, not painted — and only its owner can see it', async () => {
  const me = visitor('203.0.113.10'), other = visitor('203.0.113.11');
  const px = freeRange(3);
  const r = await claim(me, px.map(i => [i, 0xff3366]));

  assert.equal(r.json.placed, 3);
  assert.equal(r.json.pending, true);
  assert.ok(r.json.sid > 0);
  assert.equal(statusOf(r.json.sid), 'pending');

  const mine = await snapshot(me);
  assert.deepEqual(mine.meta.pending.live.map(([i]) => i), px, 'the claimant sees their own');
  for (const i of px) assert.ok(!mine.a.some(([j]) => j === i), 'not on the public wall');

  const theirs = await snapshot(other);
  assert.deepEqual(theirs.meta.pending.live, [], 'nobody else sees it');

  /* …but the ground is gone all the same: the PK settled it on submit */
  const grab = await claim(other, [[px[0], 0x00ff00]]);
  assert.equal(grab.json.placed, 0);
  assert.equal(grab.json.occupied, 1);
});

/* ── approval ─────────────────────────────────────────────────── */

test('approval puts the pixels up and clears the overlay', async () => {
  const me = visitor('203.0.113.20');
  const px = freeRange(2);
  const r = await claim(me, px.map(i => [i, 0x1188ff]));
  const bus = listen();

  const done = submissions.approve(r.json.sid, 'tg:99 (sara)');
  assert.equal(done.ok, true);
  assert.equal(statusOf(r.json.sid), 'approved');

  const paint = bus.seen.find(e => e.t === 'paint');
  const mod = bus.seen.find(e => e.t === 'mod');
  bus.stop();
  assert.ok(paint, 'everyone is told the wall changed');
  assert.deepEqual(paint.px.map(([i]) => i).sort(), px.slice().sort());
  assert.deepEqual(mod, { t: 'mod', sid: r.json.sid, status: 'approved' },
    'and the submitter is told their submission moved');
  assert.equal(mod.rev, undefined, 'a decision is not a wall revision');

  const after = await snapshot(me);
  assert.deepEqual(after.meta.pending.live, []);
  for (const i of px) assert.ok(after.a.some(([j]) => j === i), 'now public');
  assert.equal(dbm.db.prepare(
    "SELECT COUNT(*) n FROM cells WHERE submission_id = ? AND state = 'live'").get(r.json.sid).n, 2);
});

/* ── rejection ────────────────────────────────────────────────── */

test('rejection frees the ground and says why', async () => {
  const me = visitor('203.0.113.30'), other = visitor('203.0.113.31');
  const px = freeRange(2);
  const r = await claim(me, px.map(i => [i, 0x9900ff]));

  const bus = listen();
  assert.equal(submissions.reject(r.json.sid, 'tg:99 (sara)', 'not on a charity wall').ok, true);
  const removed = bus.seen.find(e => e.t === 'paint-remove');
  bus.stop();

  assert.equal(statusOf(r.json.sid), 'rejected');
  assert.equal(cellCount(r.json.sid), 0, 'the cells are gone, not just hidden');
  assert.equal(removed, undefined, 'nothing to remove from a wall it never reached');

  const mine = await snapshot(me);
  assert.deepEqual(mine.meta.pending.live, [], 'the overlay clears');

  /* somebody else can have the ground now */
  const grab = await claim(other, [[px[0], 0x00ff00]]);
  assert.equal(grab.json.placed, 1, 'the pixel is free again');

  const hist = await json(me, 'GET', '/api/me/history');
  const row = hist.json.rows.find(h => h.sid === r.json.sid);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reason, 'not on a charity wall');
});

/* ── §4.5 idempotency ─────────────────────────────────────────── */

test('a second tap decides nothing and says who got there first', async () => {
  const me = visitor('203.0.113.40');
  const r = await claim(me, freeRange(1).map(i => [i, 0x334455]));

  const first = submissions.approve(r.json.sid, 'tg:1 (sara)');
  const second = submissions.approve(r.json.sid, 'tg:2 (omar)');
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, already: 'approved', by: 'tg:1 (sara)', sid: r.json.sid });

  /* and the other button is just as refused — no un-approving by tapping */
  const flip = submissions.reject(r.json.sid, 'tg:2 (omar)', 'changed my mind');
  assert.equal(flip.ok, false);
  assert.equal(flip.already, 'approved');
  assert.equal(statusOf(r.json.sid), 'approved');

  assert.equal(dbm.db.prepare(
    "SELECT COUNT(*) n FROM events WHERE action = 'approve' AND json_extract(payload,'$.sid') = ?"
  ).get(r.json.sid).n, 1, 'one decision, one journal line');
});

/* ── §7.2 takedown ────────────────────────────────────────────── */

test('a takedown erases pixels that were already public', async () => {
  const me = visitor('203.0.113.50');
  const px = freeRange(3);
  const r = await claim(me, px.map(i => [i, 0xabcdef]));
  submissions.approve(r.json.sid, 'tg:1 (sara)');
  assert.ok(wall.wall.live.has(px[0]));

  const bus = listen();
  const down = submissions.takedown(r.json.sid, 'admin:mohab', 'reported');
  const removed = bus.seen.find(e => e.t === 'paint-remove');
  bus.stop();

  assert.equal(down.ok, true);
  assert.equal(statusOf(r.json.sid), 'rejected');
  assert.ok(removed, 'every client has to be told this time');
  assert.deepEqual(removed.px.slice().sort(), px.slice().sort());
  for (const i of px) assert.equal(wall.wall.live.has(i), false);

  const after = await snapshot(me);
  for (const i of px) assert.ok(!after.a.some(([j]) => j === i), 'off the public wall');

  /* a pending submission cannot be taken down — different guard, and the
     erase path for those is reject */
  const other = await claim(me, freeRange(1).map(i => [i, 0x111111]));
  assert.equal(submissions.takedown(other.json.sid, 'admin:mohab', 'x').ok, false);
});

/* ── history ──────────────────────────────────────────────────── */

test('history carries the whole story, newest first', async () => {
  const me = visitor('203.0.113.60');
  const a = await claim(me, freeRange(2).map(i => [i, 0x010203]));
  const b = await claim(me, freeRange(1).map(i => [i, 0x040506]));
  submissions.approve(a.json.sid, 'tg:1 (sara)');

  const h = await json(me, 'GET', '/api/me/history');
  assert.equal(h.code, 200);
  assert.equal(h.json.total, 2);
  assert.equal(h.json.rows[0].sid, b.json.sid, 'newest first');

  const first = h.json.rows.find(r => r.sid === a.json.sid);
  assert.equal(first.status, 'approved');
  assert.equal(first.type, 'free');
  assert.equal(first.px, 2);
  assert.equal(first.thumb.length, 2, 'enough to redraw it at thumbnail size');
  assert.equal(first.thumb[0].length, 3, '[dx, dy, colour] relative to the bbox');
  assert.ok(first.decidedAt > 0);
  assert.equal(first.payment, undefined, 'a free claim has no payment');

  const paged = await json(me, 'GET', '/api/me/history?limit=1&offset=1');
  assert.equal(paged.json.rows.length, 1);
  assert.equal(paged.json.rows[0].sid, a.json.sid);
  assert.equal(paged.json.total, 2);

  /* somebody else's submissions are not in it */
  const nosy = visitor('203.0.113.61');
  const theirs = await json(nosy, 'GET', '/api/me/history');
  assert.equal(theirs.json.total, 0);
});

test('a big submission still gets a thumbnail, capped', () => {
  const px = [];
  for (let i = 0; i < 5000; i++) px.push([i, 0x00ff00]);
  const blob = require('../server/seed.js').packPixels(px);
  const thumb = submissions.thumbOf(blob, [0, 0, 999, 4]);
  assert.ok(thumb.length > 0 && thumb.length <= 256, `capped, got ${thumb.length}`);
});

/* ── §4 the wipe settles what is still waiting ────────────────── */

test('a reset expires free pending work and hands paint back', async () => {
  const me = visitor('203.0.113.70');
  await req(me, 'GET', '/api/wall');                      // mint the identity
  const uid = uidOf(me);

  /* paint first, so the second claim is a 'paint' submission */
  await json(me, 'POST', '/api/paint', { pack: 25 });
  const free = await claim(me, freeRange(2).map(i => [i, 0x121212]));
  dbm.db.prepare('UPDATE allowances SET used = ? WHERE user_id = ?').run(cfg.CAP, uid);
  identity.cache.delete(uid);
  const paid = await claim(me, freeRange(3).map(i => [i, 0x131313]));
  assert.equal(dbm.db.prepare('SELECT type FROM submissions WHERE id = ?').get(paid.json.sid).type, 'paint');

  const paintBefore = dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(uid).paint;
  wall.resetCycle(Date.now(), wall.cycleStart(wall.cycleEnd(Date.now())));

  assert.equal(statusOf(free.json.sid), 'expired', 'the wall it aimed at is gone');
  assert.equal(statusOf(paid.json.sid), 'expired');
  assert.equal(cellCount(free.json.sid), 0);
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(uid).paint,
    paintBefore + 3, 'paint spent on pixels that will never exist comes back');

  const h = await json(me, 'GET', '/api/me/history');
  assert.equal(h.json.rows.find(r => r.sid === free.json.sid).status, 'expired');
});

test('an undecided booking expires when the wall it was booked for goes up', async () => {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('brand', ?, ?, ?)"
  ).run('LATE CO.', now, now).lastInsertRowid);

  const booked = wall.bookBrand({ id: uid, handle: 'LATE CO.' },
    { name: 'LATE CO.', url: 'https://late.example' },
    freeRange(4).map(i => [i, 0x778899]), now);
  assert.equal(booked.booked, 4);
  assert.equal(booked.pending, true);

  /* it is booked for the cycle after this one, so this reset promotes it
     rather than wiping it — and then it has run out of month */
  const r = wall.resetCycle(now, wall.cycleStart(wall.cycleEnd(now)));
  assert.equal(r.stale, 1, 'the booking missed its window');
  assert.equal(statusOf(booked.sid), 'expired');
  assert.equal(cellCount(booked.sid), 0);
});

/* ── TG_MODE=off ──────────────────────────────────────────────── */

/* A different configuration of the same server, so it gets its own process
   rather than a mutable global this one could read at the wrong moment. */
test('with no bot configured, submissions approve themselves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's37-auto-'));
  const script = `
    const wall = require(${JSON.stringify(path.join(ROOT, 'server', 'wall.js'))});
    const subs = require(${JSON.stringify(path.join(ROOT, 'server', 'submissions.js'))});
    const dbm  = require(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
    const now = Date.now();
    const uid = Number(dbm.db.prepare(
      "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest','auto',?,?)"
    ).run(now, now).lastInsertRowid);
    dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
    const e = { id: uid, handle: 'auto', kind: 'guest', used: 0, paint: 0, refillAt: 0 };
    const r = wall.claimPixels(e, [[12345, 0xff0000]], now);
    const before = dbm.db.prepare('SELECT status FROM submissions WHERE id = ?').get(r.sid).status;
    subs.afterCreate(r.sid);
    setTimeout(() => {
      const after = dbm.db.prepare('SELECT status FROM submissions WHERE id = ?').get(r.sid).status;
      console.log('###' + JSON.stringify({ before, after, decidedBy:
        dbm.db.prepare('SELECT decided_by b FROM submissions WHERE id = ?').get(r.sid).b }));
      dbm.close();
    }, 60);
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, STATE_DIR: dir, DATA_DIR: path.join(dir, 'data'), TG_MODE: 'off', AUTO_APPROVE_MS: '0' }
  });
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('###'));
  assert.ok(line, `child said nothing useful:\n${out.stdout}\n${out.stderr}`);
  assert.deepEqual(JSON.parse(line.slice(3)),
    { before: 'pending', after: 'approved', decidedBy: 'system:auto' });
});
