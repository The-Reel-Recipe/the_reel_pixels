/* ═══════════════════════════════════════════════════════════════
   admin test — the promises Phase 6 makes

   The panel can erase a month of work and move money, so the door
   gets the most attention here: that a password alone is not enough,
   that a code is good exactly once, that a tampered or revoked
   cookie is worth nothing, and that a mutation without the header
   the panel sends is refused however valid the session is.

   Then the half that matters operationally: that the panel and the
   bot are the same state machine, so two people deciding the same
   submission at the same moment produce one decision; that a
   takedown of paid-for pixels owes the money back; and that a price
   change is live in the next snapshot without a restart, which is
   the whole point of the config table.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-admin-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
process.env.TG_MODE = 'webhook';
process.env.SESSION_SECRET = 'a-test-session-secret-long-enough';
process.env.IP_CLAIM_CAP = '1000';
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ADMIN_IP_ALLOW;

const app = require('../server.js');
const dbm = require('../server/db.js');
const admin = require('../server/admin.js');
const settings = require('../server/settings.js');
const submissions = require('../server/submissions.js');
const payments = require('../server/payments.js');
const identity = require('../server/identity.js');
const wall = require('../server/wall.js');

const server = http.createServer(app);
let base = '';

/* ── helpers ──────────────────────────────────────────────────── */

const jar = new Map();
function req(method, url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'x-forwarded-for': opts.ip || '203.0.113.9' }, opts.headers || {});
    if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
    const useJar = opts.jar === undefined ? jar : opts.jar;
    if (useJar && useJar.size) headers.cookie = [...useJar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.cookie) headers.cookie = opts.cookie;
    const r = http.request(base + url, { method, headers }, res => {
      for (const line of res.headers['set-cookie'] || []) {
        const pair = line.split(';')[0], eq = pair.indexOf('=');
        if (eq > 0 && useJar) useJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
    });
    r.on('error', reject);
    r.end(body === undefined || body === null ? undefined : JSON.stringify(body));
  });
}
const json = async (...args) => {
  const r = await req(...args);
  let parsed = {};
  try { parsed = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not json */ }
  return { code: r.code, json: parsed, headers: r.headers };
};
/* the header the panel sends on every mutation (§7.1) */
const AS_PANEL = { headers: { 'x-admin': '1' } };

const codeFor = (secret, at = Date.now()) =>
  admin.hotp(admin.base32Decode(secret), Math.floor(at / 30000));

let acct;
const signIn = async (extra = {}) => json('POST', '/api/admin/login',
  Object.assign({ username: acct.username, password: 'a-long-test-password', code: codeFor(acct.secret) }, extra));

/* a guest with pixels, so there is something to take down */
const ENTRY = 9;
function envelope(px) {
  const j = Buffer.from('{}', 'utf8');
  const buf = Buffer.alloc(4 + j.length + 4 + px.length * ENTRY + 4);
  let o = 0;
  buf.writeUInt32LE(j.length, o); o += 4;
  j.copy(buf, o); o += j.length;
  buf.writeUInt32LE(px.length, o); o += 4;
  for (const [i, c] of px) {
    buf.writeUInt32LE(i, o); o += 4;
    buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}
let nextFree = 200000;
const freeRange = n => {
  const out = [];
  while (out.length < n) {
    const i = nextFree++;
    if (!wall.wall.live.has(i) && !wall.wall.pending.live.has(i)) out.push(i);
  }
  return out;
};
function guestClaim(n, ip) {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', ?, ?, ?)"
  ).run(`Pixel fan #${1000 + (nextFree % 8000)}`, now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
  const e = identity.rowFor(uid, now);
  const r = wall.claimPixels(e, freeRange(n).map(i => [i, 0x33aa77]), now);
  return { uid, sid: r.sid, idx: r.placedIdx };
}

test.before(async () => {
  acct = admin.createAdmin('tester', 'a-long-test-password');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  submissions.cancelPending(); payments.stopSweeper();
  server.close(); dbm.close();
});

/* ── §7.1 the door ────────────────────────────────────────────── */

test('there is no route that makes an admin', async () => {
  for (const p of ['/api/admin/signup', '/api/admin/register', '/api/admin/admins']) {
    const r = await json('POST', p, { username: 'x', password: 'y' }, AS_PANEL);
    assert.ok(r.code === 404 || r.code === 401, `${p} answered ${r.code}`);
  }
  assert.equal(admin.countAdmins().n, 1, 'still exactly the one the CLI made');
});

test('a password alone is not a sign-in', async () => {
  const noCode = await signIn({ code: '' });
  assert.equal(noCode.code, 401);
  const wrongCode = await signIn({ code: '000000' });
  assert.equal(wrongCode.code, 401);
  assert.equal(wrongCode.json.message, 'Wrong username, password or code.',
    'and it does not say which of the three was wrong');

  const wrongPass = await signIn({ password: 'not-the-password' });
  assert.equal(wrongPass.code, 401);
  assert.equal(wrongPass.json.message, 'Wrong username, password or code.');
});

test('a code is good once, and only near its own moment', async () => {
  const ok = await signIn();
  assert.equal(ok.code, 200);
  assert.equal(ok.json.username, 'tester');
  assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
  assert.match(ok.headers['set-cookie'][0], /SameSite=Strict/, '§7.1');

  /* the same code again, inside its own window */
  const replay = await json('POST', '/api/admin/login',
    { username: 'tester', password: 'a-long-test-password', code: codeFor(acct.secret) });
  assert.equal(replay.code, 401);
  assert.equal(replay.json.error, 'code-used');

  /* a code from an hour ago is not a code */
  const stale = admin.totpStep(acct.secret, codeFor(acct.secret, Date.now() - 3600e3), Date.now());
  assert.equal(stale, null);
  /* …but the neighbouring step is, for a phone whose clock drifts */
  assert.ok(admin.totpStep(acct.secret, codeFor(acct.secret, Date.now() - 30000), Date.now()) !== null);
});

test('the panel needs a session, and a real one', async () => {
  const out = await json('GET', '/api/admin/overview', null, { jar: new Map() });
  assert.equal(out.code, 401);

  const good = jar.get('adm');
  assert.ok(good, 'signed in from the test above');

  /* one character of the signature changed */
  const bits = good.split('.');
  const tampered = `${bits[0]}.${bits[1]}.${bits[2].slice(0, -1)}${bits[2].slice(-1) === 'A' ? 'B' : 'A'}`;
  const forged = await json('GET', '/api/admin/overview', null, { jar: null, cookie: `adm=${tampered}` });
  assert.equal(forged.code, 401);

  /* somebody else's id in an otherwise valid-looking cookie */
  const swapped = await json('GET', '/api/admin/overview', null,
    { jar: null, cookie: `adm=999.${bits[1]}.${bits[2]}` });
  assert.equal(swapped.code, 401);

  const fine = await json('GET', '/api/admin/overview');
  assert.equal(fine.code, 200);
});

test('a mutation without the panel header is refused', async () => {
  /* the session is valid — this is only about the header (§7.1, CSRF) */
  const bare = await json('POST', '/api/admin/system/worker-restart', {});
  assert.equal(bare.code, 403);
  assert.equal(bare.json.error, 'bad-request');

  const withIt = await json('POST', '/api/admin/system/worker-restart', {}, AS_PANEL);
  assert.equal(withIt.code, 200);
});

test('bumping the epoch kills every session that admin holds', async () => {
  const before = await json('GET', '/api/admin/me');
  assert.equal(before.code, 200);

  admin.revokeSessions(acct.id, 'test');
  const after = await json('GET', '/api/admin/me');
  assert.equal(after.code, 401, 'the cookie is unchanged and worthless');

  /* and a fresh sign-in works again */
  jar.clear();
  await new Promise(r => setTimeout(r, 30000 - (Date.now() % 30000) + 50));   // a new step
  assert.equal((await signIn()).code, 200);
});

test('five wrong tries and the address is held off', async () => {
  const ip = '198.51.100.77';
  for (let i = 0; i < admin.LOGIN_TRIES; i++) {
    const r = await json('POST', '/api/admin/login',
      { username: 'tester', password: 'wrong', code: '123456' }, { ip, jar: null });
    assert.equal(r.code, 401);
  }
  const blocked = await json('POST', '/api/admin/login',
    { username: 'tester', password: 'a-long-test-password', code: codeFor(acct.secret) },
    { ip, jar: null });
  assert.equal(blocked.code, 429, 'even with the right credentials');
});

test('the panel itself is not readable without a session', async () => {
  const gate = await req('GET', '/admin', null, { jar: null });
  assert.equal(gate.code, 200, 'the sign-in form is public');

  for (const asset of ['/admin/panel.js', '/admin/panel.css']) {
    const r = await req('GET', asset, null, { jar: null });
    assert.equal(r.code, 403, `${asset} should need a session`);
  }
  assert.equal((await req('GET', '/admin/panel.js')).code, 200, 'and be served with one');
});

test('the static server no longer hands out the source', async () => {
  for (const p of ['/server/config.js', '/server/admin.js', '/package.json',
    '/migrations/001_init.sql', '/test/admin.test.js', '/seed.bin']) {
    const r = await req('GET', p, null, { jar: null });
    assert.equal(r.code, 404, `${p} answered ${r.code}`);
  }
  assert.equal((await req('GET', '/app.js', null, { jar: null })).code, 200);
  assert.equal((await req('GET', '/assets/logo-icon.png', null, { jar: null })).code, 200);
});

/* ── §7.2 the same state machine, from a different button ─────── */

test('the panel and the bot cannot both decide one submission', async () => {
  const g = guestClaim(3);
  const viaPanel = await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);
  assert.equal(viaPanel.code, 200);

  /* the moderator taps Approve in Telegram a second later */
  const viaBot = submissions.approve(g.sid, 'tg:1 (sara)');
  assert.equal(viaBot.ok, false);
  assert.equal(viaBot.already, 'approved');
  assert.equal(viaBot.by, 'admin:tester', 'and it can say who got there first');

  /* and the reverse: the bot first, the panel second */
  const g2 = guestClaim(2);
  assert.equal(submissions.approve(g2.sid, 'tg:1 (sara)').ok, true);
  const late = await json('POST', `/api/admin/submissions/${g2.sid}/reject`, { reason: 'no' }, AS_PANEL);
  assert.equal(late.code, 409);
});

test('a takedown erases live pixels and owes the money back', async () => {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('brand', 'PAID CO.', ?, ?)"
  ).run(now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);

  const idxs = freeRange(12);
  const booked = wall.bookBrand({ id: uid, handle: 'PAID CO.' },
    { name: 'PAID CO.', url: 'https://paid.example' }, idxs.map(i => [i, 0x884422]), now);
  const order = dbm.tx(() => payments.createOrder(uid, 'brand_booking',
    { px: booked.booked, sid: booked.sid }, now));
  dbm.db.prepare("UPDATE payments SET status = 'verified', verified_at = ?, verified_by = 'tg:1' WHERE id = ?")
    .run(now, order.id);
  assert.equal(submissions.approve(booked.sid, 'admin:tester').ok, true);
  for (const i of idxs) assert.ok(wall.wall.reserved.has(i), 'live on the next layer');

  const down = await json('POST', `/api/admin/submissions/${booked.sid}/takedown`,
    { reason: 'trademark complaint' }, AS_PANEL);
  assert.equal(down.code, 200);
  for (const i of idxs) assert.equal(wall.wall.reserved.has(i), false, 'gone from the wall');
  assert.equal(payments.get(order.id).status, 'refund_due',
    'never keep money for pixels that are no longer up');

  const ev = dbm.db.prepare(
    "SELECT actor, payload FROM events WHERE action = 'takedown' ORDER BY id DESC").get();
  assert.equal(ev.actor, 'admin:tester');
  assert.match(ev.payload, /trademark complaint/);
});

test('a region wipe takes down everything it touches', async () => {
  /* two claims side by side in a corner nothing else uses */
  const put = (n, at) => {
    const now = Date.now();
    const uid = Number(dbm.db.prepare(
      "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', 'wiper', ?, ?)"
    ).run(now, now).lastInsertRowid);
    dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
    const e = identity.rowFor(uid, now);
    const px = [];
    for (let i = 0; i < n; i++) px.push([at + i, 0x5522aa]);
    const r = wall.claimPixels(e, px, now);
    submissions.approve(r.sid, 'admin:tester');
    return r.sid;
  };
  const a = put(4, 900 * 1000 + 900);
  const b = put(4, 901 * 1000 + 900);

  const r = await json('POST', '/api/admin/wall/erase-region',
    { rect: { x0: 895, y0: 899, x1: 910, y1: 902 }, reason: 'spam block' }, AS_PANEL);
  assert.equal(r.code, 200);
  assert.deepEqual(r.json.submissions.sort(), [a, b].sort());
  assert.equal(wall.wall.live.has(900 * 1000 + 900), false);
  assert.equal(wall.wall.live.has(901 * 1000 + 901), false);
});

test('the dangerous buttons need the phrase typed', async () => {
  const wrong = await json('POST', '/api/admin/wall/reset', { phrase: 'yes' }, AS_PANEL);
  assert.equal(wrong.code, 400);
  assert.equal(wrong.json.error, 'confirm');
  const wrong2 = await json('POST', '/api/admin/wall/reseed', { phrase: 'RESET THE WALL' }, AS_PANEL);
  assert.equal(wrong2.code, 400, 'and it is a different phrase for each');
});

/* ── §7.2 users ───────────────────────────────────────────────── */

test('banning stops the account and the cookie with it', async () => {
  const g = guestClaim(1);
  const before = identity.rowFor(g.uid, Date.now());
  const cookie = identity.sessionCookie(before, Date.now()).split(';')[0];

  const r = await json('POST', `/api/admin/users/${g.uid}/ban`, { reason: 'painted something vile' }, AS_PANEL);
  assert.equal(r.code, 200);
  assert.equal(dbm.db.prepare('SELECT status FROM users WHERE id = ?').get(g.uid).status, 'banned');

  /* the cookie they are holding was signed against the old epoch */
  const stillIn = identity.verifyCookie(cookie.split('=')[1], Date.now());
  assert.equal(stillIn, null, 'a ban has to log them out, not just mark them');
});

test('an adjustment says why, or it does not happen', async () => {
  const g = guestClaim(1);
  const bare = await json('POST', `/api/admin/users/${g.uid}/adjust`, { paint: 500 }, AS_PANEL);
  assert.equal(bare.code, 400);
  assert.equal(bare.json.error, 'reason-required');

  const ok = await json('POST', `/api/admin/users/${g.uid}/adjust`,
    { paint: 500, reason: 'goodwill after a bad refund' }, AS_PANEL);
  assert.equal(ok.code, 200);
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(g.uid).paint, 500);
  const ev = dbm.db.prepare("SELECT payload FROM events WHERE action = 'user-adjust' ORDER BY id DESC").get();
  assert.match(ev.payload, /goodwill/);
});

/* ── §7.2 payments ────────────────────────────────────────────── */

test('an override is whitelisted, reasoned, and audited', async () => {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', 'payer', ?, ?)"
  ).run(now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
  const order = dbm.tx(() => payments.createOrder(uid, 'paint_pack', { pack: 25 }, now));
  dbm.db.prepare("UPDATE payments SET status = 'rejected' WHERE id = ?").run(order.id);

  const nonsense = await json('POST', `/api/admin/payments/${order.id}/override`,
    { to: 'verified', reason: 'because' }, AS_PANEL);
  assert.equal(nonsense.code, 400, 'rejected → verified is not an allowed move');
  assert.equal(payments.get(order.id).status, 'rejected');

  const noReason = await json('POST', `/api/admin/payments/${order.id}/override`,
    { to: 'submitted' }, AS_PANEL);
  assert.equal(noReason.code, 400);

  const ok = await json('POST', `/api/admin/payments/${order.id}/override`,
    { to: 'submitted', reason: 'payer sent the receipt by email' }, AS_PANEL);
  assert.equal(ok.code, 200);
  assert.equal(payments.get(order.id).status, 'submitted');
});

test('the ledger exports as CSV', async () => {
  const r = await req('GET', '/api/admin/payments?format=csv');
  assert.equal(r.code, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  const lines = r.body.toString('utf8').split('\n');
  assert.match(lines[0], /^id,created_at,kind,code,status,amount/);
  assert.ok(lines.length > 1, 'and has rows in it');
});

/* ── §7.2 config ──────────────────────────────────────────────── */

test('a price change is live in the next snapshot, with no restart', async () => {
  const price = async () => {
    const r = await req('GET', '/api/wall', null, { jar: new Map() });
    const meta = JSON.parse(r.body.toString('utf8', 4, 4 + r.body.readUInt32LE(0)));
    return meta.prices.company;
  };
  assert.equal(await price(), 10);

  const set = await json('PUT', '/api/admin/config', { key: 'price_company', value: 25 }, AS_PANEL);
  assert.equal(set.code, 200);
  assert.equal(await price(), 25);
  assert.equal(settings.S.PRICE_COMPANY, 25, 'and the server agrees with what it served');

  const back = await json('PUT', '/api/admin/config', { key: 'price_company', reset: true }, AS_PANEL);
  assert.equal(back.code, 200);
  assert.equal(await price(), 10);
});

test('a setting that makes no sense is refused', async () => {
  for (const [key, value] of [['cap', -5], ['price_paint', 0], ['packs', 'not json'],
    ['maintenance', 'perhaps'], ['nonsense_key', 1]]) {
    const r = await json('PUT', '/api/admin/config', { key, value }, AS_PANEL);
    assert.equal(r.code, 400, `${key}=${value} was accepted`);
  }
  assert.equal(settings.S.CAP, 20, 'and nothing moved');
});

test('maintenance mode closes the wall to writes and leaves reads alone', async () => {
  await json('PUT', '/api/admin/config', { key: 'maintenance', value: true }, AS_PANEL);

  const visitor = new Map();
  const read = await req('GET', '/api/wall', null, { jar: visitor });
  assert.equal(read.code, 200, 'the wall is still readable');

  const claim = await req('POST', '/api/claim', null, { jar: visitor });
  assert.equal(claim.code, 503);

  const order = await json('POST', '/api/paint/order', { pack: 25 }, { jar: visitor });
  assert.equal(order.code, 503);
  assert.equal(order.json.error, 'maintenance');

  await json('PUT', '/api/admin/config', { key: 'maintenance', value: false }, AS_PANEL);
  const after = await req('GET', '/api/wall', null, { jar: visitor });
  assert.equal(after.code, 200);
});

/* ── §7.1 the panel is auditable from the panel ───────────────── */

test('every admin action left a trail', async () => {
  const r = await json('GET', '/api/admin/events?actor=admin:tester&limit=200');
  assert.equal(r.code, 200);
  const actions = new Set(r.json.rows.map(e => e.action));
  for (const a of ['takedown', 'region-wipe', 'user-ban', 'user-adjust',
    'payment-override', 'config-set', 'config-reset']) {
    assert.ok(actions.has(a), `${a} is missing from the audit log`);
  }
  for (const row of r.json.rows) assert.equal(row.actor, 'admin:tester');
});

/* ── the allowlist in front of the door ───────────────────────── */

test('ADMIN_IP_ALLOW keeps everyone else out', () => {
  const real = require('../server/config.js').ADMIN_IP_ALLOW;
  real.push('203.0.113.0/24', '198.51.100.7');
  try {
    assert.equal(admin.ipAllowed('203.0.113.9'), true);
    assert.equal(admin.ipAllowed('203.0.113.255'), true);
    assert.equal(admin.ipAllowed('198.51.100.7'), true);
    assert.equal(admin.ipAllowed('198.51.100.8'), false);
    assert.equal(admin.ipAllowed('192.0.2.1'), false);
  } finally { real.length = 0; }
  assert.equal(admin.ipAllowed('192.0.2.1'), true, 'and an empty list allows everyone');
});
