/* ═══════════════════════════════════════════════════════════════
   db — one SQLite file, opened once, migrated on the way up

   better-sqlite3 is synchronous, which is the whole point: a
   transaction runs to completion without the event loop getting a
   word in, so every mutation in §4 of the plan is a critical section
   for free. Nothing above this file needs a lock.

   Sits at the bottom of the dependency graph: db → config, and that
   is all. wall.js and identity.js require it, never the reverse.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cfg = require('./config.js');

fs.mkdirSync(cfg.DATA_DIR, { recursive: true });

const db = new Database(cfg.DB_FILE);

/* WAL so a reader (litestream, a backup, the admin panel) never blocks the
   writer; NORMAL because WAL already makes a crash safe and the extra fsync
   per commit costs more than it buys here; busy_timeout for the seconds a
   VACUUM INTO holds things up. foreign_keys is off by default in SQLite and
   has to be asked for on every connection. */
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

/* ── Migrations ───────────────────────────────────────────────── */

/* Every .sql file in migrations/ runs exactly once, in filename order,
   inside its own transaction. The recorded sha is a tripwire: editing a
   migration that has already run somewhere is how schemas drift apart, so
   it is a hard error rather than a silent no-op. */
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             name       TEXT PRIMARY KEY,
             sha        TEXT NOT NULL,
             applied_at INTEGER NOT NULL
           )`);

  const done = new Map(db.prepare('SELECT name, sha FROM schema_migrations').all()
    .map(r => [r.name, r.sha]));
  const record = db.prepare('INSERT INTO schema_migrations (name, sha, applied_at) VALUES (?, ?, ?)');

  const files = fs.existsSync(cfg.MIGRATIONS_DIR)
    ? fs.readdirSync(cfg.MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    : [];

  const applied = [];
  for (const name of files) {
    const sql = fs.readFileSync(path.join(cfg.MIGRATIONS_DIR, name), 'utf8');
    const sha = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const seen = done.get(name);
    if (seen) {
      if (seen !== sha) {
        throw new Error(`db: migration ${name} changed after it ran (${seen} → ${sha}). ` +
          'Add a new migration instead of editing an applied one.');
      }
      continue;
    }
    db.transaction(() => { db.exec(sql); record.run(name, sha, Date.now()); })();
    applied.push(name);
  }
  return applied;
}

const applied = migrate();
if (applied.length) console.log(`db: applied ${applied.length} migration(s) — ${applied.join(', ')}`);

/* ── Transactions ─────────────────────────────────────────────── */

/* tx(fn, ...args) runs fn inside a transaction and hands back what it
   returns; a throw rolls the whole thing back. Wrapping is memoized on the
   function identity, so the hot paths (claim, book) pay better-sqlite3's
   setup cost once and not per request. Nesting is safe — better-sqlite3
   turns an inner transaction into a savepoint — which is what lets
   identity.js expose tx-wrapped helpers that wall.js can also call from
   inside its own claim transaction. */
const wrapped = new WeakMap();
function tx(fn, ...args) {
  let t = wrapped.get(fn);
  if (!t) { t = db.transaction(fn); wrapped.set(fn, t); }
  return t(...args);
}

/* ── Small shared helpers ─────────────────────────────────────── */

const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMetaStmt = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ' +
  'ON CONFLICT(k) DO UPDATE SET v = excluded.v');
const eventStmt = db.prepare('INSERT INTO events (ts, actor, action, payload) VALUES (?, ?, ?, ?)');

const getMeta = k => { const r = getMetaStmt.get(k); return r ? r.v : null; };
const setMeta = (k, v) => setMetaStmt.run(k, String(v));
/* the audit journal; payload stays summary-sized, never a pixel dump */
const logEvent = (actor, action, payload, ts) =>
  eventStmt.run(ts || Date.now(), actor, action, JSON.stringify(payload || {}));

let closed = false;
function close() {
  if (closed) return;
  closed = true;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* nothing to flush */ }
  db.close();
}

module.exports = { db, tx, migrate, getMeta, setMeta, logEvent, close, file: cfg.DB_FILE };
