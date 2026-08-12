/* ═══════════════════════════════════════════════════════════════
   seed — turning a wire envelope into rows

   The prototype's artwork lives in seed.bin (committed) and, on a
   machine that ran the file-backed server, in .wall.bin. Neither
   knows anything about users or submissions, so the import invents
   the minimum that makes the schema honest: a `system` user, one
   users row per owner so the display name survives, and one approved
   submission per owner per layer to hang the cells off.

   Runs once per database — wall.js checks meta.seed_source before
   calling — and again on demand behind /api/dev/seed.

   Takes an already-decoded envelope so it never has to reach back
   into wall.js for the codec; db is the only thing below it.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('./config.js');
const { db, tx, setMeta, logEvent } = require('./db.js');

const { W, H } = cfg;
const validIdx = i => Number.isInteger(i) && i >= 0 && i < W * H;

const insUser = db.prepare(
  'INSERT INTO users (kind, handle, created_at, last_seen) VALUES (?, ?, ?, ?)');
const insSub = db.prepare(
  `INSERT INTO submissions (user_id, type, cycle, layer, px_count, bbox, pixels,
     brand_name, brand_url, brand_cta, status, created_at, decided_at, decided_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, 'system')`);
const insCell = db.prepare(
  `INSERT OR IGNORE INTO cells (cycle, layer, idx, color, submission_id, user_id, state)
   VALUES (?, ?, ?, ?, ?, ?, 'live')`);
const delCells = db.prepare('DELETE FROM cells WHERE cycle = ?');
const delSubs = db.prepare('DELETE FROM submissions WHERE cycle = ?');

/* packed [u32 idx · u8 r · u8 g · u8 b] × n — the submissions.pixels shape
   from §2, and enough on its own to replay a wall from the journal */
const PX = 7;
function packPixels(list) {
  const buf = Buffer.allocUnsafe(list.length * PX);
  let o = 0;
  for (const [idx, c] of list) {
    buf.writeUInt32LE(idx, o); o += 4;
    buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
  }
  return buf;
}
function bboxOf(list) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const [idx] of list) {
    const x = idx % W, y = (idx / W) | 0;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

function systemUser(now) {
  const row = db.prepare("SELECT id FROM users WHERE kind = 'guest' AND handle = 'system'").get();
  if (row) return row.id;
  const id = Number(insUser.run('guest', 'system', now, now).lastInsertRowid);
  setMeta('system_user', id);
  return id;
}

/* ── The import ───────────────────────────────────────────────── */

/* `a` is the live layer, `b` the one waiting on next month's wall.
   Owners are walked in envelope order and each gets its submissions in
   that order too, because the wall cache assigns owner ids by submission
   id — keeping the two in step is what makes an imported snapshot carry
   the same owner table the file did. */
function importEnvelope(meta, a, b, cycle, now, source) {
  return tx(() => {
    const sysId = systemUser(now);
    const owners = Array.isArray(meta.owners) ? meta.owners : [];
    const brands = meta.brands || {};
    const nextBrands = meta.nextBrands || {};

    /* bucket the pixels by owner index, dropping anything out of range */
    const byOwner = owners.map(() => ({ live: [], next: [] }));
    let dropped = 0;
    for (const [list, layer] of [[a, 'live'], [b, 'next']]) {
      for (const [idx, c, own] of list || []) {
        if (!validIdx(idx) || !byOwner[own]) { dropped++; continue; }
        byOwner[own][layer].push([idx, c]);
      }
    }

    const userIds = new Map();               // "NAME\0type" -> users.id
    let subs = 0, cells = 0;

    owners.forEach((o, i) => {
      const bucket = byOwner[i];
      if (!bucket.live.length && !bucket.next.length) return;   // nothing to own

      const name = String(o.n || 'ANON');
      const type = o.t === 'c' ? 'c' : 'u';
      const key = name + '\0' + type;
      let uid = userIds.get(key);
      if (uid === undefined) {
        uid = Number(insUser.run(type === 'c' ? 'brand' : 'guest', name, now, now).lastInsertRowid);
        userIds.set(key, uid);
      }

      for (const layer of ['live', 'next']) {
        const px = bucket[layer];
        if (!px.length) continue;
        const link = type === 'c' ? (layer === 'live' ? brands[name] : nextBrands[name]) : null;
        const sid = Number(insSub.run(
          uid, type === 'c' ? 'brand' : 'free', cycle, layer,
          px.length, JSON.stringify(bboxOf(px)), packPixels(px),
          type === 'c' ? name : null,
          link ? String(link.url || '') || null : null,
          link ? String(link.cta || '') || null : null,
          now, now).lastInsertRowid);
        subs++;
        for (const [idx, c] of px) cells += insCell.run(cycle, layer, idx, c, sid, uid).changes;
      }
    });

    setMeta('cycle', cycle);
    setMeta('seed_source', source);
    logEvent('system', 'seed-import',
      { source, cycle, owners: userIds.size, submissions: subs, cells, dropped }, now);
    return { owners: userIds.size, submissions: subs, cells, dropped, systemUser: sysId };
  });
}

/* /api/dev/seed replaces the wall wholesale, so the cycle is cleared first.
   Cells go before submissions — they hold the foreign key. */
function replaceCycle(meta, a, b, cycle, now, source) {
  return tx(() => {
    delCells.run(cycle);
    delSubs.run(cycle);
    return importEnvelope(meta, a, b, cycle, now, source);
  });
}

function wipeCycle(cycle, now) {
  return tx(() => {
    const cells = delCells.run(cycle).changes;
    delSubs.run(cycle);
    logEvent('system', 'wipe', { cycle, cells }, now);
    return { cells };
  });
}

module.exports = { importEnvelope, replaceCycle, wipeCycle, packPixels, bboxOf, PX };
