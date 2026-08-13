/* ═══════════════════════════════════════════════════════════════
   env + telegram setup — the two tools the cutover leans on

   Neither runs during normal operation, which is exactly why they are
   worth testing: they run once, on a box, under time pressure, and a
   mistake in either is a production secret that is subtly wrong
   rather than obviously missing.

   The Telegram half runs against a fake API, so the whole of --init
   is exercised without a bot existing — when the real token arrives,
   a failure is credentials rather than code.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const envfile = require('../tools/envfile.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 's37-envtools-'));

/* ── envfile: systemd's rules, not dotenv's ───────────────────── */

test('a value is everything after the equals sign', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, [
    '# a comment',
    'PLAIN=hello',
    'HASH=abc#def',                    // a hash is a legal character
    'SPACED=  padded  ',
    'EMPTY=',
    '  # indented comment',
    'EQUALS=a=b=c',
    'not a var at all'
  ].join('\n'));

  const v = envfile.read(f);
  assert.equal(v.PLAIN, 'hello');
  assert.equal(v.HASH, 'abc#def', 'a trailing # is not a comment to systemd');
  assert.equal(v.SPACED, '  padded  ', 'and neither end is trimmed');
  assert.equal(v.EMPTY, '');
  assert.equal(v.EQUALS, 'a=b=c', 'only the first = separates');
  assert.equal(Object.keys(v).length, 5, 'comments and prose are not variables');
});

test('editing leaves every other byte where it was', () => {
  const f = path.join(tmp(), '.env');
  const before = '# keep me\n\nA=1\n# and me\nB=2\nC=3\n';
  fs.writeFileSync(f, before);

  const changed = envfile.set(f, { B: 'two', C: '3', D: 'new' });
  const after = fs.readFileSync(f, 'utf8');

  assert.deepEqual(Object.keys(changed).sort(), ['B', 'D'], 'C was already 3');
  assert.equal(changed.B.from, '2');
  assert.equal(changed.B.to, 'two');
  assert.equal(changed.D.from, null, 'a key the file did not have');

  assert.match(after, /# keep me/);
  assert.match(after, /# and me/);
  assert.match(after, /^A=1$/m, 'untouched lines are untouched');
  assert.match(after, /^B=two$/m);
  assert.match(after, /^D=new$/m);
  assert.equal(after.split('\n')[1], '', 'the blank line survived');
});

/* ── make-env ─────────────────────────────────────────────────── */

const runNode = (script, args, env) => spawnSync(process.execPath,
  [path.join(ROOT, 'tools', script), ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

test('make-env generates real secrets and marks the rest TODO', () => {
  const f = path.join(tmp(), '.env');
  const r = runNode('make-env.js', [f]);
  assert.equal(r.status, 0, r.stderr);

  const v = envfile.read(f);
  /* 32 bytes of base64url */
  for (const k of ['SESSION_SECRET', 'TG_WEBHOOK_SECRET']) {
    assert.match(v[k], /^[A-Za-z0-9_-]{43}$/, `${k} is not 32 random bytes`);
  }
  assert.notEqual(v.SESSION_SECRET, v.TG_WEBHOOK_SECRET, 'two secrets, not one twice');

  /* what production always wants */
  assert.equal(v.NODE_ENV, 'production');
  assert.equal(v.TRUST_PROXY, '1');
  assert.equal(v.COOKIE_SECURE, '1');
  assert.equal(v.TG_MODE, 'webhook');

  /* and what it cannot know */
  for (const k of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_MOD_IDS', 'PUBLIC_URL']) {
    assert.equal(v[k], '', `${k} should be blank, got "${v[k]}"`);
  }

  /* the hint must not be on the value's line — systemd would eat it */
  const text = fs.readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (/^[A-Z][A-Z0-9_]*=/.test(line)) {
      assert.equal(line.includes('#'), false, `hint on a value line: ${line}`);
    }
  }
  assert.match(text, /^# TODO — .*\nTG_BOT_TOKEN=$/m, 'the hint goes above');
});

test('make-env refuses to mint a second SESSION_SECRET', () => {
  const f = path.join(tmp(), '.env');
  assert.equal(runNode('make-env.js', [f]).status, 0);
  const first = envfile.read(f).SESSION_SECRET;

  const again = runNode('make-env.js', [f]);
  assert.notEqual(again.status, 0, 'it overwrote the file');
  assert.match(again.stderr, /already exists/);
  assert.match(again.stderr, /signs out every/);   // the warning wraps mid-sentence
  assert.equal(envfile.read(f).SESSION_SECRET, first, 'and the secret is unchanged');
});

test('--check separates "will not boot" from "will not replicate"', () => {
  const f = path.join(tmp(), '.env');
  runNode('make-env.js', [f]);

  const before = runNode('make-env.js', ['--check', f]);
  assert.notEqual(before.status, 0, 'unfilled should be a non-zero exit');
  assert.match(before.stdout, /refuse to start/);
  assert.match(before.stdout, /TG_BOT_TOKEN/);
  assert.match(before.stdout, /replication does not/);

  envfile.set(f, {
    TG_BOT_TOKEN: '7000000000:AA-test', TG_CHAT_ID: '-1001', TG_MOD_IDS: '42',
    PUBLIC_URL: 'https://project-s37.com'
  });
  const after = runNode('make-env.js', ['--check', f]);
  assert.equal(after.status, 0, after.stdout);
  assert.match(after.stdout, /every secret the boot demands is filled in/);
  /* the R2 keys are still blank, and that is reported without blocking */
  assert.match(after.stdout, /LITESTREAM_ACCESS_KEY_ID/);
});

/* ── tg-setup --init, against a Telegram that does not exist ──── */

/* The tool talks to api.telegram.org over fetch, so the child gets a
   --require that replaces fetch before the tool loads. Everything from
   getMe to the file write runs for real. */
function fakeTelegram(dir, updates, opts = {}) {
  const shim = path.join(dir, 'shim.js');
  fs.writeFileSync(shim, `
    const updates = ${JSON.stringify(updates)};
    globalThis.fetch = async (url) => {
      const method = String(url).split('/').pop();
      const reply = {
        getMe: ${opts.badToken
    ? '{ ok: false, description: "Unauthorized" }'
    : '{ ok: true, result: { username: "s37_test_bot", first_name: "S37" } }'},
        deleteWebhook: { ok: true, result: true },
        getUpdates: { ok: true, result: updates }
      }[method] || { ok: true, result: {} };
      return { status: 200, json: async () => reply };
    };
  `);
  return shim;
}

const msg = (chat, from) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { chat, from, text: 'hello' }
});
const GROUP = { id: -1001234567890, title: 'S37 — Moderation', type: 'supergroup' };

function runInit(dir, envPath, updates, extra = [], opts = {}) {
  return spawnSync(process.execPath,
    ['--require', fakeTelegram(dir, updates, opts),
      path.join(ROOT, 'tools', 'tg-setup.js'), '--init', envPath, ...extra],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TG_BOT_TOKEN: '', NODE_ENV: 'development' } });
}

test('--init reads the group and the moderators off one message', () => {
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  const r = runInit(dir, f, [
    msg(GROUP, { id: 4242, username: 'mohab', is_bot: false }),
    msg(GROUP, { id: 4343, username: 'sara', is_bot: false }),
    msg(GROUP, { id: 99, username: 's37_test_bot', is_bot: true })
  ], ['--token', '7000000000:AA-a-test-token']);

  assert.equal(r.status, 0, r.stderr + r.stdout);
  const v = envfile.read(f);
  assert.equal(v.TG_BOT_TOKEN, '7000000000:AA-a-test-token', 'the token is written too');
  assert.equal(v.TG_CHAT_ID, '-1001234567890');
  assert.deepEqual(v.TG_MOD_IDS.split(',').sort(), ['4242', '4343'], 'humans only, not the bot');

  /* and it does not print the token back at whoever is watching */
  assert.equal(r.stdout.includes('AA-a-test-token'), false, 'the token is echoed in full');
  assert.match(r.stdout, /7000000000:…/);
});

test('--init says what to do when the bot has heard nothing', () => {
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  const r = runInit(dir, f, [], ['--token', '7000000000:AA-x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /add @s37_test_bot to it/);
  assert.match(r.stdout, /post any message/);
  assert.equal(envfile.read(f).TG_CHAT_ID, '', 'and nothing was written');
});

test('--init refuses to guess between two groups', () => {
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  const r = runInit(dir, f, [
    msg(GROUP, { id: 4242, username: 'mohab', is_bot: false }),
    msg({ id: -1009999, title: 'Some other group', type: 'group' },
      { id: 4242, username: 'mohab', is_bot: false })
  ], ['--token', '7000000000:AA-x']);

  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /More than one group/);
  assert.match(r.stdout, /Some other group/);
  assert.equal(envfile.read(f).TG_CHAT_ID, '');
});

test('--init will not write a group with nobody in it to moderate', () => {
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  /* only the bot has spoken — TG_MOD_IDS would be empty, which means
     anyone in the group can approve pixels */
  const r = runInit(dir, f, [msg(GROUP, { id: 99, username: 's37_test_bot', is_bot: true })],
    ['--token', '7000000000:AA-x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /anyone in the group can press the buttons/);
  assert.equal(envfile.read(f).TG_MOD_IDS, '');
});

test('a network that will not answer is not blamed on the token', () => {
  /* Telegram answers an *invalid* token in under a second, so a hang is
     always something in between — a proxy, a firewall, a sandbox that does
     not allow the authenticated Bot API. Saying "rejected that token" here
     sends somebody hunting for a typo in a perfectly good credential,
     which is exactly what happened the first time this was run for real. */
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  const shim = path.join(dir, 'hang.js');
  fs.writeFileSync(shim,
    'globalThis.fetch = () => Promise.reject(Object.assign(new Error("timed out"), ' +
    '{ name: "TimeoutError" }));');
  const r = spawnSync(process.execPath,
    ['--require', shim, path.join(ROOT, 'tools', 'tg-setup.js'), '--init', f, '--token', '1:AA'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TG_BOT_TOKEN: '', NODE_ENV: 'development' } });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no answer from api\.telegram\.org/);
  assert.match(r.stderr, /This is the network, not the token/);
  assert.equal(/rejected that token/.test(r.stderr), false, 'it blamed the credential');
  assert.equal(envfile.read(f).TG_CHAT_ID, '', 'and wrote nothing');
});

test('a rejected token is a sentence, not a stack trace', () => {
  const dir = tmp();
  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);

  const r = runInit(dir, f, [], ['--token', 'nonsense'], { badToken: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Telegram rejected that token/);
  assert.equal(/at Object\.<anonymous>/.test(r.stderr), false, 'a stack trace leaked');
});

test('--init tells you what it needs before it does anything', () => {
  const dir = tmp();
  const missing = runInit(dir, path.join(dir, 'nope.env'), [], ['--token', 'x']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /npm run env/);

  const f = path.join(dir, '.env');
  runNode('make-env.js', [f]);
  const noToken = runInit(dir, f, []);
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /@BotFather/);
});
