/* ═══════════════════════════════════════════════════════════════
   tg-setup — the once-per-deploy Telegram wiring (PLAN §5, setup)

     node tools/tg-setup.js --init <envfile> --token <token>
                                       the whole thing, in one command
     node tools/tg-setup.js            what the bot is and where it points
     node tools/tg-setup.js --chat     find the moderation group's chat id
     node tools/tg-setup.js --webhook  point Telegram at PUBLIC_URL
     node tools/tg-setup.js --poll     take the webhook off again
     node tools/tg-setup.js --test     send a message to TG_CHAT_ID

   The chat id is the fiddly one. Telegram will not tell you a group's
   id; you have to say something in the group and read it back off an
   update. So: create the bot, add it to the group, post any message,
   and then --init reads all three values off that one update and
   writes them into the env file itself. Hand-copying a negative
   thirteen-digit number between two windows at 1am is exactly the
   step that goes wrong.

   Needs TG_BOT_TOKEN in the environment, or --token. --webhook
   additionally needs PUBLIC_URL and TG_WEBHOOK_SECRET.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const cfg = require('../server/config.js');
const envfile = require('./envfile.js');

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};

/* --token wins over the environment, so the very first run can happen
   before anything has been written to the env file at all. */
let TOKEN = (typeof flag('token') === 'string' ? flag('token') : '') || cfg.TG_BOT_TOKEN;

const api = (method, params) => fetch(
  `https://api.telegram.org/bot${TOKEN}/${method}`,
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

/* ── the whole of step 7, in one command ──────────────────────── */

/* Reads the group and the moderators off whatever the bot has heard, and
   writes them into the env file next to the token. Everything it learns
   comes from one message somebody posted in the group, which is why the
   instructions say to post one. */
async function init(file) {
  if (typeof file !== 'string') {
    console.error('\n  usage: node tools/tg-setup.js --init <envfile> [--token <token>]');
    console.error('  e.g.   npm run tg -- --init /etc/s37.env --token 7000000000:AA…\n');
    process.exit(1);
  }
  if (!require('fs').existsSync(file)) {
    console.error(`\n  no ${file} — run \`npm run env -- ${file}\` first.\n`);
    process.exit(1);
  }
  if (!TOKEN) {
    console.error('\n  No bot token. Pass --token, or put TG_BOT_TOKEN in the environment.');
    console.error('  Get one from @BotFather on Telegram: /newbot\n');
    process.exit(1);
  }

  const me = await api('getMe');
  if (!me.ok) {
    console.error(`\n  Telegram rejected that token: ${me.description}`);
    console.error('  Check you copied the whole thing, including the digits before the colon.\n');
    process.exit(1);
  }
  console.log(`\n  bot        @${me.result.username}`);

  /* getUpdates and a webhook are mutually exclusive, so a re-run has to
     take the webhook off first. It goes back on with --webhook. */
  await api('deleteWebhook');
  const r = await api('getUpdates', { timeout: 0, limit: 100 });
  if (!r.ok) { console.error(`\n  getUpdates failed: ${r.description}\n`); process.exit(1); }

  const groups = new Map(), people = new Map();
  for (const u of r.result) {
    const msg = u.message || u.channel_post || (u.callback_query || {}).message;
    if (msg && msg.chat && msg.chat.id < 0) groups.set(msg.chat.id, msg.chat.title || '(untitled)');
    const from = (u.message || u.callback_query || {}).from;
    if (from && !from.is_bot) people.set(from.id, from.username || from.first_name || String(from.id));
  }

  if (!groups.size) {
    console.log('\n  The bot has not heard from any group.\n');
    console.log('  1. create a private group');
    console.log(`  2. add @${me.result.username} to it`);
    console.log('  3. post any message in it — "hello" will do');
    console.log('  4. run this again\n');
    console.log('  (Telegram only hands over a group id once somebody has spoken');
    console.log('   in front of the bot. There is no way to look one up.)\n');
    process.exit(1);
  }
  if (groups.size > 1) {
    console.log('\n  More than one group has spoken to this bot:\n');
    for (const [id, title] of groups) console.log(`    ${String(id).padEnd(16)} ${title}`);
    console.log('\n  Set TG_CHAT_ID by hand, then run --webhook.\n');
    process.exit(1);
  }

  const [chatId, title] = [...groups][0];
  const mods = [...people.keys()];
  console.log(`  group      ${chatId}  "${title}"`);
  console.log(`  moderators ${[...people].map(([id, n]) => `${n} (${id})`).join(', ') || '— none seen —'}`);

  if (!mods.length) {
    console.log('\n  Nobody has posted in that group yet — TG_MOD_IDS would be empty,');
    console.log('  which means anyone in the group can press the buttons. Post a');
    console.log('  message as each moderator and run this again.\n');
    process.exit(1);
  }

  const changed = envfile.set(file, {
    TG_BOT_TOKEN: TOKEN,
    TG_CHAT_ID: String(chatId),
    TG_MOD_IDS: mods.join(',')
  });

  console.log(`\n  wrote ${file}:`);
  for (const [k, v] of Object.entries(changed)) {
    const shown = k === 'TG_BOT_TOKEN' ? `${v.to.split(':')[0]}:…` : v.to;
    console.log(`    ${k.padEnd(16)} ${shown}`);
  }
  if (!Object.keys(changed).length) console.log('    (already up to date)');

  console.log('\n  Next: set PUBLIC_URL in that file, restart the service, then');
  console.log('  `npm run tg -- --webhook` to point Telegram at it.\n');
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
  /* --init is the only mode that can run before the token is in the
     environment, so it checks for one itself. */
  if (args.includes('--init')) return init(flag('init'));

  need('TG_BOT_TOKEN', TOKEN);
  const arg = (args[0] || '').replace(/^--/, '');
  if (arg === 'chat') return findChat();
  if (arg === 'webhook') return setWebhook();
  if (arg === 'poll') return clearWebhook();
  if (arg === 'test') return testMessage();
  return whoami();
})().catch(err => { console.error('\n ', err.message, '\n'); process.exit(1); });
