/* ═══════════════════════════════════════════════════════════════
   payments — InstaPay, verified by a person

   PLAN §0 is blunt about why this file looks the way it does:
   InstaPay has no merchant API for a personal handle. No webhook
   confirms a transfer, no call reverses one. So the machine here does
   not try to know whether money arrived — it makes it cheap for a
   human to say so, and impossible for that answer to be lost.

   The shape of an order:

     awaiting_transfer   created, the payer has the link and a code
     submitted           they say they sent it, with a reference
     verified            a teammate found it in their own InstaPay app
     rejected            it never turned up
     refund_due          verified, then the pixels were turned down
     refunded            the money went back and somebody confirmed
     expired             48h passed and nothing arrived

   Two things earn their keep. The code — S37-XXXX, in the transfer
   note — is what turns "someone sent 240 EGP" into "this order", and
   it is short enough to retype off a phone. And refund_due nags: a
   card that re-posts every 24h until somebody taps it is the only
   reason a manual refund does not quietly become a not-refund.

   Every transition is guarded on the status it moves away from, same
   as submissions.js, because the buttons that drive it are Telegram
   buttons and Telegram delivers taps more than once.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config.js');
const { db, tx, logEvent } = require('./db.js');
const identity = require('./identity.js');

/* telegram.js and wall.js are handed in rather than required, for the same
   one-way-dependency reason submissions.js does it. */
let hooks = { card: () => {}, edit: () => {}, notify: () => {} };
const attach = h => { hooks = Object.assign(hooks, h); };

const HOLD_MS = 48 * 60 * 60 * 1000;            // §6: brand reservations, and unpaid orders
const REMIND_MS = 24 * 60 * 60 * 1000;          // §6: how often a refund_due card comes back

/* ── The code ─────────────────────────────────────────────────── */

/* No 0/O/1/I/5/S: it is read off a screen and typed into a banking app by
   someone who is already slightly annoyed. 4 characters of this alphabet is
   ~1.05M combinations, and the uniqueness check below makes the birthday
   maths somebody else's problem. */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const crypto = require('crypto');
const codeTaken = db.prepare('SELECT 1 FROM payments WHERE code = ?');

function newCode() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const bytes = crypto.randomBytes(4);
    let code = 'S37-';
    for (let i = 0; i < 4; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!codeTaken.get(code)) return code;
  }
  /* 40 collisions in a row means the space is genuinely crowded, not that we
     were unlucky — widen rather than spin. */
  return 'S37-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/* ── Statements ───────────────────────────────────────────────── */

const insPayment = db.prepare(
  `INSERT INTO payments (user_id, kind, pack, amount, code, status, hold_expires, created_at)
   VALUES (?, ?, ?, ?, ?, 'awaiting_transfer', ?, ?)`);
const selPayment = db.prepare('SELECT * FROM payments WHERE id = ?');
const selByCode = db.prepare('SELECT * FROM payments WHERE code = ?');
const linkSub = db.prepare('UPDATE submissions SET payment_id = ? WHERE id = ?');
const selSubForPayment = db.prepare('SELECT id, status FROM submissions WHERE payment_id = ?');

const goSubmitted = db.prepare(
  `UPDATE payments SET status = 'submitted', instapay_ref = ?, payer_handle = ?
     WHERE id = ? AND status IN ('awaiting_transfer','submitted')`);
const setShot = db.prepare('UPDATE payments SET screenshot_path = ? WHERE id = ?');
const goVerified = db.prepare(
  `UPDATE payments SET status = 'verified', verified_at = ?, verified_by = ?
     WHERE id = ? AND status = 'submitted'`);
const goRejected = db.prepare(
  `UPDATE payments SET status = 'rejected' WHERE id = ? AND status IN ('awaiting_transfer','submitted')`);
const goRefunded = db.prepare(
  `UPDATE payments SET status = 'refunded', refunded_at = ?, refunded_by = ?
     WHERE id = ? AND status = 'refund_due'`);
const goExpired = db.prepare(
  `UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'awaiting_transfer'`);

const staleOrders = db.prepare(
  `SELECT * FROM payments WHERE status = 'awaiting_transfer' AND hold_expires IS NOT NULL
     AND hold_expires <= ?`);
const owedRefunds = db.prepare("SELECT * FROM payments WHERE status = 'refund_due'");
const listFor = db.prepare(
  'SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?');

/* ── Prices ───────────────────────────────────────────────────── */

/* Everything in integer piasters (§2) — EGP has 100 of them and a float
   here would eventually be off by one in somebody's favour. */
const piasters = egp => Math.round(egp * 100);
const packPrice = pack => cfg.PACKS[pack];
const bookingPrice = px => piasters(px * cfg.PRICE_COMPANY);

/* ── Creating an order ────────────────────────────────────────── */

/* No transaction of its own: booking creates the submission, its cells and
   its payment together, and this is the middle of that. */
function createOrder(userId, kind, opts, now = Date.now()) {
  const pack = kind === 'paint_pack' ? Number(opts.pack) : null;
  const amount = kind === 'paint_pack' ? piasters(packPrice(pack)) : bookingPrice(opts.px);
  if (!amount || amount < 0) return null;

  const code = newCode();
  const id = Number(insPayment.run(userId, kind, pack, amount, code, now + HOLD_MS, now).lastInsertRowid);
  if (opts.sid) linkSub.run(id, opts.sid);
  logEvent(`user:${userId}`, 'order', { payment: id, kind, pack, amount, code, sid: opts.sid || null }, now);
  return { id, code, amount, kind, pack, holdExpires: now + HOLD_MS };
}

/* What the checkout modal needs to say. The QR is the user's own official
   one (§6.1) — it encodes an IPN payload we have no business regenerating —
   so it is offered only when the file is actually there, and the link and
   the code work perfectly well without it. */
const fs = require('fs');
const path = require('path');
const QR_FILE = path.join(cfg.ROOT, 'assets', 'instapay-qr.png');

function instructionsFor(order) {
  return {
    paymentId: order.id,
    code: order.code,
    amount: order.amount,
    amountEgp: order.amount / 100,
    url: cfg.INSTAPAY_URL || null,
    handle: cfg.INSTAPAY_HANDLE || null,
    qr: fs.existsSync(QR_FILE) ? 'assets/instapay-qr.png' : null,
    holdExpires: order.holdExpires || null,
    holdHours: HOLD_MS / 3600000
  };
}

/* ── The payer says they have paid ────────────────────────────── */

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 \-_/.]{3,63}$/;

function submitProof(paymentId, userId, body, now = Date.now()) {
  const p = selPayment.get(paymentId);
  if (!p || p.user_id !== userId) return { error: 'not-found', status: 404 };
  if (!['awaiting_transfer', 'submitted'].includes(p.status)) {
    return { error: 'settled', status: 409, message: `That order is already ${p.status.replace('_', ' ')}.` };
  }

  const ref = String((body && body.instapay_ref) || '').trim();
  const handle = String((body && body.payer_handle) || '').trim().slice(0, 64);
  if (!REF_RE.test(ref)) {
    return {
      error: 'bad-reference', status: 400,
      fields: { instapay_ref: 'Copy the transaction reference from your InstaPay receipt — at least 4 characters.' }
    };
  }
  if (!handle) {
    return {
      error: 'bad-handle', status: 400,
      fields: { payer_handle: 'We need the handle or number you paid from — that is where a refund would go.' }
    };
  }

  const changed = tx(() => {
    if (!goSubmitted.run(ref, handle, paymentId).changes) return false;
    logEvent(`user:${userId}`, 'payment-submitted', { payment: paymentId, ref, handle }, now);
    return true;
  });
  if (!changed) return { error: 'settled', status: 409 };

  hooks.card(paymentId);
  return { ok: true, paymentId, status: 'submitted' };
}

function attachScreenshot(paymentId, userId, file, now = Date.now()) {
  const p = selPayment.get(paymentId);
  if (!p || p.user_id !== userId) return { error: 'not-found', status: 404 };
  if (!['awaiting_transfer', 'submitted'].includes(p.status)) return { error: 'settled', status: 409 };
  setShot.run(file, paymentId);
  logEvent(`user:${userId}`, 'payment-screenshot', { payment: paymentId }, now);
  return { ok: true };
}

/* ── A teammate found it (or did not) ─────────────────────────── */

/* Verifying a paint pack is the moment the paint exists — credited inside
   the same transaction that records the verification, so there is no window
   where the money is confirmed and the balance is not (§6.3). */
function verify(paymentId, actor, now = Date.now()) {
  const p = selPayment.get(paymentId);
  if (!p) return { ok: false, missing: true };

  const r = tx(() => {
    if (!goVerified.run(now, actor, paymentId).changes) return null;
    if (p.kind === 'paint_pack' && p.pack) identity.creditPaintRaw(p.user_id, p.pack);
    logEvent(actor, 'payment-verified',
      { payment: paymentId, user: p.user_id, amount: p.amount, kind: p.kind }, now);
    return true;
  });
  if (!r) return { ok: false, already: p.status, by: p.verified_by || null };

  identity.forget(p.user_id);                   // the cached row's paint is now stale
  hooks.edit(paymentId, 'verified', actor);
  hooks.notify(p.user_id, paymentId, 'verified');
  return { ok: true, paymentId, status: 'verified', credited: p.kind === 'paint_pack' ? p.pack : 0 };
}

function reject(paymentId, actor, now = Date.now()) {
  const p = selPayment.get(paymentId);
  if (!p) return { ok: false, missing: true };

  const r = tx(() => {
    if (!goRejected.run(paymentId).changes) return null;
    logEvent(actor, 'payment-rejected', { payment: paymentId, user: p.user_id }, now);
    return true;
  });
  if (!r) return { ok: false, already: p.status, by: p.verified_by || null };

  /* An unpaid booking holds cells it has not paid for — they go back on the
     wall for somebody else the moment the order is void. */
  const sub = selSubForPayment.get(paymentId);
  if (sub && sub.status === 'pending') hooks.voidSubmission(sub.id, actor, 'payment not received', now);

  hooks.edit(paymentId, 'rejected', actor);
  hooks.notify(p.user_id, paymentId, 'rejected');
  return { ok: true, paymentId, status: 'rejected' };
}

/* The money went back. Manual, like everything else here — this is the
   record that it happened, and the thing that stops the 24h nag. */
function markRefunded(paymentId, actor, now = Date.now()) {
  const p = selPayment.get(paymentId);
  if (!p) return { ok: false, missing: true };

  const r = tx(() => {
    if (!goRefunded.run(now, actor, paymentId).changes) return null;
    logEvent(actor, 'payment-refunded',
      { payment: paymentId, user: p.user_id, amount: p.amount, to: p.payer_handle }, now);
    return true;
  });
  if (!r) return { ok: false, already: p.status, by: p.refunded_by || null };

  hooks.edit(paymentId, 'refunded', actor);
  hooks.notify(p.user_id, paymentId, 'refunded');
  return { ok: true, paymentId, status: 'refunded' };
}

/* ── The sweeper ──────────────────────────────────────────────── */

/* One timer for both jobs, because they are the same job: things that were
   supposed to happen by now and did not. Runs every few minutes; neither
   deadline is tight enough to want a tighter loop. */
function sweep(now = Date.now()) {
  const out = { expired: 0, reminded: 0 };

  for (const p of staleOrders.all(now)) {
    const done = tx(() => {
      if (!goExpired.run(p.id).changes) return false;
      logEvent('system', 'payment-expired', { payment: p.id, user: p.user_id }, now);
      return true;
    });
    if (!done) continue;
    out.expired++;
    /* a booking whose order lapsed lets its cells go — they were never paid
       for, and holding them for a month would be the expensive kind of bug */
    const sub = selSubForPayment.get(p.id);
    if (sub && sub.status === 'pending') hooks.voidSubmission(sub.id, 'system:sweep', 'payment never arrived', now);
    hooks.edit(p.id, 'expired', 'system');
    hooks.notify(p.user_id, p.id, 'expired');
  }

  /* §6: a refund that nobody is nagged about is a refund that does not
     happen. The card comes back every 24h until somebody taps it. */
  for (const p of owedRefunds.all()) {
    const last = Number(p.refunded_at || 0) || Number(p.verified_at || p.created_at);
    if (now - last < REMIND_MS) continue;
    /* refunded_at doubles as "last reminded" while the status is refund_due;
       it is only meaningful as a refund date once the status says refunded */
    db.prepare('UPDATE payments SET refunded_at = ? WHERE id = ? AND status = ?')
      .run(now, p.id, 'refund_due');
    hooks.remind(p.id);
    out.reminded++;
  }
  return out;
}

let timer = null;
function startSweeper(everyMs = 5 * 60 * 1000) {
  if (timer) return timer;
  timer = setInterval(() => {
    try { sweep(Date.now()); } catch (err) { console.warn('payments sweep:', err.message); }
  }, everyMs);
  timer.unref();
  return timer;
}
function stopSweeper() { if (timer) clearInterval(timer); timer = null; }

/* ── Reads ────────────────────────────────────────────────────── */

const get = id => selPayment.get(id);
const byCode = code => selByCode.get(String(code || '').toUpperCase());
const forUser = (userId, limit = 20, offset = 0) => listFor.all(userId, limit, offset);

module.exports = {
  attach, createOrder, instructionsFor, submitProof, attachScreenshot,
  verify, reject, markRefunded, sweep, startSweeper, stopSweeper,
  newCode, get, byCode, forUser, piasters, packPrice, bookingPrice,
  HOLD_MS, REMIND_MS, ALPHABET
};
