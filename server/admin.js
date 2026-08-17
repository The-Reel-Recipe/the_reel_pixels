/* ═══════════════════════════════════════════════════════════════
   admin — the panel's door, and everything behind it

   PLAN §7. The panel is the superset of the Telegram surface:
   everything the bot can do plus everything it cannot, and the
   fallback for when Telegram is down. Both drive the *same*
   transitions in submissions.js and payments.js, so a decision made
   here is guarded, audited and idempotent exactly as one made in the
   chat is — nothing in this file re-implements a state machine.

   The door (§7.1):

     no signup route      accounts are made by tools/add-admin.js and
                          nowhere else
     password + TOTP      both, always; TOTP is not optional and there
                          is no path that skips it
     SameSite=Strict      plus a required X-Admin header on every
                          mutation, so a cross-site form post cannot
                          be a takedown
     token_epoch          bump it and every session that admin holds
                          is dead, with no session table to sweep
     rate limited         five attempts per IP per fifteen minutes,
                          and an optional CIDR allowlist in front

   Every mutation writes an events row. The panel's own audit page
   reads that table, so the panel is auditable from the panel.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config.js');
const settings = require('./settings.js');
const { db, tx, logEvent, getMeta } = require('./db.js');
const identity = require('./identity.js');
const submissions = require('./submissions.js');
const payments = require('./payments.js');
const wall = require('./wall.js');
const telegram = require('./telegram.js');
const { exportFromDb, render: renderWall } = require('../tools/export-wall-png.js');

const COOKIE = 'adm';
const TTL = 12 * 60 * 60 * 1000;                // §7.1
const LOGIN_TRIES = 5, LOGIN_WINDOW = 15 * 60 * 1000;

/* ── TOTP (RFC 6238) ──────────────────────────────────────────── */

/* Twenty-odd lines on node:crypto rather than a dependency, because that
   is genuinely all it is: HMAC a counter, take four bytes from an offset
   the last nibble points at, mod a million. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/[=\s]/g, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1000000).padStart(6, '0');
}

const STEP = 30000;
const equal = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* Returns the step the code belongs to, or null. ±1 step of tolerance for
   a phone whose clock is a few seconds out, which is most phones. */
function totpStep(secretB32, code, now) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / STEP);
  for (const d of [0, -1, 1]) {
    if (equal(hotp(secret, step + d), String(code).trim())) return step + d;
  }
  return null;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));
const otpauth = (username, secret, issuer = 'S37') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ── Accounts ─────────────────────────────────────────────────── */

const selAdmin = db.prepare('SELECT * FROM admins WHERE username = ?');
const selAdminById = db.prepare('SELECT * FROM admins WHERE id = ?');
const insAdmin = db.prepare(
  `INSERT INTO admins (username, pass_hash, totp_secret, created_at) VALUES (?, ?, ?, ?)`);
const noteLogin = db.prepare('UPDATE admins SET last_login = ?, last_totp_step = ? WHERE id = ?');
const bumpEpoch = db.prepare('UPDATE admins SET token_epoch = token_epoch + 1 WHERE id = ?');
const countAdminsStmt = db.prepare('SELECT COUNT(*) n FROM admins');
const countAdmins = () => countAdminsStmt.get();

/* The only way an admin comes into existence — tools/add-admin.js and
   nothing else. There is deliberately no route that reaches this. */
function createAdmin(username, password, now = Date.now()) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) throw new Error('username: 3-32 chars, a-z 0-9 . _ -');
  if (String(password || '').length < 12) throw new Error('password: at least 12 characters');
  if (selAdmin.get(name)) throw new Error(`there is already an admin called ${name}`);
  const secret = newSecret();
  const id = Number(insAdmin.run(name, identity.hashPassword(password), secret, now).lastInsertRowid);
  logEvent('cli', 'admin-created', { admin: name }, now);
  return { id, username: name, secret, otpauth: otpauth(name, secret) };
}

/* ── Sessions ─────────────────────────────────────────────────── */

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload, epoch) =>
  b64url(crypto.createHmac('sha256', cfg.SESSION_SECRET).update(`adm.${payload}.${epoch}`).digest());

function cookieFor(admin, now) {
  const exp = now + TTL;
  const payload = `${admin.id}.${exp}`;
  const value = `${payload}.${sign(payload, admin.token_epoch || 0)}`;
  const bits = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(TTL / 1000)}`];
  if (cfg.COOKIE_SECURE) bits.push('Secure');
  return bits.join('; ');
}
const clearCookie = () => {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (cfg.COOKIE_SECURE) bits.push('Secure');
  return bits.join('; ');
};

function readCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

function sessionFrom(req, now) {
  const value = readCookie(req);
  if (!value || value.length > 400) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [id, expText, sig] = parts;
  const exp = Number(expText);
  if (!Number.isInteger(Number(id)) || !Number.isInteger(exp) || now >= exp) return null;
  const admin = selAdminById.get(Number(id));
  if (!admin) return null;
  if (!equal(sig, sign(`${id}.${expText}`, admin.token_epoch || 0))) return null;
  return admin;
}

/* ── Who may knock ────────────────────────────────────────────── */

/* An optional allowlist in front of the password. Written small on purpose:
   v4 with an optional prefix, and v6 by exact match, which covers "my
   office" and "my VPN" and admits it covers nothing cleverer. */
function ipAllowed(ip) {
  if (!cfg.ADMIN_IP_ALLOW.length) return true;
  const v4 = s => {
    const p = String(s).split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
      const b = Number(part);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      n = (n * 256) + b;
    }
    return n;
  };
  const mine = v4(ip);
  for (const entry of cfg.ADMIN_IP_ALLOW) {
    const [net, bitsText] = entry.split('/');
    if (mine === null) { if (net === ip) return true; continue; }
    const theirs = v4(net);
    if (theirs === null) continue;
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if (((mine & mask) >>> 0) === ((theirs & mask) >>> 0)) return true;
  }
  return false;
}

/* Per-IP, in memory: a login flood is a thing to survive, not a thing to
   keep a record of, and a restart clearing it is fine. */
const tries = new Map();
function throttled(ip, now) {
  const t = tries.get(ip);
  if (!t) return false;
  if (now > t.until) { tries.delete(ip); return false; }
  return t.n >= LOGIN_TRIES;
}
function noteFail(ip, now) {
  const t = tries.get(ip) || { n: 0, until: now + LOGIN_WINDOW };
  t.n++;
  if (now > t.until) { t.n = 1; t.until = now + LOGIN_WINDOW; }
  tries.set(ip, t);
}

/* ── Login ────────────────────────────────────────────────────── */

/* One message whatever went wrong. A panel that says "wrong code" when the
   password was right is a panel that confirms passwords. */
const NO = { status: 401, error: 'bad-credentials', message: 'Wrong username, password or code.' };

function login(ip, body, now = Date.now()) {
  if (!ipAllowed(ip)) return { status: 403, error: 'not-allowed', message: 'Not from this address.' };
  if (throttled(ip, now)) {
    return { status: 429, error: 'too-many', message: 'Too many attempts. Wait fifteen minutes.' };
  }

  const b = body && typeof body === 'object' ? body : {};
  const admin = selAdmin.get(String(b.username || '').trim().toLowerCase());
  /* Hash regardless, so a missing username and a wrong password take the
     same ~60ms and the form cannot be used to enumerate accounts. */
  const stored = admin ? admin.pass_hash : 'x:16384:8:1:x';
  const passOk = identity.verifyPassword(String(b.password || ''), stored);
  if (!admin || !passOk) { noteFail(ip, now); return NO; }

  const step = totpStep(admin.totp_secret, b.code, now);
  if (step === null) { noteFail(ip, now); return NO; }
  /* §7.1: a code is good once. Inside its own window it is spent. */
  if (step <= (admin.last_totp_step || 0)) {
    noteFail(ip, now);
    return { status: 401, error: 'code-used', message: 'That code has already been used. Wait for the next one.' };
  }

  tries.delete(ip);
  noteLogin.run(now, step, admin.id);
  logEvent(`admin:${admin.username}`, 'admin-login', { ip }, now);
  return { ok: true, admin, cookie: cookieFor(admin, now) };
}

const logout = () => clearCookie();
/* "log out everywhere", and the only remedy if a laptop goes missing */
function revokeSessions(adminId, actor, now = Date.now()) {
  bumpEpoch.run(adminId);
  logEvent(actor, 'admin-revoke', { admin: adminId }, now);
  return { ok: true };
}

/* ── Guard ────────────────────────────────────────────────────── */

/* SameSite=Strict already stops a cross-site form reaching a mutation, and
   a custom header stops anything that is not a fetch from our own origin —
   a form post cannot set one, and a cross-origin fetch that tries needs a
   preflight we never answer. Belt and braces, cheaply. */
const MUTATES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function guard(req, now) {
  const admin = sessionFrom(req, now);
  if (!admin) return { fail: { status: 401, error: 'signed-out', message: 'Sign in again.' } };
  if (MUTATES.has(req.method) && req.headers['x-admin'] !== '1') {
    return { fail: { status: 403, error: 'bad-request', message: 'Missing X-Admin header.' } };
  }
  return { admin, actor: `admin:${admin.username}` };
}

/* ── Reads the panel needs ────────────────────────────────────── */

const one = sql => db.prepare(sql).get();
const many = (sql, ...args) => db.prepare(sql).all(...args);

function overview(now = Date.now()) {
  const money = one(`SELECT
      COALESCE(SUM(CASE WHEN status = 'verified'   THEN amount END), 0) verified,
      COALESCE(SUM(CASE WHEN status IN ('awaiting_transfer','submitted') THEN amount END), 0) awaiting,
      COALESCE(SUM(CASE WHEN status = 'refund_due' THEN amount END), 0) refundDue,
      COALESCE(SUM(CASE WHEN status = 'refunded'   THEN amount END), 0) refunded
    FROM payments`);
  const out = telegram.status();
  const today = one(`SELECT COUNT(*) n FROM submissions WHERE created_at > ${now - 86400000}`);
  const dbFile = cfg.DB_FILE;
  const size = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;

  const alerts = [];
  if (settings.S.MAINTENANCE) alerts.push({ level: 'warn', text: 'Maintenance mode is on — nobody can claim.' });
  if (out.n > 0 && out.oldest && now - out.oldest > 15 * 60 * 1000) {
    alerts.push({ level: 'bad', text: `Telegram outbox stuck — oldest item is ${Math.round((now - out.oldest) / 60000)} min old.` });
  }
  const owed = one("SELECT COUNT(*) n FROM payments WHERE status = 'refund_due'");
  if (owed.n) alerts.push({ level: 'warn', text: `${owed.n} refund(s) owed and unsent.` });
  const pending = submissions.pendingCount();
  if (pending > 40) alerts.push({ level: 'warn', text: `${pending} submissions waiting for review.` });

  return {
    wall: {
      live: wall.wall.live.size,
      booked: wall.wall.reserved.size,
      pending: wall.wall.pending.live.size + wall.wall.pending.next.size,
      cycle: wall.wall.cycle,
      cycleEnd: wall.cycleEnd(wall.wall.cycle),
      rev: wall.wall.rev
    },
    queue: { pending, claimsToday: today.n },
    money,
    telegram: { mode: cfg.TG_MODE, outbox: out.n, oldest: out.oldest || null },
    system: {
      dbBytes: size,
      seedSource: getMeta('seed_source'),
      sse: require('./http.js').clients.size,
      uptimeMs: Math.round(process.uptime() * 1000),
      maintenance: settings.S.MAINTENANCE
    },
    alerts
  };
}

/* The queue, with the same rendered preview Telegram gets — reusing the
   file render.js already wrote rather than drawing it twice. */
function queue() {
  return submissions.queue().map(s => {
    const full = submissions.get(s.id);
    const rec = submissions.recordOf(s.user_id, s.id);
    return {
      sid: s.id, type: s.type, layer: s.layer, px: s.px_count,
      handle: s.handle, userId: s.user_id, at: s.created_at,
      bbox: JSON.parse(full.bbox || '[0,0,0,0]'),
      thumb: submissions.thumbOf(full.pixels, JSON.parse(full.bbox || '[0,0,0,0]')),
      brand: full.brand_name || null,
      preview: full.preview_path ? `/api/admin/preview/${s.id}.png` : null,
      payment: full.payment_id ? payments.get(full.payment_id) : null,
      record: rec
    };
  });
}

function users(q, limit = 40) {
  const like = `%${String(q || '').trim()}%`;
  const rows = many(
    `SELECT u.id, u.kind, u.handle, u.email, u.status, u.created_at, u.last_seen,
            a.used, a.refill_at, a.paint,
            (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) subs,
            (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id AND s.status = 'approved') approved
       FROM users u LEFT JOIN allowances a ON a.user_id = u.id
      WHERE (? = '%%' OR u.handle LIKE ? OR u.email LIKE ? OR CAST(u.id AS TEXT) = ?)
      ORDER BY u.last_seen DESC LIMIT ?`,
    like, like, like, String(q || '').trim(), limit);
  return rows;
}

const brands = () => many(
  `SELECT u.id, u.handle, u.email, u.status user_status, b.*
     FROM users u JOIN brand_profiles b ON b.user_id = u.id
    ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC`);

function paymentList(filter = {}, limit = 100) {
  const where = [], args = [];
  if (filter.status) { where.push('p.status = ?'); args.push(filter.status); }
  if (filter.kind) { where.push('p.kind = ?'); args.push(filter.kind); }
  if (filter.q) { where.push('(p.code LIKE ? OR p.instapay_ref LIKE ? OR p.payer_handle LIKE ?)');
    args.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`); }
  args.push(limit);
  return many(
    `SELECT p.*, u.handle, s.id sid FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN submissions s ON s.payment_id = p.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.id DESC LIMIT ?`, ...args);
}

/* §7.2: verified money in, against what it bought. Anything that does not
   net to zero is either a bug or a refund somebody forgot. */
function reconcile() {
  const paid = one(
    `SELECT COALESCE(SUM(amount), 0) total, COUNT(*) n FROM payments
      WHERE kind = 'paint_pack' AND status = 'verified'`);
  const credited = one("SELECT COALESCE(SUM(pack), 0) total FROM payments WHERE kind = 'paint_pack' AND status = 'verified'");
  const booked = one(
    `SELECT COALESCE(SUM(amount), 0) total, COUNT(*) n FROM payments
      WHERE kind = 'brand_booking' AND status = 'verified'`);
  const bookedPx = one(
    `SELECT COALESCE(SUM(s.px_count), 0) px FROM payments p JOIN submissions s ON s.payment_id = p.id
      WHERE p.kind = 'brand_booking' AND p.status = 'verified'`);
  const owed = one("SELECT COALESCE(SUM(amount), 0) total, COUNT(*) n FROM payments WHERE status = 'refund_due'");
  const expectedBooking = bookedPx.px * settings.S.PRICE_COMPANY * 100;
  return {
    packs: { verified: paid.total, orders: paid.n, paintCredited: credited.total },
    bookings: { verified: booked.total, orders: booked.n, px: bookedPx.px, expected: expectedBooking },
    /* a price change mid-cycle makes this legitimately non-zero, which is
       why it is shown rather than asserted */
    bookingDrift: booked.total - expectedBooking,
    owed: { total: owed.total, count: owed.n }
  };
}

function events(filter = {}, limit = 200) {
  const where = [], args = [];
  if (filter.actor) { where.push('actor LIKE ?'); args.push(`%${filter.actor}%`); }
  if (filter.action) { where.push('action = ?'); args.push(filter.action); }
  if (filter.since) { where.push('ts >= ?'); args.push(Number(filter.since)); }
  args.push(limit);
  return many(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?`, ...args);
}

const actionList = () => many('SELECT DISTINCT action FROM events ORDER BY action').map(r => r.action);

/* The whole chain behind one pixel (§7.2, wall inspector). */
function pixelAt(idx) {
  const cell = db.prepare(
    'SELECT * FROM cells WHERE cycle = ? AND idx = ? ORDER BY layer').all(wall.wall.cycle, idx);
  if (!cell.length) return { idx, empty: true };
  return {
    idx,
    cells: cell.map(c => {
      const sub = submissions.get(c.submission_id);
      return {
        layer: c.layer, state: c.state, color: c.color,
        sid: c.submission_id,
        submission: sub ? {
          type: sub.type, status: sub.status, px: sub.px_count, at: sub.created_at,
          decidedBy: sub.decided_by, decidedAt: sub.decided_at, reason: sub.reject_reason,
          brand: sub.brand_name, handle: sub.handle, userId: sub.user_id
        } : null,
        payment: sub && sub.payment_id ? payments.get(sub.payment_id) : null
      };
    })
  };
}

function systemInfo(now = Date.now()) {
  const out = many('SELECT id, method, attempts, next_try, created_at, payload FROM tg_outbox ORDER BY id LIMIT 100');
  return {
    outbox: out.map(r => ({
      id: r.id, method: r.method, attempts: r.attempts,
      nextTry: r.next_try, createdAt: r.created_at,
      about: (() => { try { return JSON.parse(r.payload).about || null; } catch (e) { return null; } })()
    })),
    backups: fs.existsSync(cfg.BACKUP_DIR)
      ? fs.readdirSync(cfg.BACKUP_DIR).sort().slice(-10).map(f => {
        const st = fs.statSync(path.join(cfg.BACKUP_DIR, f));
        return { file: f, bytes: st.size, at: st.mtimeMs };
      })
      : [],
    archives: fs.existsSync(cfg.ARCHIVE_DIR) ? fs.readdirSync(cfg.ARCHIVE_DIR).sort() : [],
    db: { file: cfg.DB_FILE, bytes: fs.existsSync(cfg.DB_FILE) ? fs.statSync(cfg.DB_FILE).size : 0 },
    node: process.version,
    now
  };
}

/* ── Mutations the panel owns outright ────────────────────────── */

const banStmt = db.prepare('UPDATE users SET status = ? WHERE id = ?');

function setBan(userId, banned, actor, reason, now = Date.now()) {
  const u = db.prepare('SELECT id, status, kind FROM users WHERE id = ?').get(userId);
  if (!u) return { error: 'not-found' };
  banStmt.run(banned ? 'banned' : 'active', userId);
  /* Deliberately NOT bumping token_epoch on a ban. The epoch is what makes a
     cookie stop verifying, and a cookie that will not verify cannot be
     identified — so bumping it here meant the next request could not tell
     this was a banned person and minted them a fresh identity instead. The
     ban is enforced on every request now by identity.resolve reading
     users.status, which needs the cookie to still say who it belongs to.
     Lifting a ban is likewise just a status change.

     What a ban does and does not do, honestly: it closes that account, its
     paint and its history. Somebody who clears their cookies still becomes a
     new anonymous visitor — that is inherent to painting without an account,
     and the per-IP caps are what limit it. */
  identity.forget(userId);
  logEvent(actor, banned ? 'user-ban' : 'user-unban', { user: userId, reason: reason || null }, now);
  return { ok: true, userId, status: banned ? 'banned' : 'active' };
}

/* ── Erasure, and the hold that has to ship with it (§7.2) ────────
   PRIVACY §9 describes this procedure in some detail and, until now,
   nothing in the product could carry it out.

   What survives is the interesting half. The payment rows stay: they are
   books, kept on the tax clock, which is a different obligation with a
   different clock and one the person asking cannot waive on our behalf.
   What comes off them is everything that points at a human — the InstaPay
   handle, the transfer reference, the screenshot. The journal keeps its
   lines and loses the identifiers inside them, for the same reason the
   retention sweep redacts rather than deletes: the wall is rebuilt from
   that journal, and a hole in it is a hole in the audit trail.

   The submissions go, and with them the stored pixels and the rendered
   previews — that last is what actually anonymises the archive.

   And the hold ships in the same commit, because without it this route is
   the mechanism by which somebody destroys the record of their own post
   the moment a complaint about it lands. TERMS §11A and PRIVACY §9 both
   say nothing goes while a matter is open; this is what makes that true. */

const HELD = {
  error: 'legal-hold',
  status: 409,
  message: 'This account is under a legal hold. Nothing on it can be erased ' +
    'until the hold is lifted, and lifting it is its own recorded action.'
};

function setHold(userId, held, actor, reason, now = Date.now()) {
  if (!reason || String(reason).trim().length < 3) {
    return { error: 'reason-required', message: 'Say why — it goes in the audit log.' };
  }
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) return { error: 'not-found' };
  tx(() => {
    db.prepare('UPDATE users SET legal_hold = ? WHERE id = ?').run(held ? 1 : 0, userId);
    /* the person's own submissions travel with them: a hold is about a
       matter, and the drawing is usually what the matter is about */
    db.prepare('UPDATE submissions SET legal_hold = ? WHERE user_id = ?').run(held ? 1 : 0, userId);
  });
  logEvent(actor, held ? 'legal-hold-on' : 'legal-hold-off', { user: userId, reason }, now);
  return { ok: true, userId, legalHold: !!held };
}

const ERASE = {
  profile: db.prepare('DELETE FROM brand_profiles WHERE user_id = ?'),
  subs: db.prepare(
    'SELECT id, preview_path, layer, brand_name FROM submissions WHERE user_id = ?'),
  /* read before the delete, so the wall can be told which squares went */
  cellsOf: db.prepare('SELECT idx, layer FROM cells WHERE submission_id = ?'),
  dropSubs: db.prepare('DELETE FROM submissions WHERE user_id = ?'),
  dropCells: db.prepare('DELETE FROM cells WHERE user_id = ?'),
  pays: db.prepare('SELECT id, screenshot_path FROM payments WHERE user_id = ?'),
  scrubPay: db.prepare(
    `UPDATE payments SET instapay_ref = NULL, payer_handle = NULL, screenshot_path = NULL
      WHERE user_id = ?`),
  /* Only this person's lines, and only the fields that name them. Done in JS
     rather than json_remove so a build of SQLite without JSON1 behaves the
     same and a payload that is not an object is left alone. */
  theirs: db.prepare(
    `SELECT id, payload FROM events WHERE actor = ? AND (
       payload LIKE '%"ip"%' OR payload LIKE '%"email"%' OR
       payload LIKE '%"handle"%' OR payload LIKE '%"name"%' OR payload LIKE '%"ref"%')`),
  redact: db.prepare('UPDATE events SET payload = ? WHERE id = ?'),
  wipe: db.prepare(
    `UPDATE users SET email = NULL, pass_hash = NULL, handle = ?, status = 'banned',
            erased_at = ?, token_epoch = COALESCE(token_epoch, 0) + 1
      WHERE id = ?`)
};

const PERSONAL = ['ip', 'email', 'handle', 'name', 'ref', 'payer_handle', 'instapay_ref'];

function eraseUser(userId, actor, reason, now = Date.now()) {
  if (!reason || String(reason).trim().length < 3) {
    return { error: 'reason-required', message: 'Say why — it goes in the audit log.' };
  }
  const u = db.prepare('SELECT id, handle, kind, legal_hold, erased_at FROM users WHERE id = ?').get(userId);
  if (!u) return { error: 'not-found' };
  if (u.erased_at) return { error: 'already-erased', message: 'This account has already been erased.' };
  if (u.legal_hold) return HELD;
  if (db.prepare('SELECT 1 FROM submissions WHERE user_id = ? AND legal_hold = 1').get(userId)) return HELD;

  /* The same name this identity would have had if it had never chosen one —
     handleFor hashes the key, so 'u<id>' is exactly what identity.js mints a
     guest. An erased row therefore does not stand out as one on the wall,
     which is the point: an anonymised account that is visibly anonymised is
     only half anonymised. The 'u' prefix is not decoration; the function
     walks the string, so a bare number hashes to the same name every time. */
  const handle = identity.handleFor('u' + userId);
  const files = [];
  /* What the in-memory wall has to be told about. Collected before the rows
     go, because after the delete there is nothing left to read it from. */
  const erased = [];
  const out = tx(() => {
    for (const s of ERASE.subs.all(userId)) {
      if (s.preview_path) files.push(s.preview_path);
      erased.push({ sub: s, cells: ERASE.cellsOf.all(s.id) });
    }
    for (const p of ERASE.pays.all(userId)) if (p.screenshot_path) files.push(p.screenshot_path);

    const cells = ERASE.dropCells.run(userId).changes;
    const subs = ERASE.dropSubs.run(userId).changes;
    ERASE.profile.run(userId);
    const paid = ERASE.scrubPay.run(userId).changes;

    let lines = 0;
    for (const row of ERASE.theirs.all(`user:${userId}`)) {
      let p;
      try { p = JSON.parse(row.payload); } catch { continue; }
      if (!p || typeof p !== 'object') continue;
      let touched = false;
      for (const k of PERSONAL) if (k in p) { delete p[k]; touched = true; }
      if (touched) { ERASE.redact.run(JSON.stringify(p), row.id); lines++; }
    }

    ERASE.wipe.run(handle, now, userId);
    return { cells, subs, payments: paid, events: lines };
  });

  /* Outside the transaction: a file removed for a row that rolled back is
     recoverable from a backup, a row removed with its file left behind is
     personal data still sitting on the volume. */
  for (const f of files) unlinkQuiet(f);

  /* The database is not the wall. wall.live and wall.reserved are the maps
     every snapshot is encoded from and every open canvas is drawing, and
     deleting the cells rows does not touch them — an audit caught this by
     erasing an account and finding its pixels still being served, under a
     new anonymous name, with the rows gone. PRIVACY §9 says the pixels come
     off the wall; until a restart, they did not.

     publishErasure is the same call every other removal path makes
     (submissions.reject, .expire, .takedown): it drops the squares from the
     right map, marks the body cache dirty, unpicks a brand's sponsor link
     if that was its last batch, and broadcasts the removal so open tabs
     repaint. After the commit, so a rolled-back erasure leaves memory alone. */
  for (const e of erased) {
    try { wall.publishErasure(e.sub, e.cells); } catch (err) {
      console.warn(`erase: wall not updated for s${e.sub.id} —`, err.message);
    }
  }

  /* wall.owners is an interned name table that nothing but this refreshes.
     A direct database edit leaves every open tab, and every fresh snapshot,
     serving the old name until a restart — which is also what makes
     PRIVACY §9's "we reset your name" real rather than eventual. */
  try { wall.renameOwner(u.handle, handle); } catch (err) {
    console.warn('erase: owner table not patched —', err.message);
  }
  identity.forget(userId);

  logEvent(actor, 'user-erase',
    { user: userId, kept: ['payments'], removed: out, files: files.length, reason }, now);
  return { ok: true, userId, handle, ...out, filesRemoved: files.length };
}

/* Same containment rule the retention sweep uses: never follow a path out of
   the data directory, whatever the column happens to say. */
function unlinkQuiet(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(cfg.DATA_DIR, rel);
  if (!path.resolve(abs).startsWith(path.resolve(cfg.DATA_DIR))) return false;
  try { fs.unlinkSync(abs); return true; } catch (err) {
    if (err.code !== 'ENOENT') console.warn('erase unlink:', rel, err.message);
    return false;
  }
}

function adjust(userId, patch, actor, reason, now = Date.now()) {
  if (!reason || String(reason).trim().length < 3) {
    return { error: 'reason-required', message: 'Say why — it goes in the audit log.' };
  }
  const a = db.prepare('SELECT * FROM allowances WHERE user_id = ?').get(userId);
  if (!a) return { error: 'not-found' };
  const paint = patch.paint === undefined ? a.paint : Math.max(0, Number(patch.paint));
  const used = patch.used === undefined ? a.used : Math.max(0, Number(patch.used));
  if (!Number.isFinite(paint) || !Number.isFinite(used)) return { error: 'invalid' };

  db.prepare('UPDATE allowances SET paint = ?, used = ?, refill_at = ? WHERE user_id = ?')
    .run(paint, used, patch.clearRefill ? 0 : a.refill_at, userId);
  identity.forget(userId);
  logEvent(actor, 'user-adjust',
    { user: userId, paint: [a.paint, paint], used: [a.used, used], reason }, now);
  return { ok: true, userId, paint, used };
}

/* §7.2: rectangle-select erase. Every submission it touches goes through
   the same takedown the single-pixel one does, so refunds and SSE follow
   without this having to know about either. */
function eraseRegion(rect, actor, reason, now = Date.now()) {
  const x0 = Math.max(0, Math.min(cfg.W - 1, Number(rect.x0)));
  const y0 = Math.max(0, Math.min(cfg.H - 1, Number(rect.y0)));
  const x1 = Math.max(0, Math.min(cfg.W - 1, Number(rect.x1)));
  const y1 = Math.max(0, Math.min(cfg.H - 1, Number(rect.y1)));
  if ([x0, y0, x1, y1].some(v => !Number.isFinite(v))) return { error: 'invalid' };
  const [lx, hx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ly, hy] = y0 <= y1 ? [y0, y1] : [y1, y0];

  const hit = many(
    `SELECT DISTINCT submission_id sid FROM cells
      WHERE cycle = ? AND idx % ? BETWEEN ? AND ? AND idx / ? BETWEEN ? AND ?`,
    wall.wall.cycle, cfg.W, lx, hx, cfg.W, ly, hy);

  const done = [];
  for (const { sid } of hit) {
    const sub = submissions.get(sid);
    if (!sub) continue;
    const r = sub.status === 'approved'
      ? submissions.takedown(sid, actor, reason || 'region wipe', now)
      : submissions.reject(sid, actor, reason || 'region wipe', now);
    if (r.ok) done.push(sid);
  }
  logEvent(actor, 'region-wipe', { rect: [lx, ly, hx, hy], submissions: done.length, reason }, now);
  return { ok: true, submissions: done, rect: [lx, ly, hx, hy] };
}

/* Both of these are one keystroke away from erasing a month, so both want
   the operator to type something that cannot be a slip. */
const PHRASE = {
  reset: 'RESET THE WALL', reseed: 'RESEED THE WALL',
  /* Erasure is not undoable and not partial, so it asks to be typed out for
     the same reason the other two do. */
  erase: 'ERASE THIS ACCOUNT'
};

function forceReset(phrase, actor, now = Date.now()) {
  if (phrase !== PHRASE.reset) {
    return { error: 'confirm', message: `Type “${PHRASE.reset}” to confirm.` };
  }
  const r = wall.resetCycle(now, wall.cycleStart(wall.cycleEnd(now)));
  logEvent(actor, 'force-reset', { promoted: r.promoted, archive: r.archive }, now);
  return { ok: true, ...r };
}

function forceReseed(phrase, actor, now = Date.now()) {
  if (phrase !== PHRASE.reseed) {
    return { error: 'confirm', message: `Type “${PHRASE.reseed}” to confirm.` };
  }
  const r = wall.reseed(now);
  logEvent(actor, 'force-reseed', r, now);
  return { ok: true, ...r };
}

/* §7.2 payments: the same transitions Telegram drives, plus a narrow
   override for a state somebody has genuinely got stuck in. Whitelisted,
   never free-form — an arbitrary status write is how a ledger stops
   meaning anything. */
const OVERRIDES = {
  'rejected>submitted': "the payer says it did arrive and it is worth another look",
  'expired>awaiting_transfer': 'reopening a hold that lapsed',
  'refunded>refund_due': 'the refund bounced or never landed',
  /* the other side of erring toward owing: a debt raised on an unverified
     transfer that never actually arrived has to be closable */
  'refund_due>rejected': 'checked the account and no transfer ever arrived',
  /* The one the documents need. TERMS §5, §20 item 4 and §21, and REFUNDS
     §6.1 items 2-4, §9 and §16 all promise money back for a paint pack in
     named cases — the wall closing, an account we ended, a mistake of ours.
     Every other route into refund_due goes through settlePayment, which
     needs a submission, and a pack order has none: http.js creates it with
     no `sid`. So without this there was no path in the software that could
     do what six clauses say we will do. */
  'verified>refund_due': 'refunding a pack under the refund policy'
};

/* Paint bought and not yet spent, for the pack this payment credited. */
const selAllowance = db.prepare('SELECT paint FROM allowances WHERE user_id = ?');
const debitPaint = db.prepare(
  'UPDATE allowances SET paint = paint - ? WHERE user_id = ? AND paint >= ?');

function override(paymentId, to, actor, reason, now = Date.now()) {
  const p = payments.get(paymentId);
  if (!p) return { error: 'not-found' };
  const key = `${p.status}>${to}`;
  if (!OVERRIDES[key]) {
    return { error: 'not-allowed', message: `${p.status} → ${to} is not an allowed override.` };
  }
  if (!reason || String(reason).trim().length < 3) {
    return { error: 'reason-required', message: 'Say why — it goes in the audit log.' };
  }

  /* Turning a verified pack into a debt means giving the money back, so the
     paint it bought has to come off in the same breath. Without the debit
     you hand back the cash and leave the pixels, and reconcile() — the only
     instrument that tracks money-in against value-out — stops meaning
     anything the moment it is used.

     Refused rather than clamped when the balance is short: paint that has
     already been spent is on the wall, and a refund that would take back
     more than is there is a decision about somebody's artwork, which is not
     a decision this button should be making quietly. */
  const debiting = key === 'verified>refund_due' && p.kind === 'paint_pack' && p.pack > 0;
  if (debiting) {
    const held = selAllowance.get(p.user_id);
    const have = held ? held.paint : 0;
    if (have < p.pack) {
      return {
        error: 'paint-spent',
        message: `That pack credited ${p.pack} paint and only ${have} is left — ` +
          `${p.pack - have} has been spent on the wall. Refund it by hand and adjust ` +
          `the balance separately, so the write-off is recorded as one.`
      };
    }
  }

  const done = tx(() => {
    const moved = db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, now, paymentId, p.status).changes;
    /* Conditional on the status we read, so a double-tapped button is one
       transition — and, critically, one debit. */
    if (!moved) return false;
    if (debiting && !debitPaint.run(p.pack, p.user_id, p.pack).changes) {
      /* somebody spent it between the check and here; unwind the whole thing */
      throw new Error('paint-raced');
    }
    return true;
  });

  if (!done) return { error: 'moved', message: 'Somebody else changed this payment first.' };

  logEvent(actor, 'payment-override',
    { payment: paymentId, from: p.status, to, reason, paintDebited: debiting ? p.pack : 0 }, now);
  if (debiting) identity.forget(p.user_id);        // the cached allowance is stale
  return { ok: true, paymentId, from: p.status, to, paintDebited: debiting ? p.pack : 0 };
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function paymentsCsv(filter) {
  const rows = paymentList(filter, 10000);
  const cols = ['id', 'created_at', 'kind', 'code', 'status', 'amount', 'pack',
    'handle', 'payer_handle', 'instapay_ref', 'verified_at', 'verified_by',
    'refunded_at', 'refunded_by', 'sid'];
  return [cols.join(',')]
    .concat(rows.map(r => cols.map(c => csvCell(r[c])).join(',')))
    .join('\n');
}

module.exports = {
  COOKIE, TTL, LOGIN_TRIES, PHRASE, OVERRIDES,
  base32Decode, base32Encode, hotp, totpStep, newSecret, otpauth,
  createAdmin, countAdmins, login, logout, revokeSessions, guard, sessionFrom,
  clearCookie, ipAllowed, throttled,
  overview, queue, users, brands, paymentList, reconcile, events, actionList,
  pixelAt, systemInfo, setBan, adjust, eraseRegion, forceReset, forceReseed,
  eraseUser, setHold,
  override, paymentsCsv, exportFromDb, renderWall
};
