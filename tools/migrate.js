#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   migrate — run the migrations the boot won't run for you

     node tools/migrate.js                     # list what is waiting
     node tools/migrate.js 003_drop_legacy_keys.sql

   Requiring db.js has already applied every ordinary migration by the
   time this prints anything; the only work left for a human is the
   files marked `-- @manual`, which the runner deliberately holds back
   (see the note in server/db.js).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const dbm = require('../server/db.js');

const names = process.argv.slice(2).filter(a => !a.startsWith('-'));

try {
  if (!names.length) {
    const { deferred } = dbm.migrate();
    if (!deferred.length) console.log('migrate: nothing held back — the schema is up to date.');
    else {
      console.log('migrate: waiting for a decision (pass the name to apply it):');
      for (const n of deferred) console.log(`  ${n}`);
    }
  } else {
    const { applied } = dbm.migrate({ only: names });
    if (!applied.length) console.log(`migrate: ${names.join(', ')} — already applied, nothing to do.`);
    else console.log(`migrate: applied ${applied.join(', ')}`);
  }
} catch (err) {
  console.error('migrate:', err.message);
  process.exitCode = 1;
} finally {
  dbm.close();
}
