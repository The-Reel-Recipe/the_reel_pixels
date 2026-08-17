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
const cfg = require('../server/config.js');
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
  /* the gate script is the exception: it is how anyone logs in at all */
  assert.equal((await req('GET', '/admin/gate.js', null, { jar: null })).code, 200,
    'the login page\'s own script must not need the session it exists to create');
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

  /* The cookie deliberately still verifies. Invalidating it was the old
     behaviour and it defeated the ban: an unverifiable cookie cannot say
     who it belongs to, so the next request minted the banned person a
     fresh identity. The status is what stops them, and reading it needs
     the cookie to stay readable. */
  const held = identity.verifyCookie(cookie.split('=')[1], Date.now());
  assert.ok(held, 'the cookie still names them');
  assert.equal(held.status, 'banned', '…and names them as banned, which is what resolve refuses on');
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
  const base = settings.DEFAULTS.price_company;
  assert.equal(await price(), base);

  const set = await json('PUT', '/api/admin/config', { key: 'price_company', value: 25 }, AS_PANEL);
  assert.equal(set.code, 200);
  assert.equal(await price(), 25);
  assert.equal(settings.S.PRICE_COMPANY, 25, 'and the server agrees with what it served');

  const back = await json('PUT', '/api/admin/config', { key: 'price_company', reset: true }, AS_PANEL);
  assert.equal(back.code, 200);
  assert.equal(await price(), base);
});

test('packs follow the paint price instead of restating it', async () => {
  /* A pack is an amount and a discount; the EGP is worked out. Written as
     prices they were a third copy of the rate, and moving the rate left
     every pack quoting the old one. */
  /* one jar for all three reads: a fresh one mints an identity, and this
     file's IP only gets five a day */
  const seat = new Map();
  const packs = async () => {
    const r = await req('GET', '/api/wall', null, { jar: seat });
    const meta = JSON.parse(r.body.toString('utf8', 4, 4 + r.body.readUInt32LE(0)));
    return meta.prices.packs;
  };
  const rate = settings.S.PRICE_PAINT;
  const before = await packs();
  assert.equal(before[100], Math.round(100 * rate * 0.8), '100 paint at 20% off');

  await json('PUT', '/api/admin/config', { key: 'price_paint', value: rate * 2 }, AS_PANEL);
  const after = await packs();
  assert.equal(after[100], before[100] * 2, 'double the rate, double every pack');
  assert.equal(settings.S.PACK_OFFERS[100], 20, 'and the discount is untouched');

  await json('PUT', '/api/admin/config', { key: 'price_paint', reset: true }, AS_PANEL);
  assert.deepEqual(await packs(), before);
});

test('a setting that makes no sense is refused', async () => {
  for (const [key, value] of [['cap', -5], ['price_paint', 0],
    ['maintenance', 'perhaps'], ['nonsense_key', 1],
    ['pack_offers', 'not json'], ['pack_offers', { 100: 95 }]]) {
    const r = await json('PUT', '/api/admin/config', { key, value }, AS_PANEL);
    assert.equal(r.code, 400, `${key}=${value} was accepted`);
  }
  assert.equal(settings.S.CAP, cfg.CAP, 'and nothing moved');
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

/* ── Erasure, and the hold that has to ship with it (M7) ───────── */

const eraseBody = reason => ({ reason, confirm: admin.PHRASE.erase });

test('erasing an account keeps the books and drops the person', async () => {
  const g = guestClaim(2);
  const now = Date.now();
  dbm.db.prepare("UPDATE users SET email = ?, pass_hash = 'x', handle = 'Chosen Name' WHERE id = ?")
    .run('gone@painter.example', g.uid);

  /* a verified payment, which is a book entry and has to survive */
  const pid = Number(dbm.db.prepare(
    `INSERT INTO payments (user_id, kind, pack, amount, code, status, created_at,
                           instapay_ref, payer_handle)
     VALUES (?, 'paint_pack', 100, 16000, 'S37-ERAS', 'verified', ?, '5011234567', 'them@instapay')`
  ).run(g.uid, now).lastInsertRowid);

  /* a journal line naming them */
  dbm.db.prepare('INSERT INTO events (ts, actor, action, payload) VALUES (?,?,?,?)')
    .run(now, `user:${g.uid}`, 'guest-mint', JSON.stringify({ ip: '41.33.7.9', keep: 'this' }));

  const r = await json('POST', `/api/admin/users/${g.uid}/erase`,
    eraseBody('the owner asked us to'), AS_PANEL);
  assert.equal(r.code, 200, JSON.stringify(r.json));

  const u = dbm.db.prepare('SELECT * FROM users WHERE id = ?').get(g.uid);
  assert.equal(u.email, null, 'the email is gone');
  assert.equal(u.pass_hash, null, 'and the password with it');
  assert.match(u.handle, /^Pixel fan #\d+$/, 'the chosen name is reset, as PRIVACY says');
  assert.ok(u.erased_at > 0);
  assert.equal(u.status, 'banned', 'the account can no longer act');

  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM submissions WHERE user_id = ?').get(g.uid).n, 0);
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM cells WHERE user_id = ?').get(g.uid).n, 0);

  const p = dbm.db.prepare('SELECT * FROM payments WHERE id = ?').get(pid);
  assert.ok(p, 'the payment row survives — it is a book entry on the tax clock');
  assert.equal(p.amount, 16000, 'and it still says how much');
  assert.equal(p.instapay_ref, null, 'but nothing on it points at a person any more');
  assert.equal(p.payer_handle, null);

  const line = dbm.db.prepare(
    "SELECT payload FROM events WHERE actor = ? AND action = 'guest-mint'").get(`user:${g.uid}`);
  const after = JSON.parse(line.payload);
  assert.equal(after.ip, undefined, 'the address is out of the journal line');
  assert.equal(after.keep, 'this', 'and the rest of the line is still there');
});

test('erasure logs them out — being forgotten is not being blocked', async () => {
  const g = guestClaim(1);
  const cookie = identity.sessionCookie(identity.rowFor(g.uid, Date.now()), Date.now()).split(';')[0];

  await json('POST', `/api/admin/users/${g.uid}/erase`, eraseBody('asked to be forgotten'), AS_PANEL);

  /* This is the one place erasure and a ban are deliberately opposite. A ban
     must NOT bump token_epoch, because a cookie that will not verify cannot
     be identified and the banned person would be handed a fresh identity —
     the very thing the ban is for. Erasure bumps it precisely so that
     happens: the whole request is to stop being recognised, and coming back
     as a stranger is what that means. */
  const res = await json('GET', '/api/me', null, { ip: '198.51.100.77', headers: { cookie } });
  assert.equal(res.code, 200, 'they are served, as a new visitor');
  assert.notEqual(res.json.handle, 'Chosen Name');

  const still = identity.verifyCookie(cookie.split('=')[1], Date.now());
  assert.equal(still, null, 'the old cookie no longer names anybody');
});

test('a legal hold stops an erasure, and says so', async () => {
  const g = guestClaim(1);

  const held = await json('POST', `/api/admin/users/${g.uid}/hold`,
    { reason: 'a complaint about this drawing' }, AS_PANEL);
  assert.equal(held.code, 200);
  assert.equal(dbm.db.prepare('SELECT legal_hold FROM users WHERE id = ?').get(g.uid).legal_hold, 1);
  assert.equal(dbm.db.prepare('SELECT legal_hold FROM submissions WHERE id = ?').get(g.sid).legal_hold, 1,
    'the drawing travels with the person — it is usually what the matter is about');

  const blocked = await json('POST', `/api/admin/users/${g.uid}/erase`,
    eraseBody('trying it on'), AS_PANEL);
  assert.equal(blocked.code, 409);
  assert.equal(blocked.json.error, 'legal-hold');
  assert.ok(dbm.db.prepare('SELECT id FROM submissions WHERE id = ?').get(g.sid),
    'and nothing was destroyed on the way to being refused');

  const lifted = await json('POST', `/api/admin/users/${g.uid}/unhold`,
    { reason: 'the matter closed' }, AS_PANEL);
  assert.equal(lifted.code, 200);
  const done = await json('POST', `/api/admin/users/${g.uid}/erase`, eraseBody('and now'), AS_PANEL);
  assert.equal(done.code, 200);
});

test('a held submission is not swept away on a timer either', () => {
  const g = guestClaim(1);
  dbm.db.prepare('UPDATE submissions SET legal_hold = 1, created_at = ?, cycle = ? WHERE id = ?')
    .run(Date.now() - 2000 * 86400000, 1, g.sid);

  const retention = require('../server/retention.js');
  retention.sweep(Date.now(), {
    identity: { dayKey: identity.dayKey, forget: () => {} },
    wall: { cycleStart: () => Date.now() }
  });

  assert.ok(dbm.db.prepare('SELECT id FROM submissions WHERE id = ?').get(g.sid),
    'a retention period that ignores a hold is the erase button on a timer, ' +
    'with nobody name against it');
});

test('erasure needs the phrase typed, like the other two irreversible things', async () => {
  const g = guestClaim(1);
  const noPhrase = await json('POST', `/api/admin/users/${g.uid}/erase`,
    { reason: 'no confirmation given' }, AS_PANEL);
  assert.equal(noPhrase.code, 400);
  assert.equal(noPhrase.json.error, 'confirm-required');

  const noReason = await json('POST', `/api/admin/users/${g.uid}/erase`,
    { confirm: admin.PHRASE.erase }, AS_PANEL);
  assert.equal(noReason.code, 400);
  assert.equal(noReason.json.error, 'reason-required');

  assert.ok(dbm.db.prepare('SELECT id FROM users WHERE id = ?').get(g.uid), 'still there');
});

test('erasing twice is refused rather than done twice', async () => {
  const g = guestClaim(1);
  assert.equal((await json('POST', `/api/admin/users/${g.uid}/erase`, eraseBody('once'), AS_PANEL)).code, 200);
  const again = await json('POST', `/api/admin/users/${g.uid}/erase`, eraseBody('twice'), AS_PANEL);
  assert.equal(again.code, 400);
  assert.equal(again.json.error, 'already-erased');
});

/* ── The cash refund of a paint pack (M4) ──────────────────────── */

let refundSeq = 0;
function verifiedPack(uid, paint) {
  dbm.db.prepare('UPDATE allowances SET paint = ? WHERE user_id = ?').run(paint, uid);
  identity.forget(uid);
  return Number(dbm.db.prepare(
    `INSERT INTO payments (user_id, kind, pack, amount, code, status, created_at)
     VALUES (?, 'paint_pack', 100, 16000, ?, 'verified', ?)`
  ).run(uid, `S37-RF${++refundSeq}`, Date.now()).lastInsertRowid);
}

test('refunding a pack takes the paint back in the same breath', async () => {
  const g = guestClaim(1);
  const pid = verifiedPack(g.uid, 140);           // 100 from the pack, 40 from elsewhere

  const r = await json('POST', `/api/admin/payments/${pid}/override`,
    { to: 'refund_due', reason: 'the wall is closing and they asked for it back' }, AS_PANEL);
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.paintDebited, 100);

  assert.equal(dbm.db.prepare('SELECT status FROM payments WHERE id = ?').get(pid).status, 'refund_due');
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(g.uid).paint, 40,
    'hand back the money, take back the pixels — otherwise reconcile() stops meaning anything');
});

test('a pack whose paint is already on the wall is refused, not silently clamped', async () => {
  const g = guestClaim(1);
  const pid = verifiedPack(g.uid, 30);            // 70 of the 100 already spent

  const r = await json('POST', `/api/admin/payments/${pid}/override`,
    { to: 'refund_due', reason: 'they asked for it back' }, AS_PANEL);
  assert.equal(r.code, 400);
  assert.equal(r.json.error, 'paint-spent');
  assert.match(r.json.message, /take back 100 paint and the balance is 30/);
  assert.match(r.json.message, /one balance rather than a pile per pack/,
    'the message must not attribute the spend to this pack — paint has no such identity');

  assert.equal(dbm.db.prepare('SELECT status FROM payments WHERE id = ?').get(pid).status, 'verified',
    'and nothing moved');
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(g.uid).paint, 30);
});

test('a double-tapped refund is one refund', async () => {
  const g = guestClaim(1);
  const pid = verifiedPack(g.uid, 250);

  const body = { to: 'refund_due', reason: 'refunding under the policy' };
  const a = await json('POST', `/api/admin/payments/${pid}/override`, body, AS_PANEL);
  const b = await json('POST', `/api/admin/payments/${pid}/override`, body, AS_PANEL);

  assert.equal(a.code, 200);
  assert.equal(b.code, 400, 'the second tap finds it already moved');
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(g.uid).paint, 150,
    'debited once, not twice');
});

test('a brand booking refund does not debit paint it never credited', async () => {
  const g = guestClaim(1);
  dbm.db.prepare('UPDATE allowances SET paint = 500 WHERE user_id = ?').run(g.uid);
  identity.forget(g.uid);
  const pid = Number(dbm.db.prepare(
    `INSERT INTO payments (user_id, kind, amount, code, status, created_at)
     VALUES (?, 'brand_booking', 50000, 'S37-BKRF', 'verified', ?)`
  ).run(g.uid, Date.now()).lastInsertRowid);

  const r = await json('POST', `/api/admin/payments/${pid}/override`,
    { to: 'refund_due', reason: 'we could not give them the space' }, AS_PANEL);
  assert.equal(r.code, 200);
  assert.equal(r.json.paintDebited, 0);
  assert.equal(dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(g.uid).paint, 500);
});

/* ── Reporting a pixel (TERMS §11) ─────────────────────────────── */

const reports = require('../server/reports.js');

test('anyone can report a pixel, including somebody with no account', async () => {
  const g = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);

  /* a passer-by, no account, no cookie history */
  const r = await json('POST', '/api/report',
    { idx: g.idx[0], reason: 'hate', note: 'it is a slur' }, { ip: '198.51.100.201' });
  assert.equal(r.code, 200, JSON.stringify(r.json));

  const row = reports.queue(20).find(x => x.submission === g.sid);
  assert.ok(row, 'it reaches the queue a moderator reads');
  assert.equal(row.reason, 'hate');
  assert.equal(row.note, 'it is a slur');
  assert.equal(row.status, 'approved', 'and says whether it is still up');
});

/* the card that carries it to the moderation group is proved in
   telegram.test.js, which is where a bot token exists to make on() true */

test('reporting the same batch twice does nothing the second time', async () => {
  const g = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);
  const ip = '198.51.100.203';

  const first = await json('POST', '/api/report', { idx: g.idx[0], reason: 'spam' }, { ip });
  const cookie = first.headers['set-cookie'];
  const opts = { ip, headers: cookie ? { cookie: String(cookie).split(';')[0] } : {} };

  const again = await json('POST', '/api/report', { idx: g.idx[1] || g.idx[0], reason: 'spam' }, opts);
  assert.equal(again.code, 200, 'answered as success — "you already reported this" is an invitation');

  const mine = reports.queue(200).filter(x => x.submission === g.sid);
  assert.equal(mine.length, 1, 'but the queue has it once');
});

test('a report about nothing is refused', async () => {
  const empty = await json('POST', '/api/report', { idx: 999999, reason: 'spam' }, { ip: '198.51.100.204' });
  assert.equal(empty.code, 404);
  assert.equal(empty.json.error, 'empty');

  const nonsense = await json('POST', '/api/report', { idx: -5, reason: 'spam' }, { ip: '198.51.100.205' });
  assert.equal(nonsense.code, 400);

  const offWall = await json('POST', '/api/report', { idx: 1000 * 1000, reason: 'spam' }, { ip: '198.51.100.206' });
  assert.equal(offWall.code, 400);
});

test('an unknown reason becomes "other" rather than being rejected', async () => {
  const g = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);

  const r = await json('POST', '/api/report',
    { idx: g.idx[0], reason: 'something-a-client-made-up' }, { ip: '198.51.100.207' });
  assert.equal(r.code, 200, 'the person who found the problem is not made to fight the form');
  assert.equal(reports.queue(50).find(x => x.submission === g.sid).reason, 'other');
});

test('a long note is cut, and an enormous one never gets read at all', async () => {
  const g = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);

  /* over the note cap, under the wire limit: trimmed on the way in */
  await json('POST', '/api/report',
    { idx: g.idx[0], reason: 'other', note: 'x'.repeat(2000) }, { ip: '198.51.100.208' });
  const row = reports.queue(50).find(x => x.submission === g.sid);
  assert.equal(row.note.length, reports.REASON_MAX);

  /* over the wire limit: refused before anything parses it, which is the
     cheaper of the two places to say no */
  const g2 = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g2.sid}/approve`, {}, AS_PANEL);
  const huge = await json('POST', '/api/report',
    { idx: g2.idx[0], reason: 'other', note: 'x'.repeat(50000) }, { ip: '198.51.100.210' });
  assert.equal(huge.code, 413);
  assert.equal(reports.queue(50).find(x => x.submission === g2.sid), undefined);
});

test('the report survives the thing it is about', async () => {
  const g = guestClaim(2);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);
  await json('POST', '/api/report', { idx: g.idx[0], reason: 'violence' }, { ip: '198.51.100.209' });

  /* taken down — which is the whole point of the report */
  submissions.takedown(g.sid, 'tg:1 (sara)', 'Reported and taken down');

  const row = reports.queue(50).find(x => x.submission === g.sid);
  assert.ok(row, 'the report is still in the queue');
  assert.equal(row.status, 'rejected', 'and says what happened to the drawing');
});

/* ── The two the audit caught (both were shipped) ──────────────── */

test('erasing takes the pixels off the wall, not just out of the table', async () => {
  const g = guestClaim(3);
  await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);
  for (const i of g.idx) assert.ok(wall.wall.live.has(i), 'they are on the wall to start with');

  await json('POST', `/api/admin/users/${g.uid}/erase`, eraseBody('asked to be forgotten'), AS_PANEL);

  /* The database is not the wall. wall.live is what every snapshot is
     encoded from and what every open canvas is drawing; deleting the cells
     rows does not touch it. Before this was fixed, an erased account's
     pixels kept being served — under a fresh anonymous name, with the rows
     gone — until the process restarted. */
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM cells WHERE user_id = ?').get(g.uid).n, 0);
  for (const i of g.idx) {
    assert.ok(!wall.wall.live.has(i),
      `idx ${i} is gone from the database and still on the public wall`);
  }
});

test('a swept account with a legacy ip row does not take the whole sweep down', () => {
  const retention = require('../server/retention.js');
  const DAY = 86400000;
  const now = Date.now();

  /* legacy_keys is the pre-Phase-2 ip→user table. Migration 003 drops it and
     is marked @manual, so it is still there in production holding rows, and
     it carries a foreign key into users(id) that the dormant sweep's WHERE
     cannot exclude — it is not a reason to keep anybody. */
  const ghost = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest','Ghost',?,?)"
  ).run(now - 400 * DAY, now - 400 * DAY).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(ghost);
  dbm.db.prepare('INSERT INTO legacy_keys (key, user_id, created_at) VALUES (?,?,?)')
    .run('41.33.7.9', ghost, now - 400 * DAY);

  /* A screenshot old enough to be swept in the same pass, on somebody else:
     an account with a payment is never dormant by definition, so hanging it
     on the ghost would have excluded the ghost and tested nothing. */
  const payer = guestClaim(1).uid;
  const dir = require('path').join(cfg.DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const shot = require('path').join(dir, 'sweep-order.png');
  fs.writeFileSync(shot, 'evidence');
  dbm.db.prepare(
    `INSERT INTO payments (user_id, kind, amount, code, status, created_at, updated_at, screenshot_path)
     VALUES (?, 'paint_pack', 100, 'S37-SWEEPT', 'verified', ?, ?, ?)`
  ).run(payer, now - 400 * DAY, now - 400 * DAY, shot);

  const out = retention.sweep(now, {
    identity: { dayKey: identity.dayKey, forget: () => {} },
    wall: { cycleStart: () => now }
  });

  assert.ok(out.accounts >= 1, 'the dormant account went');
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM legacy_keys WHERE user_id = ?').get(ghost).n, 0,
    'and its raw ip row with it');
  assert.equal(fs.existsSync(shot), false, 'the screenshot went too');
});

test('a sweep that fails destroys nothing on the way down', () => {
  const retention = require('../server/retention.js');
  const DAY = 86400000;
  const now = Date.now();

  const dir = require('path').join(cfg.DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const shot = require('path').join(dir, 'must-survive.png');
  fs.writeFileSync(shot, 'evidence');
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest','Payer',?,?)"
  ).run(now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
  dbm.db.prepare(
    `INSERT INTO payments (user_id, kind, amount, code, status, created_at, updated_at, screenshot_path)
     VALUES (?, 'paint_pack', 100, 'S37-ROLLBK', 'verified', ?, ?, ?)`
  ).run(uid, now - 400 * DAY, now - 400 * DAY, shot);

  /* make the last step of the pass throw, after the screenshot step has run */
  const realForget = identity.forget;
  let threw = null;
  try {
    retention.sweep(now, {
      identity: { dayKey: identity.dayKey, forget: () => { throw new Error('boom'); } },
      wall: { cycleStart: () => { throw new Error('boom'); } }
    });
  } catch (err) { threw = err.message; }

  assert.ok(threw, 'the pass failed, which is the situation being tested');
  assert.ok(fs.existsSync(shot),
    'the file is still there — files are unlinked after the commit, never inside it, ' +
    'because a rollback would otherwise leave a row pointing at a file that is gone');
  assert.ok(dbm.db.prepare('SELECT screenshot_path FROM payments WHERE code = ?')
    .get('S37-ROLLBK').screenshot_path, 'and the row still points at it');
  identity.forget = realForget;
});

test('one reporter cannot bury the moderation queue', async () => {
  const ip = '198.51.100.240';
  const first = await json('GET', '/api/me', null, { ip, jar: new Map() });
  const cookie = String(first.headers['set-cookie'] || '').split(';')[0];
  const as = { ip, headers: cookie ? { cookie } : {} , jar: new Map() };

  /* The per-submission rule stops reporting one drawing twice; it says
     nothing about reporting a thousand different ones, and every report is
     a message in the moderation group. */
  let refused = 0, sent = 0;
  for (let i = 0; i < 34; i++) {
    const g = guestClaim(1);
    await json('POST', `/api/admin/submissions/${g.sid}/approve`, {}, AS_PANEL);
    const r = await json('POST', '/api/report', { idx: g.idx[0], reason: 'spam' }, as);
    if (r.code === 429) { refused++; assert.equal(r.json.error, 'report-cap'); }
    else if (r.code === 200) sent++;
  }
  assert.ok(sent <= 30, `${sent} reports went through in a day`);
  assert.ok(refused > 0, 'and the rest were refused rather than queued');
});

/* ── A brand's drawings, and showing one early (§7.2) ──────────── */

function bookedBrand(name, n) {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, email, pass_hash, created_at, last_seen) VALUES ('brand',?,?,'x',?,?)"
  ).run(name, `${name.replace(/\W/g, '')}@brands.example`, now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
  dbm.db.prepare(
    `INSERT INTO brand_profiles (user_id, business_name, category, description, contact_name,
       phone, instapay_handle, status) VALUES (?,?,'Drinks','x','Sara','+20100','b@instapay','approved')`
  ).run(uid, name);
  identity.accept(uid, { capacity: true }, now);

  const e = identity.rowFor(uid, now);
  const px = freeRange(n).map(i => [i, 0xff3366]);
  const r = wall.bookBrand(e, { name: name.toUpperCase(), url: 'https://example.test', cta: 'VISIT' },
    px.map(([i, c]) => [i, c]), now);
  submissions.approve(r.sid, 'tg:1 (sara)', now);
  return { uid, sid: r.sid, idx: px.map(([i]) => i) };
}

test('a brand card can show everything that brand has drawn', async () => {
  const b = bookedBrand('Nile Soda Works', 4);

  const r = await json('GET', `/api/admin/brands/${b.uid}/works`, null, AS_PANEL);
  assert.equal(r.code, 200);
  const w = r.json.rows.find(x => x.sid === b.sid);
  assert.ok(w, 'the booking is listed');
  assert.equal(w.layer, 'next', 'booked for next cycle');
  assert.equal(w.status, 'approved');
  assert.equal(w.px, 4);
  assert.ok(w.thumb && w.thumb.length, 'with something to look at');
  assert.equal(w.early, true, 'and it is a candidate for showing early');
});

test('showing early says exactly whose pixels it would take first', async () => {
  const b = bookedBrand('Cairo Cola', 4);

  /* somebody else painting over two of those squares on the live wall */
  const g = guestClaim(0);
  const painter = identity.rowFor(g.uid, Date.now());
  const clash = wall.claimPixels(painter, b.idx.slice(0, 2).map(i => [i, 0x111111]), Date.now());
  submissions.approve(clash.sid, 'tg:1 (sara)', Date.now());

  const p = await json('GET', `/api/admin/submissions/${b.sid}/early`, null, AS_PANEL);
  assert.equal(p.code, 200);
  assert.equal(p.json.px, 4);
  assert.equal(p.json.displacing, 2, 'two squares belong to somebody else');
  assert.equal(p.json.free, 2);
  assert.equal(p.json.displaces[0].sid, clash.sid, 'and it says whose');
  assert.equal(p.json.displaces[0].px, 2);

  /* asking is not doing */
  assert.equal(dbm.db.prepare(
    "SELECT COUNT(*) n FROM cells WHERE submission_id = ? AND layer = 'live'").get(b.sid).n, 0);
});

test('showing early puts it on the wall and takes the displaced work down properly', async () => {
  const b = bookedBrand('Alex Fizz', 4);
  const g = guestClaim(0);
  const painter = identity.rowFor(g.uid, Date.now());
  const clash = wall.claimPixels(painter, b.idx.slice(0, 2).map(i => [i, 0x111111]), Date.now());
  submissions.approve(clash.sid, 'tg:1 (sara)', Date.now());
  for (const i of b.idx.slice(0, 2)) assert.ok(wall.wall.live.has(i), 'their pixels are up');

  const r = await json('POST', `/api/admin/submissions/${b.sid}/early`,
    { reason: 'the brand asked and the wall is quiet' }, AS_PANEL);
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.px, 4);
  assert.equal(r.json.displaced, 2);

  /* the booking is live now */
  for (const i of b.idx) assert.ok(wall.wall.live.has(i), `idx ${i} should be on the live wall`);

  /* and the painter it displaced was told, through the normal path */
  assert.equal(dbm.db.prepare('SELECT status FROM submissions WHERE id = ?').get(clash.sid).status,
    'rejected', 'taken down rather than silently overwritten');
  assert.match(
    dbm.db.prepare('SELECT reject_reason FROM submissions WHERE id = ?').get(clash.sid).reject_reason,
    /shown early/i);

  /* it is still booked for next cycle too, so the reset still works */
  assert.equal(dbm.db.prepare('SELECT layer FROM submissions WHERE id = ?').get(b.sid).layer, 'next');
});

test('only an approved brand booking can be shown early', async () => {
  const g = guestClaim(2);
  const noReason = await json('POST', `/api/admin/submissions/${g.sid}/early`, {}, AS_PANEL);
  assert.equal(noReason.code, 400);
  assert.equal(noReason.json.error, 'reason-required');

  const notBrand = await json('POST', `/api/admin/submissions/${g.sid}/early`,
    { reason: 'trying it on a free claim' }, AS_PANEL);
  assert.equal(notBrand.code, 400);
  assert.equal(notBrand.json.error, 'not-a-booking');

  const missing = await json('GET', '/api/admin/submissions/999999/early', null, AS_PANEL);
  assert.equal(missing.code, 400);
  assert.equal(missing.json.error, 'not-found');
});

test('showing early is refused for a booking nobody has approved', async () => {
  const now = Date.now();
  const uid = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, email, pass_hash, created_at, last_seen) VALUES ('brand','Undecided Co','u@b.example','x',?,?)"
  ).run(now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(uid);
  dbm.db.prepare(
    `INSERT INTO brand_profiles (user_id, business_name, category, description, contact_name,
       phone, instapay_handle, status) VALUES (?,'Undecided Co','Drinks','x','Sara','+20100','b@instapay','approved')`
  ).run(uid);
  identity.accept(uid, { capacity: true }, now);
  const e = identity.rowFor(uid, now);
  const r = wall.bookBrand(e, { name: 'UNDECIDED CO', url: 'https://example.test', cta: 'GO' },
    freeRange(3).map(i => [i, 0x22aa88]), now);

  const out = await json('POST', `/api/admin/submissions/${r.sid}/early`,
    { reason: 'before anybody looked at it' }, AS_PANEL);
  assert.equal(out.code, 400);
  assert.equal(out.json.error, 'not-approved',
    'a booking put on the wall before a person has seen it is the one thing ' +
    'this product does not do');
});
