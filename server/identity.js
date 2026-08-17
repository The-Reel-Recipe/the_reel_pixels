/* ═══════════════════════════════════════════════════════════════
   identity — who is asking, and what they have left

   A caller is a signed cookie now, not an IP. `resolve()` is the only
   door: it verifies the uid cookie, mints a guest when there isn't a
   valid one, and hands back the same row shape the rest of the server
   already reads. The IP survives in exactly one job — the per-day caps
   in §3 — because that is the only thing it was ever good for.

   Cookie: `uid.exp.HMAC-SHA256(uid.exp.token_epoch)` base64url, brand
   sessions marked `b` in front of the id. The epoch is signed but never
   sent, so bumping users.token_epoch invalidates every cookie that user
   holds without any server-side session table (§3, v1). Verification is
   constant-time; anything tampered, expired or pointing at a user who
   changed kind is treated as no cookie at all — a fresh guest.

   writeAllowance() deliberately runs bare statements rather than its
   own transaction: wall.js calls it from inside the claim transaction,
   which is what makes §4.6 true (a burst of parallel claims cannot
   overspend, because the spend commits with the pixels or not at all).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const cfg = require('./config.js');
const { S } = require('./settings.js');
const { db, tx, logEvent } = require('./db.js');

/* ── Where a caller is (caps only) ────────────────────────────── */

/* A caller holding an IPv6 /64 can walk through billions of addresses,
   so v6 is grouped on its prefix. v4 is used whole. */
function ipv6Prefix(ip) {
  const bare = ip.split('%')[0];                       // drop any zone id
  let groups;
  if (bare.includes('::')) {
    const [head, tail] = bare.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = bare.split(':');
  }
  return groups.slice(0, 4).map(g => (g || '0').padStart(4, '0')).join(':') + '::/64';
}

function callerKey(req) {
  let ip = req.socket.remoteAddress || '';
  if (cfg.TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0];
    if (fwd && fwd.trim()) ip = fwd.trim();
  }
  ip = ip.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');   // IPv4-mapped v6
  if (!ip) return 'unknown';
  return ip.includes(':') ? ipv6Prefix(ip) : ip;
}

/* Stable, non-identifying display name. Fed the user id now that the
   caller isn't an address — same shape, and two people behind one
   router stop sharing a name. */
function handleFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `Pixel fan #${(h >>> 0) % 9000 + 1000}`;
}

/* ── Statements ───────────────────────────────────────────────── */

const selUser = db.prepare(
  `SELECT u.id, u.kind, u.handle, u.email, u.status, u.token_epoch, u.last_seen,
          u.erased_at,
          a.used, a.refill_at, a.paint
     FROM users u LEFT JOIN allowances a ON a.user_id = u.id
    WHERE u.id = ?`);
/* One email is one account, whichever kind holds it — the partial unique
   index (009) is the backstop, these are the polite checks in front of it. */
const selByEmailAny = db.prepare(
  'SELECT id, kind, pass_hash, token_epoch, status FROM users WHERE email = ? AND pass_hash IS NOT NULL');
const emailTaken = db.prepare('SELECT 1 FROM users WHERE email = ?');
const setCredentials = db.prepare(
  "UPDATE users SET email = ?, pass_hash = ? WHERE id = ? AND kind = 'guest' AND email IS NULL");
const insGuest = db.prepare(
  "INSERT INTO users (kind, handle, created_at, last_seen) VALUES ('guest', '', ?, ?)");
const insBrand = db.prepare(
  `INSERT INTO users (kind, handle, email, pass_hash, created_at, last_seen)
   VALUES ('brand', ?, ?, ?, ?, ?)`);
const insProfile = db.prepare(
  `INSERT INTO brand_profiles (user_id, business_name, category, description, website,
     socials, contact_name, phone, reg_number, instapay_handle, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
const selProfile = db.prepare('SELECT status FROM brand_profiles WHERE user_id = ?');
const setHandle = db.prepare('UPDATE users SET handle = ? WHERE id = ?');
const insAllowance = db.prepare(
  'INSERT INTO allowances (user_id, used, refill_at) VALUES (?, ?, ?)');
const setAllowance = db.prepare(
  'UPDATE allowances SET used = ?, refill_at = ?, paint = ? WHERE user_id = ?');
const bumpPaint = db.prepare('UPDATE allowances SET paint = paint + ? WHERE user_id = ?');
const readAllowance = db.prepare('SELECT used, refill_at, paint FROM allowances WHERE user_id = ?');
const clearAllowances = db.prepare('UPDATE allowances SET used = 0, refill_at = 0');
const clearIpAllowances = db.prepare('DELETE FROM ip_allowances');
const seenStmt = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

/* The prototype's IP → user map (002). Prepared only while the table is
   still there, so applying the @manual 003 that drops it needs nothing
   from this file but a restart. */
const hasLegacy = !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_keys'").get();
const legacy = hasLegacy ? {
  find: db.prepare('SELECT user_id FROM legacy_keys WHERE key = ?'),
  drop: db.prepare('DELETE FROM legacy_keys WHERE key = ?')
} : null;

/* ── Per-day IP counters (§3) ─────────────────────────────────── */

const pad = n => String(n).padStart(2, '0');
/* local days, like the cycle — a cap that rolls over at 02:00 because the
   server thinks in UTC is a support ticket nobody can reproduce */
const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const selIp = db.prepare('SELECT guests, claims, signups FROM ip_guests WHERE ip = ? AND day = ?');
const bumpIp = {};
for (const col of ['guests', 'claims', 'signups']) {
  bumpIp[col] = db.prepare(
    `INSERT INTO ip_guests (ip, day, ${col}) VALUES (?, ?, 1)
       ON CONFLICT (ip, day) DO UPDATE SET ${col} = ${col} + 1`);
}

function ipCounts(ip, now) {
  return selIp.get(ip, dayKey(now)) || { guests: 0, claims: 0, signups: 0 };
}

/* Counts one attempt against `what` and says whether it was allowed. The
   read and the increment share a transaction so two requests arriving
   together can't both see the 39th claim. */
function takeIp(ip, what, cap, now) {
  const day = dayKey(now);
  const row = selIp.get(ip, day) || { guests: 0, claims: 0, signups: 0 };
  if (row[what] >= cap) return false;
  bumpIp[what].run(ip, day);
  return true;
}
const take = (ip, what, cap, now) => tx(takeIp, ip, what, cap, now);

/* ── The shared clock a fresh mint inherits (§3, incognito) ──────
   ip_guests caps how many identities an IP can mint per day, but each
   one used to start its own 20-free/30-min clock at zero — so clearing
   cookies bought a fresh allowance instantly, up to that daily cap.
   This is read only at mint time (mintTx) and written only after a
   claim spends free pixels (wall.js's claimTx, via syncIpAllowance):
   an identity that already exists is never throttled by what another
   identity from the same IP just spent. */
const selIpAllowance = db.prepare('SELECT used, refill_at FROM ip_allowances WHERE ip = ?');
const upsertIpAllowance = db.prepare(
  `INSERT INTO ip_allowances (ip, used, refill_at) VALUES (?, ?, ?)
     ON CONFLICT (ip) DO UPDATE SET used = excluded.used, refill_at = excluded.refill_at`);

function ipAllowance(ip, now) {
  const row = selIpAllowance.get(ip);
  if (!row || (row.refill_at && now >= row.refill_at)) return { used: 0, refillAt: 0 };
  return { used: row.used, refillAt: row.refill_at };
}
function syncIpAllowance(ip, used, refillAt) {
  upsertIpAllowance.run(ip, used, refillAt);
}

/* The 429 bodies. Friendly, and specific enough that support can tell
   which cap somebody hit without asking them to read a log. */
/* An account that is no longer allowed in. Shaped like CAPPED so http.js's
   existing `if (ses.capped)` branch answers it with a 403 and a sentence,
   rather than the request quietly becoming somebody new. */
const BANNED = {
  banned: {
    error: 'account-banned', status: 403,
    message: 'This account has been closed for breaking the wall rules. ' +
      'If you think that is wrong, get in touch and a person will look again.'
  },
  erased: {
    error: 'account-erased', status: 403,
    message: 'This account has been erased at its owner\'s request.'
  }
};

const CAPPED = {
  guests: {
    error: 'ip-guest-cap',
    message: 'Too many new visitors from this connection today. ' +
      'If you have painted here before, allow cookies and reload — your pixels are still yours.'
  },
  claims: {
    error: 'ip-claim-cap',
    message: 'That connection has claimed a lot of pixels today. ' +
      'The daily limit resets at midnight — brand accounts are not capped.'
  },
  signups: {
    error: 'ip-signup-cap',
    message: 'Too many brand applications from this connection today. Try again tomorrow, ' +
      'or reply to the team if you need a hand.'
  }
};

/* ── Cookies ──────────────────────────────────────────────────── */

const COOKIE = 'uid';

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* the epoch goes into the HMAC and nowhere else: the client can't see it,
   so it can't be replayed after a bump */
const sign = (payload, epoch) =>
  b64url(crypto.createHmac('sha256', cfg.SESSION_SECRET).update(`${payload}.${epoch}`).digest());

function equal(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(id, kind, epoch, now) {
  const exp = now + (kind === 'brand' ? cfg.BRAND_TTL : cfg.GUEST_TTL);
  const payload = `${kind === 'brand' ? 'b' : ''}${id}.${exp}`;
  return { value: `${payload}.${sign(payload, epoch)}`, exp };
}

function cookieHeader(value, maxAgeMs) {
  const bits = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (cfg.COOKIE_SECURE) bits.push('Secure');
  return bits.join('; ');
}
/* Max-Age=0 with the same attributes is the only reliable way to retract
   a cookie — the browser matches on name/path/flags, not on the value. */
const clearCookie = () => cookieHeader('', 0);

function sessionCookie(e, now) {
  const { value, exp } = cookieValue(e.id, e.kind, e.epoch, now);
  return cookieHeader(value, exp - now);
}

function readCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

/* Returns the users row the cookie names, or null for "mint a fresh one".
   Null covers every failure on purpose: a tampered signature, an expired
   cookie, a deleted user and a guest cookie for what is now a brand all
   mean the same thing to the caller, and saying which is free help. */
function verifyCookie(value, now) {
  if (!value || value.length > 400) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [head, expText, sig] = parts;
  const brand = head.startsWith('b');
  const id = Number(brand ? head.slice(1) : head);
  const exp = Number(expText);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(exp) || exp <= 0) return null;
  if (now >= exp) return null;

  const u = selUser.get(id);
  if (!u) return null;
  if (!equal(sig, sign(`${head}.${expText}`, u.token_epoch))) return null;
  if (brand !== (u.kind === 'brand')) return null;
  /* the caller needs to know how much life is left, to decide whether to
     hand back a fresh one — see resolve() */
  u.cookieExp = exp;
  return u;
}

/* ── Per-caller row ───────────────────────────────────────────── */

/* user id -> { id, kind, handle, used, refillAt, paint, epoch, seen, wrote }
   A pure cache: every field also lives in SQLite, and dropping an entry
   costs one SELECT, so the idle sweep below can be as brutal as it likes.
   Brand approval is deliberately *not* in here — it changes underneath us
   when a moderator decides, and a stale 'pending' would lock somebody out
   of the flow they just got approved for. */
const cache = new Map();

/* an elapsed refill is applied on the way past, so the rest of the code
   never has to think about expiry */
function refreshed(e, now) {
  if (e.refillAt && now >= e.refillAt) {
    e.used = 0; e.refillAt = 0;
    writeAllowance(e);
  }
  return e;
}

function entryOf(u, now) {
  const hit = cache.get(u.id);
  if (hit) return refreshed(hit, now);
  const e = {
    id: u.id, kind: u.kind, handle: u.handle, email: u.email || null,
    seen: u.last_seen || now, wrote: u.last_seen || 0, epoch: u.token_epoch || 0,
    used: u.used || 0, refillAt: u.refill_at || 0, paint: u.paint || 0
  };
  cache.set(u.id, e);
  return refreshed(e, now);
}

/* Fetches a user's row by id. */
function rowFor(id, now) {
  const hit = cache.get(id);
  if (hit) return refreshed(hit, now);
  const u = selUser.get(id);
  if (!u) throw new Error(`identity: no user ${id}`);
  return entryOf(u, now);
}

/* Bare UPDATE — no transaction of its own, so it joins whichever one the
   caller is already inside (see the header). */
function writeAllowance(e) {
  setAllowance.run(e.used, e.refillAt, e.paint, e.id);
}

function allowanceOf(e, now) {
  return {
    cap: S.CAP, free: Math.max(0, S.CAP - e.used), paint: e.paint,
    refillAt: e.refillAt || 0,
    refillIn: e.refillAt ? Math.max(0, e.refillAt - now) : 0,
    refillMs: S.REFILL, handle: e.handle, now
  };
}

/* last_seen is only interesting to the minute — a write per request would
   dirty a page on every poll of /api/allowance for nothing. */
function touch(e, now) {
  e.seen = now;
  if (now - e.wrote < 60000) return;
  e.wrote = now;
  seenStmt.run(now, e.id);
}

/* ── Minting a guest ──────────────────────────────────────────── */

/* One transaction: the cap check, the counter, the users row, its
   allowance and the journal line. */
function mintTx(ip, now) {
  /* A caller whose IP still has a prototype-era row isn't a new identity
     — it's the same person, back. Adopt the user, retire the row, and
     don't spend any of today's guest budget on them. */
  const old = legacy && legacy.find.get(ip);
  if (old) {
    legacy.drop.run(ip);
    logEvent(`user:${old.user_id}`, 'legacy-adopt', { ip }, now);
    return { id: old.user_id, adopted: true };
  }

  if (!takeIp(ip, 'guests', S.IP_GUEST_CAP, now)) return { capped: 'guests' };

  const id = Number(insGuest.run(now, now).lastInsertRowid);
  setHandle.run(handleFor('u' + id), id);              // the name needs the id
  const seed = ipAllowance(ip, now);
  insAllowance.run(id, seed.used, seed.refillAt);
  logEvent(`user:${id}`, 'guest-mint', { ip }, now);
  return { id };
}

/* ── The door ─────────────────────────────────────────────────── */

/* Every /api/* request starts here. Hands back { ip, e } plus a Set-Cookie
   for http.js to attach when a new identity was minted, or { capped } when
   this IP has spent its budget of them for the day.

   `mint: false` is for the auth routes: signing up or logging in doesn't
   need a guest identity, and handing one out would mean a visitor who
   cleared their cookies to log in spent a slot of the very budget that
   exists to stop people clearing their cookies for free pixels. Those
   routes read `ip` and nothing else, so `e` is allowed to be null. */
function resolve(req, now, opts) {
  const ip = callerKey(req);
  const u = verifyCookie(readCookie(req), now);
  /* A ban used to be a logout: setBan bumps token_epoch, the cookie stops
     verifying, and the next request minted a brand-new guest — so the
     banned person got a clean identity out of it. Nothing on this path read
     users.status at all. */
  /* status is the mechanism — may this account act — and erased_at is the
     meaning, which decides the wording. Somebody who asked to be forgotten
     should not be told they broke the rules.

     In practice the erased branch is a backstop rather than the usual path:
     eraseUser bumps token_epoch, so the cookie stops verifying and its
     holder arrives here as a stranger instead. That is deliberate and it is
     the one place erasure and a ban are opposite — a ban must stay
     identifiable to be enforced, an erasure must stop being identifiable to
     be an erasure. This branch covers a session that outlives the bump. */
  if (u && u.status && u.status !== 'active') {
    return { ip, capped: u.erased_at ? BANNED.erased : (BANNED[u.status] || BANNED.banned) };
  }
  if (u) {
    const e = entryOf(u, now);
    /* Rolling session: a cookie past halfway through its life is renewed on
       the spot. Without this the clock starts at signup and never restarts,
       so somebody who uses the wall every week is still logged out on a
       fixed date for no reason they can see — and their paint, which is
       theirs, goes quiet with the session that reached it. */
    const life = e.kind === 'brand' ? cfg.BRAND_TTL : cfg.GUEST_TTL;
    if (u.cookieExp && (u.cookieExp - now) < life / 2) {
      return { ip, e, cookie: sessionCookie(e, now) };
    }
    return { ip, e };
  }
  if (opts && opts.mint === false) return { ip, e: null };

  const minted = mintTx(ip, now);
  if (minted.capped) return { ip, capped: CAPPED[minted.capped] };

  const e = rowFor(minted.id, now);
  return { ip, e, minted: true, cookie: sessionCookie(e, now) };
}

/* Claims are capped per IP per day; brands are exempt (§3 — their pixels
   are paid for and moderated, and a shop's whole team shares one office
   connection). Returns null when the claim may proceed. */
function takeClaim(ip, e, now) {
  if (e.kind === 'brand') return null;
  return take(ip, 'claims', S.IP_CLAIM_CAP, now) ? null : CAPPED.claims;
}

/* ── Passwords ────────────────────────────────────────────────── */

/* scrypt, stored as salt:N:r:p:hash (§2). Synchronous on purpose: it is
   ~60 ms on the login path and nowhere else, and the alternative is an
   await in the middle of a request handler that owns a transaction. */
function hashPassword(pw) {
  const { N, r, p, keylen, saltlen } = cfg.SCRYPT;
  const salt = crypto.randomBytes(saltlen);
  const hash = crypto.scryptSync(pw, salt, keylen, { N, r, p });
  return `${salt.toString('hex')}:${N}:${r}:${p}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [saltHex, N, r, p, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (err) {
    return false;                                      // unreadable hash = wrong password
  }
}

/* ── Brand signup ─────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+\d][\d\s()+-]{5,}$/;

const text = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

function httpUrl(v) {
  const s = text(v);
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (err) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return u.href;
}

/* socials arrive as an array or as one-per-line text; both end up as the
   JSON array §2 asks for */
function socialList(v) {
  const raw = Array.isArray(v) ? v : text(v).split(/[\n,]/);
  const out = [];
  for (const item of raw.slice(0, 8)) {
    const s = text(item);
    if (!s) continue;
    const url = httpUrl(s);
    out.push(url || s.slice(0, 200));                  // a bare @handle is still an answer
  }
  return out;
}

/* Every rule in §3, in one place, so the client can render them inline
   and the server never trusts that it did. */
function validateSignup(body) {
  const b = body && typeof body === 'object' ? body : {};
  const f = {};
  const v = {
    email: text(b.email).toLowerCase(),
    password: typeof b.password === 'string' ? b.password : '',
    business_name: text(b.business_name),
    category: text(b.category),
    description: text(b.description),
    website: text(b.website),
    socials: socialList(b.socials),
    contact_name: text(b.contact_name),
    phone: text(b.phone),
    reg_number: text(b.reg_number),
    instapay_handle: text(b.instapay_handle)
  };

  if (!v.email) f.email = 'We need an email address.';
  else if (v.email.length > 160 || !EMAIL_RE.test(v.email)) f.email = 'That does not look like an email address.';

  if (v.password.length < cfg.PASS_MIN) f.password = `Passwords need at least ${cfg.PASS_MIN} characters.`;
  else if (v.password.length > 200) f.password = 'That password is too long (200 characters max).';

  if (v.business_name.length < 2) f.business_name = 'Tell us the business name.';
  else if (v.business_name.length > 80) f.business_name = 'Business name is capped at 80 characters.';

  if (v.category.length < 2) f.category = 'Pick or type a category.';
  else if (v.category.length > 40) f.category = 'Category is capped at 40 characters.';

  if (v.description.length < cfg.DESC_MIN) {
    f.description = `Tell us properly what the business does — ${cfg.DESC_MIN} characters minimum ` +
      `(you have ${v.description.length}).`;
  } else if (v.description.length > 4000) f.description = 'That is longer than we can store (4,000 characters max).';

  const site = v.website ? httpUrl(v.website) : '';
  if (v.website && !site) f.website = 'That web address does not look right — e.g. nile-soda.com';
  else v.website = site;
  if (!v.website && !v.socials.length) {
    f.website = 'A website or at least one social account is required — we check every brand by hand.';
  }

  if (v.contact_name.length < 2) f.contact_name = 'Who should we talk to?';
  else if (v.contact_name.length > 80) f.contact_name = 'Contact name is capped at 80 characters.';

  if (!v.phone) f.phone = 'A phone number is required.';
  else if (v.phone.length > 32 || !PHONE_RE.test(v.phone)) f.phone = 'That phone number does not look right.';

  if (!v.instapay_handle) f.instapay_handle = 'Required — refunds go back to this InstaPay handle.';
  else if (v.instapay_handle.length > 64) f.instapay_handle = 'InstaPay handle is capped at 64 characters.';

  if (v.reg_number.length > 64) f.reg_number = 'Registration number is capped at 64 characters.';

  /* A brand books space and pays for it, so it accepts on the same line a
     painter does — and its capacity statement carries more weight, since the
     person filling this in is binding a business rather than themselves. */
  if (b.accept !== true) {
    f.accept = 'Please accept the terms, the privacy policy and the refund policy.';
  }

  return { fields: Object.keys(f).length ? f : null, value: v };
}

function signupTx(v, now) {
  if (emailTaken.get(v.email)) return { taken: true };
  const id = Number(insBrand.run(
    v.business_name, v.email, hashPassword(v.password), now, now).lastInsertRowid);
  insProfile.run(id, v.business_name, v.category, v.description, v.website || null,
    JSON.stringify(v.socials), v.contact_name, v.phone, v.reg_number || null, v.instapay_handle);
  insAllowance.run(id, 0, 0);           // brands are exempt from the IP clock (§3)
  accept(id, { capacity: true }, now);  // in the same transaction as the account
  logEvent(`user:${id}`, 'brand-signup',
    { email: v.email, name: v.business_name, category: v.category }, now);
  return { id };
}

/* Creates the account and signs the caller straight into it — the
   application is the login, and asking somebody to retype a password they
   set nine fields ago is a way to lose them. Everything lands 'pending';
   Phase 3 is what turns that into an approval. */
function signup(ip, body, now) {
  const { fields, value } = validateSignup(body);
  if (fields) return { status: 400, error: 'invalid', fields };
  if (!take(ip, 'signups', S.IP_SIGNUP_CAP, now)) return { status: 429, ...CAPPED.signups };

  const made = tx(signupTx, value, now);
  if (made.taken) {
    return { status: 409, error: 'email-taken', fields: { email: 'That email already has an account — log in instead.' } };
  }
  const e = rowFor(made.id, now);
  return { e, cookie: sessionCookie(e, now) };
}

/* One message for every failure — unknown email, wrong password, banned
   account — so the form can't be used to find out who has an account. */
const LOGIN_FAILED = { status: 401, error: 'bad-credentials', message: 'Wrong email or password.' };

function login(body, now) {
  const b = body && typeof body === 'object' ? body : {};
  const email = text(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email || !password) return LOGIN_FAILED;

  const u = selByEmailAny.get(email);
  if (!u || u.status !== 'active') return LOGIN_FAILED;
  if (!verifyPassword(password, u.pass_hash)) return LOGIN_FAILED;

  const e = rowFor(u.id, now);
  e.epoch = u.token_epoch || 0;
  touch(e, now);
  logEvent(`user:${u.id}`, u.kind === 'brand' ? 'brand-login' : 'painter-login', { email }, now);
  return { e, cookie: sessionCookie(e, now) };
}

/* ── Signing in with Google (§3) ──────────────────────────────────
   Three cases, and which one it is decides everything:

   1. We have seen this Google account before — `sub` matches a row.
      That is the same person, whatever their address is today; a
      workspace admin can reassign an address, and `sub` never moves.

   2. We have not, but the verified address matches an account that
      already exists. Link them: they land on the account holding
      their pixels and their paint, which is what somebody expects
      and what stops a second account owning paint they paid for.

   3. Neither. Adopt the guest they are browsing as, exactly the way
      register() does — same id, same pixels, same history — so
      signing in does not cost somebody the wall they were painting
      a moment ago.

   A banned or erased account is refused here rather than adopted,
   because otherwise Google is a way around a ban. */

const selByGoogle = db.prepare(
  'SELECT id, kind, status, token_epoch FROM users WHERE google_sub = ?');
const selByEmailAny2 = db.prepare(
  'SELECT id, kind, status, token_epoch, google_sub FROM users WHERE email = ?');
const linkGoogle = db.prepare('UPDATE users SET google_sub = ? WHERE id = ?');
const adoptGoogle = db.prepare(
  "UPDATE users SET email = ?, google_sub = ? WHERE id = ? AND kind = 'guest' AND email IS NULL");

const GOOGLE_BLOCKED = {
  status: 403, error: 'account-closed',
  message: 'That account is closed. If you think that is wrong, get in touch.'
};

function fromGoogle(e, who, now = Date.now()) {
  const email = String(who.email || '').trim().toLowerCase();
  if (!email || !who.sub) return { status: 400, error: 'invalid' };

  const seen = selByGoogle.get(who.sub);
  if (seen) {
    if (seen.status !== 'active') return GOOGLE_BLOCKED;
    const row = rowFor(seen.id, now);
    row.epoch = seen.token_epoch || 0;
    touch(row, now);
    logEvent(`user:${seen.id}`, 'google-login', { email }, now);
    return { e: row, cookie: sessionCookie(row, now) };
  }

  const byEmail = selByEmailAny2.get(email);
  if (byEmail) {
    if (byEmail.status !== 'active') return GOOGLE_BLOCKED;
    /* the address is on an account that has never signed in with Google —
       this is the link, and it happens once */
    tx(() => {
      linkGoogle.run(who.sub, byEmail.id);
      accept(byEmail.id, { capacity: true }, now);
    });
    const row = rowFor(byEmail.id, now);
    row.epoch = byEmail.token_epoch || 0;
    touch(row, now);
    logEvent(`user:${byEmail.id}`, 'google-link', { email }, now);
    return { e: row, cookie: sessionCookie(row, now), linked: true };
  }

  /* Nobody yet. Grow the guest they already are, so the pixels they have
     painted in the last five minutes come with them. */
  if (e.kind === 'brand') {
    return { status: 409, error: 'already-registered',
      message: 'This is a brand account — it signs in through the brand door.' };
  }
  if (e.email) {
    return { status: 409, error: 'already-registered',
      message: 'This browser is already signed in. Log out first to use a different account.' };
  }

  try {
    const made = tx(() => {
      if (emailTaken.get(email)) return { taken: true };
      if (!adoptGoogle.run(email, who.sub, e.id).changes) return { taken: true };
      /* Signing in with Google is the acceptance: the button says so, and
         TERMS §4 wants it recorded rather than implied. */
      accept(e.id, { capacity: true }, now);
      logEvent(`user:${e.id}`, 'google-register', { email }, now);
      return { ok: true };
    });
    if (made.taken) {
      return { status: 409, error: 'email-taken',
        message: 'That address already has an account. Log out and sign in with it.' };
    }
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return { status: 409, error: 'email-taken',
        message: 'That address already has an account. Log out and sign in with it.' };
    }
    throw err;
  }

  e.email = email;
  return { e, cookie: sessionCookie(e, now), created: true };
}

/* ── Signing in with an emailed code ──────────────────────────────
   Brands, and anyone whose address we can prove they hold. The code
   itself is emailcode.js's problem; by the time this is called it has
   already been checked, so this is only "who does that address mean".

   No account is created here. A code proves somebody holds an
   address; it does not say they applied to be a brand, and the brand
   application is the thing that creates a brand. An address with
   nothing behind it gets the same answer as a wrong code — see the
   note in emailcode.js about not confirming who has an account. */

const selByEmailForCode = db.prepare(
  'SELECT id, kind, status, token_epoch FROM users WHERE email = ?');

function fromEmailCode(email, now = Date.now()) {
  const u = selByEmailForCode.get(String(email || '').trim().toLowerCase());
  if (!u) {
    return { status: 400, error: 'bad-code',
      fields: { code: 'That code is wrong or has expired. Ask for a new one.' } };
  }
  if (u.status !== 'active') return GOOGLE_BLOCKED;

  const row = rowFor(u.id, now);
  row.epoch = u.token_epoch || 0;
  touch(row, now);
  logEvent(`user:${u.id}`, u.kind === 'brand' ? 'brand-login' : 'painter-login', { email, via: 'code' }, now);
  return { e: row, cookie: sessionCookie(row, now) };
}

/* ── Painter accounts (§3, optional) ──────────────────────────────
   Registering doesn't create anyone: it attaches an email + password
   to the guest the caller already is, so the pixels, history, paint
   and handle they've accumulated become reachable from any device.
   The identity — id, kind, cookie — does not change. */
function register(e, body, now) {
  const b = body && typeof body === 'object' ? body : {};
  const email = text(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';

  const f = {};
  if (!email) f.email = 'We need an email address.';
  else if (email.length > 160 || !EMAIL_RE.test(email)) f.email = 'That does not look like an email address.';
  if (password.length < cfg.PASS_MIN) f.password = `Passwords need at least ${cfg.PASS_MIN} characters.`;
  else if (password.length > 200) f.password = 'That password is too long (200 characters max).';
  /* One tick covers both statements because they are made in one sentence on
     one line; splitting the record but not the sentence would be recording a
     distinction the person was never shown. */
  if (b.accept !== true) {
    f.accept = 'Please accept the terms, the privacy policy and the refund policy.';
  }
  if (Object.keys(f).length) return { status: 400, error: 'invalid', fields: f };

  if (e.kind === 'brand') {
    return { status: 409, error: 'already-registered', message: 'This is a brand account — it already signs in with email.' };
  }
  if (e.email) {
    return { status: 409, error: 'already-registered', message: 'This identity already has an account. Log out to make another.' };
  }

  const TAKEN = {
    status: 409, error: 'email-taken',
    fields: { email: 'That email already has an account — log in instead.' }
  };
  try {
    const r = tx(() => {
      if (emailTaken.get(email)) return { taken: true };
      setCredentials.run(email, hashPassword(password), e.id);
      /* in the same transaction as the credentials: an account that exists
         without a record of what it agreed to is the state this whole
         migration is meant to make unreachable */
      accept(e.id, { capacity: true }, now);
      logEvent(`user:${e.id}`, 'painter-register', { email }, now);
      return { ok: true };
    });
    if (r.taken) return TAKEN;
  } catch (err) {
    /* the unique index caught a race the polite check missed */
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return TAKEN;
    throw err;
  }

  e.email = email;                      // the cached row learns its new name
  return { e };
}

/* ── Brand standing ───────────────────────────────────────────── */

/* Read through to the table every time: a moderator's decision has to
   take effect on the applicant's next click, not on their next session. */
function brandStatus(e) {
  if (!e || e.kind !== 'brand') return null;
  const row = selProfile.get(e.id);
  return row ? row.status : 'pending';
}

/* Guarded the same way a submission decision is (§4.5): conditional on the
   status it is moving away from, so a double-tapped Approve is one
   transition and the second tap can be told who beat it. `revoke` is the
   admin panel's (§7.2) — an approved brand that stops being one, which
   blocks new bookings and leaves what is already on the wall alone. */
const brandMoves = {
  approved: db.prepare(
    `UPDATE brand_profiles SET status = 'approved', reviewed_by = ?, reviewed_at = ?, reject_reason = NULL
       WHERE user_id = ? AND status = 'pending'`),
  rejected: db.prepare(
    `UPDATE brand_profiles SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reject_reason = ?
       WHERE user_id = ? AND status = 'pending'`),
  revoked: db.prepare(
    `UPDATE brand_profiles SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reject_reason = ?
       WHERE user_id = ? AND status = 'approved'`)
};
const selBrandStatus = db.prepare(
  'SELECT status, reviewed_by FROM brand_profiles WHERE user_id = ?');

function decideBrand(userId, status, actor, reason, now = Date.now()) {
  const stmt = brandMoves[status];
  if (!stmt) return { ok: false, error: 'unknown-status' };
  const before = selBrandStatus.get(userId);
  if (!before) return { ok: false, missing: true };

  const changed = status === 'rejected' || status === 'revoked'
    ? stmt.run(actor, now, reason || null, userId).changes
    : stmt.run(actor, now, userId).changes;
  if (!changed) return { ok: false, already: before.status, by: before.reviewed_by || null };

  logEvent(actor, 'brand-' + status, { user: userId, reason: reason || null }, now);
  return { ok: true, userId, status: status === 'revoked' ? 'rejected' : status };
}

/* These said "we will email you" and "reply to the email we sent". There is
   no SMTP client and no mail API anywhere in server/ or tools/, so both were
   promises about a channel that does not exist — and the second one told
   somebody to reply to a message they never received, which is worse than
   silence because it looks like the failure is at their end.

   The notifications feed does exist and already carries brand decisions, so
   that is where they are pointed. */
const GATE = {
  'not-brand': 'Booking a logo spot needs a brand account — it takes a minute to apply.',
  pending: 'Your brand application is still being reviewed. The decision appears in your notifications.',
  rejected: 'This brand account was not approved. The reason is in your notifications, and you can write to us if you think it is wrong.'
};

/* ── Display name ─────────────────────────────────────────────────
   The handle is not private: it is what the wall shows anyone who taps
   your pixels. That makes a rename the one piece of free text a visitor
   can put in front of other visitors, and this product moderates
   everything else before it is public — so it is fenced three ways.

   Accounts only, because a name with no email behind it is a name with
   nobody behind it. A strict character whitelist, so nothing that could
   be read as markup ever reaches another person's page — the tooltip
   builds with innerHTML, and a rule about escaping downstream is a rule
   somebody eventually forgets. And no borrowing a brand's name, because
   a shop's customers should not have to tell two of them apart. */
const NAME_RE = /^[\p{L}\p{N} ._'-]+$/u;
const NAME_MIN = 2, NAME_MAX = 24;
const brandNamed = db.prepare(
  "SELECT 1 FROM users WHERE kind = 'brand' AND lower(handle) = lower(?)");
const setHandleFor = db.prepare('UPDATE users SET handle = ? WHERE id = ?');

function rename(e, body, now) {
  if (!e || !e.email) {
    return { status: 403, error: 'account-required', message: PAINT_GATE.message };
  }
  if (e.kind === 'brand') {
    return {
      status: 403, error: 'brand-name-fixed',
      message: 'A brand shows the business name it was approved under. Reply to the team if it needs changing.'
    };
  }
  /* collapse runs of whitespace so " a   b " and "a b" are one name, and
     a wall of spaces is not a name at all */
  const name = text((body && body.name) || '').replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { status: 400, error: 'invalid',
      fields: { name: `A name is between ${NAME_MIN} and ${NAME_MAX} characters.` } };
  }
  if (!NAME_RE.test(name)) {
    return { status: 400, error: 'invalid',
      fields: { name: 'Letters, numbers, spaces and . _ - \' only.' } };
  }
  if (brandNamed.get(name)) {
    return { status: 409, error: 'name-taken',
      fields: { name: 'A brand already paints under that name.' } };
  }

  const was = e.handle;
  if (name === was) return { e, unchanged: true };
  tx(() => {
    setHandleFor.run(name, e.id);
    logEvent(`user:${e.id}`, 'rename', { from: was, to: name }, now);
  });
  e.handle = name;
  return { e, was };
}

/* Paint is money, and money needs somewhere to live that survives a
   cleared cookie. A guest identity is one browser: buy paint on it and the
   balance is one "clear browsing data" away from being gone, with a real
   InstaPay transfer behind it. So the shop is for accounts — the upgrade
   costs an email and a password and keeps every pixel already painted. */
/* ── What they agreed to ──────────────────────────────────────────
   TERMS §4 describes a tick and a recorded version, PRIVACY §11 an age
   confirmation. Both are recorded here rather than trusted from the
   request: a gate that reads the checkbox the client just sent is not a
   gate, it is a suggestion. The stored row is what the buying routes
   check, so an order placed by something that never rendered the form
   is refused the same as one placed by somebody who unticked the box.

   Written even when a value is already there. Re-accepting a newer
   version has to move terms_version, and the timestamp of the most
   recent acceptance is the one that matters; the older ones live in the
   event journal, which is append-only and is where the history belongs. */

const setAccept = db.prepare(
  'UPDATE users SET terms_version = ?, terms_at = ? WHERE id = ?');
const setCapacity = db.prepare(
  'UPDATE users SET capacity_confirmed_at = ? WHERE id = ? AND capacity_confirmed_at IS NULL');
const selAccept = db.prepare(
  'SELECT terms_version, terms_at, capacity_confirmed_at FROM users WHERE id = ?');

/* `capacity` is only ever set true, never cleared: it is a statement about
   the person, and somebody does not stop being an adult. Withdrawing it is
   closing the account, which is a different route. */
function accept(userId, { capacity } = {}, now = Date.now()) {
  const version = cfg.TERMS_VERSION;
  setAccept.run(version, now, userId);
  if (capacity) setCapacity.run(now, userId);
  logEvent(`user:${userId}`, 'accept-terms', { version, capacity: !!capacity }, now);
  return { version, at: now };
}

const acceptanceOf = userId => selAccept.get(userId) || {};

const NEEDS_ACCEPT = {
  error: 'terms-required',
  message: 'Please read and accept the terms and the refund policy before paying. ' +
    'They are linked from MORE.'
};
const NEEDS_CAPACITY = {
  error: 'capacity-required',
  message: 'Before buying, please confirm you are old enough to enter a contract ' +
    'and are paying for yourself.'
};
const STALE_ACCEPT = {
  error: 'terms-changed',
  message: 'The terms have changed since you last agreed to them. ' +
    'Please read them and accept the new version before buying.'
};

/* null when the caller may buy; otherwise the 403 body. Checked in this
   order because it is the order somebody fixes them in. */
function buyGate(e) {
  const a = acceptanceOf(e.id);
  if (!a.terms_at || !a.terms_version) return NEEDS_ACCEPT;
  /* Publishing a new wording has to put the tick back in front of people.
     Without this the version was decoration: somebody who accepted 1.0 kept
     buying after 1.1 went up, and createOrder stamped their order with 1.1 —
     recording an agreement to a document they had never been shown, which is
     worse than recording nothing at all. The client checks this too; the
     client is not what makes it true. */
  if (a.terms_version !== cfg.TERMS_VERSION) return STALE_ACCEPT;
  if (!a.capacity_confirmed_at) return NEEDS_CAPACITY;
  return null;
}

const PAINT_GATE = {
  error: 'account-required',
  message: 'Paint is kept on your account, so making one is the first step — ' +
    'it takes a moment and everything you have painted stays exactly as it is.'
};
function paintGate(e) {
  if (!e || !e.email) return PAINT_GATE;
  return buyGate(e);
}

/* null when the caller may book; otherwise the 403 body, with a reason
   code the client renders as a screen rather than a toast. */
function bookGate(e) {
  const status = brandStatus(e);
  const reason = status === 'approved' ? null : (status || 'not-brand');
  if (reason) return { error: 'brand-required', reason, message: GATE[reason] || GATE['not-brand'] };
  /* an approved brand still has to have agreed to something */
  return buyGate(e);
}

/* what the snapshot's meta.me carries, and the spine of /api/me */
/* Every answer that says who the caller is says the same things — the wall
   snapshot included. It used to carry only kind/handle/brandStatus, so
   logging in and then loading the wall (which login does, to pick up whose
   pixels are whose) overwrote the just-signed-in account with a version
   that had no email on it: the welcome toast was right, and by the time
   you opened your profile you were a guest again who could not buy paint. */
function meta(e) {
  const out = { kind: e.kind, handle: e.handle, brandStatus: brandStatus(e) };
  if (e.email) out.email = e.email;
  /* a guest with an email is a painter account — same identity, reachable
     from other devices. The client renders "create account" vs "signed in"
     off this bit rather than sniffing for the email field. */
  if (e.kind === 'guest') out.registered = !!e.email;
  /* What they have agreed to, so the client knows whether to put the tick in
     front of them again. The version is included because an account that
     accepted 1.0 has to be asked again once 1.1 is published — "they agreed"
     with no "to what" is the thing TERMS §4 exists to avoid. */
  const a = acceptanceOf(e.id);
  out.accepted = a.terms_at ? { version: a.terms_version, at: a.terms_at } : null;
  out.capacity = !!a.capacity_confirmed_at;
  out.termsVersion = cfg.TERMS_VERSION;
  return out;
}
/* the same identity, plus what they have left to paint with */
function me(e, now) {
  const out = meta(e);
  out.allowance = allowanceOf(e, now);
  return out;
}

/* ── Housekeeping ─────────────────────────────────────────────── */

/* the monthly wipe hands everyone their free pixels back. Runs inside the
   reset transaction, so again: no transaction of its own. */
function resetAllowances() {
  clearAllowances.run();
  clearIpAllowances.run();
  for (const e of cache.values()) { e.used = 0; e.refillAt = 0; }
}

function refill(e) {
  e.used = 0; e.refillAt = 0;
  tx(writeAllowance, e);
  return e;
}

/* the paint shop. Reads the row back so a concurrent write can't be lost. */
function creditPaint(e, n) {
  tx(() => {
    bumpPaint.run(n, e.id);
    e.paint = readAllowance.get(e.id).paint;
  });
  return e;
}

/* Same credit, by id and without a transaction of its own: payments.js calls
   it from inside the one that marks the money verified, so the balance and
   the verification commit together or neither does (§6.3). */
function creditPaintRaw(userId, n) {
  bumpPaint.run(n, userId);
  const cached = cache.get(userId);
  if (cached) cached.paint = readAllowance.get(userId).paint;
  return n;
}

/* Drop a cached row. The cache is a pure projection, so this costs one
   SELECT next time and is the honest way to say "something changed
   underneath you" from a module that does not hold the entry. */
const forget = userId => cache.delete(userId);

/* An idle row costs a Map entry and nothing else; SQLite keeps the truth. */
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) {
    if (e.refillAt && now >= e.refillAt) { e.used = 0; e.refillAt = 0; tx(writeAllowance, e); }
    if (now - e.seen > cfg.IDLE_DROP) cache.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  ipv6Prefix, callerKey, handleFor,
  cache, rowFor, allowanceOf, writeAllowance, touch, refill,
  creditPaint, creditPaintRaw, forget, resetAllowances,
  ipAllowance, syncIpAllowance,
  /* cookies + sessions */
  COOKIE, cookieValue, sessionCookie, clearCookie, verifyCookie, readCookie, resolve,
  /* caps */
  dayKey, ipCounts, takeIp: take, takeClaim, CAPPED,
  /* accounts */
  hashPassword, verifyPassword, validateSignup, signup, login, register,
  brandStatus, decideBrand, bookGate, paintGate, rename, meta, me,
  /* what they agreed to */
  accept, acceptanceOf, buyGate,
  /* the two doors that replace handing out passwords */
  fromGoogle, fromEmailCode
};
