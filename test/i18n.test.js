/* ═══════════════════════════════════════════════════════════════
   i18n — both dictionaries, and the strings that escaped them

   Consumer Protection Law 181/2018 requires the terms a consumer is
   shown to be in Arabic, and the documents go further: the Arabic
   version is the operative one by their own choice. A payment screen
   that falls back to English for the sentence about what happens to
   your money is not a translation problem, it is the wrong contract.

   Three checks, none of which knows any Arabic:

     every key in one dictionary exists in the other,
     no {placeholder} is answered in one language and not the other,
     and no string that reaches the screen is written in the source
     instead of in a dictionary.

   The third is the one that keeps finding things. app.js is 3,000
   lines and the easiest way to put a sentence on screen is still to
   type it where it is needed.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/* app.js is a browser script, not a module. Rather than parse it, pull the
   two dictionary literals out and evaluate just those — they are plain
   object literals of string values with no references to anything else. */
function dictionaries() {
  const start = SRC.indexOf('const L = {');
  assert.ok(start > 0, 'app.js no longer declares `const L = {` — this test cannot find the dictionaries');

  /* walk the braces so a } inside a string does not end it early */
  let depth = 0, inStr = null, esc = false, end = -1;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    const c = SRC[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, 'could not find the end of the dictionary literal');

  // eslint-disable-next-line no-new-func
  return new Function(`return ${SRC.slice(SRC.indexOf('{', start), end)};`)();
}

const L = dictionaries();

test('the two dictionaries exist and are not obviously truncated', () => {
  assert.ok(L.en && L.ar, 'both languages are present');
  assert.ok(Object.keys(L.en).length > 200, `only ${Object.keys(L.en).length} English keys — the parse went wrong`);
});

test('every string exists in both languages', () => {
  const en = new Set(Object.keys(L.en));
  const ar = new Set(Object.keys(L.ar));

  const missingAr = [...en].filter(k => !ar.has(k));
  const missingEn = [...ar].filter(k => !en.has(k));

  assert.deepEqual(missingAr, [],
    `${missingAr.length} key(s) have no Arabic — an Arabic reader gets the English fallback, ` +
    `which for a term of the sale is the wrong contract, not a rough edge`);
  assert.deepEqual(missingEn, [], `${missingEn.length} key(s) exist only in Arabic`);
});

test('a placeholder answered in one language is answered in the other', () => {
  /* Compared case-insensitively: copyVars supplies both `w` and `W`, the
     same words upper-cased, because English headings are set in caps and
     Arabic has no letter case at all. `{W}` in English against `{w}` in
     Arabic is the correct pair, not a mismatch. */
  const holes = s => (String(s).match(/\{[a-zA-Z]+\}/g) || []).map(h => h.toLowerCase()).sort();
  const wrong = [];

  for (const key of Object.keys(L.en)) {
    if (!(key in L.ar)) continue;                    // reported by the test above
    const a = holes(L.en[key]), b = holes(L.ar[key]);
    if (a.join() !== b.join()) wrong.push(`${key}: en ${a.join(' ') || '—'} / ar ${b.join(' ') || '—'}`);
  }

  /* A hole in one language and not the other means one of two things, and
     both are visible to a user: a literal "{w}" on screen, or a number that
     silently stopped being quoted in the language that dropped it. */
  assert.deepEqual(wrong, [], `placeholders disagree:\n  ${wrong.join('\n  ')}`);
});

test('no sentence reaches the screen without going through a dictionary', () => {
  /* Assignments of a bare English literal to something the user reads. Short
     ones are allowed: "COPY", "0 EGP" and hex colours are not sentences, and
     a rule that flagged them would be turned off within a week. */
  const patterns = [
    /\.(?:textContent|innerHTML)\s*=\s*(['"])((?:[A-Za-z][a-z]+[ ,.]){3,}[^'"]*)\1/g,
    /(?:showErr|toast)\([^,)]*,\s*(['"])((?:[A-Za-z][a-z]+[ ,.]){3,}[^'"]*)\1/g
  ];

  const found = [];
  for (const re of patterns) {
    for (const m of SRC.matchAll(re)) {
      const line = SRC.slice(0, m.index).split('\n').length;
      found.push(`app.js:${line}  "${m[2].slice(0, 60)}"`);
    }
  }

  assert.deepEqual(found, [],
    `${found.length} string(s) are written in the source rather than in the dictionaries, ` +
    `so an Arabic reader sees English:\n  ${found.join('\n  ')}`);
});

test('the acceptance ticks say what the documents say they say', () => {
  /* REFUNDS §6 rests on the buyer having asked for immediate performance.
     If this wording drifts, the section stops describing anything real —
     so the shape of the sentence is pinned in both languages. */
  assert.match(L.en['py.accept'], /as soon as the transfer is confirmed/i);
  assert.match(L.en['py.accept'], /refund policy/i);
  assert.match(L.ar['py.accept'], /أول ما التحويل يتأكد/);
  assert.match(L.ar['py.accept'], /سياسة الاسترداد/);

  /* PRIVACY §11 says we ask for an age confirmation before an account can
     buy. Both acceptance lines carry a capacity statement. */
  assert.match(L.en['au.accept'], /18 or older/i);
  assert.match(L.ar['au.accept'], /١٨/);
  assert.match(L.en['au.acceptBrand'], /on behalf of the business/i);

  /* and every one of them offers the document it names */
  for (const key of ['py.accept', 'au.accept', 'au.acceptBrand']) {
    for (const lang of ['en', 'ar']) {
      assert.match(L[lang][key], /data-legal="(terms|privacy|refunds)"/,
        `${key} (${lang}) names a document without linking it`);
    }
  }
});

test('the promises REFUNDS quotes back are still the ones the app makes', () => {
  /* REFUNDS §7 and §12.5 quote these two verbatim, in both languages, and
     say "the app puts it like this" / "we mean it". A quote that no longer
     matches the app is the document describing a product that changed. */
  const refunds = fs.readFileSync(path.join(__dirname, '..', 'legal', 'REFUNDS.md'), 'utf8');

  const quoted = [
    'If a batch is turned down, the paint comes straight back.',
    'لو دفعة اترفضت، البوية بترجعلك فورًا.',
    'Your logo is reviewed like every other pixel. If it is turned down, the payment is refunded to the InstaPay handle you paid from.',
    'اللوجو بيتراجع زي أي بكسل. لو اترفض، الفلوس بترجع لحساب إنستاباي اللي دفعت منه.'
  ];
  const strings = [L.en['ps.fine'], L.ar['ps.fine'], L.en['cf.fine'], L.ar['cf.fine']];

  quoted.forEach((q, i) => {
    assert.ok(refunds.includes(q), `legal/REFUNDS.md no longer quotes: "${q.slice(0, 50)}…"`);
    assert.ok(strings[i].includes(q),
      `the app no longer says what REFUNDS.md quotes it as saying:\n  quoted: ${q}\n  app:    ${strings[i]}`);
  });
});
