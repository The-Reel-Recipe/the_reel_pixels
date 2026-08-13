/* ═══════════════════════════════════════════════════════════════
   add-admin — the only way an admin account comes into existence

     node tools/add-admin.js <username> [--password <pw>]
     node tools/add-admin.js --list
     node tools/add-admin.js --revoke <username>

   PLAN §7.1: there is no signup route, and there is not going to be
   one. An account is made here, on the box, by somebody with a shell
   on it — which is the same bar as reading the database, so it adds
   no exposure that did not already exist.

   Prints a temporary password and the TOTP secret, both as an
   otpauth:// URL and as the grouped key an authenticator asks for
   under "enter a setup key". Copy one of them into the app before
   closing the terminal — the secret is deliberately not printable
   again afterwards.

   §7.1 also asked for an ASCII QR here. There was one, and it came
   back out: a QR encoder is a few hundred lines of Reed-Solomon and
   bit placement, this environment has no way to decode its output,
   and an unverified QR that silently encodes the wrong thing is
   worse than no QR at all — it fails at the one moment somebody is
   trying to secure an account. The URL below pastes into any QR
   generator if a camera is genuinely easier than typing.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const admin = require('../server/admin.js');
const { db, close } = require('../server/db.js');

/* Authenticator apps show setup keys in fours, and a 32-character string
   typed off a screen without them is a coin flip. */
const grouped = s => String(s).replace(/(.{4})/g, '$1 ').trim();

function list() {
  const rows = db.prepare(
    'SELECT id, username, created_at, last_login, token_epoch FROM admins ORDER BY id').all();
  if (!rows.length) { console.log('\n  No admin accounts yet.\n'); return; }
  console.log('');
  for (const r of rows) {
    const seen = r.last_login
      ? new Date(r.last_login).toISOString().slice(0, 16).replace('T', ' ')
      : 'never';
    console.log(`  ${String(r.id).padEnd(4)} ${r.username.padEnd(20)} last login ${seen}` +
      `${r.token_epoch ? `  (sessions revoked ${r.token_epoch}x)` : ''}`);
  }
  console.log('');
}

function revoke(username) {
  const row = db.prepare('SELECT id FROM admins WHERE username = ?')
    .get(String(username || '').toLowerCase());
  if (!row) { console.error(`\n  No admin called ${username}.\n`); process.exit(1); }
  admin.revokeSessions(row.id, 'cli');
  console.log(`\n  Every session ${username} holds is now dead. They can sign in again.\n`);
}

function add(username, password) {
  /* base64url so it survives being copied through a chat window, and long
     enough that "temporary" not happening is not a disaster */
  const pw = password || crypto.randomBytes(12).toString('base64url');
  const made = admin.createAdmin(username, pw);

  console.log(`\n  Admin created: ${made.username}\n`);
  console.log(`  Password        ${pw}`);
  console.log(`  Setup key       ${grouped(made.secret)}`);
  console.log(`  or this URL     ${made.otpauth}\n`);
  console.log('  Add the setup key to an authenticator app now — it is not shown again.');
  console.log('  Sign-in needs the password AND a live code, every time. No exceptions,');
  console.log('  no recovery codes: if the phone is lost, make a new account here and');
  console.log('  --revoke the old one.\n');
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--list') list();
  else if (args[0] === '--revoke') revoke(args[1]);
  else if (!args[0] || args[0].startsWith('--')) {
    console.log('\n  usage: node tools/add-admin.js <username> [--password <pw>]');
    console.log('         node tools/add-admin.js --list');
    console.log('         node tools/add-admin.js --revoke <username>\n');
  } else {
    const i = args.indexOf('--password');
    add(args[0], i >= 0 ? args[i + 1] : null);
  }
  close();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  close();
  process.exit(1);
}
