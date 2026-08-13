/* ═══════════════════════════════════════════════════════════════
   backup-nightly — the second, independent copy

   Litestream (deploy/litestream.yml) streams the WAL offsite
   continuously and is the real recovery story; this is the belt to
   its braces. A VACUUM INTO snapshot is a single consistent file
   that opens in any SQLite tool, needs no replay, and survives the
   class of accident where the replication itself is what broke.

     node tools/backup-nightly.js [--keep 30] [--quiet]

   Safe to run against a live server: VACUUM INTO takes a read lock,
   and WAL means readers never block the writer.

   Phase 8 wires it to cron, ships both files to R2 alongside the
   litestream stream, and writes the restore drill that proves the
   whole arrangement works. Until then it is a manual command.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../server/config.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const KEEP_DAYS = Number(flag('--keep', process.env.BACKUP_KEEP_DAYS || 30));
const quiet = args.includes('--quiet');
const say = (...a) => { if (!quiet) console.log(...a); };

const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}` +
  `${String(d.getDate()).padStart(2, '0')}`;
/* wall-20260812.db / wall-20260812.png — the date is in the name so pruning
   never has to trust an mtime that a copy or a restore just rewrote */
const NAMED = /^wall-(\d{4})(\d{2})(\d{2})\.(db|png)$/;

function prune(dir, before) {
  let dropped = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = NAMED.exec(name);
    if (!m) continue;
    if (new Date(+m[1], +m[2] - 1, +m[3]).getTime() >= before) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    dropped++;
  }
  return dropped;
}

/* The work, without the exit. The admin panel's System page (§7.2) triggers
   this inside the running server, where closing the database — which the
   command-line path does on its way out — would take the wall down with it. */
function runBackup(opts = {}) {
  const keep = Number(opts.keep === undefined ? KEEP_DAYS : opts.keep);
  const log = opts.quiet ? () => {} : say;
  if (!fs.existsSync(cfg.DB_FILE)) throw new Error(`no database at ${cfg.DB_FILE}`);
  fs.mkdirSync(cfg.BACKUP_DIR, { recursive: true });

  const dbmod = require('../server/db.js');
  const day = stamp(new Date());
  const dbOut = path.join(cfg.BACKUP_DIR, `wall-${day}.db`);
  const pngOut = path.join(cfg.BACKUP_DIR, `wall-${day}.png`);

  // VACUUM INTO refuses to overwrite, so a same-day re-run replaces its own file
  fs.rmSync(dbOut, { force: true });
  dbmod.db.prepare('VACUUM INTO ?').run(dbOut);
  const bytes = fs.statSync(dbOut).size;
  log(`backup: ${dbOut} — ${(bytes / 1048576).toFixed(1)} MB`);

  const png = require('./export-wall-png.js').exportFromDb(pngOut, 'live');
  log(`backup: ${pngOut} — ${png.pixels} live pixel(s)`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keep);
  cutoff.setHours(0, 0, 0, 0);
  const dropped = prune(cfg.BACKUP_DIR, cutoff.getTime());
  log(`backup: pruned ${dropped} file(s) older than ${keep} days`);

  return { file: dbOut, png: pngOut, bytes, pixels: png.pixels, pruned: dropped };
}

module.exports = { runBackup, prune, stamp, NAMED };

if (require.main === module) {
  try {
    runBackup();
    require('../server/db.js').close();
  } catch (err) {
    console.error('backup: failed —', err.message);
    process.exit(1);
  }
}
