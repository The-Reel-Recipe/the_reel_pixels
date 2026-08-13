/* ═══════════════════════════════════════════════════════════════
   make-brand — every branded artifact in the repo, from one run

     node tools/make-brand.js

   Writes assets/logo-icon.png, assets/logo-wordmark.png and the
   committed starting artwork in seed.bin. All three used to carry
   The Reel Recipe's marks — and seed.bin additionally carried five
   real trademarks (Coca-Cola, Pepsi, Nike, McDonald's, Samsung) as
   placeholder "sponsors", which was never shippable. Regenerating
   beats hand-editing a binary, and it means the mark can be moved
   without opening an image editor.

   Everything here is drawn from one 5×7 pixel font, because the
   product is a pixel wall and a vector logo on it would be a lie.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const W = 1000, H = 1000;

/* ── The font ─────────────────────────────────────────────────── */

/* 5 wide, 7 tall, one glyph per key, `#` on and `.` off. Only the
   characters the name needs — adding one is four lines of dots. */
const FONT = {
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....']
};
const GLYPH_W = 5, GLYPH_H = 7, TRACK = 1;      // TRACK = blank columns between glyphs

const textWidth = s => s.length * GLYPH_W + Math.max(0, s.length - 1) * TRACK;

/* Calls back with every lit cell of `text`, in logical font pixels with
   the top-left of the string at (0,0). Scaling is the caller's job — the
   icon wants 8× blocks, the wall wants 1 cell per font pixel. */
function eachCell(text, fn) {
  let ox = 0;
  for (const ch of String(text).toUpperCase()) {
    const g = FONT[ch];
    if (!g) { ox += GLYPH_W + TRACK; continue; }
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) if (g[y][x] === '#') fn(ox + x, y);
    }
    ox += GLYPH_W + TRACK;
  }
}

/* ── Palette ──────────────────────────────────────────────────── */

/* The theme pink is the t-shirt in the reference photo; the plum is what
   the UI shell is built on. The wall itself is white paper, so artwork
   that lands *on it* uses the deeper rose — the pale pink is a UI accent
   and would read as almost-blank on white. */
const PINK = 0xF4C3CA;        // shirt pink — accent on dark
const ROSE = 0xD81B60;        // the same hue with enough weight for white paper
const PLUM = 0x2B1620;        // ink
const PLUM_DEEP = 0x1B0F16;   // tile background

const CONFETTI = [ROSE, PINK, 0xF06292, 0xAD1457, 0xFF8FA3, 0x7B2D4B,
  0xFFD23F, 0x59C2FF, 0x22C55E, 0x8B5CF6];

/* ── PNG helpers ──────────────────────────────────────────────── */

/* A logical `w`×`h` grid blown up `scale`× with no interpolation — pixel
   art survives being scaled only if every source pixel becomes an exact
   square block, which is what nearest-neighbour by hand gets us. */
function grid(w, h, scale) {
  const png = new PNG({ width: w * scale, height: h * scale });
  png.data.fill(0);                                    // transparent
  const put = (x, y, color, alpha = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const o = ((y * scale + dy) * w * scale + (x * scale + dx)) * 4;
        png.data[o] = (color >> 16) & 255;
        png.data[o + 1] = (color >> 8) & 255;
        png.data[o + 2] = color & 255;
        png.data[o + 3] = alpha;
      }
    }
  };
  return { png, put };
}

function write(file, png) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

/* ── The icon ─────────────────────────────────────────────────── */

/* 20×20 logical, 6× blocks → 120×120. An S on a plum tile: at favicon
   size a three-character mark is mud, and the S is the one glyph that
   still reads at 16 device pixels. 20 rather than 16 because the S is
   14 logical pixels tall at 2× and needs air around it — at 16 it fused
   with the frame and read as a 5. */
function icon() {
  const S = 20, scale = 6, m = 1;                 // m = corner notch depth
  const { png, put } = grid(S, S, scale);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // single-pixel notch on each corner: reads as a drawn tile, not a crop
      const nx = Math.min(x, S - 1 - x), ny = Math.min(y, S - 1 - y);
      if (nx + ny < m) continue;
      const edge = nx === 0 || ny === 0 || nx + ny === m;
      put(x, y, edge ? PLUM : PLUM_DEEP);
    }
  }
  // the S at 2×: 5×7 → 10×14, centred with 5px of air each side
  const sx = Math.round((S - GLYPH_W * 2) / 2), sy = Math.round((S - GLYPH_H * 2) / 2);
  eachCell('S', (x, y) => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(sx + x * 2 + dx, sy + y * 2 + dy, PINK);
  });
  return write(path.join(ROOT, 'assets', 'logo-icon.png'), png);
}

/* ── The wordmark ─────────────────────────────────────────────── */

/* S37 over the name it stands for, transparent background so it can sit
   on any surface. Not referenced by index.html — it exists for the OG
   image, the README and anywhere else the name has to be a picture. */
function wordmark() {
  const top = 'S37', bottom = 'SHAKHBAT 3AL 7EET';
  const topScale = 3, gap = 3;
  const w = Math.max(textWidth(top) * topScale, textWidth(bottom));
  const h = GLYPH_H * topScale + gap + GLYPH_H;
  const { png, put } = grid(w, h, 4);

  const topX = Math.round((w - textWidth(top) * topScale) / 2);
  eachCell(top, (x, y) => {
    for (let dy = 0; dy < topScale; dy++) {
      for (let dx = 0; dx < topScale; dx++) put(topX + x * topScale + dx, y * topScale + dy, PINK);
    }
  });
  const botX = Math.round((w - textWidth(bottom)) / 2);
  eachCell(bottom, (x, y) => put(botX + x, GLYPH_H * topScale + gap + y, PINK));

  return write(path.join(ROOT, 'assets', 'logo-wordmark.png'), png);
}

/* ── The starting wall ────────────────────────────────────────── */

/* seed.bin is the artwork a virgin database adopts (wall.js importOnce),
   in the same envelope the client and server already speak:
     [u32 metaLen][meta JSON][u32 aCount][a…][u32 bCount][b…]
     entry = u32 idx · u8 r · u8 g · u8 b · u16 ownerId   (9 bytes)

   No brand owners and no `brands` map at all: the previous seed shipped
   five trademarks it had no licence to, and a fresh wall with nothing
   booked on it is the honest picture anyway. */
const ENTRY = 9;

function encodeEnvelope(meta, a, b = []) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const buf = Buffer.allocUnsafe(4 + json.length + 4 + a.length * ENTRY + 4 + b.length * ENTRY);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  for (const list of [a, b]) {
    buf.writeUInt32LE(list.length, o); o += 4;
    for (const [idx, c, own] of list) {
      buf.writeUInt32LE(idx, o); o += 4;
      buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
      buf.writeUInt16LE(own, o); o += 2;
    }
  }
  return buf;
}

/* Deterministic scatter — a committed artifact that changes every time it
   is regenerated makes for a noisy diff and an unreviewable one. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  const owners = [];
  const ids = new Map();
  const ownerId = (n, t) => {
    const k = n + '\0' + t;
    if (!ids.has(k)) { ids.set(k, owners.length); owners.push({ n, t }); }
    return ids.get(k);
  };

  const live = [];
  const used = new Set();
  const put = (x, y, color, owner) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (used.has(i)) return;
    used.add(i);
    live.push([i, color, owner]);
  };
  const stamp = (text, scale, cx, top, color, owner) => {
    const x0 = Math.round(cx - (textWidth(text) * scale) / 2);
    eachCell(text, (x, y) => {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) put(x0 + x * scale + dx, top + y * scale + dy, color, owner);
      }
    });
  };

  const house = ownerId('S37', 'u');
  stamp('S37', 12, 500, 372, ROSE, house);                  // 204 × 84
  stamp('SHAKHBAT 3AL 7EET', 4, 500, 484, PLUM, house);     // 404 × 28

  // a chalk rule under the name, the way a scribble on a wall gets underlined
  for (let x = 500 - 210; x <= 500 + 210; x++) {
    const y = 528 + Math.round(Math.sin((x - 290) / 26) * 2);
    put(x, y, ROSE, house);
    put(x, y + 1, ROSE, house);
  }

  // …and the wall it lives on: other people's pixels, scattered but fixed.
  //
  // The owner is only interned once the pixel is known to land. An owner with
  // no cells is dropped on import (seed.js skips empty buckets) but would
  // still hold its slot in this table, and the wall cache hands out owner ids
  // by submission — one skipped owner and every id after it shifts by one,
  // which the contract test sees as the whole payload drifting.
  const rnd = mulberry32(0x53333700);
  for (let n = 0; n < 340; n++) {
    // all four draws happen every pass, landed or not, so the scatter stays
    // reproducible no matter which ones collide
    const x = 8 + Math.floor(rnd() * (W - 16));
    const y = 8 + Math.floor(rnd() * (H - 16));
    const name = `Pixel fan #${Math.floor(rnd() * 9000) + 1000}`;
    const color = CONFETTI[Math.floor(rnd() * CONFETTI.length)];
    if (used.has(y * W + x)) continue;
    put(x, y, color, ownerId(name, 'u'));
  }

  const buf = encodeEnvelope({ owners, brands: {}, nextBrands: {} }, live, []);
  fs.writeFileSync(path.join(ROOT, 'seed.bin'), buf);
  return { file: path.join(ROOT, 'seed.bin'), pixels: live.length, owners: owners.length, bytes: buf.length };
}

/* ── ─────────────────────────────────────────────────────────── */

if (require.main === module) {
  console.log(`wrote ${path.relative(ROOT, icon())}`);
  console.log(`wrote ${path.relative(ROOT, wordmark())}`);
  const s = seed();
  console.log(`wrote ${path.relative(ROOT, s.file)} — ${s.pixels} pixels, ${s.owners} owners, ${s.bytes} bytes`);
}

module.exports = { FONT, GLYPH_W, GLYPH_H, TRACK, textWidth, eachCell, PINK, ROSE, PLUM };
