/* ═══════════════════════════════════════════════════════════════
   submissions — pending → approved | rejected | expired

   Everything painted on this wall is pre-moderated (PLAN §5), so a
   claim no longer paints: it reserves. wall.js writes the submission
   and its cells inside one transaction with the cells in state
   'pending', and nothing here runs until a moderator decides.

   Two properties this file exists to hold:

   §4.4 — reservation at submit time. Pending cells are real rows with
   the same (cycle, layer, idx) primary key live ones have, so the race
   is settled when somebody clicks, not when a moderator taps. By the
   time an approval runs, no other submission can be contending for
   those cells: it never got them in the first place.

   §4.5 — idempotency. Telegram delivers callbacks at least once and
   moderators double-tap. Every transition is
   `UPDATE … WHERE id = ? AND status = 'pending'` with a changes()
   check, so a second tap changes nothing and can say who got there
   first, rather than rejecting an already-approved submission.

   The wall cache is handed in rather than required (`attach`), the
   same way http.js hands in the SSE sink: wall.js owns the cache and
   the broadcast, this file owns the state machine, and neither has to
   require the other twice.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config.js');
const { db, tx, logEvent } = require('./db.js');

/* wall.js injects itself on load — see the header. Only ever used after
   boot, so the null window is never observable from a request. */
let wall = null;
const attach = w => { wall = w; };

/* ── Statements ───────────────────────────────────────────────── */

const selSub = db.prepare(
  `SELECT s.*, u.handle, u.kind FROM submissions s
     JOIN users u ON u.id = s.user_id WHERE s.id = ?`);
const selCells = db.prepare('SELECT layer, idx, color FROM cells WHERE submission_id = ?');

/* The guards. Each returns changes() === 1 exactly once per submission,
   whatever order the taps arrive in. */
const goApproved = db.prepare(
  `UPDATE submissions SET status = 'approved', decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending'`);
const goRejected = db.prepare(
  `UPDATE submissions SET status = 'rejected', decided_at = ?, decided_by = ?, reject_reason = ?
     WHERE id = ? AND status = 'pending'`);
const goExpired = db.prepare(
  `UPDATE submissions SET status = 'expired', decided_at = ?, decided_by = ?, reject_reason = ?
     WHERE id = ? AND status = 'pending'`);
/* A takedown (§7.2) is the same erasure, but from 'approved' — the pixels
   are already public when somebody notices what they spell. */
const takeDown = db.prepare(
  `UPDATE submissions SET status = 'rejected', decided_at = ?, decided_by = ?, reject_reason = ?
     WHERE id = ? AND status = 'approved'`);

const liveCells = db.prepare("UPDATE cells SET state = 'live' WHERE submission_id = ?");
const dropCells = db.prepare('DELETE FROM cells WHERE submission_id = ?');

const selPending = db.prepare(
  `SELECT s.id, s.user_id, s.type, s.layer, s.cycle, s.px_count, s.created_at, s.payment_id,
          u.handle FROM submissions s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'pending' ORDER BY s.id`);
const countPending = db.prepare("SELECT COUNT(*) n FROM submissions WHERE status = 'pending'");

/* Reputation, for the moderation card caption (§5) — "12 prior approved /
   0 rejected" is most of what tells a moderator whether to look hard. */
const selRecord = db.prepare(
  `SELECT
     SUM(status = 'approved') approved,
     SUM(status = 'rejected') rejected,
     SUM(status = 'pending')  pending
   FROM submissions WHERE user_id = ? AND id <> ?`);

const selHistory = db.prepare(
  `SELECT s.id, s.type, s.layer, s.cycle, s.px_count, s.bbox, s.pixels, s.status,
          s.created_at, s.decided_at, s.reject_reason, s.brand_name,
          p.id payment_id, p.status payment_status, p.amount payment_amount,
          p.code payment_code, p.kind payment_kind
     FROM submissions s LEFT JOIN payments p ON p.id = s.payment_id
    WHERE s.user_id = ? ORDER BY s.id DESC LIMIT ? OFFSET ?`);
const countHistory = db.prepare('SELECT COUNT(*) n FROM submissions WHERE user_id = ?');

/* ── Payment coupling (§6, wired in Phase 5) ──────────────────── */

/* Rejecting a submission whose money already arrived owes that money back.
   The payments table exists from 001 and nothing writes it until Phase 5,
   so this is a no-op today and correct the moment it isn't. */
const oweRefund = db.prepare(
  `UPDATE payments SET status = 'refund_due' WHERE id = ? AND status = 'verified'`);
/* Money that never arrived just voids with the submission. */
const voidPayment = db.prepare(
  `UPDATE payments SET status = 'expired'
     WHERE id = ? AND status IN ('awaiting_transfer','submitted')`);

function settlePayment(sub, now) {
  if (!sub.payment_id) return null;
  if (oweRefund.run(sub.payment_id).changes) {
    logEvent('system', 'refund-due', { sid: sub.id, payment: sub.payment_id }, now);
    return 'refund_due';
  }
  return voidPayment.run(sub.payment_id).changes ? 'expired' : null;
}

/* ── Transitions ──────────────────────────────────────────────── */

/* The shape every transition answers with. `already` is the caller's cue
   that somebody else got there first — the Telegram handler turns it into
   "already decided by @sara" rather than editing the card twice. */
const decided = (sub, changed) => changed
  ? { ok: true, sid: sub.id, status: sub.status }
  : { ok: false, already: sub.status, by: sub.decided_by || null, sid: sub.id };

function approveTx(sid, actor, now) {
  const sub = selSub.get(sid);
  if (!sub) return { ok: false, missing: true, sid };
  if (!goApproved.run(now, actor, sid).changes) return decided(sub, false);

  const cells = selCells.all(sid);
  liveCells.run(sid);
  logEvent(actor, 'approve', { sid, px: cells.length, type: sub.type }, now);
  return { ok: true, sid, sub, cells, status: 'approved' };
}

/* Public. The cache and the SSE event only move after the commit, so a
   rolled-back approval leaves nothing behind in memory either. */
function approve(sid, actor, now = Date.now()) {
  const r = tx(approveTx, sid, actor, now);
  if (r.ok) wall.publishApproval(r.sub, r.cells);
  notifyOwner(r, 'approved');
  return r;
}

/* reject and expire differ only in the word and in who is told: an expiry
   is the clock running out, not a person's decision. */
function eraseTx(stmt, action, sid, actor, reason, now) {
  const sub = selSub.get(sid);
  if (!sub) return { ok: false, missing: true, sid };
  if (!stmt.run(now, actor, reason || null, sid).changes) return decided(sub, false);

  const cells = selCells.all(sid);
  dropCells.run(sid);
  const payment = settlePayment(sub, now);
  logEvent(actor, action, { sid, px: cells.length, type: sub.type, reason: reason || null, payment }, now);
  return { ok: true, sid, sub, cells, payment, status: action === 'expire' ? 'expired' : 'rejected' };
}

function reject(sid, actor, reason, now = Date.now()) {
  const r = tx(eraseTx, goRejected, 'reject', sid, actor, reason, now);
  if (r.ok) wall.publishErasure(r.sub, r.cells);
  notifyOwner(r, 'rejected');
  return r;
}

function expire(sid, actor, reason, now = Date.now()) {
  const r = tx(eraseTx, goExpired, 'expire', sid, actor, reason, now);
  if (r.ok) wall.publishErasure(r.sub, r.cells);
  notifyOwner(r, 'expired');
  return r;
}

/* §7.2 — erase an *approved* submission. Same erasure, different guard, and
   the pixels were public, so every client has to be told rather than just
   the owner. */
function takedown(sid, actor, reason, now = Date.now()) {
  const r = tx(eraseTx, takeDown, 'takedown', sid, actor, reason, now);
  if (r.ok) wall.publishErasure(r.sub, r.cells);
  notifyOwner(r, 'rejected');
  return r;
}

/* One SSE line per decision. The client only cares if the sid is one of
   its own, which it can tell from its cached history — cheaper than a
   per-user channel, and no way to leak somebody else's submission id into
   anything but a refetch of the caller's own history. */
function notifyOwner(r, status) {
  if (r.ok && wall) wall.notify({ t: 'mod', sid: r.sid, status });
}

/* ── Auto-approve (TG_MODE=off) ───────────────────────────────── */

/* Without a bot there is no moderator, and a dev server where nothing ever
   goes live is useless. The delay is deliberate: at 0 ms the pending state
   would never be observable and the overlay it drives would never be seen
   in dev, which is exactly the bit worth looking at. Tests set it to 0. */
const pendingTimers = new Set();

function afterCreate(sid) {
  if (cfg.TG_MODE !== 'off' || !sid) return null;
  const t = setTimeout(() => {
    pendingTimers.delete(t);
    try { approve(sid, 'system:auto', Date.now()); }
    catch (err) { console.warn(`auto-approve ${sid}:`, err.message); }
  }, cfg.AUTO_APPROVE_MS);
  if (t.unref) t.unref();
  pendingTimers.add(t);
  return t;
}
/* so a test (or a shutdown) doesn't leave approvals firing into a closed db */
function cancelPending() {
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.clear();
}

/* ── The reset policy (§4, "pending at reset") ────────────────── */

/* Runs inside wall.js's reset transaction, so: no transaction of its own,
   no cache writes (the cache is rebuilt wholesale straight after) and no
   SSE (a 'reset' event is already going out).

   free      → expired. The wall they aimed at is gone; nothing is owed.
   paint     → expired, and the paint goes back, because it was spent on
               pixels that will never exist.
   brand     → rejected, and a verified payment becomes refund_due. Never
               keep money for undelivered pixels. */
const refundPaint = db.prepare(
  'UPDATE allowances SET paint = paint + ? WHERE user_id = ?');

const WIPED = 'the wall this was painted on has been wiped';

function sweepAtReset(cycle, now) {
  const out = { expired: 0, paintBack: 0, refunds: 0 };
  for (const sub of selPending.all()) {
    if (sub.cycle !== cycle) continue;
    /* A brand booking sits on the *next* layer and is for the cycle about to
       start — it is being promoted, not wiped, so it keeps waiting for its
       decision. sweepStaleBookings below is what catches it if that decision
       never comes. */
    if (sub.type === 'brand' && sub.layer === 'next') continue;

    if (!goExpired.run(now, 'system:reset', WIPED, sub.id).changes) continue;
    dropCells.run(sub.id);
    out.expired++;
    /* Paint was spent on pixels that will now never exist. The money for it
       changed hands at the pack, not here, so what goes back is paint (§5). */
    if (sub.type === 'paint' && sub.px_count > 0) {
      refundPaint.run(sub.px_count, sub.user_id);
      out.paintBack += sub.px_count;
    }
    if (settlePayment(sub, now) === 'refund_due') out.refunds++;
  }
  if (out.expired) logEvent('system', 'reset-sweep', out, now);
  return out;
}

/* Brand bookings that never got decided before the wall they were booked
   for went up. Runs *after* the promote, so `cycle` is the new one and
   layer 'live' means "this was the next layer a moment ago": still pending
   at this point is a booking that has missed its month entirely, which is
   undelivered pixels, which is money owed back (§4, rule 2).

   Outside the reset transaction on purpose — each expiry broadcasts. */
function sweepStaleBookings(cycle, now) {
  let n = 0;
  for (const sub of selPending.all()) {
    if (sub.type !== 'brand' || sub.cycle !== cycle || sub.layer !== 'live') continue;
    const r = expire(sub.id, 'system:reset',
      'not approved before the wall it was booked for went up', now);
    if (r.ok) n++;
  }
  return n;
}

/* ── Reads ────────────────────────────────────────────────────── */

const PX = 7;                                   // packed [u32 idx · u8 r · u8 g · u8 b]
const THUMB_MAX = 256;

/* A history row wants to show what was drawn, and a brand logo is up to
   160k pixels — far too much to ship per row. Stride the blob instead: at
   most THUMB_MAX pixels, positioned relative to the bbox, which is plenty
   to recognise your own artwork at 40px across and is the same code path
   whether the submission is 4 pixels or 160,000. */
function thumbOf(blob, bbox) {
  if (!blob || !blob.length) return [];
  const n = Math.floor(blob.length / PX);
  const step = Math.max(1, Math.ceil(n / THUMB_MAX));
  const [x0, y0] = bbox;
  const out = [];
  for (let i = 0; i < n; i += step) {
    const o = i * PX;
    const idx = blob.readUInt32LE(o);
    out.push([(idx % cfg.W) - x0, Math.floor(idx / cfg.W) - y0,
      (blob[o + 4] << 16) | (blob[o + 5] << 8) | blob[o + 6]]);
  }
  return out;
}

function historyFor(userId, opts) {
  const limit = Math.min(50, Math.max(1, Number(opts && opts.limit) || 20));
  const offset = Math.max(0, Number(opts && opts.offset) || 0);
  const rows = selHistory.all(userId, limit, offset).map(r => {
    const bbox = JSON.parse(r.bbox || '[0,0,0,0]');
    const out = {
      sid: r.id, type: r.type, layer: r.layer, cycle: r.cycle,
      px: r.px_count, bbox, thumb: thumbOf(r.pixels, bbox),
      status: r.status, at: r.created_at, decidedAt: r.decided_at || 0,
      reason: r.reject_reason || null, brand: r.brand_name || null
    };
    if (r.payment_id) {
      out.payment = {
        id: r.payment_id, status: r.payment_status, kind: r.payment_kind,
        amount: r.payment_amount, code: r.payment_code
      };
    }
    return out;
  });
  return { rows, total: countHistory.get(userId).n, limit, offset };
}

const recordOf = (userId, exceptSid) => {
  const r = selRecord.get(userId, exceptSid || 0) || {};
  return { approved: r.approved || 0, rejected: r.rejected || 0, pending: r.pending || 0 };
};

const queue = () => selPending.all();
const pendingCount = () => countPending.get().n;
const get = sid => selSub.get(sid);

module.exports = {
  attach, approve, reject, expire, takedown,
  afterCreate, cancelPending,
  sweepAtReset, sweepStaleBookings,
  historyFor, recordOf, queue, pendingCount, get, thumbOf
};
