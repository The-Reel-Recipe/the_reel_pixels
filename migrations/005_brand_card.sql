-- ═══════════════════════════════════════════════════════════════
-- 005_brand_card — the moderation card for a brand application
--
-- submissions and payments both carry tg_msg_id from 001 so a decision
-- can edit the card it was made on rather than replying to it (§5).
-- brand_profiles was missed: §3 puts new applications in the same group
-- with the same Approve/Reject buttons, so it needs the same handle on
-- the message.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE brand_profiles ADD COLUMN tg_msg_id INTEGER;
