/* ═══════════════════════════════════════════════════════════════
   export-wall-png — the wall as a picture

   One renderer, three callers: the cycle reset writes the outgoing
   month to archive/YYYY-MM.png before wiping it, the nightly backup
   files a copy next to the database snapshot, and

     node tools/export-wall-png.js [out.png] [--layer live|next]

   dumps whatever is on the wall right now.

   Flat colours on white, one pixel per cell, no scaling — 1000×1000
   PNG, ~100KB. pngjs because the alternative is a native dependency
   for something this simple.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const cfg = require('../server/config.js');

const BG = 0xff;                              // white paper under everything

/* entries: any iterable of [idx, 0xRRGGBB] — a Map's entries() shape, so the
   live wall cache can be handed straight over without copying. */
function render(entries, w = cfg.W, h = cfg.H) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(BG);
  for (const [idx, c] of entries) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= w * h) continue;
    const o = idx * 4;
    png.data[o] = (c >> 16) & 255;
    png.data[o + 1] = (c >> 8) & 255;
    png.data[o + 2] = c & 255;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

function writePng(file, entries, w, h) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(entries, w, h));
  return file;
}

/* Reads a layer straight out of SQLite rather than the in-memory cache, so
   the backup script doesn't have to boot the server to take a picture. */
function pixelsFromDb(dbmod, cycle, layer) {
  const rows = dbmod.db.prepare(
    "SELECT idx, color FROM cells WHERE cycle = ? AND layer = ? AND state = 'live' ORDER BY idx"
  ).all(cycle, layer || 'live');
  return rows.map(r => [r.idx, r.color]);
}

function exportFromDb(file, layer) {
  const dbmod = require('../server/db.js');
  const cycle = Number(dbmod.getMeta('cycle') || 0);
  const px = pixelsFromDb(dbmod, cycle, layer);
  writePng(file, px);
  return { file, cycle, pixels: px.length };
}

module.exports = { render, writePng, pixelsFromDb, exportFromDb };

if (require.main === module) {
  const args = process.argv.slice(2);
  const li = args.indexOf('--layer');
  const layer = li >= 0 ? args[li + 1] : 'live';
  const out = path.resolve(args.find(a => !a.startsWith('--') && a !== layer) ||
    path.join(cfg.DATA_DIR, 'wall.png'));
  const r = exportFromDb(out, layer);
  // local months: a cycle starts at midnight where the wall lives, and
  // toISOString() would call it the month before
  const d = new Date(r.cycle);
  console.log(`wrote ${r.file} — ${r.pixels} ${layer} pixel(s), cycle ` +
    (r.cycle ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '?'));
  require('../server/db.js').close();
}
