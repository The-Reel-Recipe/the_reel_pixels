/* ═══════════════════════════════════════════════════════════════
   make-legal — the published policy pages

     node tools/make-legal.js            build assets/*.html
     node tools/make-legal.js --draft    build with the gaps left visible
     node tools/make-legal.js --check    say what is still unfilled, write nothing

   The documents live in legal/*.md and legal/ar/*.md. This turns them
   into pages the server already knows how to serve: PUBLIC_DIRS in
   http.js includes /assets/, and TYPES['.html'] is text/html, so
   assets/terms.html is a real URL with no route to add.

   Two rules the whole file exists to enforce.

   One source. Editing the markdown and re-running is the only way to
   change a published page; nobody hand-edits the HTML, so the version
   a customer read and the version in the repository cannot drift. A
   document that says something the operator cannot produce a copy of
   is worse than no document.

   No half-filled page. Every [[PLACEHOLDER]] is answered from
   legal/operator.json, and a missing answer stops the build. A page
   reading "[[OPERATOR LEGAL NAME]] will refund you within 7 days" is
   not a weaker promise than a filled one — it is evidence nobody read
   it before publishing.

   Deliberately not a markdown library: PLAN §1's dependency rule
   still holds, and these documents use a small, known subset.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets');
const CONF = path.join(ROOT, 'legal', 'operator.json');

const DRAFT = process.argv.includes('--draft');
const CHECK = process.argv.includes('--check');

/* ── What gets built ──────────────────────────────────────────── */

const DOCS = [
  { src: 'legal/TERMS.md', out: 'terms.html', lang: 'en', title: 'Terms of Use', alt: 'terms.ar.html' },
  { src: 'legal/PRIVACY.md', out: 'privacy.html', lang: 'en', title: 'Privacy Policy', alt: 'privacy.ar.html' },
  { src: 'legal/REFUNDS.md', out: 'refunds.html', lang: 'en', title: 'Refunds & Payment', alt: 'refunds.ar.html' },
  { src: 'legal/ar/TERMS.ar.md', out: 'terms.ar.html', lang: 'ar', title: 'شروط الاستخدام', alt: 'terms.html' },
  { src: 'legal/ar/PRIVACY.ar.md', out: 'privacy.ar.html', lang: 'ar', title: 'سياسة الخصوصية', alt: 'privacy.html' },
  { src: 'legal/ar/REFUNDS.ar.md', out: 'refunds.ar.html', lang: 'ar', title: 'الاسترداد والدفع', alt: 'refunds.html' }
];

/* ── Filling the blanks ───────────────────────────────────────── */

const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
/* keys starting with _ are notes to the operator, not values */
const answers = Object.fromEntries(
  Object.entries(conf).filter(([k]) => !k.startsWith('_')));

const PLACEHOLDER = /\[\[([^\]]+)\]\]/g;

/* Some placeholders carry a note to the operator inside the brackets —
   [[BACKUP RETENTION — see FILL-IN]]. The note is for whoever fills it
   in, not part of the name, so everything from the first em dash is
   dropped. Keeps one key answering every spelling of it across six
   files, which is the point: the Arabic uses the same tokens. */
const keyOf = raw => raw.split('—')[0].trim();

/* null means "answered: say nothing" — an optional detail the operator has
   decided not to publish. Distinct from "" which means "nobody has answered
   this yet" and stops the build. The difference matters most for the
   registration numbers: leaving the line out is neutral, leaving a blank
   where a number should be is not. */
const OMIT = String.fromCharCode(0);  // cannot occur in the sources

/* A value may be a string, used in both languages, or {en, ar}, which is what
   anything reading as prose has to be. The Arabic is the operative text by
   these documents' own choice, and an operative text with "kept for 5 years"
   sitting inside an Arabic sentence is not published in Arabic — which is the
   requirement the whole translation exists to meet. Bare numerals get the
   treatment too: the sources set them in Arabic-Indic digits, and one column
   of Western digits down an otherwise Arabic page reads as an oversight. */
function fill(text, lang, missing) {
  return text.replace(PLACEHOLDER, (whole, raw) => {
    const key = keyOf(raw);
    const answer = answers[key];
    const perLang = answer && typeof answer === 'object' && !Array.isArray(answer);
    const v = perLang ? answer[lang] : answer;

    if (v === null) return OMIT;
    if (v === undefined || v === '') {
      missing.add(perLang || answer === undefined ? `${key}  (${lang})` : key);
      return whole;
    }
    return lang === 'ar' ? isolate(v) : v;
  });
}

/* Every value dropped into the Arabic text is wrapped in a first-strong
   isolate, because the bidi algorithm reorders a Latin or numeric run
   against the Arabic around it. Without this, "سارية اعتبارًا من 2026-08-17"
   renders as "17-08-2026" — the same digits, a different date, on the page
   that says when the contract came into force.

   FSI rather than LRI: it takes its direction from the first strong
   character inside, so an Arabic name and a Latin email and a bare date all
   come out right through the same wrapper. No placeholder in these
   documents is a markdown link target (checked), so nothing here can land
   inside an href where the invisible characters would break it. */
const FSI = String.fromCharCode(0x2068), PDI = String.fromCharCode(0x2069);
const isolate = v => /[A-Za-z0-9]/.test(v) ? FSI + v + PDI : v;

/* An omission leaves a line that reads wrong, and the worst version of it is
   a label with nothing after it — "Commercial register:" published under a
   heading about who you are is not a neutral omission, it is an answer.

   So: a list item containing an omitted value goes entirely. A bullet exists
   to carry one fact; withhold the fact and the bullet has no purpose, label
   and all. Anywhere else the token is removed in place, taking with it
   whichever comma — Latin or Arabic — joined it to its neighbour. */
function tidy(text) {
  return text.split('\n')
    .filter(line => {
      if (!line.includes(OMIT)) return true;
      if (/^\s*[-*]\s/.test(line)) return false;
      const rest = line.split(OMIT).join('').replace(/[-*\s،,.;:|]+/gu, '');
      return rest.length > 0;
    })
    .map(line => line.includes(OMIT)
      ? line.replace(JOINER, ' ').replace(/\s{2,}/g, ' ').trimEnd()
      : line)
    .join('\n');
}

/* the omitted value plus whichever comma — Latin or Arabic — joined it to
   its neighbour, so "a, [omitted], b" closes up to "a, b" */
const JOINER = new RegExp(`\\s*[،,]?\\s*${OMIT}\\s*[،,]?\\s*`, 'g');

/* ── Markdown, the subset these documents use ─────────────────── */

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/* inline: **bold**, *em*, `code`, [text](href) — escaped first, so a
   document that mentions a tag renders it rather than running it */
function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, h) =>
      /^(https?:|mailto:|\/)/i.test(h) ? `<a href="${h}">${t}</a>` : t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function render(md) {
  const out = [];
  let inList = null, inTable = false, para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const closeAll = () => { flushPara(); closeList(); closeTable(); };

  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { closeAll(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { closeAll(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^(---|\*\*\*|___)$/.test(t)) { closeAll(); out.push('<hr>'); continue; }

    if (t.startsWith('>')) {
      closeAll();
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    /* a table: header row, separator, then body until a blank line */
    if (t.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      closeAll();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      out.push('<table><thead><tr>' + cells(t).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      inTable = true;
      i++;                                            // skip the separator
      continue;
    }
    if (inTable && t.startsWith('|')) {
      const cells = t.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      out.push('<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();

    const ul = /^[-*]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (inList !== want) { closeList(); out.push(`<${want}>`); inList = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(t);
  }
  closeAll();
  return out.join('\n');
}

/* ── The page ─────────────────────────────────────────────────── */

/* Inline CSS: style-src allows 'unsafe-inline', and a policy page that
   depends on a second request is a policy page that can fail to render
   at exactly the moment somebody is trying to read it in a dispute. */
const CSS = `
:root{--bg:#150A10;--surface:#1F1019;--text:#FAF2F4;--dim:#CDAFBA;--pink:#FF4D9D;--line:rgba(255,255,255,.14)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:46rem;margin:0 auto;padding:24px 20px 96px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:8px}
header img{width:34px;height:34px;image-rendering:pixelated}
header b{font-size:18px;letter-spacing:.02em}
header .sp{margin-inline-start:auto;display:flex;gap:10px;flex-wrap:wrap}
a{color:var(--pink)}
h1{font-size:1.7rem;line-height:1.25;margin:24px 0 8px}
h2{font-size:1.22rem;margin:32px 0 8px;padding-top:8px;border-top:1px solid var(--line)}
h3{font-size:1.05rem;margin:22px 0 6px}
p,li{color:var(--text)}
li{margin:5px 0}
blockquote{margin:14px 0;padding:12px 16px;background:var(--surface);
  border-inline-start:3px solid var(--pink);border-radius:8px;color:var(--dim)}
code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.9em}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
table{width:100%;border-collapse:collapse;margin:14px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:start;vertical-align:top}
th{background:var(--surface)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:.9rem}
.gap{background:#FFC24B;color:#241300;padding:1px 5px;border-radius:4px;font-weight:700}
@media print{body{background:#fff;color:#000}a{color:#000}}
`;

function page(doc, body, stamp) {
  const rtl = doc.lang === 'ar';
  const other = rtl ? 'English' : 'العربية';
  const home = rtl ? 'الحيط' : 'The wall';
  return `<!DOCTYPE html>
<html lang="${doc.lang}"${rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — S37</title>
<meta name="robots" content="index,follow">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <img src="/assets/logo-icon.png" alt="">
  <b>S37</b>
  <span class="sp">
    <a href="/">${home}</a>
    <a href="/assets/${doc.alt}">${other}</a>
  </span>
</header>
${body}
<footer>
  <p>${esc(doc.title)} · ${esc(stamp)}</p>
  <p>
    <a href="/assets/${rtl ? 'terms.ar.html' : 'terms.html'}">${rtl ? 'الشروط' : 'Terms'}</a> ·
    <a href="/assets/${rtl ? 'privacy.ar.html' : 'privacy.html'}">${rtl ? 'الخصوصية' : 'Privacy'}</a> ·
    <a href="/assets/${rtl ? 'refunds.ar.html' : 'refunds.html'}">${rtl ? 'الاسترداد' : 'Refunds'}</a>
  </p>
</footer>
</div>
</body>
</html>
`;
}

/* ── Build ────────────────────────────────────────────────────── */

const missing = new Set();
const built = [];

for (const doc of DOCS) {
  const src = path.join(ROOT, doc.src);
  if (!fs.existsSync(src)) {
    console.error(`  missing source: ${doc.src}`);
    process.exit(1);
  }
  const filled = fill(fs.readFileSync(src, 'utf8'), doc.lang, missing);
  built.push({ doc, filled });
}

if (missing.size) {
  const list = [...missing].sort();
  console.error(`\n  ${list.length} answer(s) still needed in legal/operator.json:\n`);
  for (const k of list) console.error(`    [[${k}]]`);
  if (!DRAFT) {
    console.error('\n  Nothing written. Fill them in, or pass --draft to preview with the');
    console.error('  gaps left visible. See legal/FILL-IN.md for what each one is.\n');
    process.exit(1);
  }
  console.error('\n  --draft: building anyway, gaps highlighted. Do not deploy this.\n');
}
if (CHECK) {
  if (!missing.size) console.log('  every answer is filled in — ready to build');
  process.exit(missing.size ? 1 : 0);
}

const stamp = `v${answers.VERSION || '?'}` +
  (answers['EFFECTIVE DATE'] ? ` · ${answers['EFFECTIVE DATE']}` : '');

fs.mkdirSync(OUT, { recursive: true });
for (const { doc, filled } of built) {
  let body = render(tidy(filled));
  /* in draft mode the unanswered ones are made impossible to miss */
  if (DRAFT) body = body.replace(PLACEHOLDER, (m, raw) => `<span class="gap">${esc(keyOf(raw))}</span>`);
  const file = path.join(OUT, doc.out);
  fs.writeFileSync(file, page(doc, body, stamp));
  console.log(`  ${doc.out.padEnd(18)} ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
console.log(`\n  ${built.length} pages written to assets/.${DRAFT ? '  (draft — not publishable)' : ''}\n`);
