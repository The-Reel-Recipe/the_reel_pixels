/* ═══════════════════════════════════════════════════════════════
   retention — the sweep that makes the privacy notice true

   The notice publishes four periods. A period written down and not
   enforced is worse than the honest "indefinitely" it replaced: it
   is a specific, dated, published promise that the database can be
   made to contradict in an afternoon. So each clause there has one
   function here, the periods come from config, and a test compares
   the published number against the enforced one.

   What it does NOT delete is as deliberate as what it does.

   Payment rows survive everything. They are books, and the tax
   period is a different obligation with a different clock; an
   erasure request does not reach them. What goes is the screenshot
   — the one piece of a payment that is a picture of somebody's
   banking app — once the question it answers ("did the money
   arrive") is closed.

   Event rows survive too, with the address redacted out of them.
   Deleting the line would destroy the audit journal the wall is
   rebuilt from; removing one field from it keeps the history and
   drops the identifier, which is the whole of what is asked.

   Ordering matters once: submissions are deleted before dormant
   accounts, so an account that only ever made one very old drawing
   becomes sweepable in the same pass rather than the next one.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const dbm = require('./db');

const db = dbm.db;
const logEvent = dbm.logEvent;
const DAY = 24 * 60 * 60 * 1000;

/* Deleting a file that is already gone is a success, not an error: the
   sweep is idempotent by design and reruns after a crash mid-pass. */
function unlinkQuiet(rel) {
  if (!rel) return false;
  const abs = path.isAbsolute(rel) ? rel : path.join(cfg.DATA_DIR, rel);
  /* never follow a path out of the data directory, whatever the column says */
  if (!path.resolve(abs).startsWith(path.resolve(cfg.DATA_DIR))) return false;
  try { fs.unlinkSync(abs); return true; } catch (err) {
    if (err.code !== 'ENOENT') console.warn('retention unlink:', rel, err.message);
    return false;
  }
}

/* ── 1. Payment screenshots ───────────────────────────────────────
   "deleted N after the payment reaches a final state, whether that is
   confirmed, refunded, refused or expired."

   updated_at is stamped on every transition (migration 009); the
   coalesce is for rows that predate it, which fall back to when the
   payment was created — earlier, so they go sooner, never later. */

const FINAL = ['verified', 'rejected', 'refunded', 'expired'];

const staleShots = db.prepare(`
  SELECT p.id, p.screenshot_path FROM payments p
    JOIN users u ON u.id = p.user_id
   WHERE p.screenshot_path IS NOT NULL
     AND u.legal_hold = 0
     AND p.status IN (${FINAL.map(() => '?').join(',')})
     AND COALESCE(p.updated_at, p.created_at) < ?`);
const clearShot = db.prepare(`UPDATE payments SET screenshot_path = NULL WHERE id = ?`);

function sweepScreenshots(now, doomed) {
  const rows = staleShots.all(...FINAL, now - cfg.RETAIN_SCREENSHOT);
  for (const r of rows) { doomed.push(r.screenshot_path); clearShot.run(r.id); }
  return rows.length;
}

/* ── 2. Submission records ────────────────────────────────────────
   "kept for N, then deleted — whether the batch was approved, refused
   or expired."

   The cycle guard is belt and braces. At two years against a monthly
   cycle nothing current can possibly qualify, but the wall is rebuilt
   from this table and a misconfigured period should cost us an old
   record, never the wall people are looking at right now. */

/* legal_hold = 0 on every sweep below. TERMS §11A and PRIVACY §9 both say
   nothing is deleted while a matter is open, and a retention period that
   ignores that is the same destruction of evidence as the erase button —
   only on a timer, and with nobody's name against it. */
const staleSubs = db.prepare(`
  SELECT id, preview_path FROM submissions
   WHERE created_at < ? AND cycle < ? AND legal_hold = 0`);
const dropSub = db.prepare(`DELETE FROM submissions WHERE id = ?`);
const dropCells = db.prepare(`DELETE FROM cells WHERE submission_id = ?`);

function sweepSubmissions(now, currentCycle, doomed) {
  const rows = staleSubs.all(now - cfg.RETAIN_SUBMISSION, currentCycle);
  for (const r of rows) {
    if (r.preview_path) doomed.push(r.preview_path);
    dropCells.run(r.id);
    dropSub.run(r.id);
  }
  return rows.length;
}

/* ── 3. Addresses in the journal ──────────────────────────────────
   "kept for N, then the address is removed from the log line while the
   rest of the line stays."

   Done in JS rather than json_remove so it works the same on a build
   of SQLite compiled without JSON1, and so a payload that is not an
   object (or not JSON at all) is left alone instead of nulled. */

const oldWithIp = db.prepare(`
  SELECT id, payload FROM events
   WHERE ts < ? AND payload LIKE '%"ip"%' LIMIT 5000`);
const redact = db.prepare(`UPDATE events SET payload = ? WHERE id = ?`);

function sweepEventIps(now) {
  let n = 0;
  for (const row of oldWithIp.all(now - cfg.RETAIN_IP)) {
    let p;
    try { p = JSON.parse(row.payload); } catch { continue; }
    if (!p || typeof p !== 'object' || !('ip' in p)) continue;
    delete p.ip;
    redact.run(JSON.stringify(p), row.id);
    n++;
  }
  return n;
}

/* The per-address counters are the same identifier in a different shape, so
   they answer to the same clock. ip_guests is keyed by a local day string,
   which sorts correctly as text because it is zero-padded ISO. */
const dropGuestDays = db.prepare(`DELETE FROM ip_guests WHERE day < ?`);

function sweepIpTables(now, dayKey) {
  return dropGuestDays.run(dayKey(now - cfg.RETAIN_IP)).changes;
}

/* ── 4. Dormant accounts ──────────────────────────────────────────
   "kept until you ask us to erase them, or until N after your last visit
   if you never come back and have no payments with us."

   Guests only, and only the ones that left nothing behind. An account
   with an email is one somebody chose to keep; an account with a
   payment is a book entry. Both are excluded by the WHERE, not by a
   later check, so there is no path where a paying account is deleted
   because a query returned rows in an order nobody expected. */

const dormant = db.prepare(`
  SELECT u.id FROM users u
   WHERE u.kind = 'guest'
     AND u.email IS NULL
     AND u.status = 'active'
     AND u.legal_hold = 0
     AND u.last_seen < ?
     AND NOT EXISTS (SELECT 1 FROM payments    p WHERE p.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.user_id = u.id)
   LIMIT 2000`);
const dropAllowance = db.prepare(`DELETE FROM allowances WHERE user_id = ?`);
const dropUser = db.prepare(`DELETE FROM users WHERE id = ?`);

/* Six tables carry a foreign key into users(id): brand_profiles, allowances,
   submissions, cells, payments and legacy_keys. The WHERE above excludes an
   account that has any of the first five. legacy_keys is the one it cannot
   exclude, because it is not a reason to keep anybody — it is the pre-Phase-2
   ip→user table, and migration 003 that drops it is marked @manual and has
   never been run, so the table is still there holding rows.

   Deleting the user without clearing it threw FOREIGN KEY, which rolled back
   the entire sweep — every period in the privacy notice, silently, from the
   first dormant account onwards, because the timer swallows the error.

   Clearing it is also the right thing on its own terms: that row is a raw IP
   address bound to an account that is being deleted for never coming back. */
const dropLegacyKeys = db.prepare(`DELETE FROM legacy_keys WHERE user_id = ?`);

function sweepDormant(now, forget) {
  const rows = dormant.all(now - cfg.RETAIN_DORMANT);
  for (const r of rows) {
    dropLegacyKeys.run(r.id);
    dropAllowance.run(r.id);
    dropUser.run(r.id);
    forget(r.id);
  }
  return rows.length;
}

/* ── The pass ─────────────────────────────────────────────────────
   One transaction. Either the whole sweep lands or none of it does,
   which keeps a half-swept database from ever being the thing the
   next pass reasons about.

   Files are unlinked *after* it commits, never inside. The first
   version of this did the opposite, on the reasoning that a file
   deleted for a row that then rolls back is a preview nobody can
   reach anyway. That reasoning was wrong, and an audit reproduced
   why: the sweep hit a FOREIGN KEY error on a dormant account, the
   whole transaction rolled back, and the payment screenshots it had
   already unlinked were gone from disk with the rows still pointing
   at them. Evidence destroyed, and the row that says it exists left
   behind to contradict it.

   The opposite mistake — a row gone with its file still on the
   volume — is now the one this can make, and it is the survivable
   one: the next pass has no row to find it by, but a file with no
   row is inert, and it is visible on the volume. */

/* Named, not an arrow built per call: db.tx caches the wrapped transaction
   against the function it was given, and a fresh closure each pass would
   re-wrap every time and never hit that cache. */
function pass(now, identity, wall, out, doomed) {
  out.screenshots = sweepScreenshots(now, doomed);
  out.submissions = sweepSubmissions(now, wall.cycleStart(now), doomed);
  out.eventIps = sweepEventIps(now);
  out.ipRows = sweepIpTables(now, identity.dayKey);
  out.accounts = sweepDormant(now, identity.forget);
}

function sweep(now = Date.now(), deps = {}) {
  /* required here rather than at the top: identity and wall both reach back
     into this file's neighbours, and a cycle at load time would hand one of
     them a half-built module */
  const identity = deps.identity || require('./identity');
  const wall = deps.wall || require('./wall');

  const out = {};
  const doomed = [];
  dbm.tx(pass, now, identity, wall, out, doomed);

  /* only now, with the rows actually gone */
  let files = 0;
  for (const f of doomed) if (unlinkQuiet(f)) files++;
  out.files = files;

  if (Object.values(out).some(n => n > 0)) logEvent('system', 'retention-sweep', out, now);
  return out;
}

/* Daily. The first pass is a minute after boot rather than immediately:
   a restart loop should not run five sweeps, and nothing here is urgent
   enough to compete with the wall being served. */
let timer = null;

function start() {
  if (timer || !cfg.RETENTION_SWEEP) return;
  /* A sweep that throws is every published retention period quietly not
     happening, once a day, for as long as nobody looks. console.warn was not
     enough: it scrolls past, and the thing it is reporting is invisible from
     the outside — the database simply stops shrinking. So it also writes an
     event, which the panel's audit page shows and which is searchable after
     the fact. */
  const run = () => {
    try { sweep(Date.now()); } catch (err) {
      console.error('retention sweep FAILED — no retention period is being enforced:', err.message);
      try { logEvent('system', 'retention-failed', { error: err.message }, Date.now()); } catch (e) { /* db is the thing that broke */ }
    }
  };
  setTimeout(run, 60 * 1000).unref();
  timer = setInterval(run, DAY);
  timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  sweep, start, stop,
  sweepScreenshots, sweepSubmissions, sweepEventIps, sweepIpTables, sweepDormant
};
