/* config — the boot refuses bad input rather than limping on */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cfg = require('../server/config.js');
const ROOT = path.join(__dirname, '..');

/* Loading config.js in a clean process, with env overrides. Every secret
   the current PHASE enforces is supplied by default so a test about PORT
   fails on PORT — the enforcement itself is what the next test is for. */
const PROD_ENV = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'x'.repeat(32),
  TG_BOT_TOKEN: '1234:test', TG_CHAT_ID: '-100123', TG_WEBHOOK_SECRET: 'y'.repeat(24),
  TG_MOD_IDS: '4242', PUBLIC_URL: 'https://pixels.example',
  INSTAPAY_URL: 'https://ipn.eg/S/example/instapay/TEST'
};
function boot(env) {
  return spawnSync(process.execPath, ['-e', 'require("./server/config.js")'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ...PROD_ENV, ...env }
  });
}

test('dev fills safe defaults and says so', () => {
  assert.equal(cfg.PORT, 5174);
  assert.equal(cfg.CAP, 20);
  assert.equal(cfg.TG_MODE, 'off');
  assert.ok(cfg.SESSION_SECRET, 'always has a value');
  assert.ok(cfg.warnings.some(w => w.includes('SESSION_SECRET')), 'warns about the dev default');
});

test('production insists on every secret the running code reads', () => {
  /* PHASE tracks what is actually in the tree, so this is the list as of
     Phase 7 — all of it. A deploy missing any of these should not start
     rather than start and fail at the first payment. */
  for (const missing of Object.keys(PROD_ENV).filter(k => k !== 'NODE_ENV')) {
    const r = boot({ [missing]: '' });
    assert.notEqual(r.status, 0, `${missing} missing should refuse to boot`);
    assert.match(r.stderr, new RegExp(missing));
  }
});

test('missingSecrets only asks for what the phase actually reads', () => {
  const spec = cfg.SECRETS;
  assert.deepEqual(cfg.missingSecrets({}, 0, spec), [], 'phase 0 needs no secrets');
  assert.deepEqual(cfg.missingSecrets({}, 2, spec).map(s => s.k), ['SESSION_SECRET']);
  assert.ok(cfg.missingSecrets({}, 4, spec).map(s => s.k).includes('TG_BOT_TOKEN'));
  assert.deepEqual(cfg.missingSecrets({ SESSION_SECRET: '  ' }, 2, spec).map(s => s.k),
    ['SESSION_SECRET'], 'whitespace is not a secret');
  assert.deepEqual(cfg.missingSecrets({ SESSION_SECRET: 'k' }, 2, spec), []);
});

test('a production boot dies on a malformed value', () => {
  for (const [env, hint] of [
    [{ PORT: '70000' }, 'PORT'],
    [{ SESSION_SECRET: 'short' }, 'SESSION_SECRET'],
    [{ TG_MOD_IDS: '12,not-an-id' }, 'TG_MOD_IDS'],
    [{ PUBLIC_URL: 'ftp://nope' }, 'PUBLIC_URL'],
    [{ TG_MODE: 'sometimes' }, 'TG_MODE']
  ]) {
    const r = boot(env);
    assert.notEqual(r.status, 0, `${hint} should refuse to boot`);
    assert.match(r.stderr, new RegExp(`config:.*${hint}`), r.stderr.split('\n')[0]);
  }
});

test('a well-formed production env boots', () => {
  const r = boot({ PORT: '8080', PUBLIC_URL: 'https://pixels.example/', TG_MOD_IDS: '1,-2' });
  assert.equal(r.status, 0, r.stderr);
});

test('the phase marker keeps up with the tree', () => {
  /* If this fails, a phase landed without raising PHASE — and the secrets
     that phase reads are not being enforced on a production boot. */
  assert.equal(cfg.PHASE, 7);
  assert.deepEqual(cfg.missingSecrets({}, cfg.PHASE, cfg.SECRETS).map(s => s.k).sort(),
    cfg.SECRETS.map(s => s.k).sort(), 'every secret in the table is now live');
});
