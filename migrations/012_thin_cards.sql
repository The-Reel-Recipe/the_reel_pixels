-- ═══════════════════════════════════════════════════════════════
-- 012_thin_cards — let the payment cards that were photos go
--
-- Payment cards used to carry the payer's bank screenshot, which made
-- them photo messages in Telegram. They no longer carry it, so every
-- new card is a text message and every edit is editMessageText.
--
-- A photo message cannot be edited with editMessageText. The cards
-- already sitting in the group from before this change would fail
-- permanently on their next transition and retry until somebody
-- noticed. Clearing tg_msg_id makes the next transition send a fresh
-- card instead, which lands.
--
-- Only the ones still in flight. A payment that has reached a final
-- state has no further transition to publish, so its card is finished
-- with — and the old photo stays in the group either way. We cannot
-- unsend those; Telegram keeps its own copies, which is the whole
-- reason the screenshots stopped going there.
-- ═══════════════════════════════════════════════════════════════

UPDATE payments
   SET tg_msg_id = NULL
 WHERE tg_msg_id IS NOT NULL
   AND screenshot_path IS NOT NULL
   AND status IN ('awaiting_transfer', 'submitted', 'verified', 'refund_due');
