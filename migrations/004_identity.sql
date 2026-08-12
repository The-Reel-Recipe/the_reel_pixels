-- ═══════════════════════════════════════════════════════════════
-- 004_identity — what a signed cookie needs that §2 didn't have
--
-- Runs automatically (003 is the manual one, deliberately: this file
-- has to be in place before the bridge it outlives can go).
--
-- token_epoch is baked into the HMAC of every session cookie and never
-- sent to the client, so bumping the column invalidates every cookie
-- that user holds — "log out everywhere", and the revocation lever for
-- a compromised account. §7.1 gives admins the same column; users get
-- it here because Phase 2 is where the first real session is issued.
--
-- signups joins the two per-IP counters already in ip_guests: guest
-- minting and claiming are capped per day (§3), and brand signups are
-- capped the same way (3/IP/day) rather than in a table of their own.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ip_guests ADD COLUMN signups INTEGER NOT NULL DEFAULT 0;
