/* ═══════════════════════════════════════════════════════════════
   make-icons — the interface's icons, drawn on the same grid the
   wall is

     node tools/make-icons.js            rebuild the sprite in index.html
     node tools/make-icons.js --sheet    …and a contact sheet to look at

   The UI ran on emoji, which is three problems in one: they render
   as somebody else's artwork (a different somebody on every OS),
   they cannot take a colour, and half of them are the wrong metaphor
   at 12px. So: a hand-drawn set instead.

   Pixel-grid rather than the rounded-stroke house style everyone
   uses, because this product is a pixel wall — its logo is pixels,
   its typeface is pixels, and a Feather-style 1.5px rounded stroke
   next to `Press Start 2P` looks like it wandered in from a
   different application. Two icons already in the page (the cycle
   calendar and the paint bucket) were drawn this way; the rest now
   match them.

   Each icon is 16×16, authored as `#` and `.`, and compiled to a
   single <path> of merged horizontal runs. They inherit currentColor
   and scale to any size, which is the whole reason they are not
   still emoji.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { eachCell, textWidth } = require('./make-brand.js');

const ROOT = path.join(__dirname, '..');
const N = 16;

/* ── The set ──────────────────────────────────────────────────── */

const ICONS = {
  /* a block with windows and a door — brand accounts and pre-orders */
  brand: [
    '................',
    '..############..',
    '..#..........#..',
    '..#.##.##.##.#..',
    '..#..........#..',
    '..#.##.##.##.#..',
    '..#..........#..',
    '..#.##.##.##.#..',
    '..#..........#..',
    '..#.##.##.##.#..',
    '..#..........#..',
    '..#...####...#..',
    '..#...#..#...#..',
    '..#...#..#...#..',
    '..############..',
    '................'
  ],
  /* MY PIXELS, and anything about elapsed time */
  clock: [
    '................',
    '.....######.....',
    '...##......##...',
    '..#..........#..',
    '.#......#.....#.',
    '.#......#.....#.',
    '#.......#......#',
    '#.......#####..#',
    '#..............#',
    '#..............#',
    '.#............#.',
    '.#............#.',
    '..#..........#..',
    '...##......##...',
    '.....######.....',
    '................'
  ],
  /* waiting on a moderator */
  hourglass: [
    '................',
    '..###########...',
    '..###########...',
    '...#.......#....',
    '....#.....#.....',
    '.....#...#......',
    '......#.#.......',
    '.......#........',
    '......#.#.......',
    '.....#...#......',
    '....#..#..#.....',
    '...#..###..#....',
    '..#.#######.#...',
    '..###########...',
    '..###########...',
    '................'
  ],
  /* approved, verified, live */
  check: [
    '................',
    '................',
    '.............###',
    '............###.',
    '...........###..',
    '..........###...',
    '.........###....',
    '.#......###.....',
    '.##....###......',
    '.###..###.......',
    '..######........',
    '...####.........',
    '....##..........',
    '................',
    '................',
    '................'
  ],
  /* turned down, not received */
  cross: [
    '................',
    '................',
    '..##........##..',
    '..###......###..',
    '...###....###...',
    '....###..###....',
    '.....######.....',
    '......####......',
    '......####......',
    '.....######.....',
    '....###..###....',
    '...###....###...',
    '..###......###..',
    '..##........##..',
    '................',
    '................'
  ],
  /* InstaPay */
  bolt: [
    '................',
    '..........####..',
    '.........####...',
    '........####....',
    '.......####.....',
    '......####......',
    '.....##########.',
    '......#########.',
    '.........###....',
    '........###.....',
    '.......###......',
    '......###.......',
    '.....###........',
    '....###.........',
    '................',
    '................'
  ],
  /* brush tool */
  brush: [
    '................',
    '...........####.',
    '..........#####.',
    '.........#####..',
    '........#####...',
    '.......#####....',
    '......#####.....',
    '.....#####......',
    '....######......',
    '...######.......',
    '..######........',
    '.######.........',
    '.#####..........',
    '.####...........',
    '..##............',
    '................'
  ],
  /* pan / move tool */
  hand: [
    '................',
    '......##........',
    '.....#..#.......',
    '.....#..#.##....',
    '.....#..#.##....',
    '..##.#..#.#.##..',
    '.#..##..#.#.#.#.',
    '.#............#.',
    '.#............#.',
    '..#..........#..',
    '..#..........#..',
    '...#........#...',
    '....#......#....',
    '.....########...',
    '................',
    '................'
  ],
  /* find a free spot */
  search: [
    '................',
    '....######......',
    '...#......#.....',
    '..#........#....',
    '.#..........#...',
    '.#..........#...',
    '.#..........#...',
    '.#..........#...',
    '..#........#....',
    '...#......#.....',
    '....######.##...',
    '..........####..',
    '...........####.',
    '............####',
    '.............###',
    '................'
  ],
  /* something needs reading before it is agreed to */
  warn: [
    '................',
    '.......##.......',
    '.......##.......',
    '......####......',
    '......#..#......',
    '.....##..##.....',
    '.....#.##.#.....',
    '....##.##.##....',
    '....#..##..#....',
    '...##..##..##...',
    '...#...##...#...',
    '..##........##..',
    '..#....##....#..',
    '.##############.',
    '.##############.',
    '................'
  ],
  /* a sponsor's pixels open their site. Two overlapping frames rather than
     a chain link — a chain at 16px is two blobs touching. */
  link: [
    '................',
    '.......#########',
    '.......#.......#',
    '.......#.......#',
    '.###########...#',
    '.#.........#...#',
    '.#.........#...#',
    '.#.........#####',
    '.#.........#....',
    '.#.........#....',
    '.#.........#....',
    '.###########....',
    '................',
    '................',
    '................',
    '................'
  ],
  /* booked ground — somebody else's, or ratio-locked */
  lock: [
    '................',
    '.....######.....',
    '....##....##....',
    '...##......##...',
    '...##......##...',
    '...##......##...',
    '..##########....',
    '..############..',
    '..############..',
    '..####..######..',
    '..###....#####..',
    '..###....#####..',
    '..####..######..',
    '..############..',
    '..############..',
    '................'
  ],
  /* …and released */
  unlock: [
    '................',
    '.....######.....',
    '....##....##....',
    '...##......##...',
    '...##...........',
    '...##...........',
    '..##########....',
    '..############..',
    '..############..',
    '..####..######..',
    '..###....#####..',
    '..###....#####..',
    '..####..######..',
    '..############..',
    '..############..',
    '................'
  ],
  /* yours */
  star: [
    '................',
    '.......##.......',
    '.......##.......',
    '......####......',
    '......####......',
    '#############...',
    '.###########....',
    '..#########.....',
    '...#######......',
    '..#########.....',
    '..###...###.....',
    '.###.....###....',
    '.##.......##....',
    '................',
    '................',
    '................'
  ],
  /* another visitor's pixels */
  person: [
    '................',
    '......####......',
    '.....######.....',
    '.....######.....',
    '.....######.....',
    '......####......',
    '................',
    '...##########...',
    '..############..',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
    '................',
    '................'
  ],
  /* money going back */
  refund: [
    '................',
    '................',
    '..############..',
    '..#..........#..',
    '..#...####...#..',
    '..#..##..##..#..',
    '..#..##..##..#..',
    '..#...####...#..',
    '..#..........#..',
    '..############..',
    '................',
    '.....#..........',
    '....##..........',
    '...###########..',
    '....##..........',
    '.....#..........'
  ],
  /* a paint pack — money with no pixels behind it yet */
  card: [
    '................',
    '................',
    '.##############.',
    '.##############.',
    '.##############.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.#..####......#.',
    '.#..####......#.',
    '.#............#.',
    '.##############.',
    '................',
    '................',
    '................',
    '................'
  ],
  /* next step */
  'arrow-right': [
    '................',
    '................',
    '.......##.......',
    '........##......',
    '.........##.....',
    '..........##....',
    '###############.',
    '###############.',
    '..........##....',
    '.........##.....',
    '........##......',
    '.......##.......',
    '................',
    '................',
    '................',
    '................'
  ],
  /* crop tightly around a logo */
  crop: [
    '................',
    '...##.....##....',
    '...##.....##....',
    '....##...##.....',
    '.....##.##......',
    '......###.......',
    '.......#........',
    '......###.......',
    '.....##.##......',
    '....##...##.....',
    '...###...###....',
    '..##.##.##.##...',
    '..##.##.##.##...',
    '...###...###....',
    '................',
    '................'
  ],
  /* the server is not answering — an unplugged plug */
  offline: [
    '................',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '..##########....',
    '..#........#....',
    '..#........#....',
    '..#........#....',
    '...#......#.....',
    '....######......',
    '......##........',
    '......##........',
    '......##........',
    '................',
    '................',
    '................'
  ],
  /* fit the whole wall on screen — corner brackets, which say "frame the
     lot" where a filled square said "here is a square" */
  fit: [
    '................',
    '..#####....#####',
    '..#####....#####',
    '..##..........##',
    '..##..........##',
    '................',
    '................',
    '................',
    '................',
    '..##..........##',
    '..##..........##',
    '..#####....#####',
    '..#####....#####',
    '................',
    '................',
    '................'
  ],
  /* the wall wiped and started again — a cycle, not a bin. The bin this
     replaced said "deleted", and a monthly reset is not a deletion. */
  reset: [
    '................',
    '.....#####..###.',
    '...##.....#.###.',
    '..#........#####',
    '.#..........###.',
    '.#...........#..',
    '#...............',
    '#...............',
    '#...............',
    '#...............',
    '.#..............',
    '.#............#.',
    '..#..........#..',
    '...##......##...',
    '.....######.....',
    '................'
  ],
  /* it worked — a burst, which survives 16px where a party popper did not */
  celebrate: [
    '................',
    '.......##.......',
    '.......##.......',
    '..#....##....#..',
    '..##...##...##..',
    '...##..##..##...',
    '....##.##.##....',
    '.####..###..####',
    '.####..###..####',
    '....##.##.##....',
    '...##..##..##...',
    '..##...##...##..',
    '..#....##....#..',
    '.......##.......',
    '.......##.......',
    '................'
  ],
  /* the monthly cycle */
  calendar: [
    '................',
    '...##......##...',
    '...##......##...',
    '.##############.',
    '.##############.',
    '.#............#.',
    '.#.##.##.##.##.#',
    '.#............#.',
    '.#.##.##.##.##.#',
    '.#............#.',
    '.#.##.##.##....#',
    '.#............#.',
    '.##############.',
    '................',
    '................',
    '................'
  ],
  /* prepaid pixels — a bucket and a drip, matching the one already drawn
     into the action bar */
  paint: [
    '................',
    '................',
    '..###########...',
    '..###########...',
    '..#.........#...',
    '..#.........#...',
    '...#.......#....',
    '...#.......#....',
    '....#.....#..##.',
    '....#.....#.####',
    '.....#...#..####',
    '.....#####..###.',
    '.............#..',
    '................',
    '................',
    '................'
  ]
};

/* ── Bitmap → path ────────────────────────────────────────────── */

/* Horizontal runs merged into rects, emitted as one subpath each. A
   16×16 icon lands in 200–500 bytes this way, which is small enough that
   inlining the whole set costs less than one HTTP request would. */
function toPath(rows) {
  const grid = rows.concat(Array(Math.max(0, N - rows.length)).fill('.'.repeat(N)));
  const parts = [];
  for (let y = 0; y < N; y++) {
    const row = (grid[y] || '').padEnd(N, '.');
    let x = 0;
    while (x < N) {
      if (row[x] !== '#') { x++; continue; }
      let w = 0;
      while (x + w < N && row[x + w] === '#') w++;
      parts.push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return parts.join('');
}

/* ── The sprite ───────────────────────────────────────────────── */

const START = '<!-- icons:start -->';
const END = '<!-- icons:end -->';

function sprite() {
  const symbols = Object.entries(ICONS).map(([name, rows]) =>
    `      <symbol id="i-${name}" viewBox="0 0 ${N} ${N}"><path d="${toPath(rows)}"/></symbol>`);
  return [
    START,
    '  <!-- Generated by tools/make-icons.js — edit the bitmaps there, not here.',
    '       Inlined rather than loaded as a sprite file so <use> needs no second',
    '       request and no cross-document colour inheritance. -->',
    '  <svg width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute">',
    '    <defs>',
    ...symbols,
    '    </defs>',
    '  </svg>',
    `  ${END}`
  ].join('\n');
}

function inject() {
  const file = path.join(ROOT, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const block = sprite();
  let out;
  if (html.includes(START) && html.includes(END)) {
    out = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block.trim());
  } else {
    /* \r?\n, because git checks this file out with CRLF on Windows and an
       anchor that only knows about \n silently matches nothing — which
       looks exactly like a successful run right up until the page has 26
       <use> elements and no symbols to point at. */
    out = html.replace(/(<body>\r?\n)/, `$1\n${block}\n`);
    if (out === html) throw new Error('could not find <body> to inject after');
  }
  fs.writeFileSync(file, out);
  return Object.keys(ICONS).length;
}

/* ── A contact sheet, so they can be looked at ────────────────── */

/* Drawn at the size they are actually used plus a large one, because an
   icon that reads at 8× and turns to mud at 16px is not an icon. */
function sheet() {
  const SCALE = 4, PAD = 6, LABEL = 9, COL = 6;
  const names = Object.keys(ICONS);
  const cellW = N * SCALE + PAD * 2;
  const cellH = N * SCALE + PAD * 2 + LABEL + 4 + N + PAD;
  const rows = Math.ceil(names.length / COL);
  const png = new PNG({ width: cellW * COL, height: cellH * rows });

  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const o = (y * png.width + x) * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  };
  const BG = [0x21, 0x11, 0x18], INK = [0xF5, 0xC4, 0xC1], DIM = [0x5E, 0x3A, 0x4B];
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) set(x, y, BG);

  names.forEach((name, i) => {
    const ox = (i % COL) * cellW + PAD;
    const oy = Math.floor(i / COL) * cellH + PAD;
    const rowsOf = ICONS[name];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if ((rowsOf[y] || '')[x] !== '#') continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) set(ox + x * SCALE + dx, oy + y * SCALE + dy, INK);
        }
        set(ox + x, oy + N * SCALE + LABEL + 6 + y, INK);      // …and again at 1:1
      }
    }
    const label = name.replace(/-/g, ' ').toUpperCase();
    const lx = ox, ly = oy + N * SCALE + 2;
    eachCell(label.length > 10 ? label.slice(0, 10) : label, (x, y) => set(lx + x, ly + y, DIM));
  });

  const out = path.join(ROOT, 'data', 'icon-sheet.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, PNG.sync.write(png));
  return out;
}

if (require.main === module) {
  const n = inject();
  console.log(`inlined ${n} icons into index.html`);
  if (process.argv.includes('--sheet')) console.log(`contact sheet → ${sheet()}`);
}

module.exports = { ICONS, toPath, sprite, N };
