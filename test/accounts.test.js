/* ═══════════════════════════════════════════════════════════════
   accounts test — the painter upgrade and the bell

   §3's optional accounts: registering attaches an email + password
   to the guest identity the caller already holds — same id, same
   pixels — and logging in anywhere resumes it. So this file is about
   adoption (nothing resets), the one-email-one-account rule across
   painters and brands, and the unified login door.

   Then the notifications feed: decisions, money and application news
   assembled from the rows that already record them, with "unread"
   being nothing but a high-water mark.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-accounts-'));
const STATE_DIR = path.join(TMP, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

process.env.STATE_DIR = STATE_DIR;
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
process.env.IP_GUEST_CAP = '5';
process.env.IP_CLAIM_CAP = '40';
process.env.IP_SIGNUP_CAP = '3';
process.env.RATE_READ = '100000';
process.env.RATE_WRITE = '100000';
process.env.RATE_AUTH = '100000';
/* far enough out that nothing auto-approves mid-assertion */
process.env.AUTO_APPROVE_MS = '3600000';
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ALLOW_ORIGIN;

const app = require('../server.js');
const dbm = require('../server/db.js');
const wall = require('../server/wall.js');
const submissions = require('../server/submissions.js');
const payments = require('../server/payments.js');

/* ── envelope + request helpers (identity.test.js's, verbatim) ── */

const ENTRY = 9;
function encodeEnvelope(meta, a, b = []) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const buf = Buffer.alloc(4 + json.length + 4 + a.length * ENTRY + 4 + b.length * ENTRY);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  for (const list of [a, b]) {
    buf.writeUInt32LE(list.length, o); o += 4;
    for (const [i, c] of list) {
      buf.writeUInt32LE(i, o); o += 4;
      buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
      buf.writeUInt16LE(0, o); o += 2;
    }
  }
  return buf;
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
      const set = res.headers['set-cookie'] || [];
      for (const line of set) {
        const pair = line.split(';')[0], eq = pair.indexOf('=');
        if (eq > 0) who.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, setCookie: set, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const json = async (who, method, url, body, type) => {
  const r = await req(who, method, url, body ? (type ? body : JSON.stringify(body)) : null, type);
  return { code: r.code, setCookie: r.setCookie, json: JSON.parse(r.body.toString('utf8')) };
};
const uidOf = who => Number(String(who.jar.get('uid') || '').split('.')[0].replace(/^b/, ''));

let nextFree = 700000;
function freeRange(n) {
  const out = [];
  while (out.length < n) {
    const idx = nextFree++;
    if (!wall.wall.live.has(idx) && !wall.wall.pending.live.has(idx)) out.push(idx);
  }
  return out;
}
const claim = (who, idxs) => json(who, 'POST', '/api/claim',
  encodeEnvelope({}, idxs.map(i => [i, 0x22cc88])), 'application/octet-stream');

let emailSeq = 0;
const application = over => Object.assign({
  email: `brand${++emailSeq}@wall.example`,
  password: 'a-long-enough-password',
  business_name: 'Nile Soda Co.',
  category: 'Drinks',
  description: 'Nile Soda Co. has bottled hibiscus and tamarind soda in Shubra since 1998. '.repeat(4),
  website: 'nile-soda.example',
  contact_name: 'Sara Fahmy',
  phone: '+20 100 555 0134',
  instapay_handle: 'nilesoda@instapay'
}, over);

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  submissions.cancelPending();
  server.close();
  dbm.close();
});

/* ── the upgrade ──────────────────────────────────────────────── */

test('registering adopts the guest you already are', async () => {
  const me = visitor('203.0.113.210');
  const before = await json(me, 'GET', '/api/me');
  assert.equal(before.json.registered, false, 'a fresh guest is not registered');
  const id = uidOf(me);

  const spent = await claim(me, freeRange(3));
  assert.equal(spent.json.placed, 3);

  const r = await json(me, 'POST', '/api/auth/register',
    { email: 'mona@painter.example', password: 'paints-every-friday' });
  assert.equal(r.code, 200);
  assert.equal(r.json.registered, true);
  assert.equal(r.json.email, 'mona@painter.example');
  assert.deepEqual(r.setCookie, [], 'same identity — there is no new cookie to set');

  assert.equal(uidOf(me), id, 'the id did not change');
  const after = await json(me, 'GET', '/api/me');
  assert.equal(after.json.allowance.free, 17, 'the spent pixels stayed spent — adoption, not a reset');
  assert.equal(after.json.handle, before.json.handle, 'the handle survives');
});

test('the rules are told inline, field by field', async () => {
  const me = visitor('203.0.113.211');
  await json(me, 'GET', '/api/me');

  const badEmail = await json(me, 'POST', '/api/auth/register',
    { email: 'not-an-email', password: 'long-enough-honestly' });
  assert.equal(badEmail.code, 400);
  assert.ok(badEmail.json.fields.email);

  const shortPass = await json(me, 'POST', '/api/auth/register',
    { email: 'ok@painter.example', password: 'short' });
  assert.equal(shortPass.code, 400);
  assert.ok(shortPass.json.fields.password);
});

test('one email is one account, across painters and brands', async () => {
  const first = visitor('203.0.113.212');
  await json(first, 'GET', '/api/me');
  const r = await json(first, 'POST', '/api/auth/register',
    { email: 'taken@painter.example', password: 'the-first-one-through' });
  assert.equal(r.code, 200);

  /* the same session cannot register twice */
  const again = await json(first, 'POST', '/api/auth/register',
    { email: 'other@painter.example', password: 'the-first-one-through' });
  assert.equal(again.code, 409);
  assert.equal(again.json.error, 'already-registered');

  /* another guest cannot take the email */
  const second = visitor('203.0.113.213');
  await json(second, 'GET', '/api/me');
  const stolen = await json(second, 'POST', '/api/auth/register',
    { email: 'taken@painter.example', password: 'me-too-please-thanks' });
  assert.equal(stolen.code, 409);
  assert.equal(stolen.json.error, 'email-taken');

  /* and neither can a brand application */
  const brandTry = await json(visitor('203.0.113.214'), 'POST', '/api/auth/signup',
    application({ email: 'taken@painter.example' }));
  assert.equal(brandTry.code, 409);
  assert.ok(brandTry.json.fields.email);
});

test('logging in from a new phone resumes the identity', async () => {
  const phone = visitor('203.0.113.215');
  await json(phone, 'GET', '/api/me');
  const id = uidOf(phone);
  const mark = await claim(phone, freeRange(2));
  await json(phone, 'POST', '/api/auth/register',
    { email: 'omar@painter.example', password: 'same-wall-new-phone' });

  const laptop = visitor('203.0.113.216');       // clean jar, different address
  const r = await json(laptop, 'POST', '/api/auth/login',
    { email: 'omar@painter.example', password: 'same-wall-new-phone' });
  assert.equal(r.code, 200);
  assert.equal(uidOf(laptop), id, 'the same person, not a stranger');
  assert.equal(r.json.registered, true);

  const hist = await json(laptop, 'GET', '/api/me/history');
  assert.ok(hist.json.rows.find(h => h.sid === mark.json.sid),
    'the pixels claimed on the phone are visible from the laptop');
});

test('wrong password and unknown email are the same quiet no', async () => {
  const who = visitor('203.0.113.217');
  const wrong = await json(who, 'POST', '/api/auth/login',
    { email: 'omar@painter.example', password: 'guessing-badly-here' });
  assert.equal(wrong.code, 401);
  assert.equal(wrong.json.error, 'bad-credentials');

  const unknown = await json(who, 'POST', '/api/auth/login',
    { email: 'nobody@painter.example', password: 'guessing-badly-here' });
  assert.equal(unknown.code, 401);
  assert.equal(unknown.json.error, 'bad-credentials', 'and the form cannot tell who exists');
});

test('a brand still signs in through the same door', async () => {
  const who = visitor('203.0.113.218');
  const made = await json(who, 'POST', '/api/auth/signup', application({ email: 'door@brand.example' }));
  assert.equal(made.code, 200);
  await json(who, 'POST', '/api/auth/logout');

  who.jar.clear();
  const r = await json(who, 'POST', '/api/auth/login',
    { email: 'door@brand.example', password: 'a-long-enough-password' });
  assert.equal(r.code, 200);
  assert.equal(r.json.kind, 'brand');
  assert.match(String(who.jar.get('uid')), /^b\d/, 'a brand cookie, marked as one');
});

/* ── the bell ─────────────────────────────────────────────────── */

test('decisions land in the bell, and opening it quiets the badge', async () => {
  const me = visitor('203.0.113.219');
  await json(me, 'GET', '/api/me');

  const one = await claim(me, freeRange(2));
  submissions.reject(one.json.sid, 'tg:1 (sara)', 'not on this wall');
  const two = await claim(me, freeRange(1));
  submissions.approve(two.json.sid, 'tg:1 (sara)');

  const feed = await json(me, 'GET', '/api/me/notifications');
  assert.ok(feed.json.unseen >= 2, `expected unread news, got ${feed.json.unseen}`);
  const rejected = feed.json.rows.find(r => r.src === 'submission' && r.ref === one.json.sid);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.detail, 'not on this wall', 'the reason travels with the news');
  const approved = feed.json.rows.find(r => r.src === 'submission' && r.ref === two.json.sid);
  assert.equal(approved.status, 'approved');

  const seen = await json(me, 'POST', '/api/me/notifications/seen');
  assert.equal(seen.code, 200);
  const after = await json(me, 'GET', '/api/me/notifications');
  assert.equal(after.json.unseen, 0, 'opening the bell is what marks it read');
  assert.ok(after.json.rows.length >= 2, 'the news itself does not vanish');
});

test('money news lands in the bell too', async () => {
  const me = visitor('203.0.113.220');
  await json(me, 'GET', '/api/me');

  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });
  assert.equal(order.code, 200);
  const pid = order.json.paymentId;
  await json(me, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: '5011234567', payer_handle: 'me@instapay' });
  payments.verify(pid, 'tg:1 (sara)');

  const feed = await json(me, 'GET', '/api/me/notifications');
  const row = feed.json.rows.find(r => r.src === 'payment' && r.ref === pid);
  assert.equal(row.status, 'verified');
  assert.ok(row.detail, 'the instapay code rides along so the row is recognizable');
  assert.ok(row.t > 0, 'stamped when it changed, not when it was created');
});
