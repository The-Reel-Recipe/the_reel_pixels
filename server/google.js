/* ═══════════════════════════════════════════════════════════════
   google — sign in with Google, verified properly

   The authorization-code flow, server-side. The browser is sent to
   Google, comes back with a one-time code, and this exchanges that
   code for an id_token over a direct HTTPS call Google authenticates
   with our client secret. The secret never reaches the page and the
   token never travels through the URL bar.

   The part worth being careful about is what happens to the token
   afterwards. An id_token is a JWT: three base64 segments anybody
   can write. Reading the email out of the middle one without
   checking the signature is not authentication — it is a form that
   asks the visitor who they would like to be. So it is verified in
   full, against Google's published keys:

     the signature, using the RSA key whose `kid` the header names,
       fetched from Google's JWKS and cached;
     `iss`, which must be Google;
     `aud`, which must be our client id — a token minted for a
       different application is a valid Google token and is not a
       sign-in here;
     `exp`, with a small allowance for clock drift;
     and `email_verified`, because an unverified Google address is
       an address somebody typed, and we link accounts by address.

   The nonce is bound to the state cookie and checked too, which is
   what stops a token obtained elsewhere being replayed into
   somebody else's browser.

   Deliberately no library. This is one JWKS fetch, one RSA verify
   through node:crypto, and five equality checks — PLAN §1's rule
   holds, and an auth dependency is the one you least want to be
   unable to read.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const cfg = require('./config');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISS = ['https://accounts.google.com', 'accounts.google.com'];

const on = () => !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.PUBLIC_URL);
const redirectUri = () => `${cfg.PUBLIC_URL}/api/auth/google/callback`;

/* ── Where we send them ───────────────────────────────────────── */

const b64url = buf => Buffer.from(buf).toString('base64url');

/* state and nonce are independent random values. state comes back in the
   query and is compared against a cookie, which is what makes the callback
   ours rather than something a stranger can trigger. nonce is embedded in
   the token by Google and compared after verification, which is what makes
   the token *this* sign-in rather than one captured elsewhere. */
function begin() {
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: cfg.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state, nonce,
    /* We hold no refresh token and ask for no offline access: this is a
       sign-in, not an ongoing grant, and the less we are given the less
       there is to keep. */
    prompt: 'select_account'
  }).toString();
  return { url: url.toString(), state, nonce };
}

/* ── Google's keys ────────────────────────────────────────────────
   Cached until Google's own cache-control says otherwise, and refetched
   once on an unknown `kid` — which is exactly what a key rotation looks
   like from here. */

let keys = new Map();
let keysUntil = 0;

async function jwks(force = false) {
  const now = Date.now();
  if (!force && keys.size && now < keysUntil) return keys;

  const res = await fetch(JWKS);
  if (!res.ok) throw new Error(`google jwks: ${res.status}`);
  const body = await res.json();

  const next = new Map();
  for (const k of body.keys || []) {
    if (k.kty !== 'RSA' || (k.alg && k.alg !== 'RS256')) continue;
    next.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  }
  if (!next.size) throw new Error('google jwks: no usable keys');

  const cc = res.headers.get('cache-control') || '';
  const maxAge = /max-age=(\d+)/.exec(cc);
  keys = next;
  keysUntil = now + (maxAge ? Number(maxAge[1]) * 1000 : 3600_000);
  return keys;
}

/* ── Verifying the token ──────────────────────────────────────── */

const SKEW_MS = 2 * 60 * 1000;

function decode(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('id_token: not a jwt');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { header, claims, signed: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2], 'base64url') };
}

async function verifyIdToken(jwt, nonce, now = Date.now()) {
  const { header, claims, signed, sig } = decode(jwt);
  if (header.alg !== 'RS256') throw new Error('id_token: unexpected alg');

  let set = await jwks();
  let key = set.get(header.kid);
  if (!key) { set = await jwks(true); key = set.get(header.kid); }   // rotation
  if (!key) throw new Error('id_token: unknown signing key');

  if (!crypto.verify('RSA-SHA256', Buffer.from(signed), key, sig)) {
    throw new Error('id_token: bad signature');
  }
  if (!ISS.includes(claims.iss)) throw new Error('id_token: wrong issuer');
  if (claims.aud !== cfg.GOOGLE_CLIENT_ID) throw new Error('id_token: minted for another app');
  if (!claims.exp || claims.exp * 1000 + SKEW_MS < now) throw new Error('id_token: expired');
  if (claims.iat && claims.iat * 1000 - SKEW_MS > now) throw new Error('id_token: issued in the future');
  if (nonce && claims.nonce !== nonce) throw new Error('id_token: nonce does not match');

  if (!claims.sub) throw new Error('id_token: no subject');
  /* We link accounts by address, so an address Google has not confirmed is
     not one we can act on. Google sends this as a real boolean or the
     string "true" depending on the endpoint; both are accepted, nothing
     else is. */
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.email || !verified) throw new Error('id_token: email not verified with Google');

  return {
    sub: String(claims.sub),
    email: String(claims.email).trim().toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name : ''
  };
}

/* ── The exchange ─────────────────────────────────────────────── */

async function exchange(code) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.GOOGLE_CLIENT_ID,
      client_secret: cfg.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`google token: ${body.error_description || body.error || res.status}`);
    err.detail = body.error || '';
    throw err;
  }
  if (!body.id_token) throw new Error('google token: no id_token in the response');
  return body.id_token;
}

/* code + nonce in, a verified person out. */
async function identify(code, nonce, now = Date.now()) {
  return verifyIdToken(await exchange(code), nonce, now);
}

module.exports = { on, begin, identify, exchange, verifyIdToken, jwks, redirectUri };
