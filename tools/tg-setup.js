/* ═══════════════════════════════════════════════════════════════
   tg-setup — the once-per-deploy Telegram wiring (PLAN §5, setup)

     node tools/tg-setup.js            what the bot is and where it points
     node tools/tg-setup.js --chat     find the moderation group's chat id
     node tools/tg-setup.js --webhook  point Telegram at PUBLIC_URL
     node tools/tg-setup.js --poll     take the webhook off again
     node tools/tg-setup.js --test     send a message to TG_CHAT_ID

   The chat id is the fiddly one. Telegram will not tell you a group's
   id; you have to say something in the group and read it back off an
   update. So: add the bot, post any message, run --chat.

   Needs TG_BOT_TOKEN in the environment. --webhook additionally needs
   PUBLIC_URL and TG_WEBHOOK_SECRET.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('../server/config.js');

const api = (method, params) => fetch(
  `https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/${method}`,
  params
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }
    : undefined
).then(r => r.json());

function need(name, value) {
  if (value) return value;
  console.error(`\n  ${name} is not set. Put it in the environment and try again.\n`);
  process.exit(1);
}

async function whoami() {
  const me = await api('getMe');
  if (!me.ok) { console.error('  token rejected:', me.description); process.exit(1); }
  const hook = await api('getWebhookInfo');
  console.log(`\n  bot        @${me.result.username}  (${me.result.first_name})`);
  console.log(`  mode       ${cfg.TG_MODE}`);
  console.log(`  chat       ${cfg.TG_CHAT_ID || '— not set —'}`);
  console.log(`  moderators ${cfg.TG_MOD_IDS.length ? cfg.TG_MOD_IDS.join(', ') : '— anyone in the group —'}`);
  if (hook.ok) {
    const h = hook.result;
    console.log(`  webhook    ${h.url || '— none (polling) —'}`);
    if (h.pending_update_count) console.log(`  pending    ${h.pending_update_count}`);
    if (h.last_error_message) console.log(`  last error ${h.last_error_message}`);
  }
  console.log('');
}

/* getUpdates is exclusive with a webhook, so this drops the webhook first —
   which is safe to do on a live deploy only because the outbox does not
   care: nothing is sent *to* the bot except taps, and a tap missed here is
   a tap the moderator repeats. Re-register with --webhook when done. */
async function findChat() {
  await api('deleteWebhook');
  const r = await api('getUpdates', { timeout: 0, limit: 50 });
  if (!r.ok) { console.error('  getUpdates failed:', r.description); process.exit(1); }

  const seen = new Map();
  for (const u of r.result) {
    const msg = u.message || u.channel_post || (u.callback_query || {}).message;
    if (msg && msg.chat) seen.set(msg.chat.id, msg.chat);
    const from = (u.message || u.callback_query || {}).from;
    if (from) seen.set('user:' + from.id, { id: from.id, title: `@${from.username || from.first_name}`, type: 'user' });
  }
  if (!seen.size) {
    console.log('\n  Nothing to read. Add the bot to the group, post any message there,');
    console.log('  then run this again.\n');
    return;
  }
  console.log('\n  Chats and people this bot has heard from:\n');
  for (const [, chat] of seen) {
    const label = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
    console.log(`    ${String(chat.id).padEnd(16)} ${String(chat.type).padEnd(10)} ${label}`);
  }
  console.log('\n  A group id is negative. Put it in TG_CHAT_ID; put the moderators\'');
  console.log('  own (positive) ids in TG_MOD_IDS.\n');
}

async function setWebhook() {
  need('PUBLIC_URL', cfg.PUBLIC_URL);
  need('TG_WEBHOOK_SECRET', cfg.TG_WEBHOOK_SECRET);
  const url = `${cfg.PUBLIC_URL}/api/tg/webhook`;
  const r = await api('setWebhook', {
    url,
    secret_token: cfg.TG_WEBHOOK_SECRET,
    /* the only two kinds this server acts on — anything else is bandwidth */
    allowed_updates: ['callback_query', 'message'],
    drop_pending_updates: false
  });
  console.log(r.ok ? `\n  webhook → ${url}\n` : `\n  failed: ${r.description}\n`);
  if (!r.ok) process.exit(1);
}

async function clearWebhook() {
  const r = await api('deleteWebhook');
  console.log(r.ok ? '\n  webhook removed — set TG_MODE=poll to use long polling.\n'
    : `\n  failed: ${r.description}\n`);
}

async function testMessage() {
  need('TG_CHAT_ID', cfg.TG_CHAT_ID);
  const r = await api('sendMessage', {
    chat_id: cfg.TG_CHAT_ID,
    text: '✅ S37 moderation bot is wired up. Cards will arrive here.'
  });
  console.log(r.ok ? '\n  sent — check the group.\n' : `\n  failed: ${r.description}\n`);
  if (!r.ok) process.exit(1);
}

(async () => {
  need('TG_BOT_TOKEN', cfg.TG_BOT_TOKEN);
  const arg = (process.argv[2] || '').replace(/^--/, '');
  if (arg === 'chat') return findChat();
  if (arg === 'webhook') return setWebhook();
  if (arg === 'poll') return clearWebhook();
  if (arg === 'test') return testMessage();
  return whoami();
})().catch(err => { console.error('\n ', err.message, '\n'); process.exit(1); });
