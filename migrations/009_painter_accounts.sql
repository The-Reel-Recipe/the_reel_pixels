-- ═══════════════════════════════════════════════════════════════
-- 009_painter_accounts — an email a guest can grow into
--
-- A painter is a cookie, and a cookie is one browser on one phone.
-- Registering attaches an email + password to the guest row they
-- already are — same id, same pixels, same history, same paint —
-- so logging in anywhere else resumes the identity instead of
-- minting a stranger. Brands already lived this way; the unique
-- index is what keeps one email from ever meaning two accounts
-- across the two kinds.
--
-- notes_seen_at is the notifications high-water mark: everything
-- newer is "unread". Zero means "never looked".
--
-- payments.updated_at is stamped on every status transition so the
-- feed can say *when* money was verified/rejected/refunded without
-- guessing from created_at.
-- ═══════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

ALTER TABLE users ADD COLUMN notes_seen_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payments ADD COLUMN updated_at INTEGER;
