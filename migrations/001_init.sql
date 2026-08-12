-- ═══════════════════════════════════════════════════════════════
-- 001_init — the whole data model, §2 of PLAN.md
--
-- Every table lands now even though Phase 1 only populates users,
-- allowances, submissions, cells, events and meta. The schema is the
-- contract the later phases are written against; adding the columns
-- later would mean rewriting rows that already exist in production.
--
-- Timestamps are ms since epoch. Money is integer piasters (EGP×100).
-- ═══════════════════════════════════════════════════════════════

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
-- the wall cache is rebuilt off this every boot, once per cycle
CREATE INDEX submissions_cycle ON submissions(cycle, status);

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
  code         TEXT NOT NULL UNIQUE,         -- human short code e.g. 'TRR-7F3K'
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
CREATE INDEX events_ts ON events(ts DESC);

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
