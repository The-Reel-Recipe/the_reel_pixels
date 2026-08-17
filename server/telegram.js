/* ═══════════════════════════════════════════════════════════════
   telegram — the moderation surface

   Every card goes out through `tg_outbox`, and the row is inserted in
   the same transaction as the state change that caused it (PLAN §5,
   Reliability). That is the whole design: a claim commits with its
   card, or neither happens. Telegram being down for an hour means
   cards arrive an hour late, never that a submission is lost or
   quietly approved.

   The worker drains serially with exponential backoff and honours
   429 retry_after. Nothing is ever dropped — a send that cannot
   succeed keeps its place at the five-minute cap where the admin
   panel's System page (§7.2) can see it and decide.

   Callbacks are assumed to arrive more than once, because Telegram
   delivers at least once and moderators tap twice. Nothing here
   guards against that directly; submissions.js does, by making every
   transition conditional on the current status, and this file just
   reports whatever it is told back into the chat.

   Three modes: `webhook` in production, `poll` for a laptop with no
   tunnel, `off` for a dev machine with no bot at all (submissions
   approve themselves — see submissions.afterCreate).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const cfg = require('./config.js');
const settings = require('./settings.js');
const { S } = settings;
const { db, tx, logEvent } = require('./db.js');
const submissions = require('./submissions.js');
const identity = require('./identity.js');
const payments = require('./payments.js');
const wall = require('./wall.js');
const render = require('./render.js');

const API = token => `https://api.telegram.org/bot${token}`;
const on = () => cfg.TG_MODE !== 'off' && !!cfg.TG_BOT_TOKEN && !!cfg.TG_CHAT_ID;

/* ── Outbox ───────────────────────────────────────────────────── */

const insSend = db.prepare(
  'INSERT INTO tg_outbox (method, payload, next_try, created_at) VALUES (?, ?, ?, ?)');
const nextDue = db.prepare('SELECT * FROM tg_outbox WHERE next_try <= ? ORDER BY id LIMIT 1');
const bumpTry = db.prepare('UPDATE tg_outbox SET attempts = attempts + 1, next_try = ? WHERE id = ?');
const dropSend = db.prepare('DELETE FROM tg_outbox WHERE id = ?');
const outboxDepth = db.prepare('SELECT COUNT(*) n, MIN(created_at) oldest FROM tg_outbox');

/* No transaction of its own — callers are already inside one, which is
   exactly the property that makes "the card commits with the decision"
   true rather than aspirational. */
function enqueue(method, payload, now = Date.now()) {
  if (!on()) return null;
  return Number(insSend.run(method, JSON.stringify(payload), now, now).lastInsertRowid);
}

const BACKOFF_CAP = 5 * 60 * 1000;
const backoff = attempts => Math.min(BACKOFF_CAP, 1000 * Math.pow(2, Math.min(attempts, 9)));

/* ── Talking to the API ───────────────────────────────────────── */

/* Node's fetch has FormData and Blob built in, which is the whole reason
   sendPhoto needs no dependency. Photos are referenced by path in the
   outbox and read here, so a queued card is a few hundred bytes of JSON
   rather than a megabyte of PNG sitting in SQLite. */
async function call(method, params) {
  const url = `${API(cfg.TG_BOT_TOKEN)}/${method}`;
  let res;
  if (params.photoPath) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (k === 'photoPath') continue;
      fd.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    fd.set('photo', new Blob([fs.readFileSync(params.photoPath)], { type: 'image/png' }), 'card.png');
    res = await fetch(url, { method: 'POST', body: fd });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    });
  }
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    const err = new Error(`telegram ${method}: ${body.description || res.status}`);
    err.code = res.status;
    err.retryAfter = body.parameters && body.parameters.retry_after;
    /* 400s are usually permanent (a deleted message, a bad caption) and 403
       means the bot was removed from the group — worth saying out loud, but
       still not worth dropping the row over. */
    err.permanent = res.status === 400;
    throw err;
  }
  return body.result;
}

/* ── Where a card lives ───────────────────────────────────────── */

/* An edit needs the message id the original send came back with, and the
   send may still be sitting in the queue behind it. Rather than thread that
   through, the payload names what it is about and the id is looked up at
   send time — if it is not there yet the row simply waits its turn again. */
const msgIdOf = {
  submission: db.prepare('SELECT tg_msg_id id FROM submissions WHERE id = ?'),
  payment: db.prepare('SELECT tg_msg_id id FROM payments WHERE id = ?'),
  brand: db.prepare('SELECT tg_msg_id id FROM brand_profiles WHERE user_id = ?')
};
const setMsgId = {
  submission: db.prepare('UPDATE submissions SET tg_msg_id = ? WHERE id = ?'),
  payment: db.prepare('UPDATE payments SET tg_msg_id = ? WHERE id = ?'),
  brand: db.prepare('UPDATE brand_profiles SET tg_msg_id = ? WHERE user_id = ?')
};
/* sendPhoto and sendMessage create a card and hand back the id to save;
   everything else edits one that must already exist. Brand cards and
   screenshot-less payment cards create via sendMessage, not sendPhoto —
   keying this off the method name rather than "is it sendPhoto" is what
   makes those work the same as the photo cards. */
const EDIT_METHODS = new Set(['editMessageCaption', 'editMessageReplyMarkup', 'editMessageText']);

/* ── The worker ───────────────────────────────────────────────── */

let timer = null, running = false;

async function drainOne(now) {
  const row = nextDue.get(now);
  if (!row) return false;
  const payload = JSON.parse(row.payload);

  try {
    if (payload.about) {
      const found = msgIdOf[payload.about.kind].get(payload.about.id);
      const id = found && found.id;
      if (EDIT_METHODS.has(row.method) && !id) {
        /* the card it edits has not gone out yet — wait for it rather than
           sending an edit into the void */
        bumpTry.run(now + 2000, row.id);
        return true;
      }
      if (id) payload.params.message_id = id;
    }
    const result = await call(row.method, payload.params);
    if (!EDIT_METHODS.has(row.method) && payload.about && result && result.message_id) {
      setMsgId[payload.about.kind].run(result.message_id, payload.about.id);
    }
    dropSend.run(row.id);
  } catch (err) {
    const wait = err.retryAfter ? err.retryAfter * 1000 : backoff(row.attempts);
    bumpTry.run(now + wait, row.id);
    /* Loud on the first failure and then quiet — a bot that has been down
       for an hour should not have written an hour of identical lines. */
    if (row.attempts === 0 || row.attempts === 5) {
      console.warn(`telegram: ${err.message} — retrying in ${Math.round(wait / 1000)}s ` +
        `(attempt ${row.attempts + 1})`);
    }
    if (err.permanent && row.attempts === 0) {
      logEvent('system', 'tg-error', { method: row.method, error: err.message }, now);
    }
  }
  return true;
}

async function drain() {
  if (running || !on()) return;
  running = true;
  try {
    const now = Date.now();
    /* A bounded slice per tick: a backlog should clear briskly without the
       loop hogging the process that is also serving the wall. */
    for (let i = 0; i < 20; i++) if (!await drainOne(now)) break;
  } finally { running = false; }
}

function startWorker() {
  if (timer || !on()) return null;
  timer = setInterval(drain, 1000);
  timer.unref();
  return timer;
}
function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ── Captions and keyboards (§5) ──────────────────────────────── */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ago = ms => {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60000))}m`;
};
const money = piasters => `${(piasters / 100).toLocaleString('en-US')} EGP`;

const HEAD = { free: '🟩 FREE CLAIM', paint: '💰 PAINT', brand: '🏢 BRAND' };

/* Same states payCaption() shows on the payment's own card — repeated
   here so a moderator reading the submission card doesn't have to go
   find the other one to see whether Approve is even going to work. */
const PAY_WORD = {
  awaiting_transfer: 'AWAITING TRANSFER', submitted: 'SUBMITTED', verified: '✅ VERIFIED',
  rejected: '🚫 REJECTED', refund_due: 'REFUND DUE', refunded: 'REFUNDED', expired: 'EXPIRED'
};
const selSubPayment = db.prepare('SELECT code, status, instapay_ref FROM payments WHERE id = ?');

function captionFor(sub, now) {
  const rec = submissions.recordOf(sub.user_id, sub.id);
  const bits = [
    `<b>${HEAD[sub.type] || sub.type} #s${sub.id}</b>`,
    esc(sub.brand_name || sub.handle),
    `${sub.px_count} px`
  ];
  if (sub.type === 'brand') {
    if (sub.brand_url) bits.push(esc(sub.brand_url));
    bits.push(money(sub.px_count * S.PRICE_COMPANY * 100));
  }
  if (sub.payment_id) {
    const p = selSubPayment.get(sub.payment_id);
    if (p) {
      bits.push(`payment ${esc(p.code)} ${PAY_WORD[p.status] || p.status}` +
        (p.instapay_ref ? ` ref ${esc(p.instapay_ref)}` : ''));
    }
  }
  bits.push(`${sub.kind === 'brand' ? 'brand' : 'guest'} since ${ago(now - (sub.created_at || now))}`);
  bits.push(`${rec.approved} prior approved / ${rec.rejected} rejected`);
  return bits.join(' · ');
}

const btn = (text, callback_data) => ({ text, callback_data });
const decideKeys = sid => ({
  inline_keyboard: [[btn('✅ Approve', `ap:${sid}`), btn('❌ Reject', `rj:${sid}`)]]
});

/* Canned reasons, because a moderator on a phone will not type one and a
   rejection with no reason is the thing people write in about. "Other"
   still lands a usable message in the submitter's history. */
const REASONS = [
  'Offensive or hateful',
  'Spam or advertising',
  'Covers someone else’s work',
  'Not suitable for a public wall',
  'Rejected by a moderator'
];
const reasonKeys = sid => ({
  inline_keyboard: [
    ...REASONS.map((r, i) => [btn(`❌ ${r}`, `rx:${sid}:${i}`)]),
    [btn('« back', `bk:${sid}`)]
  ]
});

const brandKeys = uid => ({
  inline_keyboard: [[btn('✅ Approve brand', `ba:${uid}`), btn('❌ Reject brand', `bb:${uid}`)]]
});

/* ── Sending a card ───────────────────────────────────────────── */

const selSub = db.prepare(
  `SELECT s.*, u.handle, u.kind FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`);

/* Called from submissions.afterCreate, which http.js runs straight after the
   claim transaction — so rendering (which is CPU, not a transaction) happens
   outside it and only the enqueue is transactional. */
function cardForSubmission(sid, now = Date.now()) {
  if (!on()) return null;
  const sub = selSub.get(sid);
  if (!sub || sub.status !== 'pending') return null;

  let photo;
  try {
    photo = render.cardFor(sub, wall.wall.live);
  } catch (err) {
    console.warn(`telegram: could not render card for s${sid} —`, err.message);
    return null;
  }
  db.prepare('UPDATE submissions SET preview_path = ? WHERE id = ?').run(photo, sid);

  return tx(() => enqueue('sendPhoto', {
    about: { kind: 'submission', id: sid },
    params: {
      chat_id: cfg.TG_CHAT_ID,
      photoPath: photo,
      caption: captionFor(sub, now),
      parse_mode: 'HTML',
      reply_markup: decideKeys(sid)
    }
  }, now));
}

/* ── A report (§11) ───────────────────────────────────────────────
   TERMS §11 promises a REPORT button on any pixel and a person who looks.
   The button is in the tooltip and the route is reports.js; this is the
   half that makes "a person looks" true, because a report that only
   reaches the events table reaches nobody.

   It is a message, not a photo. The drawing already has a card in this
   group from when it was moderated — re-sending the picture would be a
   second copy of something the group has seen, and the point of this one
   is the complaint, not the artwork. The coordinates are a link into the
   panel for anybody who wants to look again.

   Only one button: take it down. Approve is not an outcome here — the
   thing is already approved and already up. Doing nothing is the other
   outcome and needs no button. */

const REPORT_WHY = {
  sexual: 'Sexual content', hate: 'Hate or harassment', violence: 'Violence',
  personal: "Someone's personal information", copyright: 'Copyright', spam: 'Spam',
  other: 'Other'
};

function cardForReport(sid, about, now = Date.now()) {
  if (!on()) return null;
  const sub = selSub.get(sid);
  if (!sub) return null;

  const where = cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/admin#pixel-${about.x}-${about.y}` : null;
  const lines = [
    `<b>⚑ Reported — #s${sid}</b>`,
    `${REPORT_WHY[about.reason] || about.reason}`,
    `(${about.x}, ${about.y}) · ${sub.px_count} px · by ${esc(sub.brand_name || sub.handle)}`,
    sub.status === 'approved' ? 'On the wall now.' : `Currently ${sub.status}.`
  ];
  if (about.note) lines.push(`\n<i>${esc(about.note)}</i>`);
  if (where) lines.push(`\n${where}`);

  return tx(() => enqueue('sendMessage', {
    /* its own kind, so a later decision on the submission does not try to
       edit this message as though it were the moderation card */
    about: { kind: 'report', id: sid },
    params: {
      chat_id: cfg.TG_CHAT_ID,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: sub.status === 'approved'
        ? { inline_keyboard: [[btn('🧹 Take it down', `td:${sid}`)]] }
        : { inline_keyboard: [] }
    }
  }, now));
}

/* A decision edits the card it was made on rather than adding to the thread:
   a moderation group with forty cards in it is unreadable if every one of
   them is three messages long. */
const OUTCOME = {
  approved: '✅ Approved', rejected: '❌ Rejected',
  expired: '⌛ Expired', taken_down: '🧹 Taken down'
};

function editDecision(sub, status, actor, reason, now = Date.now()) {
  if (!on()) return null;
  const when = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const line = `\n\n${OUTCOME[status] || status} by ${esc(actor)} · ${when}` +
    (reason ? `\n<i>${esc(reason)}</i>` : '');
  return enqueue('editMessageCaption', {
    about: { kind: 'submission', id: sub.id },
    params: {
      chat_id: cfg.TG_CHAT_ID,
      caption: captionFor(sub, now) + line,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    }
  }, now);
}

/* ── Brand applications (§3) ──────────────────────────────────── */

const selBrand = db.prepare(
  `SELECT u.id, u.handle, u.email, b.* FROM users u
     JOIN brand_profiles b ON b.user_id = u.id WHERE u.id = ?`);

function cardForBrand(userId, now = Date.now()) {
  if (!on()) return null;
  const b = selBrand.get(userId);
  if (!b || b.status !== 'pending') return null;

  const socials = (() => { try { return JSON.parse(b.socials || '[]'); } catch (e) { return []; } })();
  const text = [
    `<b>🏢 NEW BRAND APPLICATION</b>`,
    `<b>${esc(b.business_name)}</b> · ${esc(b.category)}`,
    `contact: ${esc(b.contact_name)} · ${esc(b.phone)} · ${esc(b.email)}`,
    b.website ? `site: ${esc(b.website)}` : null,
    socials.length ? `social: ${socials.map(esc).join(', ')}` : null,
    b.reg_number ? `reg: ${esc(b.reg_number)}` : null,
    `instapay: ${esc(b.instapay_handle)}`,
    '',
    esc(b.description)
  ].filter(l => l !== null).join('\n');

  return tx(() => enqueue('sendMessage', {
    about: { kind: 'brand', id: userId },
    params: {
      chat_id: cfg.TG_CHAT_ID,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      reply_markup: brandKeys(userId)
    }
  }, now));
}

function editBrandDecision(userId, status, actor, now = Date.now()) {
  const b = selBrand.get(userId);
  if (!on() || !b) return null;
  const when = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return enqueue('editMessageReplyMarkup', {
    about: { kind: 'brand', id: userId },
    params: { chat_id: cfg.TG_CHAT_ID, reply_markup: { inline_keyboard: [] } }
  }, now) && enqueue('sendMessage', {
    params: {
      chat_id: cfg.TG_CHAT_ID,
      text: `${status === 'approved' ? '✅' : '❌'} <b>${esc(b.business_name)}</b> ` +
        `${status} by ${esc(actor)} · ${when}`,
      parse_mode: 'HTML'
    }
  }, now);
}

/* ── Payment cards (§6) ───────────────────────────────────────── */

/* The moderator's job here is to open their own InstaPay app and look for
   the amount and the code. Everything they need to do that is in the
   caption; the screenshot, when there is one, is the photo. */
const selPay = db.prepare(
  `SELECT p.*, u.handle, s.id sid, s.px_count, s.brand_name
     FROM payments p JOIN users u ON u.id = p.user_id
     LEFT JOIN submissions s ON s.payment_id = p.id
    WHERE p.id = ?`);

const PAY_HEAD = { paint_pack: '💳 PAINT PACK', brand_booking: '🏢 BRAND BOOKING' };
const PAY_STATE = {
  awaiting_transfer: 'waiting for the transfer',
  submitted: 'SAYS THEY HAVE PAID',
  verified: '✅ VERIFIED',
  rejected: '🚫 NOT RECEIVED',
  refund_due: '💸 REFUND OWED',
  refunded: '💸 REFUNDED',
  expired: '⌛ EXPIRED'
};

function payCaption(p, now) {
  const bits = [
    `<b>${PAY_HEAD[p.kind] || p.kind} ${esc(p.code)}</b>`,
    esc(p.brand_name || p.handle),
    money(p.amount)
  ];
  if (p.kind === 'paint_pack') bits.push(`${p.pack} paint`);
  if (p.sid) bits.push(`#s${p.sid} · ${p.px_count} px`);
  bits.push(PAY_STATE[p.status] || p.status);
  const tail = [];
  if (p.instapay_ref) tail.push(`ref <code>${esc(p.instapay_ref)}</code>`);
  if (p.payer_handle) tail.push(`from <code>${esc(p.payer_handle)}</code>`);
  return bits.join(' · ') + (tail.length ? `\n${tail.join(' · ')}` : '') +
    `\n<i>look for ${money(p.amount)} with “${esc(p.code)}” in the note</i>`;
}

const payKeys = pid => ({
  inline_keyboard: [[btn('💵 Money received', `mv:${pid}`), btn('🚫 Not received', `mn:${pid}`)]]
});
const refundKeys = pid => ({ inline_keyboard: [[btn('💸 Refund sent', `rf:${pid}`)]] });

function cardForPayment(paymentId, now = Date.now()) {
  if (!on()) return null;
  const p = selPay.get(paymentId);
  if (!p) return null;

  const params = {
    chat_id: cfg.TG_CHAT_ID,
    caption: payCaption(p, now),
    parse_mode: 'HTML',
    reply_markup: payKeys(paymentId)
  };
  /* A screenshot makes the card a photo; without one there is nothing to
     look at, so it goes as text and sendMessage wants `text`, not `caption`. */
  if (p.screenshot_path && fs.existsSync(p.screenshot_path)) {
    params.photoPath = p.screenshot_path;
    return tx(() => enqueue('sendPhoto', { about: { kind: 'payment', id: paymentId }, params }, now));
  }
  const { caption, ...rest } = params;
  return tx(() => enqueue('sendMessage', {
    about: { kind: 'payment', id: paymentId },
    params: { ...rest, text: caption }
  }, now));
}

/* A payment card can be either a photo or a message, and Telegram has a
   different edit method for each. Which one it was is recoverable from
   whether a screenshot was ever attached. */
function editPayment(paymentId, status, actor, now = Date.now()) {
  if (!on()) return null;
  const p = selPay.get(paymentId);
  if (!p) return null;
  const when = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const body = payCaption(p, now) +
    `\n\n${PAY_STATE[p.status] || p.status} · ${esc(actor)} · ${when}`;
  const photo = !!(p.screenshot_path && fs.existsSync(p.screenshot_path));
  /* refund_due is the one state that keeps a button: somebody still has to
     send the money and then say so. */
  const markup = p.status === 'refund_due' ? refundKeys(paymentId) : { inline_keyboard: [] };
  return enqueue(photo ? 'editMessageCaption' : 'editMessageText', {
    about: { kind: 'payment', id: paymentId },
    params: photo
      ? { chat_id: cfg.TG_CHAT_ID, caption: body, parse_mode: 'HTML', reply_markup: markup }
      : { chat_id: cfg.TG_CHAT_ID, text: body, parse_mode: 'HTML', reply_markup: markup }
  }, now);
}

/* §6: a refund nobody is nagged about is a refund that does not happen. This
   is a *new* message rather than an edit on purpose — an edit to a card that
   has scrolled out of view is not a reminder. */
function remindRefund(paymentId, now = Date.now()) {
  if (!on()) return null;
  const p = selPay.get(paymentId);
  if (!p || p.status !== 'refund_due') return null;
  return tx(() => enqueue('sendMessage', {
    params: {
      chat_id: cfg.TG_CHAT_ID,
      text: `💸 <b>Still owed:</b> ${money(p.amount)} back to <code>${esc(p.payer_handle || '—')}</code>` +
        `\norder ${esc(p.code)} · ${esc(p.brand_name || p.handle)}` +
        `\n\nSend it from InstaPay, then tap below.`,
      parse_mode: 'HTML',
      reply_markup: refundKeys(paymentId)
    }
  }, now));
}

/* ── Callbacks ────────────────────────────────────────────────── */

/* Fails closed. This read "an empty list means everybody", which turns one
   blanked environment variable into "every member of the group decides what
   goes on the public wall" — silently, with nothing in the log. An empty
   list now means nobody, and config.js refuses to boot production without
   one, so the failure is loud at start rather than invisible forever. */
const isMod = id => cfg.TG_MOD_IDS.includes(Number(id));

/* Updates from anywhere but the moderation group are ignored outright.
   Without this, adding the bot to any other group by its public username
   hands strangers /pending and /stats (which list the queue with handles)
   and a /freeze button that closes the wall to writes. */
const fromOurChat = chatId => String(chatId) === String(cfg.TG_CHAT_ID);
const who = from => `tg:${from.id} (${from.username || from.first_name || 'unknown'})`;

/* Always answers the callback query — an unanswered one leaves a spinner on
   the moderator's button until Telegram gives up. */
async function answer(id, text, alert) {
  try {
    await call('answerCallbackQuery', {
      callback_query_id: id, text: (text || '').slice(0, 200), show_alert: !!alert
    });
  } catch (err) { /* the tap is already handled; the toast is not worth a retry */ }
}

async function onCallback(q) {
  const data = String(q.data || '');
  const actor = who(q.from || {});
  if (!fromOurChat(q.message && q.message.chat && q.message.chat.id)) return null;
  if (!isMod(q.from && q.from.id)) {
    await answer(q.id, 'You are not on the moderator list for this wall.', true);
    return { refused: true };
  }

  const [verb, a, b] = data.split(':');
  const now = Date.now();

  if (verb === 'rj') {                                  // ask what for
    await call('editMessageReplyMarkup', {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      reply_markup: reasonKeys(Number(a))
    }).catch(() => {});
    await answer(q.id, 'Pick a reason');
    return { asked: true };
  }
  if (verb === 'bk') {                                  // …changed their mind
    await call('editMessageReplyMarkup', {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      reply_markup: decideKeys(Number(a))
    }).catch(() => {});
    await answer(q.id, '');
    return { asked: false };
  }

  if (verb === 'ap' || verb === 'rx') {
    const sid = Number(a);
    const reason = verb === 'rx' ? (REASONS[Number(b)] || REASONS[REASONS.length - 1]) : null;
    const r = verb === 'ap'
      ? submissions.approve(sid, actor, now)
      : submissions.reject(sid, actor, reason, now);

    if (r.missing) { await answer(q.id, 'That submission is gone.', true); return r; }
    if (r.unpaid) { await answer(q.id, 'Verify payment first.', true); return r; }
    if (!r.ok) {
      /* the other tap won. Say who, and leave the card exactly as they left it */
      await answer(q.id, `Already ${r.already}${r.by ? ` by ${r.by}` : ''}.`, true);
      return r;
    }
    await answer(q.id, verb === 'ap' ? 'Approved — it is on the wall.' : `Rejected: ${reason}`);
    return r;
  }

  /* Acting on a report. takedown() is the existing §7.2 erasure of approved
     work — it publishes the removal to every open wall and tells the owner —
     so this button is a way into it from the group rather than a new path. */
  if (verb === 'td') {
    const sid = Number(a);
    const r = submissions.takedown(sid, actor, 'Reported and taken down', now);
    if (r.missing) { await answer(q.id, 'That submission is gone.', true); return r; }
    if (!r.ok) { await answer(q.id, `Already ${r.already}.`, true); return r; }
    await call('editMessageReplyMarkup', {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    await answer(q.id, 'Taken down, and the painter has been told.');
    return r;
  }

  if (verb === 'fz') {
    const to = a === '1';
    const r = settings.set('maintenance', to, actor, now);
    if (r.error) { await answer(q.id, r.message, true); return r; }
    await call('editMessageText', {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: to ? `🧊 Wall frozen by ${esc(actor)}.` : `☀️ Wall open again — ${esc(actor)}.`,
      parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    await answer(q.id, to ? 'Frozen.' : 'Open.');
    return r;
  }

  if (verb === 'mv' || verb === 'mn' || verb === 'rf') {
    const pid = Number(a);
    const r = verb === 'mv' ? payments.verify(pid, actor, now)
      : verb === 'mn' ? payments.reject(pid, actor, now)
        : payments.markRefunded(pid, actor, now);
    if (r.missing) { await answer(q.id, 'That order is gone.', true); return r; }
    if (!r.ok) { await answer(q.id, `Already ${String(r.already).replace('_', ' ')}.`, true); return r; }
    await answer(q.id, verb === 'mv' ? 'Verified — paint credited.'
      : verb === 'mn' ? 'Marked as not received.' : 'Refund recorded. Thank you.');
    return r;
  }

  if (verb === 'ba' || verb === 'bb') {
    const uid = Number(a);
    const status = verb === 'ba' ? 'approved' : 'rejected';
    const r = identity.decideBrand(uid, status, actor, null, now);
    if (!r.ok) { await answer(q.id, `Already ${r.already}.`, true); return r; }
    editBrandDecision(uid, status, actor, now);
    await answer(q.id, `Brand ${status}.`);
    return r;
  }

  await answer(q.id, '');
  return { ignored: true };
}

/* Convenience commands (§7.3). Anything heavier belongs in the panel. */
async function onCommand(msg) {
  const text = String(msg.text || '').trim().split(/\s+/)[0].replace(/@.*$/, '');
  if (!fromOurChat(msg.chat && msg.chat.id)) return null;
  if (!isMod(msg.from && msg.from.id)) return null;
  const say = t => call('sendMessage', {
    chat_id: msg.chat.id, text: t, parse_mode: 'HTML'
  }).catch(() => {});

  if (text === '/pending') {
    const q = submissions.queue();
    const oldest = q.length ? ago(Date.now() - q[0].created_at) : '—';
    return say(`⏳ <b>${q.length}</b> waiting · oldest ${oldest}`);
  }
  if (text === '/stats') {
    const d = outboxDepth.get();
    return say(`🖼 ${wall.wall.live.size} live · ${wall.wall.reserved.size} booked · ` +
      `⏳ ${submissions.pendingCount()} waiting · 📤 outbox ${d.n}` +
      (settings.S.MAINTENANCE ? '\n\n🧊 <b>The wall is frozen.</b>' : ''));
  }

  /* §7.3. Freezing the wall is the one command here that changes anything,
     so it asks first — a fat thumb in a group chat should not be able to
     close the wall. */
  if (text === '/freeze' || text === '/unfreeze') {
    const to = text === '/freeze';
    if (settings.S.MAINTENANCE === to) {
      return say(to ? 'Already frozen.' : 'The wall is already open.');
    }
    return call('sendMessage', {
      chat_id: msg.chat.id,
      text: to
        ? '🧊 Freeze the wall? Reading keeps working; claims, bookings and orders will say “back soon”.'
        : '☀️ Open the wall back up?',
      reply_markup: { inline_keyboard: [[btn(to ? 'Yes, freeze it' : 'Yes, open it', `fz:${to ? 1 : 0}`)]] }
    }).catch(() => {});
  }
  return null;
}

async function onUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message && update.message.text) return onCommand(update.message);
  return null;
}

/* ── Webhook ──────────────────────────────────────────────────── */

/* The secret header is the whole authentication: the URL is guessable in
   principle and Telegram offers nothing else. Checked before the body is
   parsed, and constant-time so the check itself says nothing. */
const crypto = require('crypto');
function secretOk(header) {
  const want = Buffer.from(cfg.TG_WEBHOOK_SECRET || '');
  const got = Buffer.from(String(header || ''));
  return want.length > 0 && want.length === got.length && crypto.timingSafeEqual(want, got);
}

/* ── Polling (local dev without a tunnel) ─────────────────────── */

let pollTimer = null, offset = 0, polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const updates = await call('getUpdates', { offset, timeout: 0, limit: 20 });
    for (const u of updates || []) {
      offset = u.update_id + 1;
      try { await onUpdate(u); } catch (err) { console.warn('telegram poll:', err.message); }
    }
  } catch (err) {
    // a poll that fails is a poll; the next one is two seconds away
  } finally { polling = false; }
}
function startPolling() {
  if (pollTimer || cfg.TG_MODE !== 'poll' || !on()) return null;
  pollTimer = setInterval(pollOnce, 2000);
  pollTimer.unref();
  return pollTimer;
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ── End-of-cycle warnings (§5) ───────────────────────────────── */

/* Unresolved cards are only a problem near the wipe, when there is no
   longer time to fix them — so the nag arrives 48h and 6h out and not
   before. Fired at most once per window per cycle. */
/* Most urgent first, because that is the one that matters: if the process
   was down when the 48h mark went past, waking up five hours out should say
   "six hours" and not deliver a stale two-day warning. Crossing a window
   therefore spends every wider one too. */
const DIGESTS = [{ key: 'd6', at: 6 * 3600 * 1000 }, { key: 'd48', at: 48 * 3600 * 1000 }];
const { getMeta, setMeta } = require('./db.js');

function digestCheck(now = Date.now()) {
  if (!on()) return null;
  const left = wall.cycleEnd(wall.wall.cycle) - now;
  if (left <= 0) return null;

  const window = DIGESTS.find(d => left <= d.at);
  if (!window) return null;
  const mark = key => `tg_${key}_${wall.wall.cycle}`;
  if (getMeta(mark(window.key))) return null;

  /* Nothing waiting is not an occasion for a message — and not a reason to
     spend the window either, so anything claimed in the next ten minutes
     still gets its warning. */
  const q = submissions.queue();
  if (!q.length) return null;

  for (const d of DIGESTS) if (d.at >= window.at) setMeta(mark(d.key), String(now));

  const lines = q.slice(0, 20).map(s =>
    `• #s${s.id} ${s.type} · ${s.px_count}px · ${esc(s.handle)} · waiting ${ago(now - s.created_at)}`);
  return tx(() => enqueue('sendMessage', {
    params: {
      chat_id: cfg.TG_CHAT_ID,
      text: `⏰ <b>The wall wipes in ${Math.round(window.at / 3600000)}h</b> and ${q.length} ` +
        `submission(s) are still waiting:\n\n${lines.join('\n')}` +
        (q.length > 20 ? `\n…and ${q.length - 20} more` : '') +
        `\n\nAnything still pending at the reset is settled automatically — free work expires, ` +
        `paid work is refunded.`,
      parse_mode: 'HTML'
    }
  }, now));
}

/* ── Wiring ───────────────────────────────────────────────────── */

/* submissions.js knows nothing about Telegram; it just announces what it
   did and this file decides that means a card. Registered at load, which
   server/index.js triggers by requiring this module. */
submissions.onCreated(sid => cardForSubmission(sid));
submissions.onDecided((sub, status, actor, reason) => editDecision(sub, status, actor, reason));

/* payments.js is the same arrangement: it announces, this decides that means
   a card, and it calls back into submissions for the one thing it cannot do
   itself — letting go of cells an unpaid booking was holding. */
payments.attach({
  card: pid => cardForPayment(pid),
  edit: (pid, status, actor) => editPayment(pid, status, actor),
  remind: pid => remindRefund(pid),
  notify: (userId, pid, status) => wall.notify({ t: 'pay', pid, status }),
  voidSubmission: (sid, actor, reason, now) => submissions.reject(sid, actor, reason, now)
});

function start() {
  if (!on()) {
    if (cfg.TG_MODE === 'off') console.log('telegram   →  off (submissions auto-approve after ' +
      `${cfg.AUTO_APPROVE_MS}ms)`);
    else console.log('telegram   →  configured mode is ' + cfg.TG_MODE + ' but the token/chat is missing');
    return;
  }
  startWorker();
  startPolling();
  const t = setInterval(() => digestCheck(), 10 * 60 * 1000);
  t.unref();
  console.log(`telegram   →  ${cfg.TG_MODE} · chat ${cfg.TG_CHAT_ID} · ` +
    `${cfg.TG_MOD_IDS.length || 'any'} moderator id(s)`);
}

module.exports = {
  on, start, enqueue, drain, drainOne, backoff, startWorker, stopWorker,
  startPolling, stopPolling, pollOnce,
  call, captionFor, decideKeys, reasonKeys, REASONS,
  cardForSubmission, editDecision, cardForBrand, editBrandDecision, cardForReport,
  cardForPayment, editPayment, remindRefund, payCaption,
  onUpdate, onCallback, onCommand, secretOk, digestCheck,
  status: () => outboxDepth.get()
};
