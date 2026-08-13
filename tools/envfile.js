/* ═══════════════════════════════════════════════════════════════
   envfile — reading and editing /etc/s37.env the way systemd does

   Shared by make-env.js and tg-setup.js so the parsing rules live in
   one place, because they are not the obvious ones:

     • only a line that *starts* with # is a comment. A `#` after a
       value is part of the value — systemd does no trailing-comment
       stripping, so neither does this. A hash is a legal character
       in a secret and truncating one would be worse than useless.
     • the value is everything after the first `=`, unquoted and
       untrimmed on the right, because a trailing space in a token is
       a real thing that has cost people real evenings.

   set() edits in place: it rewrites the lines it is given and leaves
   every other byte — comments, blank lines, ordering — exactly where
   it found them. A config file that gets reformatted every time a
   tool touches it is a config file nobody can diff.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(LINE);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const read = file => parse(fs.readFileSync(file, 'utf8'));

/* Returns what actually changed, so a caller can report honestly rather
   than claiming to have set something that was already that. */
function set(file, values) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const changed = {};
  const wanted = new Set(Object.keys(values));

  const lines = text.split(/\r?\n/).map(line => {
    const m = line.match(LINE);
    if (!m || !wanted.has(m[1])) return line;
    const key = m[1];
    const next = String(values[key]);
    wanted.delete(key);
    if (m[2] === next) return line;
    changed[key] = { from: m[2], to: next };
    return `${key}=${next}`;
  });

  /* a key the template never had still has to end up in the file */
  for (const key of wanted) {
    changed[key] = { from: null, to: String(values[key]) };
    lines.push(`${key}=${values[key]}`);
  }

  fs.writeFileSync(file, lines.join(eol));
  return changed;
}

module.exports = { parse, read, set, LINE };
