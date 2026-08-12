# The Reel Pixels — Production Plan

**Goal:** take the current prototype (single-file Node server + vanilla JS client) to a
production-ready pixel wall where:

- All payments go through **InstaPay** (`https://ipn.eg/S/mohaby/instapay/0Nif30`, handle `mohaby@instapay`).
- **Every** pixel placement — free 20s and paid/brand — is pre-moderated in a **private Telegram group**.
  A submission only appears on the public wall after a team member taps **Approve**; **Reject** on a paid
  submission triggers a tracked manual refund.
- The Telegram card shows the drawn pixels **zoomed out with adjacent context** (anti-abuse).
- The site shows each user a **history tab**: pending / approved / rejected (+ refunded) per submission, updating live.
- **Guests** paint without signup (cookie identity + IP restrictions). **Brands** must sign up with substantial
  business data before booking.
- An **admin panel** (web, owner-only, at `/admin`) with **full access to everything**: moderation parity
  with Telegram, takedowns of already-live pixels, user/brand/payment management, runtime config
  (prices, caps, maintenance mode), audit browser, and system operations (§7).
- Every pixel is durably stored, backed up, race-condition safe.

This plan is written to be executed top-to-bottom by a coding agent. Each phase has explicit
deliverables and acceptance criteria. Read the whole plan before starting Phase 0.

---

## 0. Current state (verified 2026-08-12, commit `b54b042`)

| Piece | Reality |
|---|---|
| Server | [server.js](server.js) — dependency-free Node `http` server. Owns the wall (two `Map`s: `live`, `reserved`), per-IP allowance ledger, monthly cycle reset, SSE stream, binary wire envelope (9-byte pixel entries). |
| Persistence | Files: `.wall.bin` + `.allowance.json` in `STATE_DIR` (Vercel: `os.tmpdir()` → **evaporates on cold start**). `seed.bin` is the committed fallback artwork. |
| Client | [app.js](app.js) (1,652 lines) + [index.html](index.html) + [styles.css](styles.css). Canvas renderer, palette, brush, brand pre-order flow with logo crop/pixelate, checkout modals — **all payments are mocked** (`/api/paint` credits instantly; brand "PAY & BOOK" books instantly). |
| Identity | None. Caller = IP (IPv6 grouped to /64). Display handle derived from IP hash. |
| Moderation | None. Claims go live immediately. |
| Deploy | Vercel: [api/[...path].js](api/[...path].js) catch-all → `server.js` handler; static via CDN. SSE survives serverless kills by client auto-refetch. |
| Prices in code | `PRICE_PAINT=10`, `PRICE_COMPANY=10` EGP/px; packs `25→225, 100→800, 500→3500` EGP; `CAP=20` free px; refill 30 min; wall 1000×1000; wipes on the 1st. |
| Git | `origin` = The-Reel-Recipe/the_reel_pixels (fetch), `fork` = MohabYasser2/the_reel_pixels (push default). **All work happens on the fork.** |

### Hard external constraints (accept these, don't fight them)

1. **InstaPay has no public merchant API.** No webhooks, no server-side confirmation, no programmatic
   refunds for a personal `@instapay` handle. Payment verification is therefore *human*: the payer sends
   money via the link/QR, submits the transaction reference, and a team member confirms receipt inside
   their own banking/InstaPay app before tapping Verify in Telegram. This is not a weakness to engineer
   around — it merges naturally with the required human approval step. Refunds are likewise manual
   InstaPay transfers, tracked to completion by the system.
2. **Telegram is the day-to-day moderation surface; the `/admin` panel (§7) is the full-control surface
   and fallback.** Both drive the *same* state machine — a decision made in either place edits the
   Telegram card and fires the same SSE/history updates. If Telegram is down, submissions queue safely
   (outbox with retry) and moderation continues from the panel. Nothing is ever lost or auto-approved.
3. **Pre-moderation implies latency.** Pixels are *reserved instantly* (first-come-wins is decided at submit
   time, race-safe) but only *visible publicly* after approval. The submitter sees their own pending pixels
   as a shimmering overlay immediately.

---

## 1. Target architecture

```
                      ┌──────────────────────────────────────────────┐
                      │  VPS (single persistent Node process)        │
 Browser ── HTTPS ──► │  Caddy (TLS, gzip) ──► node server           │
   │  SSE ◄────────── │    ├─ http routes (/api/*) + static          │
   │                  │    ├─ wall cache (in-memory, rebuilt from DB)│
   │                  │    ├─ SQLite (WAL)  ◄── litestream ──► R2/S3 │
   │                  │    ├─ moderation state machine               │
   │                  │    ├─ telegram outbox worker (retry queue)   │
   │                  │    └─ POST /tg/webhook/<secret>  ◄─────────┐ │
   └─ InstaPay app    └──────────────────────────────────────────── │ ┘
      (user pays there;                                             │
       no integration)                Telegram Bot API ─────────────┘
                                      (private moderation group)
```

**Hosting decision: one persistent Node process on a small VPS** (Hetzner CX22 / DigitalOcean droplet,
~$5–8/mo), Caddy in front for TLS. Rationale:

- SSE, an in-process Telegram outbox worker, cron-like cycle reset, and an in-memory wall cache all want
  a long-lived process. Vercel serverless fights every one of these (the current code contains multiple
  workarounds for it already).
- A single process + synchronous SQLite transactions gives the simplest correct concurrency story
  (see §4). Race conditions are solved by construction instead of distributed coordination.
- Acceptable alternative if the user prefers zero server admin: **Fly.io or Railway** with a persistent
  volume — identical code, still one instance. **Do not** keep the API on Vercel; retire
  `api/[...path].js` + `vercel.json` at cutover (Phase 8), or leave Vercel serving a static
  "we moved" redirect.

**Dependency policy** (repo is proudly dependency-free today; keep it minimal):

| Dep | Why | Alternative rejected |
|---|---|---|
| `better-sqlite3` | Synchronous transactions = trivially correct critical sections; WAL; fast | `node:sqlite` (still experimental-ish on 18/20; fine to use instead if the deploy Node is ≥22 and it proves stable — agent's choice) |
| `pngjs` | Pure-JS PNG encode/decode for Telegram preview renders and payment screenshots re-encode | `sharp` (native, heavy, unneeded — wall pixels are flat colors) |
| *(nothing else)* | Telegram Bot API via built-in `fetch`; password hashing via `node:crypto.scrypt`; sessions via HMAC (`node:crypto`); QR not needed server-side | express/fastify (hand-rolled http is established house style), telegram libs, ORMs |

**Module split** (server.js is 580 lines and about to triple; split it, keep the style):

```
server/
  index.js        boot: config, db open, wall cache load, http listen, workers start
  config.js       env parsing + validation, fail-fast on missing prod secrets
  db.js           better-sqlite3 open, PRAGMAs, migrations runner (migrations/*.sql)
  wall.js         in-memory wall cache + binary envelope codec + snapshot/delta (moved from server.js)
  identity.js     guest cookies, brand signup/login, sessions, allowance
  submissions.js  claim/book → pending reservation → approve/reject state machine
  payments.js     orders, codes, reference capture, verify/refund state machine
  telegram.js     outbox queue worker, sendPhoto/editMessage, webhook handler, callback routing
  render.js       pngjs composer: context crop + locator thumbnail for moderation cards
  admin.js        admin auth (scrypt+TOTP), /api/admin/* routes, runtime config, takedowns
  http.js         request router, static files, SSE hub, rate limiting, body/cookie helpers
admin/
  index.html + admin.js + admin.css   the panel UI (vanilla, house style; served behind auth)
migrations/
  001_init.sql ...
tools/
  export-wall-png.js   (archive snapshot; also used at cycle reset)
  restore-drill.md
test/
  *.test.js       (node:test, no framework)
```

`server.js` stays as a thin compatibility entry (`require('./server/index.js')`) so `npm run dev`
and `.claude/launch.json` keep working.

---

## 2. Data model (SQLite, WAL mode)

All timestamps ms-since-epoch integers. All money in **integer piasters** (EGP×100) to avoid float.

```sql
-- 001_init.sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest','brand')),
  handle      TEXT NOT NULL,                -- "Pixel fan #4821" or brand display name
  email       TEXT UNIQUE,                  -- brands only
  pass_hash   TEXT,                         -- scrypt: salt:N:r:p:hash, brands only
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned'))
);

CREATE TABLE brand_profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  business_name  TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT NOT NULL,             -- min 200 chars, enforced app-side
  website        TEXT,
  socials        TEXT,                      -- JSON array of urls
  contact_name   TEXT NOT NULL,
  phone          TEXT NOT NULL,
  reg_number     TEXT,                      -- commercial reg / tax id, optional
  instapay_handle TEXT,                     -- where refunds go back to
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  reviewed_by    TEXT, reviewed_at INTEGER, reject_reason TEXT
);

CREATE TABLE allowances (                    -- replaces .allowance.json, keyed by USER not IP
  user_id   INTEGER PRIMARY KEY REFERENCES users(id),
  used      INTEGER NOT NULL DEFAULT 0,
  refill_at INTEGER NOT NULL DEFAULT 0,
  paint     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ip_guests (                     -- cookie-clearing abuse guard
  ip         TEXT NOT NULL,                  -- v4 whole / v6 /64, same normalization as today
  day        TEXT NOT NULL,                  -- YYYY-MM-DD
  guests     INTEGER NOT NULL DEFAULT 0,     -- new guest identities minted from this ip today
  claims     INTEGER NOT NULL DEFAULT 0,     -- claim submissions from this ip today
  PRIMARY KEY (ip, day)
);

CREATE TABLE submissions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('free','paint','brand')),
  cycle        INTEGER NOT NULL,             -- cycleStart the pixels belong to
  layer        TEXT NOT NULL CHECK (layer IN ('live','next')),
  px_count     INTEGER NOT NULL,
  bbox         TEXT NOT NULL,                -- JSON [x0,y0,x1,y1]
  pixels       BLOB NOT NULL,                -- packed [u32 idx·u8 r·u8 g·u8 b] × n
  brand_name   TEXT, brand_url TEXT, brand_cta TEXT,
  payment_id   INTEGER REFERENCES payments(id),   -- NULL for 'free'
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected','expired')),
  tg_msg_id    INTEGER,                      -- moderation card, for edit-in-place
  preview_path TEXT,                         -- rendered card PNG (kept for audit)
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER, decided_by TEXT,     -- telegram username/id of moderator
  reject_reason TEXT
);
CREATE INDEX submissions_user ON submissions(user_id, created_at DESC);
CREATE INDEX submissions_status ON submissions(status) WHERE status = 'pending';

-- THE race-condition backstop. One row per cell per cycle per layer, no exceptions.
CREATE TABLE cells (
  cycle  INTEGER NOT NULL,
  layer  TEXT    NOT NULL CHECK (layer IN ('live','next')),
  idx    INTEGER NOT NULL,                   -- 0 .. 999999
  color  INTEGER NOT NULL,                   -- 0xRRGGBB
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  state  TEXT NOT NULL CHECK (state IN ('pending','live')),
  PRIMARY KEY (cycle, layer, idx)
) WITHOUT ROWID;

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('paint_pack','brand_booking')),
  pack         INTEGER,                      -- 25/100/500 for paint_pack
  amount       INTEGER NOT NULL,             -- piasters
  code         TEXT NOT NULL UNIQUE,         -- human short code e.g. 'TRR-7F3K' (payer puts it in the transfer note)
  instapay_ref TEXT,                         -- transaction reference the payer reports
  payer_handle TEXT,                         -- payer's instapay handle/phone (for refunds)
  screenshot_path TEXT,
  status       TEXT NOT NULL DEFAULT 'awaiting_transfer' CHECK (status IN (
                 'awaiting_transfer',        -- order created, instructions shown
                 'submitted',                -- payer entered ref (± screenshot)
                 'verified',                 -- team confirmed money arrived
                 'rejected',                 -- not received / mismatch → order void
                 'refund_due',               -- verified but submission rejected → owe money back
                 'refunded',                 -- team sent it back and confirmed
                 'expired')),                -- hold lapsed before payment
  hold_expires INTEGER,                      -- brand bookings: reservation TTL
  tg_msg_id    INTEGER,
  created_at   INTEGER NOT NULL,
  verified_at INTEGER, verified_by TEXT,
  refunded_at INTEGER, refunded_by TEXT
);

CREATE TABLE tg_outbox (                     -- Telegram never blocks or loses a submission
  id       INTEGER PRIMARY KEY,
  method   TEXT NOT NULL,                    -- sendPhoto / editMessageCaption / ...
  payload  TEXT NOT NULL,                    -- JSON; photo paths referenced, not inlined
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (                        -- append-only audit journal (also the rebuild source)
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,                     -- 'user:12' / 'tg:987654 (name)' / 'system'
  action  TEXT NOT NULL,                     -- 'claim','approve','reject','verify','refund','reset',...
  payload TEXT NOT NULL                      -- JSON
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- current cycle, schema version, etc.

CREATE TABLE admins (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,                 -- scrypt, same format as brands
  totp_secret TEXT NOT NULL,                 -- RFC 6238, base32; 2FA is mandatory
  token_epoch INTEGER NOT NULL DEFAULT 0,    -- bump = revoke all sessions
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);

CREATE TABLE config (                        -- runtime-editable settings (admin panel), hot-applied
  k TEXT PRIMARY KEY,                        -- 'price_paint','price_company','packs','cap','refill_ms',
                                             -- 'ip_guest_cap','ip_claim_cap','hold_ttl','maintenance'
  v TEXT NOT NULL,                           -- JSON value
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
```

Code reads prices/caps through a `config` accessor with the env/code values as defaults — a row in
`config` overrides without redeploy, every change audited in `events`.

**Wall cache invariant:** the in-memory maps (kept — the client wire format doesn't change) are a pure
projection of `cells`. On boot: `SELECT` all cells for the current cycle → rebuild maps. Public snapshot
= `state='live'` only; a submitter's personal snapshot additionally includes their own `pending` cells
(sent in the meta as a separate small list, rendered client-side as the pending overlay).

**Migration from prototype state:** one-off script imports `seed.bin` (or live `.wall.bin`) into `cells`
as `state='live'` under a synthetic `system` user + one synthetic approved submission per owner, so the
current artwork survives. `.allowance.json` is discarded (IP-keyed; incompatible — acceptable, it's a 30-minute allowance).

---

## 3. Identity & accounts

### Guests (no signup)
- First request without a valid cookie mints a guest: `users` row + `uid` cookie —
  `HttpOnly; Secure; SameSite=Lax; Max-Age=1y`, value `uid.exp.hmac(SESSION_SECRET)`. Stateless verify.
- **Cookies save the pixels** (requirement): history/allowance ride on the cookie identity, so a
  returning guest sees their history even from a new IP.
- **IP restriction** (requirement): keep today's normalization (v4 whole, v6→/64). Enforced via `ip_guests`:
  max **5 new guest identities per IP per day**, max **40 claim submissions per IP per day**, plus the
  existing 20-px/30-min allowance per identity. Tightenable via env without deploy.
- Anti-abuse note: a cookie-wiping visitor burns the 5-identities budget, then that IP is claim-blocked
  for the day. VPNs can rotate IPs — accepted residual risk; moderation is the real gate since **nothing
  shows publicly unapproved anyway**.

### Brands
- Signup form (modal): email + password (min 10 chars) + **all `brand_profiles` fields**; description
  min 200 chars; website or ≥1 social required; instapay_handle required (refund destination).
- `scrypt` hash (node:crypto), constant-time compare. Login sets a server-side session row? No —
  same HMAC cookie with `kind=brand` claim + a `sessions` nonce table only if revocation is wanted;
  v1: HMAC cookie with 30-day expiry + "log out everywhere" = bump per-user `token_epoch` column.
- New application → **Telegram card** ("🏢 NEW BRAND APPLICATION" + all fields) → Approve/Reject.
  Only `status='approved'` brands can open the booking flow (server-enforced on `/api/book`).
- Brands are exempt from the free-pixel IP caps but every booking still goes through moderation + payment.

---

## 4. Race conditions — the concurrency contract

1. **Single writer process.** All mutations run on the one Node event loop.
2. **Synchronous transactions.** Every mutation is one `better-sqlite3` transaction (synchronous, no
   interleaving possible). `claim`, `book`, `approve`, `verify`, `reset` are each single transactions.
3. **DB constraint as backstop.** `cells` PK `(cycle,layer,idx)` makes double-selling impossible even if
   app logic regresses. Claim flow: `INSERT OR IGNORE` each cell → cells that didn't insert are reported
   back as `occupied` (client already handles partial placement today).
4. **Reservation at submit time.** Pending submissions *hold* their cells. Reject/expire deletes the rows
   (cells free instantly, SSE `sync` if big). This means no two submissions ever contend at approval time.
5. **Idempotent moderation.** Telegram delivers callback queries at-least-once and moderators double-tap.
   `approve/reject/verify/refund` transitions guard on current status (`UPDATE ... WHERE status='pending'`,
   check `changes()===1`); a second tap edits nothing and answers "already decided by X".
6. **Allowance under concurrency.** `used`/`paint` updated inside the same claim transaction that inserts
   cells — a burst of parallel claims from one user can't overspend.
7. **Cycle reset** is a transaction: promote `next→live` cells, expire stale pendings (policy below),
   reset allowances, bump `meta.cycle`, snapshot wall PNG to `archive/YYYY-MM.png` **before** the wipe.
8. Keep `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000; foreign_keys=ON`.

**Pending-at-reset policy** (make explicit, agent must implement exactly):
- `free` pending at reset → `expired` (harmless; the wall they targeted is gone).
- `paint`/`brand` pending with `payments.status='verified'` at reset → auto `rejected`,
  payment → `refund_due` (never keep verified money for undelivered pixels).
- `brand` bookings target `layer='next'` so approval before reset is the normal case; the reset job
  posts a Telegram warning digest **48h and 6h before** month end listing unresolved cards.

---

## 5. Moderation pipeline (Telegram)

### Setup (user does once, Phase 4 start)
1. BotFather → create bot → token in env `TG_BOT_TOKEN`. Disable privacy mode or make bot group admin.
2. Create private group ("Reel Pixels — Moderation"), add the bot, add teammates. Only the owner invites (Telegram group setting; outside code scope).
3. `node tools/tg-setup.js` helper: prints the group `chat_id` (from `getUpdates`) and registers the
   webhook `https://<domain>/api/tg/webhook` with `secret_token=TG_WEBHOOK_SECRET`.
4. Env `TG_CHAT_ID`, `TG_MOD_IDS` (comma-separated Telegram user IDs allowed to press buttons —
   defense-in-depth beyond group membership).

### Card contents (render.js, pngjs — no native deps)
One composite PNG per submission:
- **Panel A (context view):** submission bbox expanded by max(2×bbox, 64px) on each side, clamped to the
  wall; existing approved pixels drawn normally, **new pixels at full color with a 1px magenta outline
  ring** around the group; unpainted cells as light checkerboard. Scaled to ≤1024px (integer nearest-neighbor).
- **Panel B (locator):** whole 1000×1000 wall scaled to 256px with a red rectangle where the submission sits.
- Caption (Markdown):
  `🟩 FREE CLAIM #s142 · Pixel fan #4821 · 17 px · guest since 3d · 12 prior approved / 0 rejected`
  or `💰 PAINT #s143 · … · 240 px · payment TRR-7F3K VERIFIED (2,400 EGP)`
  or `🏢 BRAND #s144 · "NILE SODA CO." → nilesoda.com · 4,180 px · 41,800 EGP · payment TRR-9Q2M SUBMITTED ref 5011…`
- Inline keyboard by state:
  - submission pending: `✅ Approve` `❌ Reject`
  - payment submitted: `💵 Money received` `🚫 Not received`
  - after reject of a verified payment: `💸 Refund sent` (with payer handle in caption)
- Decisions **edit the same message** (strikethrough keyboard → outcome line: `✅ Approved by @sara · 14:02`).

### Flow per submission type
- **free claim:** claim tx reserves cells → card queued → approve flips cells `pending→live`, SSE paint
  event; reject deletes cells, SSE removal (only the submitter was seeing them anyway) + history update.
- **paint claim:** same, but claim is only accepted if the user has `paint` balance (bought previously —
  payment verification happens at pack purchase, not per claim). Approve/reject as free; reject **refunds
  the paint balance**, not money (money↔paint conversion already happened; no cash refund unless the
  user requests it — out of scope, note in ops runbook).
- **brand booking:** two gates in one card thread — payment verify then content approve. Cells held with
  `hold_expires = now+48h` while `awaiting_transfer/submitted`; hold expiry frees cells + voids order +
  edits card. Approve requires `payments.status='verified'` (button answers "verify payment first" otherwise).
- **brand application:** text-only card (no pixels yet).

### Reliability
- All sends go through `tg_outbox` (INSERT in the same tx as the state change). Worker drains serially,
  exponential backoff (1s→2s→…→5min cap), respects 429 `retry_after`. Telegram down for an hour = cards
  arrive an hour late, zero loss.
- Webhook handler: verify `X-Telegram-Bot-Api-Secret-Token`, verify `callback_query.from.id ∈ TG_MOD_IDS`,
  route by callback data `{a:'approve',sid:142}` (≤64 bytes, fits), always `answerCallbackQuery`.
- Every decision → `events` row with the moderator's Telegram identity.
- Local dev: `TG_MODE=poll` uses `getUpdates` long-polling instead of a webhook (no tunnel needed);
  `TG_MODE=off` logs cards to console and auto-approves after 2s (keeps dev flow usable — replaces `/api/dev/*`'s role for this).

---

## 6. Payments (InstaPay, human-verified)

### Paint packs (guest or brand)
1. `POST /api/paint/order {pack}` → payment row `awaiting_transfer`, unique code `TRR-XXXX`
   (4 chars from an unambiguous alphabet, uniqueness-checked). Response drives the modal:
   - amount, the **InstaPay link** (`INSTAPAY_URL` env = `https://ipn.eg/S/mohaby/instapay/0Nif30`),
     the **official InstaPay QR** (static asset — **ASSET NEEDED FROM USER:** save the QR PNG they have
     to `assets/instapay-qr.png`; do not regenerate it, the official QR encodes an IPN payload),
     and the instruction: *"put the code TRR-XXXX in the transfer note"*.
2. User pays inside their banking app, returns, submits `POST /api/payments/:id/proof`
   `{instapay_ref, payer_handle}` + optional screenshot (multipart, ≤5MB, jpeg/png/webp, magic-byte
   sniffed, re-encoded via pngjs, stored `data/uploads/`). Status → `submitted`, Telegram card queued
   (screenshot attached as the photo when present).
3. Moderator checks their InstaPay app for the amount + code/ref → `💵 Money received` → `verified`
   → paint credited to `allowances.paint` (same tx) → SSE nudge → user sees balance update.
   `🚫 Not received` → `rejected`, order void, history shows it.
4. Unpaid orders auto-`expired` after 48h (sweeper).

### Brand bookings
- The existing client flow (logo → crop → pixelate → place ghost → confirm) stays. The confirm step
  changes: `POST /api/book` now requires an approved brand session, creates submission (cells held,
  `layer='next'`) + payment row, and the modal becomes the InstaPay instruction screen (same as packs;
  amount = px × `PRICE_COMPANY`). Payment methods radio group in [index.html](index.html) (card/vodafone/
  fawry/insta) is replaced by InstaPay-only.
- Timeline: pay + get verified + get approved before the wall reset → logo goes live at reset
  (existing promote mechanic, now DB-backed).

### Refunds (manual, tracked, never silent)
- Any rejection of a submission whose payment is `verified` flips payment → `refund_due` and posts/edits
  the card with `💸 Refund sent` + payer handle + amount. The card **re-posts a reminder every 24h** while
  `refund_due` (outbox job) so a refund can't be forgotten. Moderator taps after sending the money in
  their app → `refunded` (+who/when in events). User history shows `REJECTED → REFUNDED ✓`.

### Pricing
Keep code values (10 EGP/px paint & brand, packs 225/800/3,500). **Confirm with user before launch** —
memory notes an older 2 EGP figure for free-tier-adjacent pricing; the site copy currently says 10 everywhere.

---

## 7. Admin panel — full access to everything

A minimal-dependency web panel at `/admin` (vanilla HTML/JS/CSS, same house style — server-rendered
shell + `fetch` against `/api/admin/*`). It is the **superset** of the Telegram surface: everything
Telegram can do plus everything it can't. Both surfaces call the same `submissions.js` / `payments.js`
transitions, so idempotency guards (§4.5) apply identically, and a panel decision edits the
corresponding Telegram card ("✅ Approved via admin panel by mohab · 14:02").

### 7.1 Access & session security
- Admin accounts live in `admins` — **created only via CLI** (`node tools/add-admin.js <username>`:
  generates a temp password + TOTP secret, prints the `otpauth://` URL + ASCII QR for the authenticator
  app). No signup route exists.
- Login = username + password (scrypt) + **mandatory TOTP code** (RFC 6238 implemented on
  `node:crypto` — ~20 lines, no dependency; ±1 time-step tolerance, code reuse within a step rejected).
- Session: separate `adm` cookie — `HttpOnly; Secure; SameSite=Strict; Max-Age=12h`, HMAC with
  `token_epoch` baked in (bump epoch = instant logout everywhere). CSRF: SameSite=Strict + require a
  custom `X-Admin: 1` header on every mutating request (blocks form-based cross-site posts).
- Login rate limit 5 attempts / 15 min / IP; optional `ADMIN_IP_ALLOW` env (comma-separated CIDRs).
- **Every** admin mutation writes an `events` row (`actor='admin:mohab'`) with the reason field where
  one exists. The panel is itself auditable from the panel.

### 7.2 Capabilities (grouped as panel pages)

**Dashboard** — live stats: pixels live/pending/next, claims today, revenue this cycle
(verified / awaiting / refund_due, in EGP), open moderation count, TG outbox depth + oldest age,
SSE client count, DB size, last litestream sync, last nightly backup, disk %. Red banners for §11's
alert conditions so the panel doubles as a status page.

**Moderation queue** — full parity with Telegram: pending submissions with the *same* rendered
context/locator previews (reuse `render.js` output), submitter history stats, approve / reject-with-reason,
multi-select bulk approve/reject. Filter by type/age. This is the fallback when Telegram is down.

**Wall inspector** — the actual wall rendered in-panel; click any pixel → owner, submission, payment,
timestamps, full chain. From there:
- **Takedown**: erase an *already-approved* submission's pixels (late-discovered abuse). Frees the cells,
  SSE-syncs clients, flips the submission to `rejected` with reason; if paid+verified → auto `refund_due`.
- **Region wipe**: rectangle-select erase (multiple submissions at once, same per-submission semantics,
  confirmation modal listing what will be hit).
- **Export PNG** of the current wall at any moment.
- **Force cycle reset** and **reseed from archive** — both gated behind typing a confirmation phrase.

**Users** — search by handle / email / IP / user id; view profile, balances, submission + payment
history; adjust `paint` balance or reset allowance (reason required, audited); **ban/unban**
(`users.status='banned'` → claims/bookings/logins refused with a neutral message; option at ban time to
also take down their live pixels); delete a guest identity (frees nothing on the wall unless taken down).

**Brands** — applications list (pending/approved/rejected), full profile view, approve / reject / **revoke**
(revoke blocks new bookings, existing live pixels untouched unless taken down), edit profile fields.

**Payments** — full ledger, filterable by status/kind/date; screenshot viewer; the same transitions as
Telegram (`verified` / `rejected` / `refunded`) plus **admin override** for stuck states (e.g. force-expire
a hold, re-open a mis-tapped rejection — allowed transitions whitelisted in `payments.js`, never free-form);
reconciliation view (sum of verified vs paint credited vs booked px — should always net to zero, red if not);
CSV export for bookkeeping.

**Config** — edit the `config` table (§2) with typed inputs: pixel prices, pack prices, free cap, refill
window, IP caps, brand hold TTL, and **maintenance mode** (wall freezes: reads fine, claims return a
friendly "back soon"). Changes hot-apply, no deploy; each shows who set it last.

**Audit log** — `events` browser: filter by actor / action / date range, paginate, expand payload JSON.

**System** — TG outbox inspector (list stuck sends, retry-now, drop poison message); trigger manual
`VACUUM INTO` backup; download latest DB snapshot; restart the Telegram worker; view recent server log tail.

### 7.3 Telegram convenience commands (thin wrappers over the same code)
`/pending` (count + oldest), `/stats` (dashboard one-liner), `/freeze` + `/unfreeze` (maintenance mode,
mod-allowlist only, confirmation button). Anything heavier → the panel.

---

## 8. Client changes (app.js / index.html / styles.css)

1. **History tab.** New bottom-sheet/panel (mobile-first, matches existing modal style) reachable from a
   new `🕘 MY PIXELS` button in the action bar. Rows: type icon, px count, thumbnail (data-URI rendered
   client-side from the submission's pixels), status chip `⏳ PENDING / ✅ LIVE / ❌ REJECTED (reason) /
   💸 REFUNDED / ⌛ EXPIRED`, date, amount+payment state for paid rows. Data: `GET /api/me/history`.
   Live updates: SSE event `{t:'mod', sid}` → if `sid` is in my cached list, refetch history + allowance.
2. **Pending overlay.** Personal snapshot includes own pending cells; render them pulsing (client
   already layers preview/reserved; add a third treatment). Tooltip: "awaiting approval".
3. **Checkout rewrite.** Paint-shop and brand-confirm modals: replace mock instantly-credited flows with
   the order → InstaPay instructions (link button + QR image + copyable code) → "I've paid — enter
   reference" form → "submitted, you'll see it in your history" state. Remove `payMethods` radios.
   Remove all "Prototype — nothing is charged" fine print.
4. **Claim flow copy.** After a free claim: toast changes from "pixels claimed!" to
   "sent for review — they'll appear once approved (usually minutes)". Selected pixels convert to the
   pending overlay instead of live paint.
5. **Brand auth UI.** Signup/login modal (email, password, profile fields, char counter on description);
   "BRAND PRE-ORDER" button routes: not logged in → signup; pending → "application under review"; approved → booking flow.
6. **Kill the demo pill** in production builds (`dev:false` already hides it — verify) and the fake
   sponsor logos in the header (Coca-Cola/Nike/Pepsi/etc. are placeholder trademarks — **must not ship**;
   replace with real approved brands from the wall or hide the strip).
7. Keep the binary envelope + SSE reconnect logic untouched — it already handles `sync`/`reset`.

---

## 9. API surface (final)

| Route | Auth | Notes |
|---|---|---|
| `GET /api/wall` | cookie (auto-mint) | snapshot + own pending list + allowance + prices + brandStatus |
| `GET /api/stream` | — | SSE; adds `{t:'mod',sid}` and `{t:'paint-remove',px:[...]}` events |
| `GET /api/allowance` | cookie | unchanged shape + paint |
| `POST /api/claim` | cookie | → submission pending; response includes `sid`, occupied list |
| `GET /api/me` | cookie | identity, kind, brand status, handle |
| `GET /api/me/history` | cookie | submissions + payments joined, newest first, paginated |
| `POST /api/auth/signup` | — | brand signup (rate-limited 3/IP/day) |
| `POST /api/auth/login` / `logout` | — | scrypt verify; generic error on fail |
| `POST /api/book` | brand, approved | → submission(next) + payment(awaiting) + hold |
| `POST /api/paint/order` | cookie | → payment(awaiting), returns code+instructions |
| `POST /api/payments/:id/proof` | owner | ref + screenshot multipart |
| `POST /api/tg/webhook` | TG secret header | callbacks + (ignore other updates) |
| `GET /healthz` | — | db up, outbox depth, sse clients — for uptime monitor |
| ~~`/api/dev/*`~~ | | deleted outright in Phase 7 (not just `DEV=0`) |

Admin (all `admin` cookie + `X-Admin` header, §7.1; rate-limited; every mutation audited):

| Route | Notes |
|---|---|
| `POST /api/admin/login` / `logout` | password + TOTP; sets/clears `adm` cookie |
| `GET /api/admin/overview` | dashboard stats + alert states |
| `GET /api/admin/queue` · `POST /api/admin/submissions/:id/approve\|reject` | reason on reject; bulk via array body |
| `POST /api/admin/submissions/:id/takedown` | approved → rejected, cells freed, auto refund_due if paid |
| `POST /api/admin/wall/erase-region` · `POST /api/admin/wall/reset` · `GET /api/admin/wall/export.png` | reset requires confirmation phrase in body |
| `GET /api/admin/users?q=` · `POST /api/admin/users/:id/ban\|unban\|adjust` | adjust = paint/allowance delta + reason |
| `GET /api/admin/brands` · `POST /api/admin/brands/:id/approve\|reject\|revoke` · `PUT .../profile` | |
| `GET /api/admin/payments` · `POST /api/admin/payments/:id/verify\|reject\|refunded\|override` | override limited to whitelisted transitions |
| `GET/PUT /api/admin/config` | typed validation per key; hot-apply |
| `GET /api/admin/events` | audit browser, filters + pagination |
| `GET /api/admin/system` · `POST /api/admin/system/backup\|outbox-retry\|worker-restart` | |

All POSTs: strict JSON schema validation (hand-rolled validators, house style), per-IP+per-uid token
bucket (e.g. 30 req/min general, 5/min for auth), 413 on oversize, structured 4xx errors.

---

## 10. Backups & durability

1. **Litestream** sidecar (systemd unit) streaming the SQLite WAL to **Cloudflare R2** continuously
   (user has CF account; S3-compatible creds needed — **SECRET NEEDED FROM USER**). RPO ≈ seconds.
2. **Nightly** cron: `VACUUM INTO data/backup/wall-YYYYMMDD.db` + wall PNG export + prune >30 days,
   uploaded to R2 too (second, independent copy).
3. **Monthly** (at reset, in-process): final wall PNG + full DB snapshot archived permanently (marketing
   asset + audit).
4. `events` journal makes any wall state rebuildable: `state = replay(approved claims) - resets`.
5. **Restore drill** documented in `tools/restore-drill.md` and executed once before launch
   (Phase 8 acceptance): fresh VPS + R2 creds → serving wall in <30 min.
6. Uploaded screenshots included in nightly R2 sync (they're evidence for payment disputes).

---

## 11. Security & hardening checklist (Phase 7 gate)

- [ ] HTTPS only (Caddy auto-TLS); HSTS; `ALLOW_ORIGIN` removed (same-origin only now).
- [ ] Headers: CSP (`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` +
      fonts.googleapis/gstatic or **self-host the two fonts** — preferred, removes Google + the CSP hole),
      `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`.
- [ ] Cookies: HttpOnly, Secure, SameSite=Lax, HMAC-signed, constant-time verify.
- [ ] `TRUST_PROXY` correctness: Caddy terminates → trust only `X-Forwarded-For` set by Caddy
      (Caddy strips inbound), never CF headers unless behind CF proxy — document the chosen topology.
- [ ] Rate limits (above) + upload constraints + screenshot re-encode (strips EXIF/polyglots).
- [ ] `/api/dev/*` **deleted**; demo pill markup removed from HTML.
- [ ] Placeholder sponsor trademarks removed.
- [ ] Secrets only via env (`config.js` fail-fast lists every required var; `.env.example` committed).
- [ ] Telegram webhook: secret token check + moderator allowlist + payload size cap.
- [ ] Admin panel: TOTP mandatory, `SameSite=Strict` + `X-Admin` header on mutations, login rate limit,
      no admin signup route, `token_epoch` revocation works, `/admin` static files behind auth too.
- [ ] `safeUrl` retained for brand CTA links + `rel="noopener nofollow"` client-side (verify existing).
- [ ] Graceful shutdown: SIGTERM → stop accepting, flush outbox marker, close SSE, `db.close()`.
- [ ] Error boundary: uncaught → log + `events` + process restart via systemd `Restart=always`.
- [ ] Ops alerts: a second Telegram channel (or same group) gets `healthz` failures (external uptime
      ping — UptimeRobot/CF worker cron), disk >80%, outbox stuck >15 min, litestream errors.
- [ ] `npm audit` clean; lockfile committed; Node LTS pinned in `engines` + `.nvmrc`.

---

## 12. Testing (Phase 7 gate, `node:test`)

- **Unit:** envelope codec round-trip; allowance/refill math incl. cycle edge; scrypt verify; HMAC cookie
  tamper; validators; ipv6 /64 normalization (exists in code — port tests).
- **Race:** two concurrent claims for the same idx → exactly one wins (`cells` PK proves it); 50 parallel
  claims from one user never exceed allowance; double-tap approve → single transition + "already decided".
- **State machine:** exhaustive transition table tests for submissions × payments (pending→approved,
  reject-verified→refund_due→refunded, hold expiry, reset policy in §4).
- **Telegram:** outbox retry on 429/500 (mock fetch); webhook auth rejection; callback idempotency.
- **Admin:** TOTP window/reuse rejection; cookie tamper + epoch revocation; mutation without `X-Admin`
  header refused; takedown frees cells + sets refund_due; panel and Telegram deciding the same
  submission concurrently → exactly one wins, the other gets "already decided"; config hot-apply
  (price change reflected in next `/api/wall` snapshot without restart).
- **Integration:** boot → migrate → seed import → snapshot equals prototype snapshot byte-for-byte
  (guards the client contract).
- **Load (manual, pre-launch):** autocannon: 200 rps mixed read, 50 concurrent claims, 1k SSE clients on
  the VPS size chosen; p99 < 150ms for `/api/wall`.
- **E2E happy paths (Playwright, headless):** guest claim→approve(TG_MODE=off)→pixel visible+history LIVE;
  brand signup→approve→book→pay-proof→verify→approve→reset→logo live.

---

## 13. Phased execution

Every phase ends: tests green, committed to `fork/main` (or a feature branch per phase, merged), short
CHANGELOG entry. Phases 1–3 don't touch Telegram/payments and are safe to run locally throughout.

### Phase 0 — Foundations (½ day)
Branch `production` off `main` on the fork. Add `package-lock`, deps (`better-sqlite3`, `pngjs`),
`.nvmrc`, `.env.example`, `config.js` with fail-fast, module skeleton per §1, move existing code into
`server/` unchanged-behavior (snapshot test before/after), CI: GitHub Actions `node --test` + `npm audit`.
**Accept:** `npm run dev` serves the identical prototype through the new layout.

### Phase 1 — Persistence (1–1.5 days)
Migrations runner + §2 schema; wall cache rebuilt from `cells`; claim/book write through transactions
(§4 items 1–3, 6); seed importer; litestream config (runs no-op locally); nightly backup script.
**Accept:** kill -9 mid-claims → restart → zero lost approved pixels; race unit tests green;
prototype behavior otherwise unchanged (everything still auto-approves in this phase).

### Phase 2 — Identity (1 day)
Guest cookie minting + HMAC; allowance keyed by user; `ip_guests` caps; brand signup/login + profile
validation; `/api/me`. Client: auth modal, brand gating on pre-order button.
**Accept:** cookie survives IP change with history intact; 6th guest identity from one IP in a day is
refused; brand signup lands `pending`.

### Phase 3 — Moderation core + history (1.5 days)
Submissions/cells state machine (§4 items 4–5, 7 + reset policy); pending overlay in personal snapshot;
SSE `mod` events; `/api/me/history`; client history tab + pending rendering + claim copy changes.
`TG_MODE=off` auto-approve keeps the app usable.
**Accept:** claim → pixels pending-only for others… actually invisible to others, shimmering for me →
auto-approve → live everywhere + history flips PENDING→LIVE without reload.

### Phase 4 — Telegram (1.5 days)
Outbox + worker; render.js cards (context + locator, §5); webhook + poll modes; approve/reject/brand-app
cards; idempotent callbacks; decision edits; audit events; reset warning digests; `tools/tg-setup.js`.
**Accept:** real group end-to-end on a tunnel or the VPS: claim from phone → card with correct zoom-out
context → Approve → pixel public in <2s; Reject → gone from submitter view + history REJECTED; bot
offline 10 min → cards arrive after; double-tap → one decision.

### Phase 5 — Payments (1.5 days)
Payments table flows (§6); order codes; proof endpoint + screenshot pipeline; InstaPay checkout modals
(link + QR asset + code + proof form); paint credit on verify; brand hold/expiry; refund_due reminders;
sweepers (expiry, reminders) on one interval scheduler.
**Accept:** full brand journey on staging incl. a real 1-EGP InstaPay transfer verified by hand; reject
after verify → refund_due reminder fires; hold expiry frees cells.

### Phase 6 — Admin panel (1.5 days)
`admins`/`config` tables + `tools/add-admin.js` (TOTP provisioning); admin auth (§7.1); `/api/admin/*`
routes over the existing state machines; panel pages per §7.2 (dashboard, queue, wall inspector with
takedown/region-wipe, users, brands, payments + reconciliation, config, audit, system); TG convenience
commands (§7.3); decision-sync edits to Telegram cards.
**Accept:** with Telegram worker stopped, a full moderation day is possible from the panel alone;
takedown of a live paid submission frees cells on all clients in <2s and creates refund_due; a price
change in config is served in the next snapshot without restart; every action visible in the audit page;
login without TOTP impossible.

### Phase 7 — Hardening (1 day)
Everything in §11 + §12; delete dev routes/demo pill/fake sponsors; self-host fonts; load test; fix fallout.
**Accept:** checklist all ✓, tests green, load numbers recorded in the PR description.

### Phase 8 — Deploy & cutover (½–1 day)
VPS provision (Ubuntu LTS, non-root user, ufw 80/443, unattended-upgrades) → Caddyfile → systemd units
(app + litestream) → env secrets → domain DNS (behind Cloudflare proxy: then trust CF-Connecting-IP;
decide and document) → tg-setup webhook → **restore drill** → seed import of the real current wall →
uptime monitor + alerts → Vercel project retired/redirected → go-live smoke: one real free claim + one
real 10-EGP paint pack end-to-end. Write `RUNBOOK.md`: daily verify SOP, refund SOP, bot-down SOP,
restore SOP, "how to ban a user", pricing-change SOP.
**Accept:** production URL serving; all monitors green for 24h; runbook reviewed by the user.

**Total: ~10–11 focused dev-days.**

---

## 14. Inputs needed from the user (blockers — collect before the matching phase)

| Needed by | Item |
|---|---|
| Phase 4 | Telegram bot token (BotFather), the private group created + bot added, moderator Telegram user IDs |
| Phase 5 | Official InstaPay QR PNG (they have it), confirm the InstaPay link + handle, confirm pricing (10 EGP/px? packs?) |
| Phase 6 | An authenticator app on the team's phones (TOTP for admin accounts) |
| Phase 8 | VPS provider account (or pick Fly/Railway), domain name + DNS access, Cloudflare R2 bucket + S3 creds for backups, decision: behind Cloudflare proxy or plain Caddy |
| Any | Refund policy wording for the site (who pays transfer fees, timeline promise) |

## 15. Explicitly out of scope (v1)
Automatic payment matching (no API exists); email verification/sending; multi-region/HA
(single VPS + backups is the accepted availability tier — document ~minutes of downtime on deploys);
cash refunds of paint balances; i18n/Arabic UI (worth a fast-follow); native apps.
