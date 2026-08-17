/* ═══════════════════════════════════════════════════════════════
   retention — the sweep the privacy notice depends on

   Four published periods, four things that actually get deleted.
   Most of what follows is about the second half of each pair: not
   that old rows go, but that the rows next to them stay. A payment
   is a book entry, a ban is an enforcement, an audit line minus its
   address is still an audit line. A sweep that took those too would
   pass a naive test and lose the business.

   test/legal.test.js is the other half — it checks the numbers here
   against the numbers on the page.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-retention-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
/* the timer stays off: this file drives sweep() directly, and a suite that
   seeds a row dated last year should not be racing a background pass for it */
process.env.RETENTION_SWEEP = '0';
delete process.env.VERCEL;
delete process.env.DEV;

const cfg = require('../server/config.js');
const dbm = require('../server/db.js');
const retention = require('../server/retention.js');
const identity = require('../server/identity.js');

const db = dbm.db;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15);

/* ── helpers ──────────────────────────────────────────────────── */

let seq = 0;
function mkUser(over = {}) {
  const id = db.prepare(`
    INSERT INTO users (kind, handle, email, created_at, last_seen, status)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    over.kind || 'guest',
    over.handle || `sweep tester ${++seq}`,
    over.email === undefined ? null : over.email,
    over.created_at || NOW - 400 * DAY,
    over.last_seen || NOW,
    over.status || 'active').lastInsertRowid;
  return id;
}

function mkPayment(userId, over = {}) {
  return db.prepare(`
    INSERT INTO payments (user_id, kind, pack, amount, code, screenshot_path,
                          status, created_at, updated_at)
    VALUES (?, 'paint_pack', 100, 5000, ?, ?, ?, ?, ?)`).run(
    userId, `SWP-${++seq}`,
    over.screenshot_path === undefined ? null : over.screenshot_path,
    over.status || 'verified',
    over.created_at || NOW - 400 * DAY,
    over.updated_at === undefined ? NOW - 400 * DAY : over.updated_at).lastInsertRowid;
}

function mkSubmission(userId, over = {}) {
  return db.prepare(`
    INSERT INTO submissions (user_id, type, cycle, layer, px_count, bbox, pixels,
                             status, created_at, preview_path)
    VALUES (?, 'free', ?, 'live', 1, '[0,0,1,1]', X'00', ?, ?, ?)`).run(
    userId,
    over.cycle === undefined ? Date.UTC(2024, 0, 1) : over.cycle,
    over.status || 'approved',
    over.created_at || NOW - 900 * DAY,
    over.preview_path === undefined ? null : over.preview_path).lastInsertRowid;
}

/* a real file under DATA_DIR, so the unlink path is exercised rather than
   swallowed by the "already gone" branch */
function mkFile(name) {
  const dir = path.join(cfg.DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'not really a screenshot');
  return file;
}

const stubs = {
  identity: { dayKey: identity.dayKey, forget: () => {} },
  wall: { cycleStart: () => Date.UTC(2026, 5, 1) }
};
const sweep = (now = NOW) => retention.sweep(now, stubs);

/* ── screenshots ──────────────────────────────────────────────── */

test('a screenshot goes once the payment it settles is final', () => {
  const u = mkUser();
  const file = mkFile('old-final.png');
  const id = mkPayment(u, { screenshot_path: file, status: 'verified', updated_at: NOW - 400 * DAY });

  sweep();

  assert.equal(fs.existsSync(file), false, 'the file is gone from the volume');
  assert.equal(db.prepare('SELECT screenshot_path FROM payments WHERE id = ?').get(id).screenshot_path, null);
  assert.ok(db.prepare('SELECT id FROM payments WHERE id = ?').get(id),
    'the payment row itself stays — it is a book entry, not a picture');
});

test('a screenshot stays while the payment is still moving', () => {
  const u = mkUser();
  const file = mkFile('old-but-open.png');
  /* old enough by the clock, but 'submitted' is not a final state: this is
     the row where somebody is still arguing about whether money arrived */
  const id = mkPayment(u, { screenshot_path: file, status: 'submitted', updated_at: NOW - 400 * DAY });

  sweep();

  assert.ok(fs.existsSync(file));
  assert.ok(db.prepare('SELECT screenshot_path FROM payments WHERE id = ?').get(id).screenshot_path);
  fs.unlinkSync(file);
});

test('a recent screenshot is left alone', () => {
  const u = mkUser();
  const file = mkFile('fresh.png');
  mkPayment(u, { screenshot_path: file, status: 'refunded', updated_at: NOW - 10 * DAY });

  sweep();

  assert.ok(fs.existsSync(file));
  fs.unlinkSync(file);
});

/* ── submissions ──────────────────────────────────────────────── */

test('an old submission and its preview both go', () => {
  const u = mkUser();
  const file = mkFile('preview.png');
  const id = mkSubmission(u, { created_at: NOW - 900 * DAY, preview_path: file });
  db.prepare(`INSERT INTO cells (cycle, layer, idx, color, submission_id, user_id, state)
              VALUES (?, 'live', ?, 0, ?, ?, 'live')`)
    .run(Date.UTC(2024, 0, 1), 900000 + seq, id, u);

  sweep();

  assert.equal(db.prepare('SELECT id FROM submissions WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cells WHERE submission_id = ?').get(id).n, 0);
  assert.equal(fs.existsSync(file), false);
});

test('the current cycle is never swept, whatever the clock says', () => {
  const u = mkUser();
  /* dated three years ago but belonging to the cycle on screen — a
     misconfigured period must cost an old record, never the live wall */
  const id = mkSubmission(u, { created_at: NOW - 1100 * DAY, cycle: Date.UTC(2026, 5, 1) });

  sweep();

  assert.ok(db.prepare('SELECT id FROM submissions WHERE id = ?').get(id));
});

/* ── addresses ────────────────────────────────────────────────── */

test('an old log line keeps everything except the address', () => {
  const id = db.prepare('INSERT INTO events (ts, actor, action, payload) VALUES (?,?,?,?)')
    .run(NOW - 300 * DAY, 'user:1', 'guest-mint', JSON.stringify({ ip: '41.33.7.9', why: 'kept' }))
    .lastInsertRowid;

  sweep();

  const after = JSON.parse(db.prepare('SELECT payload FROM events WHERE id = ?').get(id).payload);
  assert.equal(after.ip, undefined, 'the identifier is gone');
  assert.equal(after.why, 'kept', 'the rest of the line survives — it is the audit journal');
});

test('a recent log line keeps its address, because the law requires it kept', () => {
  const id = db.prepare('INSERT INTO events (ts, actor, action, payload) VALUES (?,?,?,?)')
    .run(NOW - 5 * DAY, 'user:1', 'guest-mint', JSON.stringify({ ip: '41.33.7.9' }))
    .lastInsertRowid;

  sweep();

  assert.equal(JSON.parse(db.prepare('SELECT payload FROM events WHERE id = ?').get(id).payload).ip, '41.33.7.9');
});

test('a log line that is not an object is left alone rather than nulled', () => {
  const id = db.prepare('INSERT INTO events (ts, actor, action, payload) VALUES (?,?,?,?)')
    .run(NOW - 300 * DAY, 'system', 'odd', '"ip-in-a-string"').lastInsertRowid;

  sweep();

  assert.equal(db.prepare('SELECT payload FROM events WHERE id = ?').get(id).payload, '"ip-in-a-string"');
});

/* ── dormant accounts ─────────────────────────────────────────── */

test('an account nobody came back for is deleted', () => {
  const u = mkUser({ last_seen: NOW - 400 * DAY });
  db.prepare('INSERT INTO allowances (user_id, used, refill_at, paint) VALUES (?,0,0,0)').run(u);

  sweep();

  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(u), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM allowances WHERE user_id = ?').get(u).n, 0);
});

test('an account that paid is kept however long it has been idle', () => {
  const u = mkUser({ last_seen: NOW - 900 * DAY });
  mkPayment(u, { status: 'verified' });

  sweep();

  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(u),
    'a payment is a book entry, and the person behind it stays with it');
});

test('an account with an email is kept — somebody chose to keep it', () => {
  const u = mkUser({ last_seen: NOW - 900 * DAY, email: 'still.here@example.com' });

  sweep();

  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(u));
});

test('an account that drew something is kept until the drawing goes', () => {
  const u = mkUser({ last_seen: NOW - 900 * DAY });
  mkSubmission(u, { created_at: NOW - 10 * DAY, cycle: Date.UTC(2026, 4, 1) });

  sweep();

  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(u));
});

test('a banned account is not swept away', () => {
  const u = mkUser({ last_seen: NOW - 900 * DAY, status: 'banned' });

  sweep();

  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(u),
    'deleting a ban is unbanning them — the row is the enforcement');
});
