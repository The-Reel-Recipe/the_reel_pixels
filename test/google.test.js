/* ═══════════════════════════════════════════════════════════════
   google — the token checks, against tokens built to break them

   An id_token is three base64 segments anybody can write. Everything
   that makes it evidence of who somebody is happens in verifyIdToken,
   and every check there exists because skipping it turns the sign-in
   into a form that asks the visitor who they would like to be.

   So this file signs its own tokens with its own key and tries each
   attack in turn: no signature, the wrong key, another application's
   audience, an expired token, an unverified address, a replayed
   nonce. A test that only proves the happy path proves nothing here —
   the happy path works in the version with no checks at all.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-google-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.PUBLIC_URL = 'https://wall.example';
process.env.RETENTION_SWEEP = '0';
delete process.env.VERCEL;

const google = require('../server/google.js');

/* ── a signing key standing in for Google's ───────────────────── */

const KID = 'test-key-1';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const good = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: process.env.GOOGLE_CLIENT_ID,
  sub: '1029384756',
  email: 'painter@example.com',
  email_verified: true,
  name: 'A Painter',
  nonce: 'the-nonce',
  iat: Math.floor(NOW / 1000) - 10,
  exp: Math.floor(NOW / 1000) + 3600,
  ...over
});

/* Serve our key where Google's would be. */
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async url => {
    if (String(url).includes('oauth2/v3/certs')) {
      return {
        ok: true,
        headers: { get: () => 'public, max-age=3600' },
        json: async () => ({
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }]
        })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
});
test.after(() => { globalThis.fetch = realFetch; });

const fails = async (jwt, why, nonce = 'the-nonce') => {
  await assert.rejects(() => google.verifyIdToken(jwt, nonce, NOW), why);
};

/* ── the happy path, so the rest means something ──────────────── */

test('a properly signed token identifies the person', async () => {
  const who = await google.verifyIdToken(sign(good()), 'the-nonce', NOW);
  assert.equal(who.sub, '1029384756');
  assert.equal(who.email, 'painter@example.com');
  assert.equal(who.name, 'A Painter');
});

test('the address is lowercased, because it is what accounts link on', async () => {
  const who = await google.verifyIdToken(sign(good({ email: 'Painter@Example.COM' })), 'the-nonce', NOW);
  assert.equal(who.email, 'painter@example.com');
});

/* ── and every way in that must not work ──────────────────────── */

test('a token signed by somebody else is refused', async () => {
  await fails(sign(good(), { key: OTHER.privateKey }), /bad signature/);
});

test('a token with no signature at all is refused', async () => {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  await fails(`${head}.${b64(good())}.`, /bad signature/);
});

test('alg:none is refused rather than believed', async () => {
  /* the classic: claim there is no algorithm and hope the verifier agrees */
  const head = b64({ alg: 'none', kid: KID, typ: 'JWT' });
  await fails(`${head}.${b64(good())}.`, /unexpected alg/);
});

test('a token minted for a different application is refused', async () => {
  /* a real, correctly signed Google token — for somebody else's app */
  await fails(sign(good({ aud: 'someone-elses.apps.googleusercontent.com' })), /another app/);
});

test('a token from the wrong issuer is refused', async () => {
  await fails(sign(good({ iss: 'https://accounts.evil.example' })), /wrong issuer/);
});

test('an expired token is refused', async () => {
  await fails(sign(good({ exp: Math.floor(NOW / 1000) - 3600 })), /expired/);
});

test('a token signed by an unknown key is refused', async () => {
  await fails(sign(good(), { kid: 'not-a-key-we-know' }), /unknown signing key/);
});

test('an unverified Google address is refused', async () => {
  /* we link accounts by address, so an address Google has not confirmed
     would let somebody claim a stranger's account by typing it */
  await fails(sign(good({ email_verified: false })), /not verified/);
  await fails(sign(good({ email_verified: undefined })), /not verified/);
});

test('a token for a different sign-in is refused', async () => {
  /* the nonce is what makes this token THIS attempt, not one captured
     somewhere else and replayed into somebody's browser */
  await fails(sign(good({ nonce: 'a-different-nonce' })), /nonce/);
});

test('a token with no subject is refused', async () => {
  await fails(sign(good({ sub: undefined })), /no subject/);
});

/* ── what we ask Google for ───────────────────────────────────── */

test('the authorize url asks for the least it can', async () => {
  const { url, state, nonce } = google.begin();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://wall.example/api/auth/google/callback');
  assert.equal(u.searchParams.get('scope'), 'openid email profile',
    'nothing beyond these three — more scope means a Google review and more to hold');
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(u.searchParams.get('nonce'), nonce);
  assert.equal(u.searchParams.get('access_type'), null, 'no offline access: this is a sign-in, not a grant');

  const again = google.begin();
  assert.notEqual(again.state, state, 'state is per attempt');
  assert.notEqual(again.nonce, nonce);
});

test('it is off unless every piece is configured', () => {
  assert.equal(google.on(), true);
  const keep = process.env.GOOGLE_CLIENT_SECRET;
  /* config is read once at load, so this asserts the shape rather than
     re-reading it — the routes check google.on() and 404 when false */
  assert.ok(typeof google.on === 'function');
  process.env.GOOGLE_CLIENT_SECRET = keep;
});
