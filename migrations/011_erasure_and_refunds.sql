-- ═══════════════════════════════════════════════════════════════
-- 011_erasure_and_refunds — the two remedies the documents promise
--
-- PRIVACY §9 describes an erasure procedure in detail and there was
-- no delete path anywhere in the product. TERMS §5, §20 and §21 and
-- REFUNDS §6.1, §9 and §16 promise money back for a paint pack in
-- six named cases and there was no way to record one.
--
-- ── payments.refund_amount ──
-- Without it a refund is all-or-nothing. Several of the promised
-- cases are partial by nature — a pack half spent when the wall
-- closes, a booking cut short — and "we returned some of it" has to
-- be a number the row can hold, not a note in a Telegram thread.
-- NULL means "the whole amount", so nothing has to be backfilled.
--
-- ── legal_hold, on users and on submissions ──
-- TERMS §11A and PRIVACY §9 both say nothing is deleted while a
-- legal matter is open. Without this flag the erasure route becomes
-- the mechanism by which somebody destroys the record of their own
-- post the moment a complaint about it arrives — and the retention
-- sweep becomes the same thing on a timer. Both check it.
--
-- ── users.erased_at ──
-- Not a new `status`. That column's CHECK allows ('active','banned')
-- and widening it in SQLite means rebuilding the table, which needs
-- foreign_keys=off, which cannot be set inside the transaction this
-- migration runs in. Rebuilding a table every other table references
-- to add one enum value is a large risk for a small tidiness.
--
-- So the two are separated: `status` stays the mechanism — may this
-- account act, no — and `erased_at` is the meaning, which is what
-- decides the message the person is shown and what the admin list
-- prints. An erased account reads as erased, not as banned.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE payments ADD COLUMN refund_amount INTEGER;

ALTER TABLE users ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN erased_at INTEGER;

-- A sweep and an erasure both start by asking "is anything held?", and
-- both run over every row. Held rows are a handful out of everything.
CREATE INDEX idx_users_hold ON users(legal_hold) WHERE legal_hold = 1;
CREATE INDEX idx_submissions_hold ON submissions(legal_hold) WHERE legal_hold = 1;
