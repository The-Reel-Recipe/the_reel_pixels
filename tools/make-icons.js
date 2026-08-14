/* ═══════════════════════════════════════════════════════════════
   make-icons — the interface's icons

     node tools/make-icons.js            rebuild the sprite in index.html
     node tools/make-icons.js --sheet    …and a page to look at them on
     node tools/make-icons.js --find x   search the library for a name

   The UI ran on emoji, which is three problems in one: they render as
   somebody else's artwork (a different somebody on every OS), they
   cannot take a colour, and half of them are the wrong metaphor at
   12px.

   The replacement is `pixelarticons` — 564 icons drawn on a 24×24
   grid, MIT, by Gerrit Halfmann. Pixel-art rather than the
   rounded-stroke house style everyone else ships, which matters here
   more than it usually would: this product is a pixel wall, its logo
   is pixels and its typeface is pixels, so a 1.5px rounded stroke
   would look like it wandered in from a different application.

   A **dev** dependency on purpose. The chosen icons are compiled into
   index.html as inline <symbol>s by this script, so nothing from the
   package is on the runtime path and PLAN §1's two-dependency rule
   still holds — `npm ci --omit=dev` on the server installs
   better-sqlite3 and pngjs and nothing else.

   To change an icon: edit MAP, re-run, look at the sheet.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'node_modules', 'pixelarticons', 'svg');

/* ── What the page asks for → what the library calls it ───────── */

/* Left column is the name the code uses, and it stays stable: `refund`
   means "money going back" whatever picture ends up representing it. */
const MAP = {
  /* identity and ownership */
  brand: 'building',            // brand accounts, pre-orders, sponsor pixels
  person: 'user',               // somebody else's pixels
  star: 'star',                 // yours

  /* time */
  clock: 'clock',               // MY PIXELS, and anything historical
  loader: 'loader',             // waiting on a moderator
  timer: 'alarm-clock',         // the free-pixel refill counting down
  calendar: 'calendar',         // the monthly cycle

  /* decisions */
  check: 'check',               // approved, verified, live
  cross: 'close',               // turned down, not received
  warn: 'square-alert',         // read this before agreeing to it

  /* money */
  bolt: 'zap',                  // InstaPay
  card: 'credit-card',          // a paint pack — money with no pixels yet
  refund: 'money',              // money going back
  /* A spray can rather than a swatch or a bucket. The swatch read as a bar
     chart at 12px, and the product is called "scribble on the wall" — if
     any icon in the set gets to be on the nose, it is this one. */
  paint: 'spray-can',           // prepaid pixels

  /* tools */
  hand: 'hand',                 // pan
  brush: 'brush',               // paint
  /* pixelarticons has no eraser; `delete` is the backspace key, which is
     the set's own "take this back" glyph and the closest honest match. */
  eraser: 'delete',             // rub pixels back out of the basket
  search: 'search',             // find a free spot
  crop: 'scissors',             // crop tightly around a logo
  fit: 'scale',                 // fit the whole wall on screen

  /* state */
  lock: 'lock',                 // booked ground, or a locked ratio
  unlock: 'unlock',
  link: 'external-link',        // a sponsor's pixels open their site
  offline: 'power-off',         // the server is not answering
  reset: 'reload',              // the wall wiped and started again
  celebrate: 'party-popper',    // it worked
  'arrow-right': 'arrow-right', // next step
  chevron: 'chevron-down',      // the colour picker opens downwards

  /* the glass shell (mobile-first remake) */
  home: 'home',                 // the wall itself — the nav's front door
  bell: 'bell',                 // notifications
  more: 'more-horizontal',      // everything that is not a front door
  globe: 'languages',           // Arabic <-> English
  login: 'login',
  logout: 'logout',
  mail: 'mail'                  // the account an email turns a guest into
};

/* ── Reading the library ──────────────────────────────────────── */

function read(name) {
  const file = path.join(LIB, `${name}.svg`);
  if (!fs.existsSync(file)) {
    const near = fs.readdirSync(LIB)
      .filter(f => f.endsWith('.svg') && f.includes(name.split('-')[0]))
      .slice(0, 8).map(f => f.replace('.svg', ''));
    throw new Error(`pixelarticons has no "${name}"` +
      (near.length ? ` — did you mean: ${near.join(', ')}?` : ''));
  }
  const svg = fs.readFileSync(file, 'utf8');
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').trim();
  const box = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';
  if (!body) throw new Error(`${name}.svg is empty`);
  return { body: body.replace(/\s+/g, ' '), box };
}

/* ── The sprite ───────────────────────────────────────────────── */

const START = '<!-- icons:start -->';
const END = '<!-- icons:end -->';

function sprite() {
  const symbols = Object.entries(MAP).map(([ours, theirs]) => {
    const { body, box } = read(theirs);
    return `      <symbol id="i-${ours}" viewBox="${box}">${body}</symbol>`;
  });
  return [
    START,
    '  <!-- Generated by tools/make-icons.js from pixelarticons (MIT, Gerrit',
    '       Halfmann) — change the mapping there, not the markup here. Inlined',
    '       rather than fetched as a sprite file so <use> needs no second',
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
       looks exactly like a successful run right up until the page has
       twenty-odd <use> elements and no symbols to point at. */
    out = html.replace(/(<body>\r?\n)/, `$1\n${block}\n`);
    if (out === html) throw new Error('could not find <body> to inject after');
  }
  fs.writeFileSync(file, out);
  return Object.keys(MAP).length;
}

/* ── A sheet, so they can be looked at ────────────────────────── */

/* HTML rather than a rendered PNG, because these are vector paths and the
   only honest way to check an icon is to see it drawn by the thing that
   will be drawing it — at the size it is actually used, on the colour it
   is actually on. */
function sheet() {
  const cells = Object.keys(MAP).map(name =>
    `    <figure>
      <span class="row">
        <svg class="ic sm"><use href="#i-${name}"/></svg>
        <svg class="ic md"><use href="#i-${name}"/></svg>
        <svg class="ic lg"><use href="#i-${name}"/></svg>
      </span>
      <figcaption>${name}<small>${MAP[name]}</small></figcaption>
    </figure>`).join('\n');

  const html = `<!DOCTYPE html>
<meta charset="utf-8"><title>S37 icons</title>
<style>
  body { background:#211118; color:#F5C4C1; font:14px system-ui; margin:0; padding:28px; }
  h1 { font-size:15px; letter-spacing:2px; margin:0 0 22px; }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
  figure { margin:0; border:1px solid #3E2532; border-radius:6px; padding:14px; background:#1A0D13; }
  .row { display:flex; align-items:center; gap:12px; min-height:44px; }
  .ic { fill:currentColor; }
  .sm { width:12px; height:12px; }   /* a chip label */
  .md { width:20px; height:20px; }   /* a button */
  .lg { width:40px; height:40px; }   /* the success screens */
  figcaption { margin-top:10px; font-size:12px; color:#C3A6AF; }
  figcaption small { display:block; color:#5E3A4B; font-size:11px; }
</style>
<h1>S37 ICONS — 12px · 20px · 40px</h1>
${sprite().split('\n').slice(1, -1).join('\n')}
<div class="grid">
${cells}
</div>`;

  const out = path.join(ROOT, 'data', 'icons.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return out;
}

/* ── ─────────────────────────────────────────────────────────── */

if (require.main === module) {
  const args = process.argv.slice(2);
  const find = args.indexOf('--find');
  if (find >= 0) {
    const q = (args[find + 1] || '').toLowerCase();
    const hits = fs.readdirSync(LIB)
      .filter(f => f.endsWith('.svg') && !f.endsWith('-sharp.svg'))
      .map(f => f.replace('.svg', ''))
      .filter(n => n.includes(q));
    console.log(hits.length ? hits.join('\n') : `nothing matching "${q}"`);
  } else {
    console.log(`inlined ${inject()} icons into index.html`);
    if (args.includes('--sheet')) console.log(`sheet → ${sheet()}`);
  }
}

module.exports = { MAP, read, sprite };
