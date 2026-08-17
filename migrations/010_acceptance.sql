-- ═══════════════════════════════════════════════════════════════
-- 010_acceptance — what somebody agreed to, and when
--
-- TERMS §4 describes a tick and a recorded version. Until now the
-- only checkbox in the whole product was "remove the background",
-- so the section described something that did not exist.
--
-- Three separate records, because they answer three different
-- questions and a court asks them separately:
--
--   terms_version / terms_at — which wording this person accepted,
--     and when. Not a boolean: the documents change, and "they
--     agreed" is worthless without "to what".
--
--   capacity_confirmed_at — they said they are old enough to enter
--     a contract and are doing so for themselves. PRIVACY §11 says
--     we ask before an account can buy, and TERMS §5 leans on it.
--     Stored, so the gate is on the record rather than on a
--     checkbox the client could simply not send.
--
--   payments.terms_version — which wording applied to THIS order.
--     The users row moves when somebody re-accepts a new version;
--     an order does not. "Which terms applied to S37-7F3K" is the
--     only question a consumer complaint actually asks, and this
--     is the single column that answers it.
--
-- All nullable. Everyone who signed up before this migration has
-- accepted nothing, which is the truth, and the gates treat a NULL
-- as "has not agreed" rather than backfilling a consent nobody gave.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_at INTEGER;
ALTER TABLE users ADD COLUMN capacity_confirmed_at INTEGER;

ALTER TABLE payments ADD COLUMN terms_version TEXT;
