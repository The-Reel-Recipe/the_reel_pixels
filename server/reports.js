/* ═══════════════════════════════════════════════════════════════
   reports — the button TERMS §11 says is there

   §11 tells anyone who sees something that should not be on the wall
   to use "the REPORT button on any pixel". There was no such button,
   no route behind it, and no queue in front of a moderator. A notice
   procedure that exists only in the document is the kind of gap that
   turns a hosting defence into an admission.

   Three properties this needs and a bare logEvent would not give it.

   It has to reach a person. A report that lands in the events table
   is a report nobody reads; the moderation group is where decisions
   already get made, so a report goes there as a card with the
   coordinates, the drawing it is about, and a button to act on.

   It has to be cheap to make and expensive to spam. Anyone can
   report, including a guest with no account — insisting on an
   account is insisting the person who found the problem sign up
   before telling you. So the per-IP write budget is what limits it,
   plus one report per person per batch: the second one says nothing
   the first did not.

   And it has to survive the thing it is about. The submission id is
   recorded, not just the cell, because the whole point is that the
   pixels may be gone by the time anybody looks — taken down, cycled
   out, or erased. The event journal keeps the report either way.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config');
const dbm = require('./db');
const wall = require('./wall');

const db = dbm.db;
const logEvent = dbm.logEvent;

/* Free text somebody else reads, so: bounded, and never longer than a
   moderator will actually read on a phone. */
const REASON_MAX = 500;
const REASONS = new Set(['sexual', 'hate', 'violence', 'personal', 'copyright', 'spam', 'other']);

const cellAt = db.prepare(
  `SELECT c.submission_id, c.user_id, c.layer, s.status, s.brand_name, s.px_count
     FROM cells c LEFT JOIN submissions s ON s.id = c.submission_id
    WHERE c.cycle = ? AND c.idx = ? ORDER BY c.layer LIMIT 1`);

/* One per reporter per batch. A second report from the same person about
   the same drawing tells a moderator nothing the first did not, and the
   pair of them is how a queue becomes unreadable. Counted off the journal
   because that is where reports live — there is no reports table, and one
   would only be a slower copy of it. */
const alreadyReported = db.prepare(
  `SELECT 1 FROM events
    WHERE action = 'report' AND actor = ? AND payload LIKE ? LIMIT 1`);

function report(reporter, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  const idx = Number(b.idx);

  if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.W * cfg.H) {
    return { status: 400, error: 'invalid', fields: { idx: 'That is not a pixel on this wall.' } };
  }
  const reason = REASONS.has(b.reason) ? b.reason : 'other';
  const note = String(b.note || '').trim().slice(0, REASON_MAX);

  const cell = cellAt.get(wall.wall.cycle, idx);
  if (!cell || !cell.submission_id) {
    return { status: 404, error: 'empty', message: 'There is nothing painted there.' };
  }

  const actor = `user:${reporter.id}`;
  if (alreadyReported.get(actor, `%"submission":${cell.submission_id},%`)) {
    /* Answered as success. Telling somebody "you already reported this"
       invites them to work out how to report it again, and the honest
       outcome — a moderator has it — is the same either way. */
    return { ok: true, already: true };
  }

  const x = idx % cfg.W, y = Math.floor(idx / cfg.W);
  logEvent(actor, 'report', {
    submission: cell.submission_id, idx, x, y,
    layer: cell.layer, reason, note: note || null,
    owner: cell.user_id, brand: cell.brand_name || null
  }, now);

  /* Required lazily: telegram requires submissions, which requires wall,
     and a cycle at load time hands one of them a half-built module. */
  try { require('./telegram').cardForReport(cell.submission_id, { x, y, reason, note }, now); } catch (err) {
    console.warn('report: card not queued —', err.message);
  }

  return { ok: true };
}

/* What the panel's queue reads. Newest first, and joined back to the
   submission so a moderator can see whether it is still up — a report about
   something already taken down is one they can close without looking. */
const recent = db.prepare(
  `SELECT e.id, e.ts, e.actor, e.payload FROM events e
    WHERE e.action = 'report' ORDER BY e.ts DESC LIMIT ?`);

function queue(limit = 100) {
  const rows = [];
  for (const r of recent.all(Math.min(500, Math.max(1, Number(limit) || 100)))) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const sub = p.submission
      ? db.prepare('SELECT status, type, px_count, user_id, legal_hold FROM submissions WHERE id = ?')
        .get(p.submission)
      : null;
    rows.push({
      id: r.id, at: r.ts, by: r.actor,
      submission: p.submission, x: p.x, y: p.y, idx: p.idx,
      reason: p.reason, note: p.note || null, brand: p.brand || null,
      /* gone means the drawing is no longer on the wall — taken down,
         rejected, or swept — which is usually the answer to the report */
      gone: !sub, status: sub ? sub.status : null,
      owner: sub ? sub.user_id : p.owner || null,
      held: sub ? !!sub.legal_hold : false
    });
  }
  return rows;
}

module.exports = { report, queue, REASONS, REASON_MAX };
