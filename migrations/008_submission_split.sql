-- ═══════════════════════════════════════════════════════════════
-- 008_submission_split — how much of a claim was free, how much paint
--
-- A mixed claim can spend both: the free quota first, then paint for
-- whatever's left. Only the total ever landed on the row (px_count)
-- and the type it's filed under is whichever kind touched last
-- (paidQuota ? 'paint' : 'free') — so a reject or an expiry had no
-- way to know how much of that total to hand back as paint without
-- either refunding the whole thing (wrong, on a mixed claim) or
-- nothing at all (what §5's reject/expire path did until now).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE submissions ADD COLUMN used_free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN used_paint INTEGER NOT NULL DEFAULT 0;
