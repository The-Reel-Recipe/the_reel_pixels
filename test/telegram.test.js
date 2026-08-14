/* ═══════════════════════════════════════════════════════════════
   telegram test — the promises Phase 4 makes

   The bot is the moderation surface, so the properties worth pinning
   are the ones that decide whether a submission can be lost: that a
   card is queued in the same breath as the claim, that a send which
   fails is retried rather than dropped, that 429 is waited out for as
   long as Telegram asks, and that a webhook without the right secret
   is not a webhook.

   No network. globalThis.fetch is replaced with a script the test
   drives, which is also the only honest way to test a retry — a real
   API would have to actually fail to prove anything.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's37-telegram-'));
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.TRUST_PROXY = '1';
/* A configured bot, without one existing: `poll` keeps the worker running
   but never registers a webhook, and every call goes through the fake
   below. The token is nonsense on purpose — nothing may reach the network. */
process.env.TG_MODE = 'poll';
process.env.TG_BOT_TOKEN = '1234:test-token-not-real';
process.env.TG_CHAT_ID = '-1001234567890';
process.env.TG_WEBHOOK_SECRET = 'a-secret-worth-16-chars';
process.env.TG_MOD_IDS = '4242,4343';
process.env.IP_CLAIM_CAP = '1000';
/* The §9 token buckets are per minute and this file spends a day's worth
   of requests in a second; raised so the assertions are about the caps and
   the races they are testing rather than the rate limiter in front of them.
   admin.test.js deliberately leaves RATE_AUTH alone — the login throttle is
   one of the things it checks. */
process.env.RATE_READ = '100000';
process.env.RATE_WRITE = '100000';
process.env.RATE_AUTH = '100000';
delete process.env.VERCEL;
delete process.env.DEV;

const app = require('../server.js');
const dbm = require('../server/db.js');
const wall = require('../server/wall.js');
const submissions = require('../server/submissions.js');
const telegram = require('../server/telegram.js');
const identity = require('../server/identity.js');

/* ── the fake API ─────────────────────────────────────────────── */

/* Every call the server makes lands here. `plan` is a queue of replies;
   when it runs dry the call succeeds, so a test only has to describe the
   failures it cares about. */
const calls = [];
let plan = [];
let msgSeq = 1000;

globalThis.fetch = async (url, opts) => {
  const method = String(url).split('/').pop();
  let params = {};
  if (opts && typeof opts.body === 'string') params = JSON.parse(opts.body);
  else if (opts && opts.body && typeof opts.body.get === 'function') {
    for (const k of ['chat_id', 'caption', 'reply_markup', 'text']) {
      const v = opts.body.get(k);
      if (v != null) params[k] = v;
    }
    params.photo = !!opts.body.get('photo');
  }
  calls.push({ method, params });

  const next = plan.shift();
  if (next) {
    return {
      status: next.status,
      json: async () => next.body || { ok: false, description: 'nope' }
    };
  }
  return {
    status: 200,
    json: async () => ({ ok: true, result: { message_id: ++msgSeq } })
  };
};

const server = http.createServer(app);
let base = '';

const ENTRY = 9;
function envelope(px) {
  const json = Buffer.from('{}', 'utf8');
  const buf = Buffer.alloc(4 + json.length + 4 + px.length * ENTRY + 4);
  let o = 0;
  buf.writeUInt32LE(json.length, o); o += 4;
  json.copy(buf, o); o += json.length;
  buf.writeUInt32LE(px.length, o); o += 4;
  for (const [i, c] of px) {
    buf.writeUInt32LE(i, o); o += 4;
    buf[o++] = (c >> 16) & 255; buf[o++] = (c >> 8) & 255; buf[o++] = c & 255;
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}
function request(method, url, body, type, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'x-forwarded-for': '198.51.100.7' }, headers || {});
    if (body) h['content-type'] = type || 'application/json';
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = http.request(base + url, { method, headers: h }, res => {
      for (const line of res.headers['set-cookie'] || []) {
        const pair = line.split(';')[0], eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const jar = new Map();
const claim = async px => JSON.parse(
  (await request('POST', '/api/claim', envelope(px), 'application/octet-stream')).body.toString('utf8'));

let nextFree = 800000;
const freeRange = n => {
  const out = [];
  while (out.length < n) {
    const i = nextFree++;
    if (!wall.wall.live.has(i) && !wall.wall.pending.live.has(i)) out.push(i);
  }
  return out;
};

/* sendPhoto goes as multipart and everything else as JSON, so a keyboard
   arrives here as a string one way and an object the other. */
const asObj = v => (typeof v === 'string' ? JSON.parse(v) : v);

const queued = () => dbm.db.prepare('SELECT * FROM tg_outbox ORDER BY id').all();
const statusOf = sid => dbm.db.prepare('SELECT status FROM submissions WHERE id = ?').get(sid).status;

test.before(async () => {
  /* The server booted its worker and its poller, both of which run on
     intervals. Left alone they drain the queue and call getUpdates while a
     test is halfway through counting either — so drains happen only when a
     test asks for one. */
  telegram.stopWorker();
  telegram.stopPolling();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  submissions.cancelPending();
  telegram.stopWorker(); telegram.stopPolling();
  server.close(); dbm.close();
});

/* ── a card is queued with the claim ──────────────────────────── */

test('a claim queues its card, and the card carries a rendered picture', async () => {
  calls.length = 0;
  const px = freeRange(4).map(i => [i, 0xff0055]);
  const r = await claim(px);
  assert.ok(r.sid > 0);

  const q = queued();
  assert.equal(q.length, 1, 'exactly one card');
  assert.equal(q[0].method, 'sendPhoto');
  const payload = JSON.parse(q[0].payload);
  assert.deepEqual(payload.about, { kind: 'submission', id: r.sid });
  assert.ok(fs.existsSync(payload.params.photoPath), 'the picture was rendered to disk');
  assert.match(payload.params.caption, /FREE CLAIM #s\d+/);
  assert.match(payload.params.caption, /4 px/);
  assert.match(payload.params.caption, /0 prior approved \/ 0 rejected/);
  assert.deepEqual(payload.params.reply_markup.inline_keyboard[0].map(b => b.callback_data),
    [`ap:${r.sid}`, `rj:${r.sid}`]);

  /* it is filed for the audit trail too (§2, preview_path) */
  const row = dbm.db.prepare('SELECT preview_path FROM submissions WHERE id = ?').get(r.sid);
  assert.ok(row.preview_path && fs.existsSync(row.preview_path));

  /* nothing has gone out yet — the worker has not run */
  assert.equal(calls.length, 0);
});

test('draining sends it and remembers the message id', async () => {
  calls.length = 0;
  const sid = JSON.parse(queued()[0].payload).about.id;
  await telegram.drain();

  assert.equal(queued().length, 0, 'the queue empties on success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].params.photo, true, 'the PNG was attached');
  assert.equal(calls[0].params.chat_id, '-1001234567890');

  const row = dbm.db.prepare('SELECT tg_msg_id FROM submissions WHERE id = ?').get(sid);
  assert.ok(row.tg_msg_id > 0, 'so a decision can edit the card rather than reply to it');
});

/* ── §5 Reliability ───────────────────────────────────────────── */

test('a failed send is retried, not dropped', async () => {
  calls.length = 0;
  const r = await claim(freeRange(2).map(i => [i, 0x00ccff]));
  plan = [{ status: 500, body: { ok: false, description: 'Bad Gateway' } }];

  await telegram.drain();
  const q = queued();
  assert.equal(q.length, 1, 'still queued');
  assert.equal(q[0].attempts, 1);
  assert.ok(q[0].next_try > Date.now(), 'and backed off');
  assert.equal(statusOf(r.sid), 'pending', 'the submission is untouched by a failed send');

  /* the wait is over — same row, sent */
  dbm.db.prepare('UPDATE tg_outbox SET next_try = 0 WHERE id = ?').run(q[0].id);
  await telegram.drain();
  assert.equal(queued().length, 0);
});

test('429 waits exactly as long as Telegram asks', async () => {
  await claim(freeRange(1).map(i => [i, 0x123456]));
  plan = [{ status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } } }];

  const before = Date.now();
  await telegram.drain();
  const q = queued();
  assert.equal(q.length, 1);
  const wait = q[0].next_try - before;
  assert.ok(wait >= 29000 && wait <= 31500, `waited ${wait}ms, expected ~30s`);

  dbm.db.prepare('UPDATE tg_outbox SET next_try = 0').run();
  await telegram.drain();
  assert.equal(queued().length, 0);
});

test('backoff climbs and then stops climbing', () => {
  assert.equal(telegram.backoff(0), 1000);
  assert.equal(telegram.backoff(1), 2000);
  assert.equal(telegram.backoff(4), 16000);
  assert.equal(telegram.backoff(30), 5 * 60 * 1000, 'capped at five minutes');
});

test('an edit waits for the card it edits to exist', async () => {
  calls.length = 0;
  const r = await claim(freeRange(2).map(i => [i, 0x445566]));
  /* decide before the card has gone out — the panel can do this, and so can
     a fast moderator if the bot was briefly down */
  submissions.approve(r.sid, 'tg:4242 (sara)');

  const q = queued();
  assert.equal(q.length, 2);
  assert.equal(q[0].method, 'sendPhoto');
  assert.equal(q[1].method, 'editMessageCaption');

  /* hold the send back and let the edit come up first */
  plan = [{ status: 500, body: { ok: false, description: 'nope' } }];
  await telegram.drain();
  const after = queued();
  assert.equal(after.length, 2, 'the edit did not fire into the void');
  assert.equal(after[1].attempts, 1, 'it deferred rather than failed');

  dbm.db.prepare('UPDATE tg_outbox SET next_try = 0').run();
  await telegram.drain();
  await telegram.drain();
  assert.equal(queued().length, 0, 'both went, in order');
  const edit = calls.find(c => c.method === 'editMessageCaption');
  assert.ok(edit, 'the card was edited');
  assert.match(edit.params.caption, /Approved by tg:4242 \(sara\)/);
  assert.deepEqual(asObj(edit.params.reply_markup).inline_keyboard, [],
    'and its buttons are gone');
});

/* ── the webhook ──────────────────────────────────────────────── */

test('a webhook without the right secret is not a webhook', async () => {
  const body = JSON.stringify({ update_id: 1 });
  const none = await request('POST', '/api/tg/webhook', body);
  assert.equal(none.code, 403);

  const wrong = await request('POST', '/api/tg/webhook', body, 'application/json',
    { 'x-telegram-bot-api-secret-token': 'a-secret-worth-16-chary' });
  assert.equal(wrong.code, 403, 'one character off is off');

  const right = await request('POST', '/api/tg/webhook', body, 'application/json',
    { 'x-telegram-bot-api-secret-token': 'a-secret-worth-16-chars' });
  assert.equal(right.code, 200);

  const wrongMethod = await request('GET', '/api/tg/webhook');
  assert.equal(wrongMethod.code, 405);
});

test('the webhook never mints a guest identity', async () => {
  const before = dbm.db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const r = await request('POST', '/api/tg/webhook', JSON.stringify({ update_id: 2 }),
    'application/json', { 'x-telegram-bot-api-secret-token': 'a-secret-worth-16-chars' });
  assert.equal(r.code, 200);
  assert.equal(dbm.db.prepare('SELECT COUNT(*) n FROM users').get().n, before,
    'the bot is not a visitor and must not spend an IP its budget of them');
});

/* ── callbacks ────────────────────────────────────────────────── */

const tap = (data, from) => telegram.onCallback({
  id: 'cbq' + Math.random(), data,
  from: from || { id: 4242, username: 'sara' },
  message: { message_id: 5, chat: { id: -1001234567890 } }
});

test('only a listed moderator can decide', async () => {
  const r = await claim(freeRange(1).map(i => [i, 0x778899]));
  const stranger = await tap(`ap:${r.sid}`, { id: 9999, username: 'nobody' });
  assert.equal(stranger.refused, true);
  assert.equal(statusOf(r.sid), 'pending', 'and nothing happened');

  const mod = await tap(`ap:${r.sid}`);
  assert.equal(mod.ok, true);
  assert.equal(statusOf(r.sid), 'approved');
});

test('a double tap decides once and says who won', async () => {
  const r = await claim(freeRange(2).map(i => [i, 0xaabbcc]));
  const first = await tap(`ap:${r.sid}`, { id: 4242, username: 'sara' });
  const second = await tap(`ap:${r.sid}`, { id: 4343, username: 'omar' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.already, 'approved');
  assert.equal(second.by, 'tg:4242 (sara)');

  calls.length = 0;
  await tap(`rx:${r.sid}:0`, { id: 4343, username: 'omar' });
  assert.equal(statusOf(r.sid), 'approved', 'a reject after an approve changes nothing');
  const answered = calls.filter(c => c.method === 'answerCallbackQuery');
  assert.ok(answered.some(c => /Already approved by tg:4242/.test(c.params.text)));
});

test('rejecting asks what for, and the reason reaches the submitter', async () => {
  const r = await claim(freeRange(3).map(i => [i, 0xddeeff]));
  calls.length = 0;

  const asked = await tap(`rj:${r.sid}`);
  assert.equal(asked.asked, true);
  assert.equal(statusOf(r.sid), 'pending', 'asking is not deciding');
  const keyboard = calls.find(c => c.method === 'editMessageReplyMarkup');
  assert.ok(keyboard, 'the buttons became reasons');
  assert.equal(asObj(keyboard.params.reply_markup).inline_keyboard.length,
    telegram.REASONS.length + 1, 'every reason, plus a way back');

  const done = await tap(`rx:${r.sid}:1`);
  assert.equal(done.ok, true);
  assert.equal(statusOf(r.sid), 'rejected');
  assert.equal(dbm.db.prepare('SELECT reject_reason FROM submissions WHERE id = ?').get(r.sid).reject_reason,
    telegram.REASONS[1]);
});

test('a decision on a submission that no longer exists is survivable', async () => {
  const r = await tap('ap:999999');
  assert.equal(r.missing, true);
});

/* ── brand applications ───────────────────────────────────────── */

test('a brand application becomes a card, and the buttons decide it', async () => {
  const form = {
    email: 'hello@nile-soda.example', password: 'a-long-enough-password',
    business_name: 'Nile Soda Co.', category: 'Drinks',
    description: 'x'.repeat(220), website: 'nile-soda.example',
    contact_name: 'Sara Fahmy', phone: '+20 100 555 0134',
    instapay_handle: 'nilesoda@instapay'
  };
  const before = queued().length;
  const r = await request('POST', '/api/auth/signup', JSON.stringify(form));
  assert.equal(r.code, 200);

  const q = queued();
  assert.equal(q.length, before + 1);
  const card = JSON.parse(q[q.length - 1].payload);
  assert.equal(card.about.kind, 'brand');
  assert.match(card.params.text, /NEW BRAND APPLICATION/);
  assert.match(card.params.text, /Nile Soda Co\./);
  assert.match(card.params.text, /nilesoda@instapay/);

  const uid = card.about.id;
  assert.equal(identity.brandStatus({ id: uid, kind: 'brand' }), 'pending');

  const ok = await tap(`ba:${uid}`);
  assert.equal(ok.ok, true);
  assert.equal(identity.brandStatus({ id: uid, kind: 'brand' }), 'approved');

  const again = await tap(`bb:${uid}`);
  assert.equal(again.ok, false, 'and it cannot be un-approved by tapping the other button');
  assert.equal(identity.brandStatus({ id: uid, kind: 'brand' }), 'approved');
});

/* A brand card and a screenshot-less payment card both create via
   sendMessage, not sendPhoto — there is no photo ahead of them to wait
   for, so draining must not treat "not sendPhoto" as "an edit, wait for
   an id". Regression for the bug where such a card retried forever
   because the id it was waiting on could only ever come from itself. */
test('a card that creates via sendMessage sends on its own, with nothing to wait for', async () => {
  dbm.db.prepare('DELETE FROM tg_outbox').run();
  calls.length = 0;
  const form = {
    email: 'hello@second-brand.example', password: 'a-long-enough-password',
    business_name: 'Second Brand Co.', category: 'Drinks',
    description: 'y'.repeat(220), website: 'second-brand.example',
    contact_name: 'Sara Fahmy', phone: '+20 100 555 0135',
    instapay_handle: 'secondbrand@instapay'
  };
  const r = await request('POST', '/api/auth/signup', JSON.stringify(form));
  assert.equal(r.code, 200);

  const q = queued();
  assert.equal(q.length, 1);
  assert.equal(q[0].method, 'sendMessage', 'a brand card has no photo to attach');
  const uid = JSON.parse(q[0].payload).about.id;

  await telegram.drain();
  assert.equal(queued().length, 0, 'it must not sit forever waiting for a message id only it can produce');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');

  const row = dbm.db.prepare('SELECT tg_msg_id FROM brand_profiles WHERE user_id = ?').get(uid);
  assert.ok(row.tg_msg_id > 0, 'saved, so approving later edits this card instead of stacking a new one');
});

/* ── the end-of-cycle nag (§5) ────────────────────────────────── */

test('the wipe warning lists what is still waiting, once per window', async () => {
  await claim(freeRange(2).map(i => [i, 0x101010]));
  dbm.db.prepare('DELETE FROM tg_outbox').run();

  const sixHoursOut = wall.cycleEnd(wall.wall.cycle) - 5 * 3600 * 1000;
  assert.ok(telegram.digestCheck(sixHoursOut), 'it fires');
  const q = queued();
  assert.equal(q.length, 1);
  const text = JSON.parse(q[0].payload).params.text;
  assert.match(text, /wipes in 6h/);
  assert.match(text, /#s\d+/);

  dbm.db.prepare('DELETE FROM tg_outbox').run();
  assert.equal(telegram.digestCheck(sixHoursOut), null, 'and does not nag twice for the same window');
  assert.equal(queued().length, 0);

  /* …nor does the wider window turn up afterwards. Waking inside six hours
     spends the 48h warning too — it is two days stale and would only
     confuse whoever reads it. */
  const twoDaysOut = wall.cycleEnd(wall.wall.cycle) - 47 * 3600 * 1000;
  assert.equal(telegram.digestCheck(twoDaysOut), null);
  assert.equal(queued().length, 0);
});

test('an empty queue is not an occasion for a warning', () => {
  dbm.db.prepare('DELETE FROM tg_outbox').run();
  /* a cycle nobody has any pending work in — the marks are per cycle, so
     moving it is enough to get a clean window */
  const cycle = wall.wall.cycle;
  wall.wall.cycle = cycle - 40 * 24 * 3600 * 1000;
  try {
    dbm.db.prepare("UPDATE submissions SET status = 'approved' WHERE status = 'pending'").run();
    const sixOut = wall.cycleEnd(wall.wall.cycle) - 5 * 3600 * 1000;
    assert.equal(telegram.digestCheck(sixOut), null, 'nothing to say');
    assert.equal(queued().length, 0);
    /* and the window is not spent, so work claimed a minute later still
       gets its warning */
    assert.equal(dbm.getMeta(`tg_d6_${wall.wall.cycle}`), null);
  } finally { wall.wall.cycle = cycle; }
});

/* ── the convenience commands (§7.3) ──────────────────────────── */

test('/pending and /stats answer in the group', async () => {
  calls.length = 0;
  await telegram.onCommand({ text: '/pending', chat: { id: -1 }, from: { id: 4242 } });
  await telegram.onCommand({ text: '/stats@s37bot', chat: { id: -1 }, from: { id: 4242 } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].params.text, /waiting/);
  assert.match(calls[1].params.text, /live/);

  calls.length = 0;
  await telegram.onCommand({ text: '/stats', chat: { id: -1 }, from: { id: 1 } });
  assert.equal(calls.length, 0, 'not for strangers');
});

test('/freeze asks before it closes the wall', async () => {
  const settings = require('../server/settings.js');
  calls.length = 0;
  await telegram.onCommand({ text: '/freeze', chat: { id: -1 }, from: { id: 4242 } });
  assert.equal(settings.S.MAINTENANCE, false, 'asking is not doing');
  const ask = calls.find(c => c.method === 'sendMessage');
  assert.ok(ask, 'it asked');
  assert.deepEqual(asObj(ask.params.reply_markup).inline_keyboard[0].map(b => b.callback_data), ['fz:1']);

  await telegram.onCallback({
    id: 'cb', data: 'fz:1', from: { id: 4242, username: 'sara' },
    message: { message_id: 7, chat: { id: -1 } }
  });
  assert.equal(settings.S.MAINTENANCE, true, 'and the tap does it');

  await telegram.onCallback({
    id: 'cb2', data: 'fz:0', from: { id: 4242, username: 'sara' },
    message: { message_id: 8, chat: { id: -1 } }
  });
  assert.equal(settings.S.MAINTENANCE, false);

  /* a stranger cannot even ask */
  calls.length = 0;
  await telegram.onCommand({ text: '/freeze', chat: { id: -1 }, from: { id: 1 } });
  assert.equal(calls.length, 0);
});
