/* ═══════════════════════════════════════════════════════════════
   identity test — the promises Phase 2 makes

   Cookies decide who a caller is (§3), so this file is about the
   cookie: that one is minted, that a forged or stale one is worth
   nothing, that the prototype's IP-keyed visitors keep their pixels
   on the way across, and that two people behind one router are two
   people. Then the caps that stop a cleared cookie from being a free
   refill, and the brand accounts that /api/book is gated on.

   TRUST_PROXY lets a single test process be several addresses: with
   it on, callerKey reads X-Forwarded-For, so each test can pick an IP
   and not spend another test's daily budget.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reelpixel-identity-'));
const STATE_DIR = path.join(TMP, 'state');            // empty: no .wall.bin to inherit
fs.mkdirSync(STATE_DIR, { recursive: true });

process.env.STATE_DIR = STATE_DIR;
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
/* the §3 numbers, spelled out rather than inherited, so a change to the
   defaults shows up here as a decision instead of a mystery failure */
process.env.IP_GUEST_CAP = '5';
process.env.IP_CLAIM_CAP = '40';
process.env.IP_SIGNUP_CAP = '3';
delete process.env.VERCEL;
delete process.env.DEV;
delete process.env.ALLOW_ORIGIN;

const app = require('../server.js');
const dbm = require('../server/db.js');
const identity = require('../server/identity.js');
const wall = require('../server/wall.js');
const cfg = require('../server/config.js');

const DAY = 24 * 60 * 60 * 1000;

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

/* A browser, roughly: `who` is a jar (a Map) plus the address it dials
   from, so a test can hold several visitors at once. */
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

/* somewhere the seed never painted, handed out in slices */
let nextFree = 640000;
function freeRange(n, layer) {
  const held = layer === 'next' ? wall.wall.reserved : wall.wall.live;
  const out = [];
  while (out.length < n) {
    const idx = nextFree++;
    if (!held.has(idx) && !wall.wall.live.has(idx)) out.push(idx);
  }
  return out;
}
const claim = (who, idxs) => json(who, 'POST', '/api/claim',
  encodeEnvelope({}, idxs.map(i => [i, 0x22cc88])), 'application/octet-stream');

/* a complete, valid application — tests bend one field at a time off it */
let emailSeq = 0;
const application = over => ({
  email: `brand${++emailSeq}@nilesoda.test`,
  password: 'correct horse battery',
  business_name: 'Nile Soda Co.',
  category: 'Drinks',
  description: 'Nile Soda Co. has bottled hibiscus and tamarind soda in Shubra since 1998. '.repeat(4),
  website: 'nile-soda.example',
  socials: 'https://instagram.com/nilesoda',
  contact_name: 'Sara Fahmy',
  phone: '+20 100 555 0134',
  reg_number: 'CR-99112',
  instapay_handle: 'nilesoda@instapay',
  ...over
});

test.before(() => new Promise(done => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
}));
test.after(() => {
  server.close();
  dbm.close();                              // Windows won't unlink an open .db
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ── the cookie ───────────────────────────────────────────────── */

test('a caller without a cookie is minted one, and keeps it', async () => {
  const me = visitor('198.51.100.10');
  const first = await json(me, 'GET', '/api/me');
  assert.equal(first.code, 200);

  const set = first.setCookie.join('');
  assert.match(set, /^uid=/, 'no cookie was set');
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.match(set, /Path=\//i);
  assert.match(set, /Max-Age=31536000/, 'a guest identity is worth a year');
  assert.ok(!/Secure/i.test(set), 'Secure over plain http would hide the cookie from dev');
  assert.match(me.jar.get('uid'), /^\d+\.\d+\.[\w-]+$/, 'uid.exp.hmac');

  assert.equal(first.json.kind, 'guest');
  assert.match(first.json.handle, /^Pixel fan #\d{4}$/);
  assert.equal(first.json.brandStatus, null);
  assert.equal(first.json.allowance.free, 20);

  /* second request carries it — same person, no new identity */
  const again = await json(me, 'GET', '/api/me');
  assert.deepEqual(again.setCookie, [], 'a valid cookie was re-minted');
  assert.equal(again.json.handle, first.json.handle);

  /* one users row, one allowance row, and a line in the journal saying so */
  const id = uidOf(me);
  assert.equal(dbm.db.prepare("SELECT kind FROM users WHERE id = ?").get(id).kind, 'guest');
  assert.ok(dbm.db.prepare('SELECT 1 n FROM allowances WHERE user_id = ?').get(id));
  assert.ok(dbm.db.prepare(
    "SELECT 1 n FROM events WHERE action = 'guest-mint' AND actor = ?").get(`user:${id}`));
});

test('a tampered or expired cookie is worth exactly nothing', async () => {
  const me = visitor('198.51.100.10');
  await json(me, 'GET', '/api/me');
  const good = me.jar.get('uid');
  const [id, exp, sig] = good.split('.');

  /* every byte of it is signed */
  for (const forged of [
    `${Number(id) + 1}.${exp}.${sig}`,                       // somebody else's id
    `${id}.${Number(exp) + 1000}.${sig}`,                    // a longer life
    `${id}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`,
    `b${id}.${exp}.${sig}`,                                  // promoted to a brand
    'nonsense', ''
  ]) {
    assert.equal(identity.verifyCookie(forged, Date.now()), null, `accepted: ${forged}`);
  }
  assert.ok(identity.verifyCookie(good, Date.now()), 'the real one stopped verifying');

  /* expiry is checked before anything is looked up */
  const stale = identity.cookieValue(Number(id), 'guest', 0, Date.now() - 2 * cfg.GUEST_TTL);
  assert.equal(identity.verifyCookie(stale.value, Date.now()), null);

  /* over the wire: a forged cookie is not an error, it is a new visitor */
  const forged = visitor('198.51.100.10');
  forged.jar.set('uid', `${id}.${exp}.${sig.slice(0, -2)}zz`);
  const r = await json(forged, 'GET', '/api/me');
  assert.equal(r.code, 200);
  assert.match(r.setCookie.join(''), /^uid=/, 'a fresh identity should have been minted');
  assert.notEqual(uidOf(forged), Number(id), 'the forged id was honoured');
});

test('two cookies from one address are two people', async () => {
  const a = visitor('198.51.100.20'), b = visitor('198.51.100.20');
  await json(a, 'GET', '/api/me');
  await json(b, 'GET', '/api/me');
  assert.notEqual(uidOf(a), uidOf(b));

  const spent = await claim(a, freeRange(4));
  assert.equal(spent.json.placed, 4);
  assert.equal(spent.json.free, 16);

  const other = await json(b, 'GET', '/api/allowance');
  assert.equal(other.json.free, 20, 'one visitor spent the other one\'s pixels');
});

test('a returning prototype visitor is adopted, not replaced', async () => {
  const ip = '198.51.100.30';
  const now = Date.now();
  /* what Phase 1 left behind: a users row keyed by the caller's IP */
  const old = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', 'Pixel fan #7777', ?, ?)"
  ).run(now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id, used) VALUES (?, 7)').run(old);
  dbm.db.prepare('INSERT INTO legacy_keys (key, user_id, created_at) VALUES (?, ?, ?)').run(ip, old, now);

  const before = identity.ipCounts(ip, now).guests;
  const me = visitor(ip);
  const r = await json(me, 'GET', '/api/me');

  assert.equal(uidOf(me), old, 'a new identity was minted over the top of theirs');
  assert.equal(r.json.handle, 'Pixel fan #7777', 'their name changed under them');
  assert.equal(r.json.allowance.free, 13, 'the 7 pixels they had spent came back');
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM legacy_keys WHERE key = ?').get(ip).n, 0,
    'the bridge row should be retired once it has been used');
  assert.equal(identity.ipCounts(ip, now).guests, before,
    'coming back is not a new identity and must not cost a day\'s budget');
});

/* ── the per-IP caps (§3) ─────────────────────────────────────── */

test('the sixth new identity from an address in a day is refused', async () => {
  const ip = '198.51.100.40';
  const minted = [];
  for (let i = 1; i <= cfg.IP_GUEST_CAP; i++) {
    const who = visitor(ip);
    const r = await json(who, 'GET', '/api/me');
    assert.equal(r.code, 200, `identity ${i} was refused`);
    minted.push(who);
  }
  const sixth = await json(visitor(ip), 'GET', '/api/me');
  assert.equal(sixth.code, 429);
  assert.equal(sixth.json.error, 'ip-guest-cap');
  assert.match(sixth.json.message, /cookies/i, 'the message should tell them what to try');
  assert.deepEqual(sixth.setCookie, [], 'a refused visitor still got an identity');
  assert.equal(identity.ipCounts(ip, Date.now()).guests, cfg.IP_GUEST_CAP,
    'the refused mint was counted anyway');

  /* the five who already have a cookie are untouched: the cap is on minting
     identities, not on the office everybody is sitting in */
  for (const who of minted) {
    const r = await json(who, 'GET', '/api/me');
    assert.equal(r.code, 200, 'an existing visitor was locked out by the cap');
  }

  /* and claiming still works for them */
  const r = await claim(minted[0], freeRange(2));
  assert.equal(r.code, 200);
  assert.equal(r.json.placed, 2);
});

test('the 41st claim from an address in a day is refused', async () => {
  const ip = '198.51.100.50';
  const me = visitor(ip);
  const first = await claim(me, freeRange(1));
  assert.equal(first.code, 200);

  /* the cap counts submissions, not pixels — the allowance runs out long
     before it does, and an empty-handed claim is still a claim */
  for (let i = 2; i <= cfg.IP_CLAIM_CAP; i++) {
    const r = await claim(me, freeRange(1));
    assert.equal(r.code, 200, `claim ${i} was refused early`);
  }
  const over = await claim(me, freeRange(1));
  assert.equal(over.code, 429);
  assert.equal(over.json.error, 'ip-claim-cap');

  /* reading the wall still works — only claiming is closed for the day */
  assert.equal((await req(me, 'GET', '/api/wall')).code, 200);
});

test('the counters roll over at midnight', () => {
  const ip = '198.51.100.60';
  const now = Date.now();
  for (let i = 0; i < cfg.IP_CLAIM_CAP; i++) {
    assert.equal(identity.takeIp(ip, 'claims', cfg.IP_CLAIM_CAP, now), true);
  }
  assert.equal(identity.takeIp(ip, 'claims', cfg.IP_CLAIM_CAP, now), false, 'the cap did not bite');
  assert.equal(identity.takeIp(ip, 'claims', cfg.IP_CLAIM_CAP, now + DAY), true, 'tomorrow is a new day');
  assert.notEqual(identity.dayKey(now), identity.dayKey(now + DAY));
  assert.equal(identity.ipCounts(ip, now).claims, cfg.IP_CLAIM_CAP, 'yesterday was rewritten');
  assert.equal(identity.ipCounts(ip, now + DAY).claims, 1);
});

/* ── passwords ────────────────────────────────────────────────── */

test('scrypt round-trips, and nothing else does', () => {
  const stored = identity.hashPassword('correct horse battery');
  const [salt, N, r, p, hash] = stored.split(':');
  assert.equal(Number(N), cfg.SCRYPT.N);
  assert.equal(Number(r), cfg.SCRYPT.r);
  assert.equal(Number(p), cfg.SCRYPT.p);
  assert.equal(Buffer.from(salt, 'hex').length, cfg.SCRYPT.saltlen);
  assert.equal(Buffer.from(hash, 'hex').length, cfg.SCRYPT.keylen);

  assert.equal(identity.verifyPassword('correct horse battery', stored), true);
  assert.equal(identity.verifyPassword('correct horse batterY', stored), false);
  assert.equal(identity.verifyPassword('', stored), false);
  assert.equal(identity.verifyPassword('correct horse battery', 'garbage'), false);
  assert.equal(identity.verifyPassword('correct horse battery', ''), false);

  /* the salt is per-account, so two identical passwords don't look alike */
  assert.notEqual(identity.hashPassword('correct horse battery'), stored);
});

/* ── brand signup ─────────────────────────────────────────────── */

test('the signup form is validated field by field', async () => {
  const ip = '198.51.100.70';
  const cases = [
    ['description', { description: 'We sell soda.' }, /200 characters/],
    ['website', { website: '', socials: '' }, /social/i],
    ['password', { password: 'short' }, /10 characters/],
    ['email', { email: 'not-an-email' }, /email address/i],
    ['phone', { phone: '' }, /phone/i],
    ['instapay_handle', { instapay_handle: '' }, /refund/i],
    ['business_name', { business_name: '' }, /business name/i],
    ['category', { category: '' }, /category/i],
    ['contact_name', { contact_name: '' }, /talk to/i]
  ];
  for (const [field, over, hint] of cases) {
    const r = await json(visitor(ip), 'POST', '/api/auth/signup', application(over));
    assert.equal(r.code, 400, `${field} was accepted`);
    assert.equal(r.json.error, 'invalid');
    assert.ok(r.json.fields[field], `no error reported against ${field}: ${JSON.stringify(r.json.fields)}`);
    assert.match(r.json.fields[field], hint);
  }

  /* a rejected form is not an account, and costs nothing against the
     3-a-day signup budget */
  assert.equal(identity.ipCounts(ip, Date.now()).signups, 0);
  assert.equal(dbm.db.prepare("SELECT COUNT(*) n FROM users WHERE kind = 'brand' AND email LIKE '%@nilesoda.test'").get().n, 0);

  /* a website alone is enough, and so is a social account alone */
  const withSite = await json(visitor(ip), 'POST', '/api/auth/signup', application({ socials: '' }));
  assert.equal(withSite.code, 200, JSON.stringify(withSite.json));
  const withSocial = await json(visitor(ip), 'POST', '/api/auth/signup', application({ website: '' }));
  assert.equal(withSocial.code, 200, JSON.stringify(withSocial.json));
});

test('signing up lands pending, signs you in, and takes the email', async () => {
  const me = visitor('198.51.100.80');
  const form = application();
  const r = await json(me, 'POST', '/api/auth/signup', form);
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.kind, 'brand');
  assert.equal(r.json.handle, 'Nile Soda Co.');
  assert.equal(r.json.brandStatus, 'pending');
  assert.equal(r.json.email, form.email);
  assert.equal(r.json.allowance.cap, 20, 'a brand paints like anyone else');

  const set = r.setCookie.join('');
  assert.match(set, /^uid=b\d+\./, 'a brand session is marked in the cookie');
  assert.match(set, /Max-Age=2592000/, 'a login lasts 30 days, not a year');

  const stored = dbm.db.prepare(
    `SELECT u.kind, u.pass_hash, b.status, b.description, b.socials, b.instapay_handle, b.website
       FROM users u JOIN brand_profiles b ON b.user_id = u.id WHERE u.email = ?`).get(form.email);
  assert.equal(stored.kind, 'brand');
  assert.equal(stored.status, 'pending');
  assert.match(stored.pass_hash, /^[0-9a-f]{64}:16384:8:1:[0-9a-f]{64}$/, 'salt:N:r:p:hash');
  assert.ok(!stored.pass_hash.includes(form.password), 'the password was stored in the clear');
  assert.deepEqual(JSON.parse(stored.socials), ['https://instagram.com/nilesoda']);
  assert.equal(stored.website, 'https://nile-soda.example/', 'a bare domain should be normalised');
  assert.equal(stored.instapay_handle, 'nilesoda@instapay');
  assert.ok(stored.description.length >= cfg.DESC_MIN);

  /* the session really is the brand, on the next request */
  const who = await json(me, 'GET', '/api/me');
  assert.equal(who.json.kind, 'brand');
  assert.equal(who.json.brandStatus, 'pending');

  /* and the email is spoken for */
  const twice = await json(visitor('198.51.100.80'), 'POST', '/api/auth/signup', form);
  assert.equal(twice.code, 409);
  assert.equal(twice.json.error, 'email-taken');
  assert.match(twice.json.fields.email, /log in/i);

  const logged = dbm.db.prepare("SELECT COUNT(*) n FROM events WHERE action = 'brand-signup'").get().n;
  assert.ok(logged >= 1, 'a signup should be in the journal');
});

test('three brand applications an address per day', async () => {
  const ip = '198.51.100.90';
  for (let i = 1; i <= cfg.IP_SIGNUP_CAP; i++) {
    const r = await json(visitor(ip), 'POST', '/api/auth/signup', application());
    assert.equal(r.code, 200, `application ${i} was refused`);
  }
  const over = await json(visitor(ip), 'POST', '/api/auth/signup', application());
  assert.equal(over.code, 429);
  assert.equal(over.json.error, 'ip-signup-cap');
});

/* ── login ────────────────────────────────────────────────────── */

test('login is generic about failure and specific about success', async () => {
  const ip = '198.51.100.100';
  const form = application();
  await json(visitor(ip), 'POST', '/api/auth/signup', form);

  for (const body of [
    { email: form.email, password: 'wrong password entirely' },
    { email: 'nobody@nowhere.test', password: form.password },
    { email: form.email },
    {}
  ]) {
    const r = await json(visitor(ip), 'POST', '/api/auth/login', body);
    assert.equal(r.code, 401);
    assert.equal(r.json.message, 'Wrong email or password.', 'the message leaks which half was wrong');
    assert.equal(r.json.error, 'bad-credentials');
  }

  const me = visitor(ip);
  const ok = await json(me, 'POST', '/api/auth/login', { email: form.email, password: form.password });
  assert.equal(ok.code, 200);
  assert.equal(ok.json.kind, 'brand');
  assert.equal(ok.json.brandStatus, 'pending');
  assert.match(ok.setCookie.join(''), /^uid=b\d+\./);

  /* logging out puts them back to a guest on the next request */
  const bye = await json(me, 'POST', '/api/auth/logout');
  assert.equal(bye.code, 200);
  assert.match(bye.setCookie.join(''), /Max-Age=0/);
  const after = await json(me, 'GET', '/api/me');
  assert.equal(after.json.kind, 'guest');
  assert.notEqual(uidOf(me), Number(ok.setCookie.join('').match(/uid=b(\d+)\./)[1]));
});

test('bumping token_epoch invalidates every cookie already out there', async () => {
  const ip = '198.51.100.110';
  const form = application();
  const me = visitor(ip);
  await json(me, 'POST', '/api/auth/signup', form);
  const id = uidOf(me);
  const stolen = me.jar.get('uid');
  assert.equal((await json(me, 'GET', '/api/me')).json.kind, 'brand');

  dbm.db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?').run(id);

  assert.equal(identity.verifyCookie(stolen, Date.now()), null, 'the old cookie still verifies');
  const thief = visitor(ip);
  thief.jar.set('uid', stolen);
  const r = await json(thief, 'GET', '/api/me');
  assert.equal(r.json.kind, 'guest', 'a revoked session was still honoured');

  /* logging in again mints against the new epoch */
  const back = visitor(ip);
  const ok = await json(back, 'POST', '/api/auth/login', { email: form.email, password: form.password });
  assert.equal(ok.code, 200);
  assert.equal((await json(back, 'GET', '/api/me')).json.kind, 'brand');
  assert.notEqual(back.jar.get('uid'), stolen);
});

/* ── /api/book is for approved brands ─────────────────────────── */

test('booking is gated on an approved brand account', async () => {
  const ip = '198.51.100.120';
  const book = (who, n) => json(who, 'POST', '/api/book',
    encodeEnvelope({ name: 'NILE SODA CO.', url: 'https://nile-soda.example', cta: 'TRY IT' },
      freeRange(n, 'next').map(i => [i, 0xff3366])), 'application/octet-stream');

  /* a guest is told what to do about it */
  const guest = visitor(ip);
  const asGuest = await book(guest, 3);
  assert.equal(asGuest.code, 403);
  assert.equal(asGuest.json.error, 'brand-required');
  assert.equal(asGuest.json.reason, 'not-brand');
  assert.match(asGuest.json.message, /brand account/i);

  const form = application();
  const brand = visitor(ip);
  await json(brand, 'POST', '/api/auth/signup', form);
  const id = uidOf(brand);

  const pending = await book(brand, 3);
  assert.equal(pending.code, 403);
  assert.equal(pending.json.reason, 'pending');

  dbm.db.prepare("UPDATE brand_profiles SET status = 'rejected' WHERE user_id = ?").run(id);
  assert.equal((await book(brand, 3)).json.reason, 'rejected', 'a rejected brand should not get past the gate');

  /* the moderator's decision has to land without a new session */
  dbm.db.prepare("UPDATE brand_profiles SET status = 'approved' WHERE user_id = ?").run(id);
  const ok = await book(brand, 5);
  assert.equal(ok.code, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.booked, 5);
  assert.equal(ok.json.cost, 5 * cfg.PRICE_COMPANY);

  /* filed against the brand's own account, not whoever was at the keyboard */
  const sub = dbm.db.prepare(
    "SELECT user_id, brand_name, layer, px_count FROM submissions WHERE type = 'brand' AND user_id = ?").get(id);
  assert.equal(sub.user_id, id);
  assert.equal(sub.layer, 'next');
  assert.equal(sub.px_count, 5);
  assert.equal(sub.brand_name, 'NILE SODA CO.');

  /* and the snapshot tells the page which screen to show */
  const snapshot = await req(brand, 'GET', '/api/wall');
  const metaLen = snapshot.body.readUInt32LE(0);
  const meta = JSON.parse(snapshot.body.toString('utf8', 4, 4 + metaLen));
  assert.deepEqual(meta.me, { kind: 'brand', handle: 'Nile Soda Co.', brandStatus: 'approved' });
});

test('brands are exempt from the per-IP claim cap', () => {
  const ip = '198.51.100.130';
  const guest = { id: -1, kind: 'guest' }, brand = { id: -2, kind: 'brand' };
  for (let i = 0; i < cfg.IP_CLAIM_CAP; i++) identity.takeClaim(ip, guest, Date.now());
  assert.ok(identity.takeClaim(ip, guest, Date.now()), 'the guest cap did not bite');
  assert.equal(identity.takeClaim(ip, brand, Date.now()), null, 'a brand was caught by it');
});
