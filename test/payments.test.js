/* ═══════════════════════════════════════════════════════════════
   payments test — the promises Phase 5 makes

   Money that cannot be confirmed programmatically has to be
   confirmed by a person, so the properties worth pinning are the
   ones that stop a person's mistake becoming a customer's loss:
   that verifying credits paint in the same breath, that a rejected
   booking lets go of the pixels it was holding, that money taken for
   pixels that never went up becomes a refund somebody is nagged
   about, and that a double-tapped button is one decision.

   Plus the upload path, which is the only place bytes from a
   stranger reach the disk.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-payments-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
process.env.TG_MODE = 'webhook';                // decisions are driven by hand
process.env.INSTAPAY_URL = 'https://ipn.eg/S/example/instapay/TEST';
process.env.INSTAPAY_HANDLE = 'example@instapay';
process.env.IP_CLAIM_CAP = '1000';
/* The §9 token buckets are per minute and this file spends a day's worth
   of requests in a second; raised so the assertions are about the caps and
   the races they are testing rather than the rate limiter in front of them.
   admin.test.js deliberately leaves RATE_AUTH alone — the login throttle is
   one of the things it checks. */
process.env.RATE_READ = '100000';
process.env.RATE_WRITE = '100000';
process.env.RATE_AUTH = '100000';
delete process.env.VERCEL;
delete process.env.DEV;

const app = require('../server.js');
const dbm = require('../server/db.js');
const wall = require('../server/wall.js');
const payments = require('../server/payments.js');
const submissions = require('../server/submissions.js');
const identity = require('../server/identity.js');
const uploads = require('../server/uploads.js');
const cfg = require('../server/config.js');
const { S } = require('../server/settings.js');

/* ── helpers ──────────────────────────────────────────────────── */

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
const json = async (who, method, url, body, type) => {
  const r = await req(who, method, url, body === undefined ? null
    : (type ? body : JSON.stringify(body)), type);
  let parsed = {};
  try { parsed = JSON.parse(r.body.toString('utf8')); } catch (e) { /* binary */ }
  return { code: r.code, json: parsed };
};
const uidOf = who => Number(String(who.jar.get('uid') || '').split('.')[0].replace(/^b/, ''));

const ENTRY = 9;
function envelope(meta, px) {
  const j = Buffer.from(JSON.stringify(meta), 'utf8');
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

let nextFree = 500000;
const freeRange = n => {
  const out = [];
  while (out.length < n) {
    const i = nextFree++;
    if (!wall.wall.reserved.has(i) && !wall.wall.pending.next.has(i)) out.push(i);
  }
  return out;
};

/* an approved brand, without going through the whole application */
function brand(ip, name) {
  const who = visitor(ip);
  const now = Date.now();
  const id = Number(dbm.db.prepare(
    "INSERT INTO users (kind, handle, email, pass_hash, created_at, last_seen) VALUES ('brand', ?, ?, 'x', ?, ?)"
  ).run(name, `${name.replace(/\W/g, '')}@example.test`, now, now).lastInsertRowid);
  dbm.db.prepare('INSERT INTO allowances (user_id) VALUES (?)').run(id);
  dbm.db.prepare(
    `INSERT INTO brand_profiles (user_id, business_name, category, description, contact_name,
       phone, instapay_handle, status) VALUES (?, ?, 'Drinks', 'x', 'Sara', '+20100', ?, 'approved')`
  ).run(id, name, 'payer@instapay');
  /* signup records this in the same transaction as the account; this helper
     builds the row directly, so it has to say so too — a brand that agreed
     to nothing cannot book, which is the point of the gate */
  identity.accept(id, { capacity: true }, now);
  const e = identity.rowFor(id, now);
  who.jar.set('uid', identity.cookieValue(id, 'brand', 0, now).value);
  return { who, id, e };
}

const payOf = id => dbm.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
const subOf = id => dbm.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
const paintOf = uid => dbm.db.prepare('SELECT paint FROM allowances WHERE user_id = ?').get(uid).paint;

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  submissions.cancelPending(); payments.stopSweeper();
  server.close(); dbm.close();
});

/* ── the code ─────────────────────────────────────────────────── */

test('the order code is short, unambiguous and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = payments.newCode();
    assert.match(code, /^S37-[A-Z2-9]{4}$/);
    /* the characters a person will misread off a phone are not in it */
    assert.equal(/[01OIS5]/.test(code.slice(4)), false, `ambiguous character in ${code}`);
    seen.add(code);
  }
  assert.ok(seen.size > 490, 'and not the same one over and over');
});

/* Paint is only sold to accounts (§3): a browser cookie is not somewhere
   money can live, and a cleared one would strand a real transfer. Every
   buyer below signs up first — which is the flow the shop now enforces. */
let buyerSeq = 0;
async function buyer(ip) {
  const who = visitor(ip);
  await req(who, 'GET', '/api/wall');
  const r = await json(who, 'POST', '/api/auth/register',
    { email: `buyer${++buyerSeq}@painter.example`, password: 'a-long-enough-password',
      accept: true });
  assert.equal(r.code, 200, 'the buyer has an account to keep paint on');
  return who;
}

/* ── buying paint ─────────────────────────────────────────────── */

test('a paint order credits nothing until a person confirms it', async () => {
  const me = await buyer('203.0.113.100');
  const uid = uidOf(me);

  const order = await json(me, 'POST', '/api/paint/order', { pack: 100 });
  assert.equal(order.code, 200);
  assert.match(order.json.code, /^S37-/);
  assert.equal(order.json.amountEgp, S.PACKS[100]);
  assert.equal(order.json.url, 'https://ipn.eg/S/example/instapay/TEST');
  assert.equal(order.json.handle, 'example@instapay');
  /* The QR is optional by design: shipped when assets/instapay-qr.png is
     there, link-only when it is not. Asserted against the file rather than
     against a fixed answer, so adding or removing the image is never a
     failing test — the old assertion pinned its absence and broke the day
     the real one arrived. */
  const hasQr = fs.existsSync(path.join(__dirname, '..', 'assets', 'instapay-qr.png'));
  assert.equal(order.json.qr, hasQr ? 'assets/instapay-qr.png' : null,
    'the checkout offers the QR exactly when there is one to offer');
  assert.equal(paintOf(uid), 0, 'nothing credited on ordering');
  assert.equal(payOf(order.json.paymentId).status, 'awaiting_transfer');

  /* the payer says they have sent it */
  const proof = await json(me, 'POST', `/api/payments/${order.json.paymentId}/proof`,
    { instapay_ref: '5011234567', payer_handle: 'me@instapay' });
  assert.equal(proof.code, 200);
  const p = payOf(order.json.paymentId);
  assert.equal(p.status, 'submitted');
  assert.equal(p.instapay_ref, '5011234567');
  assert.equal(paintOf(uid), 0, 'still nothing — saying so is not paying');

  /* …and a teammate finds it in their own app */
  const v = payments.verify(order.json.paymentId, 'tg:1 (sara)');
  assert.equal(v.ok, true);
  assert.equal(v.credited, 100);
  assert.equal(paintOf(uid), 100, 'the paint and the verification commit together');

  const allowance = await json(me, 'GET', '/api/allowance');
  assert.equal(allowance.json.paint, 100, 'and the cached row was not left stale');
});

test('a paint pack shows up in MY PIXELS, where the checkout said it would', async () => {
  const me = await buyer('203.0.113.130');
  const order = await json(me, 'POST', '/api/paint/order', { pack: 500 });
  await json(me, 'POST', `/api/payments/${order.json.paymentId}/proof`,
    { instapay_ref: '5044556677', payer_handle: 'me@instapay' });

  const h = await json(me, 'GET', '/api/me/history');
  /* a pack is money with no pixels behind it — it has no submission at all,
     so it only appears if the query goes looking for it */
  const row = h.json.rows.find(r => r.payment && r.payment.id === order.json.paymentId);
  assert.ok(row, 'the purchase is in the list');
  assert.equal(row.sid, null);
  assert.equal(row.type, 'pack');
  assert.equal(row.px, 500, 'the pack size, not a pixel count');
  assert.equal(row.status, 'pending');
  assert.equal(row.payment.status, 'submitted');
  assert.equal(h.json.total, 1);

  payments.verify(order.json.paymentId, 'tg:1 (sara)');
  const after = await json(me, 'GET', '/api/me/history');
  const done = after.json.rows.find(r => r.payment && r.payment.id === order.json.paymentId);
  assert.equal(done.status, 'approved', 'which the page shows as PAINT ADDED');
  assert.equal(done.payment.status, 'verified');
});

test('a reference has to look like one', async () => {
  const me = await buyer('203.0.113.101');
  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });
  const id = order.json.paymentId;

  const short = await json(me, 'POST', `/api/payments/${id}/proof`,
    { instapay_ref: 'x', payer_handle: 'me@instapay' });
  assert.equal(short.code, 400);
  assert.ok(short.json.fields.instapay_ref);

  const noHandle = await json(me, 'POST', `/api/payments/${id}/proof`,
    { instapay_ref: '5011234567', payer_handle: '  ' });
  assert.equal(noHandle.code, 400);
  assert.ok(noHandle.json.fields.payer_handle);
  assert.equal(payOf(id).status, 'awaiting_transfer');
});

test('somebody else cannot pay off, or look at, your order', async () => {
  const me = await buyer('203.0.113.102'), nosy = visitor('203.0.113.103');
  await req(nosy, 'GET', '/api/wall');
  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });

  const r = await json(nosy, 'POST', `/api/payments/${order.json.paymentId}/proof`,
    { instapay_ref: '5011234567', payer_handle: 'nosy@instapay' });
  assert.equal(r.code, 404, 'and is told nothing about whose it is');
  assert.equal(payOf(order.json.paymentId).status, 'awaiting_transfer');

  /* …and cannot put a file on their order either. The upload is named after
     the payment id and writing it is an overwrite, so a stranger who got as
     far as the disk would be replacing the evidence a moderator confirms the
     transfer against — the ownership check has to come first. */
  const id = order.json.paymentId;
  const mine = pngOf(8, 8);
  const ok = await req(me, 'POST', `/api/payments/${id}/screenshot`, mine, 'image/png');
  assert.equal(ok.code, 200);
  const shot = payOf(id).screenshot_path;
  assert.ok(shot && fs.existsSync(shot), 'the owner\'s screenshot is on disk');
  const before = fs.readFileSync(shot);

  const theirs = await req(nosy, 'POST', `/api/payments/${id}/screenshot`, pngOf(64, 64), 'image/png');
  assert.equal(theirs.code, 404, 'a stranger is refused');
  assert.deepEqual(fs.readFileSync(shot), before, 'and did not overwrite the file on the way to being refused');
});

test('an unpaid order expires and cannot then be paid', async () => {
  const me = await buyer('203.0.113.104');
  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });
  const id = order.json.paymentId;

  payments.sweep(Date.now() + payments.HOLD_MS + 1000);
  assert.equal(payOf(id).status, 'expired');

  const late = await json(me, 'POST', `/api/payments/${id}/proof`,
    { instapay_ref: '5011234567', payer_handle: 'me@instapay' });
  assert.equal(late.code, 409);
});

test('a double-tapped button is one decision', async () => {
  const me = await buyer('203.0.113.105');
  const uid = uidOf(me);
  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });
  await json(me, 'POST', `/api/payments/${order.json.paymentId}/proof`,
    { instapay_ref: '99887766', payer_handle: 'me@instapay' });

  const first = payments.verify(order.json.paymentId, 'tg:1 (sara)');
  const second = payments.verify(order.json.paymentId, 'tg:2 (omar)');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.already, 'verified');
  assert.equal(second.by, 'tg:1 (sara)');
  assert.equal(paintOf(uid), 25, 'credited once, not twice');

  const flip = payments.reject(order.json.paymentId, 'tg:2 (omar)');
  assert.equal(flip.ok, false, 'and verified money cannot be un-verified by tapping');
});

/* ── brand bookings ───────────────────────────────────────────── */

test('a booking holds the ground and comes with an order for it', async () => {
  const { who, id } = brand('203.0.113.110', 'NILE SODA CO.');
  const px = freeRange(60).map(i => [i, 0x2255ff]);
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'NILE SODA CO.' }, px),
    'application/octet-stream');

  assert.equal(r.code, 200);
  assert.equal(r.json.booked, 60);
  assert.equal(r.json.pending, true);
  assert.ok(r.json.payment, 'and the transfer instructions come with it');
  assert.equal(r.json.payment.amountEgp, 60 * cfg.PRICE_COMPANY);
  assert.ok(r.json.payment.holdExpires > Date.now());

  const p = payOf(r.json.payment.paymentId);
  assert.equal(p.kind, 'brand_booking');
  assert.equal(p.user_id, id);
  assert.equal(subOf(r.json.sid).payment_id, p.id, 'the submission knows what pays for it');
  assert.equal(wall.wall.pending.next.size >= 60, true, 'the cells are held');
});

test('a booking cannot be approved ahead of its payment', async () => {
  const { who } = brand('203.0.113.113', 'TWO GATES CO.');
  const px = freeRange(15).map(i => [i, 0x336699]);
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'TWO GATES CO.' }, px),
    'application/octet-stream');
  const pid = r.json.payment.paymentId, sid = r.json.sid;

  const early = submissions.approve(sid, 'tg:1 (sara)');
  assert.equal(early.ok, false);
  assert.equal(early.unpaid, true, 'content is fine, but nobody has paid yet');
  assert.equal(subOf(sid).status, 'pending', 'the pixels stay held, not live');

  await json(who, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: 'two-gates-1', payer_handle: 'twogates@instapay' });
  const stillEarly = submissions.approve(sid, 'tg:1 (sara)');
  assert.equal(stillEarly.unpaid, true, 'a reference alone is not verified money');

  payments.verify(pid, 'tg:1 (sara)');
  const now = submissions.approve(sid, 'tg:1 (sara)');
  assert.equal(now.ok, true, 'verified — the second gate opens');
  assert.equal(subOf(sid).status, 'approved');
});

test('a booking nobody pays for lets the pixels go', async () => {
  const { who } = brand('203.0.113.111', 'SLOW CO.');
  const idxs = freeRange(20);
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'SLOW CO.' },
    idxs.map(i => [i, 0x991144])), 'application/octet-stream');
  const pid = r.json.payment.paymentId;
  for (const i of idxs) assert.ok(wall.wall.pending.next.has(i));

  payments.sweep(Date.now() + payments.HOLD_MS + 1000);

  assert.equal(payOf(pid).status, 'expired');
  assert.equal(subOf(r.json.sid).status, 'rejected', 'the booking goes with the order');
  for (const i of idxs) {
    assert.equal(wall.wall.pending.next.has(i), false, 'and the ground is free again');
  }
});

test('money that never arrived frees the spot immediately', async () => {
  const { who } = brand('203.0.113.112', 'WRONG CO.');
  const idxs = freeRange(12);
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'WRONG CO.' },
    idxs.map(i => [i, 0x445566])), 'application/octet-stream');
  const pid = r.json.payment.paymentId;
  await json(who, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: 'made-up-1234', payer_handle: 'wrong@instapay' });

  const rej = payments.reject(pid, 'tg:1 (sara)');
  assert.equal(rej.ok, true);
  assert.equal(subOf(r.json.sid).status, 'rejected');
  for (const i of idxs) assert.equal(wall.wall.pending.next.has(i), false);
});

/* ── refunds (§6) ─────────────────────────────────────────────── */

test('money nobody has checked yet is owed back, not written off', async () => {
  /* The dangerous order of events: the brand transfers, submits the
     reference, and the artwork is rejected before anyone opens the bank app.
     The payment was closing as "expired" — the never-arrived outcome — so a
     transfer that may well have landed left no record of being owed. */
  const { who } = brand('203.0.113.118', 'UNCHECKED CO.');
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'UNCHECKED CO.' },
    freeRange(20).map(i => [i, 0x224466])), 'application/octet-stream');
  const pid = r.json.payment.paymentId;

  await json(who, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: '5011122233', payer_handle: 'unchecked@instapay' });
  assert.equal(payOf(pid).status, 'submitted', 'said to be sent, not yet verified');

  assert.equal(submissions.reject(r.json.sid, 'tg:1 (sara)', 'not this month').ok, true);
  assert.equal(payOf(pid).status, 'refund_due', 'the debt is recorded rather than lost');

  /* an order nobody ever claimed to have paid still just expires */
  const quiet = brand('203.0.113.119', 'NEVER PAID CO.');
  const q = await json(quiet.who, 'POST', '/api/book', envelope({ name: 'NEVER PAID CO.' },
    freeRange(20).map(i => [i, 0x664422])), 'application/octet-stream');
  assert.equal(submissions.reject(q.json.sid, 'tg:1 (sara)', 'no').ok, true);
  assert.equal(payOf(q.json.payment.paymentId).status, 'expired', 'nothing sent, nothing owed');

  /* settle it: refund_due is global state the sweep counts, and a debt left
     lying here would show up in the next test's nag count */
  payments.markRefunded(pid, 'tg:1 (sara)');
  assert.equal(payOf(pid).status, 'refunded');
});

test('rejecting paid-for pixels owes the money back, and keeps saying so', async () => {
  const { who } = brand('203.0.113.113', 'TURNED DOWN CO.');
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'TURNED DOWN CO.' },
    freeRange(30).map(i => [i, 0x778899])), 'application/octet-stream');
  const pid = r.json.payment.paymentId;

  await json(who, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: '5099887766', payer_handle: 'payer@instapay' });
  assert.equal(payments.verify(pid, 'tg:1 (sara)').ok, true);
  assert.equal(payOf(pid).status, 'verified');

  /* the money is in, and then the artwork is turned down */
  assert.equal(submissions.reject(r.json.sid, 'tg:1 (sara)', 'covers another brand').ok, true);
  assert.equal(payOf(pid).status, 'refund_due', 'never keep money for pixels that will not go up');

  /* …and it is nagged about until somebody sends it */
  const day = payments.REMIND_MS;
  assert.equal(payments.sweep(Date.now()).reminded, 0, 'not immediately');
  assert.equal(payments.sweep(Date.now() + day + 1000).reminded, 1);
  assert.equal(payments.sweep(Date.now() + day + 2000).reminded, 0, 'and not again straight away');
  assert.equal(payments.sweep(Date.now() + 2 * day + 5000).reminded, 1, 'but again tomorrow');

  const done = payments.markRefunded(pid, 'tg:1 (sara)');
  assert.equal(done.ok, true);
  assert.equal(payOf(pid).status, 'refunded');
  assert.equal(payments.sweep(Date.now() + 9 * day).reminded, 0, 'the nagging stops');
});

test('the history shows a refund as a refund', async () => {
  const { who } = brand('203.0.113.114', 'REFUND CO.');
  const r = await json(who, 'POST', '/api/book', envelope({ name: 'REFUND CO.' },
    freeRange(10).map(i => [i, 0xaa3344])), 'application/octet-stream');
  const pid = r.json.payment.paymentId;
  await json(who, 'POST', `/api/payments/${pid}/proof`,
    { instapay_ref: '5000111222', payer_handle: 'payer@instapay' });
  payments.verify(pid, 'tg:1 (sara)');
  submissions.reject(r.json.sid, 'tg:1 (sara)', 'not this month');

  const h = await json(who, 'GET', '/api/me/history');
  const row = h.json.rows.find(x => x.sid === r.json.sid);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reason, 'not this month');
  assert.equal(row.payment.status, 'refund_due');
  assert.equal(row.payment.amount, 10 * cfg.PRICE_COMPANY * 100, 'piasters, not pounds');
});

/* ── uploads ──────────────────────────────────────────────────── */

const pngOf = (w, h) => {
  const png = new PNG({ width: w, height: h });
  png.data.fill(200);
  return PNG.sync.write(png);
};

test('a screenshot is sniffed, not trusted', () => {
  assert.equal(uploads.sniff(pngOf(4, 4)), 'png');
  assert.equal(uploads.sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), 'jpeg');
  assert.equal(uploads.sniff(Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.equal(uploads.sniff(Buffer.from('<?php echo 1; ?>')), null);
  assert.equal(uploads.sniff(Buffer.from('%PDF-1.7')), null);

  /* a script that says it is an image is still not one */
  const r = uploads.store(Buffer.from('GIF89a<script>alert(1)</script>'), 'x');
  assert.equal(r.error, 'not-an-image');
});

test('a PNG is rebuilt from its pixels, so nothing rides along', () => {
  const png = PNG.sync.read(pngOf(8, 6));
  const original = PNG.sync.write(png);
  /* a text chunk, of the kind an exporter or an attacker leaves behind */
  const marker = Buffer.from('SECRET-PAYLOAD-DO-NOT-KEEP');
  const chunk = Buffer.concat([
    Buffer.alloc(4), Buffer.from('tEXt'), Buffer.from('Comment\0'), marker, Buffer.alloc(4)]);
  chunk.writeUInt32BE(8 + marker.length, 0);
  const withChunk = Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
  assert.ok(withChunk.includes(marker), 'the fixture actually contains it');

  const out = uploads.store(withChunk, 'test-png');
  assert.ok(!out.error, out.message);
  const stored = fs.readFileSync(out.file);
  assert.equal(stored.includes(marker), false, 'and the stored copy does not');
  assert.equal(uploads.sniff(stored), 'png');
});

test('a JPEG keeps its picture and loses its EXIF', () => {
  const gps = Buffer.from('Exif\0\0GPS-LATITUDE-30.0444-LONGITUDE-31.2357');
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), Buffer.alloc(2), gps]);
  app1.writeUInt16BE(2 + gps.length, 2);
  const scan = Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0xAB, 0xCD, 0xEF, 0xFF, 0xD9]);
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, scan]);
  assert.ok(jpeg.includes('GPS-LATITUDE'), 'the fixture actually contains it');

  const out = uploads.store(jpeg, 'test-jpeg');
  assert.ok(!out.error, out.message);
  const stored = fs.readFileSync(out.file);
  assert.equal(stored.includes('GPS-LATITUDE'), false, 'location data does not survive storage');
  assert.equal(uploads.sniff(stored), 'jpeg');
  assert.ok(stored.includes(Buffer.from([0xAB, 0xCD, 0xEF])), 'but the image data does');
});

test('a WebP loses its EXIF chunk and its advertisement of one', () => {
  const vp8x = Buffer.concat([
    Buffer.from('VP8X'), Buffer.alloc(4), Buffer.from([0b00001000, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  vp8x.writeUInt32LE(10, 4);
  const exif = Buffer.concat([Buffer.from('EXIF'), Buffer.alloc(4), Buffer.from('GPS-HERE-XX')]);
  exif.writeUInt32LE(11, 4);
  const body = Buffer.concat([vp8x, exif, Buffer.alloc(1)]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'ascii');
  const webp = Buffer.concat([head, body]);

  const out = uploads.store(webp, 'test-webp');
  assert.ok(!out.error, out.message);
  const stored = fs.readFileSync(out.file);
  assert.equal(stored.includes('GPS-HERE'), false);
  assert.equal(stored.includes('EXIF'), false);
  assert.equal(uploads.sniff(stored), 'webp');
  const flags = stored[stored.indexOf('VP8X') + 8];
  assert.equal(flags & 0b00001000, 0, 'and the VP8X flag claiming EXIF is cleared with it');
});

test('an oversize upload is refused before it is written', () => {
  const huge = Buffer.concat([pngOf(2, 2), Buffer.alloc(uploads.MAX_BYTES)]);
  assert.equal(uploads.store(huge, 'nope').error, 'too-large');
});

test('a screenshot lands on the payment through the route', async () => {
  const me = await buyer('203.0.113.120');
  const order = await json(me, 'POST', '/api/paint/order', { pack: 25 });
  const id = order.json.paymentId;

  const up = await req(me, 'POST', `/api/payments/${id}/screenshot`, pngOf(20, 20), 'image/png');
  assert.equal(up.code, 200);
  const shot = payOf(id).screenshot_path;
  assert.ok(shot && fs.existsSync(shot));
  /* it is under DATA_DIR, which http.js refuses to serve */
  assert.ok(shot.startsWith(cfg.DATA_DIR), 'never inside the web root');

  const junk = await req(me, 'POST', `/api/payments/${id}/screenshot`,
    Buffer.from('not an image at all'), 'image/png');
  assert.equal(junk.code, 400);
});
