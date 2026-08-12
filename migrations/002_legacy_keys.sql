-- ═══════════════════════════════════════════════════════════════
-- 002_legacy_keys — the Phase 1 → Phase 2 identity bridge
--
-- §2 keys allowances on users(id), but real identity is a signed
-- cookie that Phase 2 introduces. Until then the caller is still the
-- normalized IP that identity.js has always used, so something has to
-- map that string onto a users row.
--
-- Rather than bolt an ip column onto users (a column Phase 2 would
-- immediately have to drop, on a table that will hold real accounts),
-- the mapping lives here on its own. Phase 2 mints a uid cookie,
-- backfills it against these rows so returning visitors keep their
-- pixels, and then drops this table — no surgery on users.
--
-- Nothing outside identity.js may read it.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE legacy_keys (
  key        TEXT PRIMARY KEY,               -- normalized caller ip (v4 whole, v6 /64)
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
