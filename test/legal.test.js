/* ═══════════════════════════════════════════════════════════════
   legal — the documents, and the two ways they can go wrong

   A policy page fails in exactly two directions, and both are worse
   than having no page at all.

   It can ship unfinished — "[[OPERATOR LEGAL NAME]] will refund you
   within 7 days" is not a weaker promise than a filled one, it is
   evidence that nobody read the document before publishing it.

   Or it can drift — the notice publishes a retention period, the
   code enforces a different one, and the gap sits there unnoticed
   until somebody asks. legal/operator.json and server/config.js
   have no reason to agree on their own, so this is the reason.

   Neither check knows anything about the law. They only insist
   that what is published is finished, and that it is true of the
   code sitting next to it.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-legal-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
delete process.env.VERCEL;

const cfg = require('../server/config.js');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const published = JSON.parse(fs.readFileSync(path.join(ROOT, 'legal', 'operator.json'), 'utf8'));

/* The six pages tools/make-legal.js writes. Absent is fine — that is a
   repository nobody has published from yet. Present and unfinished is not. */
const PAGES = ['terms.html', 'privacy.html', 'refunds.html',
  'terms.ar.html', 'privacy.ar.html', 'refunds.ar.html'];

/* ── unfinished ───────────────────────────────────────────────── */

test('no published page carries an unanswered placeholder', () => {
  for (const name of PAGES) {
    const file = path.join(ROOT, 'assets', name);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');

    const gaps = html.match(/\[\[[^\]]+\]\]/g);
    assert.equal(gaps, null,
      `assets/${name} still has ${gaps && gaps.length} unfilled: ${gaps && gaps.slice(0, 3).join(', ')}`);

    /* --draft marks them up instead of leaving the brackets in. A draft is
       for looking at locally; it must never be what a customer reads. */
    assert.ok(!html.includes('class="gap"'),
      `assets/${name} is a --draft build — rebuild without the flag before committing`);
  }
});

test('the app only offers a link once the page behind it exists', () => {
  /* The wall snapshot carries meta.legal, and the client hides the links
     when it is false. This is the pair to the check above: a half-published
     set would have the flag on and one link broken, which is the failure
     this whole arrangement exists to make impossible. */
  const wall = fs.readFileSync(path.join(ROOT, 'server', 'wall.js'), 'utf8');
  assert.match(wall, /legal:\s*legalPublished\(\)/,
    'wall.js no longer reports whether the documents are published');

  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /showLegalLinks\(meta\.legal !== false\)/,
    'app.js no longer acts on the flag — the links would show whether or not the pages exist');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<nav class="more-legal"[^>]*\shidden/,
    'the links must start hidden, or they flash before the wall snapshot arrives');

  /* The unwrap is destructive and the sweep only rebuilds what the
     dictionaries render, so an anchor written in index.html that got
     unwrapped at boot — before the snapshot said the pages exist — never
     came back when it said they did. It must only ever unwrap dictionary
     content. */
  assert.match(app, /a\.closest\('\[data-i18n-html\]'\)\s*\)\s*a\.replaceWith/,
    'syncLegalLinks must only unwrap anchors the i18n sweep will rebuild');
});

test('the pages are all present, or all absent', () => {
  const here = PAGES.filter(n => fs.existsSync(path.join(ROOT, 'assets', n)));
  assert.ok(here.length === 0 || here.length === PAGES.length,
    `${here.length} of ${PAGES.length} pages exist — a half-published set means a link ` +
    `in the app leads to a 404, and the missing one is usually the Arabic. ` +
    `Missing: ${PAGES.filter(n => !here.includes(n)).join(', ')}`);
});

/* ── drift ────────────────────────────────────────────────────── */

/* Each published period is free text — "180 days", "24 months", "5 years" —
   because that is how it has to read on the page. Parsing it back to days is
   what lets the sentence stay readable and the comparison stay exact.
   A month is 30 days on both sides; see the note in config.js. */
function toDays(s) {
  const m = /^(\d+)\s*(day|days|month|months|year|years)$/i.exec(String(s).trim());
  assert.ok(m, `"${s}" is not a period this can check — write it as "N days/months/years"`);
  const n = Number(m[1]);
  return /^day/i.test(m[2]) ? n : /^month/i.test(m[2]) ? n * 30 : n * 365;
}

/* Values that read as prose carry both languages. The English side is the one
   this can parse; the Arabic is checked for presence, because the Arabic is
   the operative text and a missing one means the binding version has a hole. */
function en(key) {
  const v = published[key];
  assert.ok(v, `legal/operator.json is missing ${key}`);
  if (typeof v === 'object') {
    assert.ok(v.ar, `${key} has no Arabic — the Arabic version is the one that applies`);
    assert.ok(v.en, `${key} has no English`);
    return v.en;
  }
  return v;
}

test('what the privacy notice publishes is what the sweep enforces', () => {
  const pairs = [
    ['IP RETENTION', cfg.RETAIN_IP],
    ['SUBMISSION RETENTION', cfg.RETAIN_SUBMISSION],
    ['SCREENSHOT RETENTION', cfg.RETAIN_SCREENSHOT]
  ];

  for (const [key, enforcedMs] of pairs) {
    const value = en(key);
    assert.equal(toDays(value), enforcedMs / DAY,
      `the notice publishes "${value}" for ${key}, the sweep enforces ${enforcedMs / DAY} days`);
  }

  assert.equal(Number(en('DORMANT ACCOUNT MONTHS')) * 30, cfg.RETAIN_DORMANT / DAY,
    'the notice and config.RETAIN_DORMANT disagree about how long an idle account lives');
});

test('what the notice says a cookie lasts is what the cookie lasts', () => {
  assert.equal(toDays(en('GUEST COOKIE LIFETIME')), cfg.GUEST_TTL / DAY);
  assert.equal(toDays(en('BRAND COOKIE LIFETIME')), cfg.BRAND_TTL / DAY);
});

/* ── the file itself ──────────────────────────────────────────── */

test('every answer is a string, a null, or both languages', () => {
  for (const [key, v] of Object.entries(published)) {
    if (key.startsWith('_')) continue;                 // notes to the operator
    if (v === null || typeof v === 'string') continue;
    assert.equal(typeof v, 'object', `${key} is a ${typeof v}, which nothing can publish`);
    assert.deepEqual(Object.keys(v).sort(), ['ar', 'en'],
      `${key} must carry exactly en and ar, got ${Object.keys(v).join(', ')}`);
  }
});

test('nobody has written an admission into the imprint', () => {
  /* The registration lines are meant to be omitted (null) until they exist.
     Filling one with "not registered", "none" or "N/A" turns a neutral
     silence into a dated, signed statement handed to a regulator. */
  const forbidden = /\b(not\s+registered|unregistered|none|n\/?a|لا\s+يوجد|غير\s+مسجل)\b/i;
  const keys = ['COMMERCIAL REGISTRATION NUMBER', 'TAX REGISTRATION NUMBER',
    'COMMERCIAL / TAX REGISTRATION NUMBER'];

  for (const key of keys) {
    const v = published[key];
    if (v === null || v === undefined || v === '') continue;
    for (const s of typeof v === 'object' ? Object.values(v) : [v]) {
      assert.ok(!forbidden.test(String(s)),
        `${key} says "${s}". Leave it null instead — omitting the line is neutral, ` +
        `saying so is an admission.`);
    }
  }
});
