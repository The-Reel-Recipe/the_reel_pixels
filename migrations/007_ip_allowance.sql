-- ═══════════════════════════════════════════════════════════════
-- 007_ip_allowance — the clock an incognito tab can't reset
--
-- §3's guest allowance is keyed by user, refilling on its own clock —
-- exactly what lets a cookie-wiping visitor mint a fresh identity and
-- a fresh 20 free pixels with none of the waiting a returning guest
-- would do. ip_guests already caps how many identities an IP can mint
-- per day, but each one still starts its own clock at zero.
--
-- This is the shared clock a brand-new identity is seeded from instead
-- of zero: identity.js only ever reads it at mint time, so an existing
-- identity (a second real person on the same office wifi, say) is
-- never constrained by somebody else's spending. It is a mint-time
-- inheritance, not an additional per-request cap.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE ip_allowances (
  ip        TEXT PRIMARY KEY,
  used      INTEGER NOT NULL DEFAULT 0,
  refill_at INTEGER NOT NULL DEFAULT 0
);
