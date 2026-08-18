/* ═══════════════════════════════════════════════════════════════
   signin — the emailed code, and the limits that make it safe

   Six digits is a million possibilities, which is nothing. What
   makes this a credential rather than a formality is the ceiling on
   attempts, the single live code per address, and the refusal to
   say whether an address has an account behind it. Each of those is
   tested here as the attack it prevents, because a test that only
   asks somebody to type the right code passes against a version
   with no limits at all.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-signin-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
process.env.SESSION_SECRET = 'a-test-session-secret-long-enough';
/* Brevo "configured", so the door is open. Nothing reaches the network:
   the outbox is inspected instead of drained. */
process.env.BREVO_API_KEY = 'test-key';
process.env.BREVO_SENDER_EMAIL = 'noreply@example.test';
process.env.RATE_AUTH = '100000';
process.env.RATE_READ = '100000';
process.env.RATE_WRITE = '100000';
process.env.RETENTION_SWEEP = '0';
delete process.env.VERCEL;
delete process.env.GOOGLE_CLIENT_ID;

const app = require('../server.js');
const dbm = require('../server/db.js');
const identity = require('../server/identity.js');
const emailcode = require('../server/emailcode.js');
const mail = require('../server/mail.js');

const server = http.createServer(app);
let base = '';

const visitor = ip => ({ ip, jar: new Map() });
function req(who, method, url, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-forwarded-for': who.ip };
    if (body) headers['content-type'] = 'application/json';
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
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
const json = async (...a) => {
  const r = await req(...a);
  let parsed = {}; try { parsed = JSON.parse(r.body.toString('utf8')); } catch (e) { /* */ }
  return { code: r.code, json: parsed };
};

/* The code only exists in the email, which is the point. Tests reach past
   that by issuing a known one through the same statements the route uses. */
function plant(email, code, now = Date.now(), over = {}) {
  dbm.db.prepare(
    `INSERT INTO email_codes (email, hash, expires_at, attempts, sent, window_at, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET hash=excluded.hash, expires_at=excluded.expires_at,
       attempts=excluded.attempts, sent=excluded.sent`
  ).run(email, emailcode.hashOf(code, email),
    over.expires_at ?? now + emailcode.LIFE_MS, over.attempts ?? 0, over.sent ?? 1, now, now);
}

let seq = 0;
function account(kind = 'brand') {
  const now = Date.now();
  const email = `person${++seq}@example.test`;
  const id = Number(dbm.db.prepare(
    `INSERT INTO users (kind, handle, email, pass_hash, created_at, last_seen)
     VALUES (?, ?, ?, 'x', ?, ?)`).run(kind, `Person ${seq}`, email, now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(id);
  if (kind === 'brand') {
    dbm.db.prepare(
      `INSERT INTO brand_profiles (user_id, business_name, category, description, contact_name,
         phone, instapay_handle, status) VALUES (?,?,'Drinks','x','Sara','+20100','b@instapay','approved')`
    ).run(id, `Person ${seq}`);
  }
  identity.accept(id, { capacity: true }, now);
  return { id, email };
}

const queued = () => dbm.db.prepare('SELECT * FROM mail_outbox ORDER BY id').all();

test.before(async () => {
  mail.stopWorker();                       // nothing leaves; the outbox is read directly
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); dbm.close(); });

/* ── asking for one ───────────────────────────────────────────── */

test('asking for a code queues exactly one email', async () => {
  const a = account();
  dbm.db.prepare('DELETE FROM mail_outbox').run();

  const r = await json(visitor('203.0.113.1'), 'POST', '/api/auth/code/request', { email: a.email });
  assert.equal(r.code, 200);
  assert.equal(r.json.ok, true);

  const q = queued();
  assert.equal(q.length, 1);
  assert.equal(q[0].to_email, a.email);
  assert.match(q[0].subject, /\d{6}/, 'the code is in the subject, so the notification is enough');
  assert.equal(q[0].about, `code:${a.email}`);
});

test('an address with no account gets the same answer as one that has', async () => {
  dbm.db.prepare('DELETE FROM mail_outbox').run();
  const known = account();

  const a = await json(visitor('203.0.113.2'), 'POST', '/api/auth/code/request', { email: known.email });
  const b = await json(visitor('203.0.113.3'), 'POST', '/api/auth/code/request',
    { email: 'nobody-at-all@example.test' });

  assert.equal(a.code, b.code, 'same status');
  assert.deepEqual(a.json, b.json,
    'and the same body — a route that says "no account with that address" is a route ' +
    'that tells you which of your customers are worth attacking');
});

test('asking twice replaces the code rather than adding another', async () => {
  const a = account();
  dbm.db.prepare('DELETE FROM mail_outbox').run();
  const who = visitor('203.0.113.4');

  await json(who, 'POST', '/api/auth/code/request', { email: a.email });
  await json(who, 'POST', '/api/auth/code/request', { email: a.email });
  await json(who, 'POST', '/api/auth/code/request', { email: a.email });

  assert.equal(queued().length, 1,
    'one live code, one email — three racing into an inbox is three chances to guess');
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM email_codes WHERE email = ?').get(a.email).n, 1);
});

test('an address cannot be mailed forever', async () => {
  const a = account();
  const who = visitor('203.0.113.5');
  for (let i = 0; i < emailcode.PER_WINDOW + 3; i++) {
    const r = await json(who, 'POST', '/api/auth/code/request', { email: a.email });
    assert.equal(r.code, 200, 'always answered the same way');
  }
  const row = dbm.db.prepare('SELECT sent FROM email_codes WHERE email = ?').get(a.email);
  assert.ok(row.sent <= emailcode.PER_WINDOW,
    `stopped issuing at ${emailcode.PER_WINDOW}; this route must not be a way to post mail at a stranger`);
});

test('a malformed address is refused before anything is sent', async () => {
  dbm.db.prepare('DELETE FROM mail_outbox').run();
  const r = await json(visitor('203.0.113.6'), 'POST', '/api/auth/code/request', { email: 'not-an-address' });
  assert.equal(r.code, 400);
  assert.ok(r.json.fields.email);
  assert.equal(queued().length, 0);
});

/* ── using one ────────────────────────────────────────────────── */

test('the right code signs them in', async () => {
  const a = account('brand');
  plant(a.email, '123456');

  const who = visitor('203.0.113.10');
  const r = await json(who, 'POST', '/api/auth/code/verify', { email: a.email, code: '123456' });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.email, a.email);
  assert.equal(r.json.kind, 'brand');
  assert.ok(who.jar.get('uid'), 'and they are carrying a session');
});

test('a code is good exactly once', async () => {
  const a = account();
  plant(a.email, '222222');

  assert.equal((await json(visitor('203.0.113.11'), 'POST', '/api/auth/code/verify',
    { email: a.email, code: '222222' })).code, 200);
  const again = await json(visitor('203.0.113.12'), 'POST', '/api/auth/code/verify',
    { email: a.email, code: '222222' });
  assert.equal(again.code, 400, 'a replayed code is not a code');
});

test('three wrong guesses kill the code, not just the guess', async () => {
  const a = account();
  plant(a.email, '333333');
  const who = visitor('203.0.113.13');

  for (let i = 0; i < emailcode.MAX_TRIES; i++) {
    const r = await json(who, 'POST', '/api/auth/code/verify', { email: a.email, code: '000000' });
    assert.equal(r.code, 400);
  }
  /* and now the RIGHT code no longer works — otherwise the limit is a
     speed bump rather than a wall */
  const right = await json(who, 'POST', '/api/auth/code/verify', { email: a.email, code: '333333' });
  assert.equal(right.code, 400, 'the code died with the third wrong guess');
});

test('an expired code is refused', async () => {
  const a = account();
  plant(a.email, '444444', Date.now(), { expires_at: Date.now() - 1000 });
  const r = await json(visitor('203.0.113.14'), 'POST', '/api/auth/code/verify',
    { email: a.email, code: '444444' });
  assert.equal(r.code, 400);
});

test('a code for one address does not work for another', async () => {
  const a = account(), b = account();
  plant(a.email, '555555');
  /* the hash binds the code to the address, so lifting one row's hash
     cannot be replayed against a different account */
  const r = await json(visitor('203.0.113.15'), 'POST', '/api/auth/code/verify',
    { email: b.email, code: '555555' });
  assert.equal(r.code, 400);
});

test('a code cannot open a closed account', async () => {
  const a = account();
  dbm.db.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(a.id);
  plant(a.email, '666666');

  const r = await json(visitor('203.0.113.16'), 'POST', '/api/auth/code/verify',
    { email: a.email, code: '666666' });
  assert.equal(r.code, 403);
  assert.equal(r.json.error, 'account-closed', 'otherwise email is a way around a ban');
});

test('a valid code for an address with no account creates nothing', async () => {
  plant('ghost@example.test', '777777');
  const r = await json(visitor('203.0.113.17'), 'POST', '/api/auth/code/verify',
    { email: 'ghost@example.test', code: '777777' });
  assert.equal(r.code, 400,
    'proving you hold an address is not the same as having applied to be a brand');
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('ghost@example.test').n, 0);
});

test('the code is stored hashed, never in the clear', () => {
  const a = account();
  plant(a.email, '888888');
  const row = dbm.db.prepare('SELECT * FROM email_codes WHERE email = ?').get(a.email);
  assert.ok(!JSON.stringify(row).includes('888888'),
    'a credential in plain text is a credential in every backup of this database');
  assert.match(row.hash, /^[0-9a-f]{64}$/);
});

/* ── the door itself ──────────────────────────────────────────── */

test('the snapshot says which doors are open', async () => {
  const r = await req(visitor('203.0.113.20'), 'GET', '/api/wall');
  const n = r.body.readUInt32LE(0);
  const meta = JSON.parse(r.body.toString('utf8', 4, 4 + n));
  assert.equal(meta.signin.code, true, 'Brevo is configured in this suite');
  assert.equal(meta.signin.google, false, 'and Google is not — so the page renders no button');
});

test('password registration still works while Google is unconfigured', async () => {
  /* The route closes only where there is another way to make an account.
     With Google off there would otherwise be no way at all. */
  const who = visitor('203.0.113.21');
  await req(who, 'GET', '/api/wall');
  const r = await json(who, 'POST', '/api/auth/register',
    { email: 'still-works@example.test', password: 'a-long-enough-password', accept: true });
  assert.equal(r.code, 200);
});

/* ── The callback route, not just the token checks ────────────────
   google.test.js proves verifyIdToken rejects every forgery, and all of
   that was true while the route in front of it threw ReferenceError on
   the first real sign-in: it read `q`, which was declared inside two
   unrelated route blocks further up. The unit tests could not see it
   because they never went through HTTP.

   These do. They do not need Google to exist — with GOOGLE_CLIENT_ID
   unset the routes must 404, and that is itself the contract. */

test('the google routes are absent, not broken, when unconfigured', async () => {
  const who = visitor('203.0.113.30');
  const start = await json(who, 'GET', '/api/auth/google/start');
  assert.equal(start.code, 404);
  assert.equal(start.json.error, 'not-configured');

  const cb = await json(who, 'GET',
    '/api/auth/google/callback?state=abc&code=def');
  assert.equal(cb.code, 404,
    'and the callback answers the same way rather than throwing on its way to finding out');
  assert.equal(cb.json.error, 'not-configured');
});

test('every route that reads the query string can actually read it', async () => {
  /* The bug was one route reaching for a `q` that existed only inside two
     others. Walk the query-reading routes and assert none of them 500s —
     a ReferenceError surfaces as a 500 with a message, which is precisely
     what reached production. */
  const who = visitor('203.0.113.31');
  await req(who, 'GET', '/api/wall');

  const paths = [
    '/api/auth/google/callback?state=x&code=y',
    '/api/auth/google/start',
    '/api/me/history?limit=5&offset=0',
    '/api/me/notifications?limit=5'
  ];
  for (const p of paths) {
    const r = await json(who, 'GET', p);
    assert.notEqual(r.code, 500, `${p} → 500 ${JSON.stringify(r.json)}`);
    assert.ok(!/is not defined/.test(JSON.stringify(r.json)),
      `${p} threw a ReferenceError: ${JSON.stringify(r.json)}`);
  }
});
