-- ═══════════════════════════════════════════════════════════════
-- 015_google_and_codes — two new ways in, and one way out
--
-- Passwords stop being handed out. A painter's account comes from
-- Google; a brand's comes from the application form and is entered
-- with a code sent to the address on it. The accounts that already
-- have a password keep it — four painters and two brands, one of
-- whom has bought paint — because taking a door away from somebody
-- who is standing in it is not a migration, it is a lockout.
--
-- ── users.google_sub ──
-- Google's `sub` claim: the stable, unique id for a Google account.
-- Not the email. An email address can be reassigned by a workspace
-- admin and can change; `sub` never does, and matching on it is the
-- difference between "the same person" and "whoever holds that
-- address today".
--
-- The email is still what LINKS a Google sign-in to an existing
-- account the first time — that was the deliberate choice, so
-- somebody who already has paint lands on it rather than on an empty
-- second account. After that first link, `sub` is what identifies
-- them. Unique, so one Google account is one account here, the same
-- way one email is.
--
-- ── email_codes ──
-- A short-lived code, stored hashed. It is a credential for the few
-- minutes it lives, and a credential in a database in plain text is
-- a credential in every backup of that database.
--
-- Keyed by email rather than by user: the address is what somebody
-- types, and it has to be answerable before we know — or admit —
-- whether an account exists behind it. `attempts` is what stops the
-- six digits being guessed; `sent` is what stops the route being a
-- free way to send mail to strangers.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY,          -- lowercased, as typed
  hash       TEXT NOT NULL,             -- sha256(code . email . SESSION_SECRET)
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 1,-- codes issued to this address in this window
  window_at  INTEGER NOT NULL,          -- when the current sending window opened
  created_at INTEGER NOT NULL
);

-- The sweep drops expired rows; nothing else reads by time.
CREATE INDEX idx_email_codes_exp ON email_codes(expires_at);

-- Its own outbox, so a backlog of moderation cards cannot delay a
-- sign-in code and vice versa. Same shape as tg_outbox otherwise.
CREATE TABLE mail_outbox (
  id         INTEGER PRIMARY KEY,
  about      TEXT,                      -- 'code:<email>' — a second one supersedes the first
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_try   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_outbox_due ON mail_outbox(next_try);
