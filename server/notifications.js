/* ═══════════════════════════════════════════════════════════════
   notifications — what happened to your things while you looked away

   Not a table. Every notification-worthy fact already lives in a row
   somewhere — a submission's decision, a payment's status, a brand
   application's review — and duplicating them into an inbox table
   would mean two places to disagree. The feed is a UNION over those
   rows, newest first, and "unread" is nothing more than a per-user
   high-water mark (users.notes_seen_at, 009): everything that
   happened after the last time they opened the bell counts.

   The client keeps the badge live between fetches on its own — the
   SSE stream already whispers 'mod' and 'pay' events at the owner.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const { db } = require('./db.js');

/* One row shape for three sources:
     src     'submission' | 'payment' | 'brand'
     ref     submission id · payment id · user id
     status  the state it landed in
     detail  reject reason (submissions, brand) · instapay code (payments)
     n       pixel count · pack size
     amount  piasters, payments only
     t       when it happened                                         */
const FEED = `
  SELECT 'submission' src, s.id ref, s.status, s.reject_reason detail,
         s.px_count n, NULL amount, s.type kind, s.decided_at t
    FROM submissions s
   WHERE s.user_id = @uid AND s.decided_at IS NOT NULL
     AND s.status IN ('approved','rejected','expired')
  UNION ALL
  SELECT 'payment', p.id, p.status, p.code, p.pack, p.amount, p.kind,
         COALESCE(p.updated_at, p.created_at)
    FROM payments p
   WHERE p.user_id = @uid
     AND p.status IN ('verified','rejected','refund_due','refunded','expired')
  UNION ALL
  SELECT 'brand', b.user_id, b.status, b.reject_reason, NULL, NULL, 'application',
         b.reviewed_at
    FROM brand_profiles b
   WHERE b.user_id = @uid AND b.reviewed_at IS NOT NULL
     AND b.status IN ('approved','rejected')`;

const selFeed = db.prepare(
  `SELECT * FROM (${FEED}) ORDER BY t DESC, ref DESC LIMIT @limit OFFSET @offset`);
const countUnseen = db.prepare(
  `SELECT COUNT(*) n FROM (${FEED}) WHERE t > @since`);
const selSeen = db.prepare('SELECT notes_seen_at FROM users WHERE id = ?');
const setSeen = db.prepare('UPDATE users SET notes_seen_at = ? WHERE id = ?');

/* Number(null) is 0, which would quietly turn "no ?limit= given" into
   LIMIT 0 and an empty feed — so absence is checked before arithmetic. */
const clamp = (v, dflt, max) => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : dflt;
};

function feedFor(userId, opts = {}) {
  const limit = clamp(opts.limit, 30, 100);
  const offset = clamp(opts.offset, 0, 10000);
  const seenAt = (selSeen.get(userId) || { notes_seen_at: 0 }).notes_seen_at;
  const rows = selFeed.all({ uid: userId, limit, offset });
  return {
    rows,
    seenAt,
    unseen: countUnseen.get({ uid: userId, since: seenAt }).n
  };
}

/* the bell was opened — everything up to now stops counting */
function markSeen(userId, now = Date.now()) {
  setSeen.run(now, userId);
  return { ok: true, seenAt: now };
}

module.exports = { feedFor, markSeen };
