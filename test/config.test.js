/* config — the boot refuses bad input rather than limping on */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cfg = require('../server/config.js');
const ROOT = path.join(__dirname, '..');

/* loading config.js in a clean process, with env overrides */
function boot(env) {
  return spawnSync(process.execPath, ['-e', 'require("./server/config.js")'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), ...env }
  });
}

test('dev fills safe defaults and says so', () => {
  assert.equal(cfg.PORT, 5174);
  assert.equal(cfg.CAP, 20);
  assert.equal(cfg.DEV, true);
  assert.equal(cfg.TG_MODE, 'off');
  assert.ok(cfg.SESSION_SECRET, 'always has a value');
  assert.ok(cfg.warnings.some(w => w.includes('SESSION_SECRET')), 'warns about the dev default');
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
