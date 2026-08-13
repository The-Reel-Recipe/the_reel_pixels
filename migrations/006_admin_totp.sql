-- ═══════════════════════════════════════════════════════════════
-- 006_admin_totp — the step a code was last accepted for
--
-- §7.1 requires that a TOTP code cannot be replayed inside its own
-- 30-second window. Remembering the last accepted step is what makes
-- that true, and remembering it in memory would make it true only
-- until the next restart — which is exactly when somebody watching
-- would try it.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE admins ADD COLUMN last_totp_step INTEGER NOT NULL DEFAULT 0;
