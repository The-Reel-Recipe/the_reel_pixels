/* ═══════════════════════════════════════════════════════════════
   render — what a moderator actually looks at

   A submission on its own tells you nothing. Twelve pixels spelling
   something vile look identical to twelve pixels of confetti until
   you can see what is around them, which is why PLAN §5 asks for the
   drawing zoomed *out* with its neighbours rather than cropped tight:
   the abuse this catches is almost always the surrounding context,
   not the shape.

   Two panels per card:

     A  the submission's bounding box grown by max(2×bbox, 64) on each
        side and clamped to the wall. Existing approved pixels drawn
        normally, the new ones at full colour inside a thin
        black·white·black ring — dark and light bands so it reads
        against any colour underneath — so there is never a question
        about which is which, and unpainted ground as a pale
        checkerboard so white artwork is still visible against it.

     B  the whole 1000×1000 wall at 256px with a red box where the
        submission sits — "is this in the middle of somebody's logo"
        is a question panel A cannot answer.

   pngjs, no native dependency: the wall is flat colours and integer
   nearest-neighbour scaling, which is the one kind of image resize
   that wants no interpolation at all.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const cfg = require('./config.js');

const { W, H } = cfg;
const PX = 7;                                   // packed [u32 idx · u8 r · u8 g · u8 b]

/* the card's own furniture, in the project's colours */
const BG = [0x1B, 0x0F, 0x16];                  // plum, the shell
const RING_STRIPES = [[0, 0, 0], [255, 255, 255], [0, 0, 0]];  // black·white·black
const LOCATOR = [0xE2, 0x3B, 0x2E];             // the shirt-print red
const PAPER = [0xFF, 0xFF, 0xFF];
const CHECK_A = [0xEC, 0xEC, 0xEC];
const CHECK_B = [0xF8, 0xF8, 0xF8];

const MAX_PANEL = 1024;                         // Telegram re-encodes anything larger anyway
const LOCATOR_SIZE = 256;
const MARGIN = 12;
const GAP = 10;

/* ── small canvas ─────────────────────────────────────────────── */

/* Enough of a drawing surface for two rectangles and some blitting. Kept
   local rather than pulled from tools/export-wall-png.js because that one
   renders the wall 1:1 on white and this one needs neither. */
function surface(w, h, fill) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = fill[0]; png.data[o + 1] = fill[1]; png.data[o + 2] = fill[2]; png.data[o + 3] = 255;
  }
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    png.data[o] = rgb[0]; png.data[o + 1] = rgb[1]; png.data[o + 2] = rgb[2]; png.data[o + 3] = 255;
  };
  const block = (x, y, bw, bh, rgb) => {
    for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) put(x + dx, y + dy, rgb);
  };
  const box = (x, y, bw, bh, rgb, weight = 1) => {
    for (let t = 0; t < weight; t++) {
      for (let dx = 0; dx < bw; dx++) { put(x + dx, y + t, rgb); put(x + dx, y + bh - 1 - t, rgb); }
      for (let dy = 0; dy < bh; dy++) { put(x + t, y + dy, rgb); put(x + bw - 1 - t, y + dy, rgb); }
    }
  };
  return { png, w, h, put, block, box };
}

const rgb = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/* ── unpacking ────────────────────────────────────────────────── */

/* submissions.pixels is the packed blob from §2; a Map is what both panels
   want, and it doubles as the "is this one of the new ones" test. */
function unpack(blob) {
  const out = new Map();
  if (!blob || !blob.length) return out;
  for (let o = 0; o + PX <= blob.length; o += PX) {
    out.set(blob.readUInt32LE(o), (blob[o + 4] << 16) | (blob[o + 5] << 8) | blob[o + 6]);
  }
  return out;
}

/* ── Panel A: the drawing, in context ─────────────────────────── */

function contextPanel(mine, bbox, live) {
  const [x0, y0, x1, y1] = bbox;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  /* §5: grow by twice the drawing, never less than 64 cells. A 3-pixel
     scribble gets a 131-cell view; a 400-cell logo gets its own size again
     on every side, which is what makes "what is it sitting next to" answerable. */
  const pad = Math.max(2 * Math.max(bw, bh), 64);
  const rx0 = Math.max(0, x0 - pad), ry0 = Math.max(0, y0 - pad);
  const rx1 = Math.min(W - 1, x1 + pad), ry1 = Math.min(H - 1, y1 + pad);
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;

  /* integer scaling only — a fractional resize of flat colour pixels is
     how you turn a legible drawing into porridge */
  const scale = Math.max(1, Math.floor(MAX_PANEL / Math.max(rw, rh)));
  const s = surface(rw * scale, rh * scale, BG);

  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const idx = y * W + x;
      const px = (x - rx0) * scale, py = (y - ry0) * scale;
      const own = mine.get(idx);
      if (own !== undefined) { s.block(px, py, scale, scale, rgb(own)); continue; }
      const there = live.get(idx);
      if (there !== undefined) { s.block(px, py, scale, scale, rgb(there)); continue; }
      /* unpainted. A checkerboard rather than flat white, so a submission
         painted white is still something a moderator can see. */
      const checkSize = Math.max(1, Math.round(8 / Math.max(1, scale / 4)));
      const on = (Math.floor(x / checkSize) + Math.floor(y / checkSize)) % 2 === 0;
      s.block(px, py, scale, scale, on ? CHECK_A : CHECK_B);
    }
  }
  s.box(0, 0, s.w, s.h, BG, 1);            // an edge, so the panel reads as one

  /* The ring: a thin black·white·black band along every edge where the new
     pixels meet something that isn't itself, drawn after the fill so it
     always wins. Fixed at a few panel pixels regardless of `scale`, rather
     than the full cell — a ring as thick as the zoom factor swallows
     exactly the pixels it exists to point at on a heavily zoomed-in crop.

     Orthogonal edges only, each stroked on its own single axis, and where
     two edges land on the same neighbouring cell (the inside of a notch)
     the second stroke simply overwrites the first rather than blending
     with it. Blending by distance-to-nearest-edge was the tidier idea,
     but on a concave shape a cell can be close to two edges at once, and
     banding *that* distance draws nested L-shaped contours around the
     corner — small spirals, not a line. A flat overwrite gives up a mitred
     corner for one that's always unambiguously a straight, readable
     stroke. */
  const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const bandPx = Math.max(1, Math.floor(scale / (RING_STRIPES.length * 2)));
  const ringDepth = bandPx * RING_STRIPES.length;
  for (const idx of mine.keys()) {
    const x = idx % W, y = Math.floor(idx / W);
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx, ny = y + dy;
      if (nx < rx0 || ny < ry0 || nx > rx1 || ny > ry1) continue;
      if (mine.has(ny * W + nx)) continue;
      const bx = (nx - rx0) * scale, by = (ny - ry0) * scale;
      for (let oy = 0; oy < scale; oy++) {
        for (let ox = 0; ox < scale; ox++) {
          const dist = dx !== 0 ? (dx < 0 ? scale - 1 - ox : ox) : (dy < 0 ? scale - 1 - oy : oy);
          if (dist < ringDepth) s.put(bx + ox, by + oy, RING_STRIPES[Math.floor(dist / bandPx)]);
        }
      }
    }
  }
  return s;
}

/* ── Panel B: where on the wall ───────────────────────────────── */

function locatorPanel(bbox, live) {
  const n = LOCATOR_SIZE;
  const s = surface(n, n, PAPER);
  /* One sample per output pixel. At 1000→256 this drops detail, which is
     the point: the question is "whereabouts", not "what". */
  const step = W / n;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const c = live.get(Math.floor(py * step) * W + Math.floor(px * step));
      if (c !== undefined) s.put(px, py, rgb(c));
    }
  }

  const [x0, y0, x1, y1] = bbox;
  /* A 12px floor with crosshairs out to the edges. Without them a small
     claim is a 4-pixel dot on a 256-pixel square, which answers the
     question in theory and not at all in practice. */
  const bw = Math.max(12, Math.ceil((x1 - x0 + 1) / step));
  const bh = Math.max(12, Math.ceil((y1 - y0 + 1) / step));
  const bx = Math.min(Math.max(0, Math.floor(x0 / step) - 2), n - bw);
  const by = Math.min(Math.max(0, Math.floor(y0 / step) - 2), n - bh);
  const cx = bx + Math.floor(bw / 2), cy = by + Math.floor(bh / 2);
  for (let x = 0; x < n; x++) if (x < bx - 1 || x > bx + bw) s.put(x, cy, LOCATOR);
  for (let y = 0; y < n; y++) if (y < by - 1 || y > by + bh) s.put(cx, y, LOCATOR);
  s.box(bx, by, bw, bh, LOCATOR, 2);
  s.box(0, 0, n, n, BG, 1);
  return s;
}

/* ── the card ─────────────────────────────────────────────────── */

function compose(a, b) {
  const w = Math.max(a.w, b.w) + MARGIN * 2;
  const h = a.h + GAP + b.h + MARGIN * 2;
  const card = surface(w, h, BG);
  const blit = (src, ox, oy) => {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const o = (y * src.w + x) * 4;
        card.put(ox + x, oy + y, [src.png.data[o], src.png.data[o + 1], src.png.data[o + 2]]);
      }
    }
  };
  blit(a, MARGIN + Math.floor((w - MARGIN * 2 - a.w) / 2), MARGIN);
  blit(b, MARGIN + Math.floor((w - MARGIN * 2 - b.w) / 2), MARGIN + a.h + GAP);
  return PNG.sync.write(card.png);
}

/* `live` is the wall cache's map (idx -> { c, o }) or anything with the same
   get(); normalised here so callers can hand over whichever they hold. */
function asColors(live) {
  const out = new Map();
  if (!live) return out;
  for (const [idx, v] of live) out.set(idx, typeof v === 'number' ? v : v.c);
  return out;
}

/* Renders and files the card, returning the path. Kept on disk rather than
   in memory because §2 wants preview_path for the audit trail — the picture
   a decision was made from is evidence, and it outlives the message. */
function cardFor(sub, live, opts) {
  const mine = unpack(sub.pixels);
  const bbox = JSON.parse(sub.bbox || '[0,0,0,0]');
  const colors = asColors(live);
  const png = compose(contextPanel(mine, bbox, colors), locatorPanel(bbox, colors));

  const dir = path.join(cfg.DATA_DIR, 'previews');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `s${sub.id}.png`);
  fs.writeFileSync(file, png);
  return (opts && opts.buffer) ? { file, png } : file;
}

module.exports = { cardFor, contextPanel, locatorPanel, compose, unpack, asColors, surface };
