/* ═══════════════════════════════════════════════════════════════
   S37 admin panel

   Vanilla, one file, no build step — same house rule as the wall.
   Every mutation goes out with the X-Admin header the server insists
   on (§7.1), and every page is a render() over data fetched fresh,
   because a moderation panel showing a stale queue is worse than one
   that takes an extra 80ms.

   Nothing here decides anything. Approve posts to the same
   submissions.approve the bot calls; the guards, the idempotency and
   the audit trail all live server-side, and this is a set of
   buttons.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ── talking to the server ────────────────────────────────────── */

async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401) return signedOut();
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
async function post(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin': '1' },
    body: JSON.stringify(body || {})
  });
  if (res.status === 401) return signedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `${path} → ${res.status}`);
  return data;
}
/* Back to the login screen, for real.

   `location.href = '/admin'` is not reliable from here. Every page in the
   panel now carries a hash — /admin#pay, /admin#brands — and a navigation
   to a URL that differs only in its fragment is defined as a same-document
   navigation: the browser may move the fragment and never reload, leaving
   the whole panel on screen with a session that no longer exists. It
   reloads in some browsers and not others, which is the worst kind of
   difference to depend on.

   Dropping the hash without navigating, then reloading, is unambiguous. */
function leave() {
  try { history.replaceState(null, '', '/admin'); } catch (e) { /* older browsers */ }
  location.reload();
}

function signedOut() {
  document.body.innerHTML = '<p style="padding:40px;font-family:monospace">Signed out. ' +
    '<a href="/admin">Sign in again</a>.</p>';
  throw new Error('signed out');
}

/* ── chrome ───────────────────────────────────────────────────── */

const fmt = n => Number(n || 0).toLocaleString('en-US');
const egp = piasters => `${fmt(Math.round((piasters || 0) / 100))} EGP`;
const when = ts => ts ? new Date(ts).toLocaleString('en-GB',
  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = ms => {
  if (!ms || ms < 0) return '—';
  const d = Math.floor(ms / 86400000);
  if (d) return `${d}d`;
  const h = Math.floor(ms / 3600000);
  if (h) return `${h}h`;
  return `${Math.max(1, Math.floor(ms / 60000))}m`;
};

function toast(text, bad) {
  const wrap = $('.toast-wrap') || document.body.appendChild(el('div', 'toast-wrap'));
  const t = el('div', 'toast' + (bad ? ' bad' : ''), text);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3800);
}
const oops = err => toast(err.message || String(err), true);

/* Anything that erases or spends should cost one deliberate confirmation.
   Native confirm on purpose: it cannot be missed and cannot be styled into
   something that looks like a normal button. */
const sure = q => window.confirm(q);
const askReason = what => {
  const r = window.prompt(`${what}\n\nReason (goes in the audit log and, where it matters, to the person):`);
  return r === null ? null : r.trim();
};

/* ── the tabs ─────────────────────────────────────────────────── */

const PAGES = [
  { id: 'dash', label: 'DASHBOARD' },
  { id: 'queue', label: 'QUEUE' },
  { id: 'wall', label: 'WALL' },
  { id: 'users', label: 'USERS' },
  { id: 'brands', label: 'BRANDS' },
  { id: 'pay', label: 'PAYMENTS' },
  { id: 'config', label: 'CONFIG' },
  { id: 'audit', label: 'AUDIT' },
  { id: 'system', label: 'SYSTEM' }
];

let current = 'dash';
let me = { username: '…' };

function shell() {
  document.body.innerHTML = '';
  const top = el('div', 'top');
  const logo = el('img'); logo.src = '/assets/logo-icon.png'; logo.alt = '';
  top.append(logo, el('b', null, 'S37 ADMIN'));
  const who = el('div', 'who');
  who.append(el('span', null, me.username));
  const out = el('button', null, 'SIGN OUT');
  out.onclick = async () => { await post('/api/admin/logout'); leave(); };
  who.append(out);
  top.append(who);

  const tabs = el('div', 'tabs');
  for (const p of PAGES) {
    const b = el('button', 'tab' + (p.id === current ? ' sel' : ''), p.label);
    b.id = `tab-${p.id}`;
    b.onclick = () => show(p.id);
    tabs.append(b);
  }
  const main = el('main');
  main.id = 'main';
  document.body.append(top, tabs, main, el('div', 'toast-wrap'));
}

const RENDER = {};
async function show(id) {
  current = id;
  /* keep the address bar honest, and make the page reloadable and
     linkable — without pushing a history entry per tab click */
  if (pageFromHash() !== id) history.replaceState(null, '', `#${id}`);
  for (const p of PAGES) {
    const t = document.getElementById(`tab-${p.id}`);
    if (t) t.classList.toggle('sel', p.id === id);
  }
  const main = $('#main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  try { await RENDER[id](main); }
  catch (err) { main.innerHTML = ''; main.append(el('p', 'muted', err.message)); }
}

/* ── dashboard ────────────────────────────────────────────────── */

RENDER.dash = async main => {
  const d = await get('/api/admin/overview');
  main.innerHTML = '';

  for (const a of d.alerts) {
    main.append(el('div', `alert ${a.level}`, a.text));
  }

  const stat = (label, value, note) => {
    const c = el('div', 'card stat');
    c.append(el('span', null, label), el('b', null, value));
    if (note) c.append(el('i', null, note));
    return c;
  };
  const g = el('div', 'grid');
  g.append(
    stat('PIXELS LIVE', fmt(d.wall.live), `${fmt(d.wall.booked)} booked for next cycle`),
    stat('WAITING', fmt(d.queue.pending), `${fmt(d.queue.claimsToday)} claims in 24h`),
    stat('HELD', fmt(d.wall.pending), 'reserved, not yet public'),
    stat('VERIFIED', egp(d.money.verified), `${egp(d.money.awaiting)} awaiting`),
    stat('REFUNDS OWED', egp(d.money.refundDue), `${egp(d.money.refunded)} sent`),
    stat('TELEGRAM', `${d.telegram.outbox}`, `${d.telegram.mode}${d.telegram.oldest ? ` · oldest ${ago(Date.now() - d.telegram.oldest)}` : ''}`),
    stat('SSE CLIENTS', fmt(d.system.sse), `up ${ago(d.system.uptimeMs)}`),
    stat('DATABASE', `${(d.system.dbBytes / 1048576).toFixed(1)} MB`, `seed: ${d.system.seedSource || '—'}`),
    stat('RESETS IN', ago(d.wall.cycleEnd - Date.now()), when(d.wall.cycleEnd))
  );
  main.append(g);

  const quick = el('div', 'card');
  quick.style.marginTop = '14px';
  quick.append(el('h2', null, 'MAINTENANCE MODE'));
  const p = el('p', 'muted',
    'Reads keep working; claims, bookings and orders answer “back soon”.');
  const b = el('button', d.system.maintenance ? 'go' : '',
    d.system.maintenance ? 'TURN THE WALL BACK ON' : 'FREEZE THE WALL');
  b.onclick = async () => {
    await post('/api/admin/config', { key: 'maintenance', value: !d.system.maintenance }, 'PUT');
    toast(d.system.maintenance ? 'Wall open.' : 'Wall frozen.');
    show('dash');
  };
  quick.append(p, b);
  main.append(quick);
};

/* ── moderation queue ─────────────────────────────────────────── */

RENDER.queue = async main => {
  const d = await get('/api/admin/queue');
  main.innerHTML = '';

  const head = el('div', 'row spread');
  head.append(el('h2', null, `${d.rows.length} WAITING`));
  if (d.rows.length > 1) {
    const bulk = el('button', 'go', 'APPROVE ALL');
    bulk.onclick = async () => {
      if (!sure(`Approve all ${d.rows.length} waiting submissions?`)) return;
      const r = await post('/api/admin/submissions/bulk',
        { action: 'approve', ids: d.rows.map(x => x.sid) }).catch(oops);
      if (r) toast(`Approved ${r.done} of ${r.of}.`);
      show('queue');
    };
    head.append(bulk);
  }
  main.append(head);

  if (!d.rows.length) {
    main.append(el('div', 'card q-empty', 'Nothing waiting. The wall is up to date.'));
    return;
  }

  for (const row of d.rows) {
    const card = el('div', 'card');
    card.style.marginBottom = '12px';
    const inner = el('div', 'q-card');

    if (row.preview) {
      const img = el('img');
      img.src = row.preview;
      img.alt = `submission ${row.sid} in context`;
      img.loading = 'lazy';
      inner.append(img);
    } else {
      /* no card was rendered (Telegram off), so draw the thumbnail we do have */
      const c = el('canvas');
      const w = Math.max(1, row.bbox[2] - row.bbox[0] + 1);
      const h = Math.max(1, row.bbox[3] - row.bbox[1] + 1);
      c.width = w; c.height = h;
      c.style.width = '160px'; c.style.imageRendering = 'pixelated'; c.style.background = '#fff';
      const g = c.getContext('2d');
      for (const [dx, dy, col] of row.thumb || []) {
        g.fillStyle = '#' + col.toString(16).padStart(6, '0');
        g.fillRect(dx, dy, 1, 1);
      }
      inner.append(c);
    }

    const side = el('div', 'q-side');
    const meta = el('div', 'q-meta');
    meta.append(el('b', null, `#s${row.sid} · ${row.type.toUpperCase()}${row.brand ? ` · ${row.brand}` : ''}`));
    meta.append(el('span', null,
      `${fmt(row.px)} px · ${row.handle} · waiting ${ago(Date.now() - row.at)} · at ${row.bbox[0]},${row.bbox[1]}`));
    meta.append(el('span', null,
      `${row.record.approved} prior approved / ${row.record.rejected} rejected`));
    if (row.payment) {
      meta.append(el('span', null,
        `payment ${row.payment.code} · ${row.payment.status} · ${egp(row.payment.amount)}`));
    }
    side.append(meta);

    const actions = el('div', 'row');
    const ok = el('button', 'go', 'APPROVE');
    ok.onclick = async () => {
      try { await post(`/api/admin/submissions/${row.sid}/approve`); toast(`#s${row.sid} is on the wall.`); }
      catch (e) { oops(e); }
      show('queue');
    };
    const no = el('button', 'bad', 'REJECT');
    no.onclick = async () => {
      const reason = askReason(`Reject #s${row.sid}?`);
      if (reason === null) return;
      try { await post(`/api/admin/submissions/${row.sid}/reject`, { reason }); toast(`#s${row.sid} rejected.`); }
      catch (e) { oops(e); }
      show('queue');
    };
    actions.append(ok, no);
    side.append(actions);
    inner.append(side);
    card.append(inner);
    main.append(card);
  }
};

/* ── wall inspector ───────────────────────────────────────────── */

const SCALE = 0.6;                                  // 1000px wall → 600px canvas

RENDER.wall = async main => {
  main.innerHTML = '';
  main.append(el('h2', null, 'THE WALL'));

  const bar = el('div', 'row');
  const exportLive = el('a', 'btn', 'EXPORT LIVE PNG');
  exportLive.href = '/api/admin/wall/export.png?layer=live';
  const exportNext = el('a', 'btn', 'EXPORT NEXT PNG');
  exportNext.href = '/api/admin/wall/export.png?layer=next';
  const hint = el('span', 'muted', 'Click a pixel to trace it · drag to select a region');
  bar.append(exportLive, exportNext, hint);
  main.append(bar);

  const wrap = el('div', 'wall-wrap');
  wrap.style.marginTop = '12px';
  const canvas = el('canvas');
  canvas.id = 'wallCanvas';
  canvas.width = 1000 * SCALE; canvas.height = 1000 * SCALE;
  wrap.append(canvas);
  const box = el('div', 'sel-box');
  box.hidden = true;
  wrap.append(box);
  main.append(wrap);

  const out = el('div', 'card inspect');
  out.style.marginTop = '12px';
  out.textContent = 'Nothing selected.';
  main.append(out);

  /* the exported PNG doubles as the picture — one renderer, not two */
  const img = new Image();
  img.onload = () => {
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = '/api/admin/wall/export.png?layer=live&t=' + Date.now();

  const at = e => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - r.left) / r.width * 1000),
      y: Math.floor((e.clientY - r.top) / r.height * 1000)
    };
  };

  let drag = null;
  canvas.onpointerdown = e => {
    drag = at(e);
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = e => {
    if (!drag) return;
    const p = at(e);
    const r = canvas.getBoundingClientRect();
    const s = r.width / 1000;
    box.hidden = false;
    box.style.left = `${Math.min(drag.x, p.x) * s}px`;
    box.style.top = `${Math.min(drag.y, p.y) * s}px`;
    box.style.width = `${Math.abs(p.x - drag.x) * s}px`;
    box.style.height = `${Math.abs(p.y - drag.y) * s}px`;
  };
  canvas.onpointerup = async e => {
    const start = drag; drag = null;
    if (!start) return;
    const p = at(e);
    const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);

    if (w < 3 && h < 3) {                            // a click, not a drag
      box.hidden = true;
      const idx = p.y * 1000 + p.x;
      const info = await get(`/api/admin/wall/pixel?idx=${idx}`);
      renderPixel(out, info, p);
      return;
    }

    const rect = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y),
      x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) };
    out.textContent = `Region ${rect.x0},${rect.y0} → ${rect.x1},${rect.y1} ` +
      `(${rect.x1 - rect.x0 + 1} × ${rect.y1 - rect.y0 + 1})`;
    const wipe = el('button', 'bad', 'ERASE EVERYTHING IN THIS REGION');
    wipe.style.marginTop = '10px';
    wipe.onclick = async () => {
      const reason = askReason('Erase every submission touching this region?');
      if (reason === null) return;
      if (!sure('This takes down live pixels and refunds anything paid for. Sure?')) return;
      try {
        const r = await post('/api/admin/wall/erase-region', { rect, reason });
        toast(`Erased ${r.submissions.length} submission(s).`);
        show('wall');
      } catch (e) { oops(e); }
    };
    out.append(document.createElement('br'), wipe);
  };

  main.append(dangerZone());
};

function renderPixel(out, info, p) {
  out.textContent = '';
  if (info.empty) { out.textContent = `${p.x}, ${p.y} — unpainted.`; return; }
  for (const c of info.cells) {
    const s = c.submission || {};
    const lines = [
      `${p.x}, ${p.y}  ·  layer ${c.layer}  ·  ${c.state}  ·  #${'000000'.slice(String(c.color.toString(16)).length) + c.color.toString(16)}`,
      `#s${c.sid}  ${s.type || '?'}  ${s.status || '?'}  ${fmt(s.px || 0)} px`,
      `by ${s.brand || s.handle || '?'} (user ${s.userId})  ·  ${when(s.at)}`,
      s.decidedBy ? `decided by ${s.decidedBy} · ${when(s.decidedAt)}` : 'not decided yet',
      s.reason ? `reason: ${s.reason}` : null,
      c.payment ? `payment ${c.payment.code} · ${c.payment.status} · ${egp(c.payment.amount)}` : null
    ].filter(Boolean);
    out.append(el('div', null, lines.join('\n')));

    const act = el('div', 'row');
    act.style.margin = '8px 0 16px';
    const down = el('button', 'bad', s.status === 'approved' ? 'TAKE DOWN' : 'REJECT');
    down.onclick = async () => {
      const reason = askReason(`${s.status === 'approved' ? 'Take down' : 'Reject'} #s${c.sid}?`);
      if (reason === null) return;
      try {
        await post(`/api/admin/submissions/${c.sid}/${s.status === 'approved' ? 'takedown' : 'reject'}`,
          { reason });
        toast(`#s${c.sid} erased.`);
        show('wall');
      } catch (e) { oops(e); }
    };
    act.append(down);
    out.append(act);
  }
}

function dangerZone() {
  const card = el('div', 'card danger-zone');
  card.style.marginTop = '16px';
  card.append(el('h2', null, 'DANGER'));
  card.append(el('p', 'muted',
    'Force reset wipes the live wall and promotes what is booked, exactly as the 1st does. ' +
    'Reseed lays the committed artwork back over the top. Both archive first.'));
  const row = el('div', 'row');
  row.style.marginTop = '10px';

  const mk = (label, path, phrase) => {
    const b = el('button', 'bad', label);
    b.onclick = async () => {
      const typed = window.prompt(`Type ${phrase} to confirm.`);
      if (typed === null) return;
      try {
        const r = await post(path, { phrase: typed });
        toast(`Done — ${fmt(r.live)} live, ${fmt(r.booked)} booked.`);
        show('wall');
      } catch (e) { oops(e); }
    };
    return b;
  };
  row.append(mk('FORCE CYCLE RESET', '/api/admin/wall/reset', '“RESET THE WALL”'));
  row.append(mk('RESEED FROM ARTWORK', '/api/admin/wall/reseed', '“RESEED THE WALL”'));
  card.append(row);
  return card;
}

/* ── users ────────────────────────────────────────────────────── */

RENDER.users = async main => {
  main.innerHTML = '';
  main.append(el('h2', null, 'USERS'));
  const bar = el('div', 'row');
  const q = el('input', 'wide');
  q.placeholder = 'handle, email or user id';
  const go = el('button', 'go', 'SEARCH');
  bar.append(q, go);
  main.append(bar);

  const host = el('div');
  host.style.marginTop = '12px';
  main.append(host);

  const load = async () => {
    const d = await get(`/api/admin/users?q=${encodeURIComponent(q.value)}`);
    host.innerHTML = '';
    const t = el('table');
    t.innerHTML = '<thead><tr><th>ID</th><th>WHO</th><th>KIND</th><th>FREE / PAINT</th>' +
      '<th>SUBMISSIONS</th><th>LAST SEEN</th><th></th></tr></thead>';
    const body = el('tbody');
    for (const u of d.rows) {
      const tr = el('tr');
      tr.append(el('td', 'num', u.id));
      const who = el('td');
      who.append(el('div', null, u.handle));
      if (u.email) who.append(el('div', 'muted', u.email));
      tr.append(who);
      const kind = el('td');
      kind.append(el('span', `chip ${u.status === 'banned' ? 'c-bad' : 'c-dim'}`,
        u.status === 'banned' ? 'BANNED' : u.kind.toUpperCase()));
      tr.append(kind);
      tr.append(el('td', 'num', `${u.used || 0} used / ${u.paint || 0}`));
      tr.append(el('td', 'num', `${u.approved || 0} / ${u.subs || 0}`));
      tr.append(el('td', 'muted', when(u.last_seen)));

      const act = el('td');
      const ban = el('button', u.status === 'banned' ? '' : 'bad',
        u.status === 'banned' ? 'UNBAN' : 'BAN');
      ban.onclick = async () => {
        const reason = askReason(`${u.status === 'banned' ? 'Unban' : 'Ban'} ${u.handle}?`);
        if (reason === null) return;
        try {
          await post(`/api/admin/users/${u.id}/${u.status === 'banned' ? 'unban' : 'ban'}`, { reason });
          toast('Done.'); load();
        } catch (e) { oops(e); }
      };
      const adj = el('button', null, 'ADJUST');
      adj.onclick = async () => {
        const paint = window.prompt(`Paint balance for ${u.handle}:`, String(u.paint || 0));
        if (paint === null) return;
        const reason = askReason('Why?');
        if (reason === null) return;
        try {
          await post(`/api/admin/users/${u.id}/adjust`, { paint: Number(paint), clearRefill: true, reason });
          toast('Adjusted.'); load();
        } catch (e) { oops(e); }
      };
      act.append(ban, adj);
      tr.append(act);
      body.append(tr);
    }
    t.append(body);
    host.append(t);
    if (!d.rows.length) host.append(el('p', 'muted', 'Nobody matches that.'));
  };

  go.onclick = load;
  q.onkeydown = e => { if (e.key === 'Enter') load(); };
  await load();
};

/* ── brands ───────────────────────────────────────────────────── */

RENDER.brands = async main => {
  const d = await get('/api/admin/brands');
  main.innerHTML = '';
  main.append(el('h2', null, 'BRAND ACCOUNTS'));

  for (const b of d.rows) {
    const card = el('div', 'card');
    card.style.marginBottom = '10px';
    const head = el('div', 'row spread');
    const title = el('div');
    title.append(el('b', null, b.business_name));
    title.append(el('span', ` chip ${b.status === 'approved' ? 'c-ok' : b.status === 'pending' ? 'c-warn' : 'c-bad'}`,
      b.status.toUpperCase()));
    head.append(title);
    card.append(head);

    const socials = (() => { try { return JSON.parse(b.socials || '[]'); } catch (e) { return []; } })();
    const meta = el('div', 'q-meta');
    meta.style.marginTop = '8px';
    meta.append(el('span', null, `${b.category} · ${b.contact_name} · ${b.phone} · ${b.email}`));
    if (b.website) meta.append(el('span', null, b.website));
    if (socials.length) meta.append(el('span', null, socials.join(' · ')));
    meta.append(el('span', null, `instapay: ${b.instapay_handle || '—'}${b.reg_number ? ` · reg ${b.reg_number}` : ''}`));
    meta.append(el('span', null, b.description));
    if (b.reviewed_by) {
      meta.append(el('span', null, `${b.status} by ${b.reviewed_by} · ${when(b.reviewed_at)}` +
        (b.reject_reason ? ` · ${b.reject_reason}` : '')));
    }
    card.append(meta);

    const act = el('div', 'row');
    act.style.marginTop = '10px';
    const call = (verb, label, cls) => {
      const btn = el('button', cls, label);
      btn.onclick = async () => {
        const reason = verb === 'approve' ? '' : askReason(`${label} ${b.business_name}?`);
        if (reason === null) return;
        try { await post(`/api/admin/brands/${b.user_id}/${verb}`, { reason }); toast('Done.'); show('brands'); }
        catch (e) { oops(e); }
      };
      return btn;
    };
    if (b.status === 'pending') act.append(call('approve', 'APPROVE', 'go'), call('reject', 'REJECT', 'bad'));
    if (b.status === 'approved') act.append(call('revoke', 'REVOKE', 'bad'));

    /* What have they actually run with us. The queue shows only what is
       undecided and the wall only what is up now, so neither answers it —
       and it is the question worth asking before approving a fourth
       booking, or before showing one early. */
    const works = el('div');
    works.style.marginTop = '10px';
    const seeBtn = el('button', null, 'DRAWINGS');
    seeBtn.onclick = async () => {
      if (works.dataset.open === '1') {
        works.dataset.open = ''; works.innerHTML = ''; works.append(seeBtn);
        return;
      }
      works.dataset.open = '1';
      seeBtn.disabled = true;
      try {
        const w = await get(`/api/admin/brands/${b.user_id}/works`);
        works.innerHTML = '';
        works.append(seeBtn);
        works.append(renderWorks(w.rows, b));
      } catch (e) { oops(e); } finally { seeBtn.disabled = false; }
    };
    works.append(seeBtn);
    act.append(works);

    card.append(act);
    main.append(card);
  }
  if (!d.rows.length) main.append(el('div', 'card q-empty', 'No brand accounts yet.'));
};

const WORK_CHIP = {
  approved: 'c-ok', pending: 'c-warn', rejected: 'c-bad', expired: 'c-dim'
};

function renderWorks(rows, brand) {
  const box = el('div');
  box.style.marginTop = '10px';
  if (!rows.length) {
    box.append(el('div', 'q-empty', 'Nothing on the wall from this brand yet.'));
    return box;
  }

  for (const w of rows) {
    const item = el('div', 'card');
    item.style.margin = '8px 0';
    const inner = el('div', 'q-card');

    if (w.preview) {
      const img = el('img');
      img.src = w.preview; img.alt = `submission ${w.sid}`; img.loading = 'lazy';
      inner.append(img);
    } else {
      const c = el('canvas');
      const cw = Math.max(1, w.bbox[2] - w.bbox[0] + 1);
      const ch = Math.max(1, w.bbox[3] - w.bbox[1] + 1);
      c.width = cw; c.height = ch;
      c.style.width = '160px'; c.style.imageRendering = 'pixelated'; c.style.background = '#fff';
      const g = c.getContext('2d');
      for (const [dx, dy, col] of w.thumb || []) {
        g.fillStyle = '#' + col.toString(16).padStart(6, '0');
        g.fillRect(dx, dy, 1, 1);
      }
      inner.append(c);
    }

    const side = el('div', 'q-side');
    const meta = el('div', 'q-meta');
    const head = el('b', null, `#s${w.sid}`);
    head.append(el('span', ` chip ${WORK_CHIP[w.status] || 'c-dim'}`, w.status.toUpperCase()));
    if (w.layer === 'next') head.append(el('span', ' chip c-accent', 'NEXT CYCLE'));
    if (w.held) head.append(el('span', ' chip c-warn', 'LEGAL HOLD'));
    meta.append(head);
    meta.append(el('span', null,
      `${fmt(w.px)} px · at ${w.bbox[0]},${w.bbox[1]} · sent ${when(w.at)}`));
    if (w.decidedAt) {
      meta.append(el('span', null,
        `${w.status} by ${w.decidedBy || '—'} · ${when(w.decidedAt)}${w.reason ? ` · ${w.reason}` : ''}`));
    }
    if (w.url) meta.append(el('span', null, w.url));
    if (w.payment) {
      meta.append(el('span', null,
        `${w.payment.code} · ${(w.payment.amount / 100).toLocaleString('en-US')} EGP · ${w.payment.status}`));
    }
    side.append(meta);

    /* Show early. Two steps, because the number is the decision: ask what it
       would displace, then say yes to that number. */
    if (w.early) {
      const act = el('div', 'row');
      act.style.marginTop = '8px';
      const go = el('button', 'go', 'SHOW EARLY');
      go.onclick = async () => {
        go.disabled = true;
        try {
          const p = await get(`/api/admin/submissions/${w.sid}/early`);
          const lines = [
            `Put ${brand.business_name}'s ${fmt(p.px)} px on the wall now,`,
            `before the 1st?`,
            '',
            `${fmt(p.free)} of those squares are empty.`
          ];
          if (p.displacing) {
            lines.push('',
              `${fmt(p.displacing)} are NOT — they belong to somebody else and will be`,
              `taken down. Those painters are told, and their paint goes back:`);
            for (const d of p.displaces) {
              lines.push(`   #s${d.sid} · ${fmt(d.px)} px · ${d.handle || 'a painter'}`);
            }
          } else {
            lines.push('', 'Nothing of anybody else\'s is in the way.');
          }
          lines.push('', 'Say why — it goes in the audit log:');

          const reason = prompt(lines.join('\n'), 'Shown early at the brand\'s request');
          if (reason === null) return;
          const r = await post(`/api/admin/submissions/${w.sid}/early`, { reason });
          toast(`On the wall — ${fmt(r.px)} px${r.displaced ? `, ${fmt(r.displaced)} taken down` : ''}.`);
          show('brands');
        } catch (e) { oops(e); } finally { go.disabled = false; }
      };
      act.append(go);
      act.append(el('span', 'muted', 'goes up now instead of on the 1st'));
      side.append(act);
    }

    inner.append(side);
    item.append(inner);
    box.append(item);
  }
  return box;
}

/* ── payments ─────────────────────────────────────────────────── */

const PAY_CHIP = {
  awaiting_transfer: 'c-dim', submitted: 'c-warn', verified: 'c-ok',
  rejected: 'c-bad', refund_due: 'c-warn', refunded: 'c-accent', expired: 'c-dim'
};

RENDER.pay = async main => {
  main.innerHTML = '';
  main.append(el('h2', null, 'PAYMENTS'));

  const bar = el('div', 'row');
  const status = el('select');
  status.innerHTML = '<option value="">any status</option>' +
    ['awaiting_transfer', 'submitted', 'verified', 'rejected', 'refund_due', 'refunded', 'expired']
      .map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('');
  const q = el('input', 'wide');
  q.placeholder = 'code, reference or payer handle';
  const go = el('button', 'go', 'FILTER');
  const csv = el('a', 'btn', 'CSV');
  bar.append(status, q, go, csv);
  main.append(bar);

  const recon = el('div', 'card');
  recon.style.margin = '12px 0';
  const host = el('div');
  main.append(recon, host);

  const load = async () => {
    const params = new URLSearchParams();
    if (status.value) params.set('status', status.value);
    if (q.value) params.set('q', q.value);
    csv.href = `/api/admin/payments?format=csv&${params}`;
    const d = await get(`/api/admin/payments?${params}`);

    const r = d.reconcile;
    recon.innerHTML = '';
    recon.append(el('h2', null, 'RECONCILIATION'));
    const grid = el('div', 'grid');
    const cell = (label, v, note) => {
      const c = el('div', 'stat');
      c.append(el('span', null, label), el('b', null, v));
      if (note) c.append(el('i', null, note));
      return c;
    };
    grid.append(
      cell('PACKS VERIFIED', egp(r.packs.verified), `${r.packs.orders} orders · ${fmt(r.packs.paintCredited)} paint credited`),
      cell('BOOKINGS VERIFIED', egp(r.bookings.verified), `${fmt(r.bookings.px)} px · expected ${egp(r.bookings.expected)}`),
      cell('DRIFT', egp(r.bookingDrift), r.bookingDrift ? 'a price change mid-cycle explains this' : 'nets to zero'),
      cell('OWED', egp(r.owed.total), `${r.owed.count} refund(s) unsent`)
    );
    recon.append(grid);

    host.innerHTML = '';
    const t = el('table');
    t.innerHTML = '<thead><tr><th>CODE</th><th>WHO</th><th>KIND</th><th>AMOUNT</th>' +
      '<th>STATUS</th><th>REF</th><th>WHEN</th><th></th></tr></thead>';
    const body = el('tbody');
    for (const p of d.rows) {
      const tr = el('tr');
      tr.append(el('td', 'num', p.code));
      tr.append(el('td', null, `${p.handle}${p.sid ? ` · #s${p.sid}` : ''}`));
      tr.append(el('td', 'muted', p.kind === 'paint_pack' ? `pack ${p.pack}` : 'booking'));
      tr.append(el('td', 'num', egp(p.amount)));
      const st = el('td');
      st.append(el('span', `chip ${PAY_CHIP[p.status] || 'c-dim'}`, p.status.replace('_', ' ')));
      tr.append(st);
      const ref = el('td', 'muted');
      ref.append(el('div', null, p.instapay_ref || '—'));
      if (p.payer_handle) ref.append(el('div', null, p.payer_handle));
      if (p.screenshot_path) {
        const a = el('a', null, 'screenshot');
        a.href = `/api/admin/payments/${p.id}/screenshot`;
        a.target = '_blank'; a.rel = 'noopener';
        ref.append(a);
      }
      tr.append(ref);
      tr.append(el('td', 'muted', when(p.created_at)));

      const act = el('td');
      const call = (verb, label, cls, confirm) => {
        const b = el('button', cls, label);
        b.onclick = async () => {
          if (confirm && !sure(confirm)) return;
          try { await post(`/api/admin/payments/${p.id}/${verb}`); toast('Done.'); load(); }
          catch (e) { oops(e); }
        };
        return b;
      };
      if (p.status === 'submitted') {
        act.append(call('verify', 'MONEY IN', 'go',
          `Confirm ${egp(p.amount)} with “${p.code}” actually arrived?`));
        act.append(call('reject', 'NOT RECEIVED', 'bad'));
      }
      if (p.status === 'refund_due') {
        act.append(call('refunded', 'REFUND SENT', 'go',
          `Confirm you have sent ${egp(p.amount)} back to ${p.payer_handle || 'the payer'}?`));
      }
      const over = el('button', null, 'OVERRIDE');
      over.onclick = async () => {
        const to = window.prompt(`Move ${p.code} from “${p.status}” to which status?\n` +
          'Allowed: submitted (from rejected), awaiting_transfer (from expired), refund_due (from refunded)');
        if (!to) return;
        const reason = askReason('Why?');
        if (reason === null) return;
        try { await post(`/api/admin/payments/${p.id}/override`, { to: to.trim(), reason }); toast('Overridden.'); load(); }
        catch (e) { oops(e); }
      };
      act.append(over);
      tr.append(act);
      body.append(tr);
    }
    t.append(body);
    host.append(t);
    if (!d.rows.length) host.append(el('p', 'muted', 'No payments match.'));
  };

  go.onclick = load;
  status.onchange = load;
  q.onkeydown = e => { if (e.key === 'Enter') load(); };
  await load();
};

/* ── config ───────────────────────────────────────────────────── */

RENDER.config = async main => {
  const d = await get('/api/admin/config');
  main.innerHTML = '';
  main.append(el('h2', null, 'SETTINGS'));
  main.append(el('p', 'muted',
    'Changes take effect immediately — no deploy, no restart. Every change is in the audit log.'));

  const card = el('div', 'card');
  card.style.marginTop = '12px';
  for (const row of d.rows) {
    const r = el('div', 'cfg-row');
    const left = el('div');
    left.append(el('div', 'k', row.key));
    left.append(el('div', 'why', row.why));
    r.append(left);

    const isObj = typeof row.value === 'object';
    const input = el('input');
    input.value = isObj ? JSON.stringify(row.value) : String(row.value);
    if (typeof row.value === 'boolean') {
      input.remove();
    }
    const mid = el('div');
    /* Packs get a real editor rather than a JSON string in a text box: they
       are pairs of numbers, and the price each one lands on is the thing
       being decided, so it is shown. */
    if (row.key === 'pack_offers') {
      const rate = (d.rows.find(x => x.key === 'price_paint') || {}).value || 1;
      const rows = Object.entries(row.value).map(([a, off]) => ({ a: Number(a), off: Number(off) }));
      const list = el('div');
      const draw = () => {
        list.innerHTML = '';
        rows.forEach((p, i) => {
          const line = el('div', 'pack-line');
          const amt = el('input'); amt.type = 'number'; amt.min = '1'; amt.value = String(p.a);
          const off = el('input'); off.type = 'number'; off.min = '0'; off.max = '90'; off.value = String(p.off);
          const out = el('span', 'why');
          const price = () => Math.max(1, Math.round(p.a * rate * (1 - p.off / 100)));
          const say = () => { out.textContent = `= ${price()} EGP  (${(price() / p.a).toFixed(2)}/px)`; };
          amt.oninput = () => { p.a = Number(amt.value) || 0; say(); };
          off.oninput = () => { p.off = Number(off.value) || 0; say(); };
          say();
          const drop = el('button', null, '×');
          drop.title = 'Remove this pack';
          drop.onclick = () => { rows.splice(i, 1); draw(); };
          line.append(el('span', 'why', 'paint'), amt, el('span', 'why', '% off'), off, out, drop);
          list.append(line);
        });
        const add = el('button', null, '+ PACK');
        add.onclick = () => { rows.push({ a: 100, off: 10 }); draw(); };
        list.append(add);
      };
      draw();
      mid.append(list);
      mid.append(el('div', 'why', row.overridden
        ? `changed by ${row.updatedBy} · ${when(row.updatedAt)}`
        : 'using the built-in default'));
      /* the SAVE below reads this back out */
      input.value = '';
      input.dataset.packs = '1';
      input.readOnly = true;
      input.style.display = 'none';
      input.collect = () => {
        const obj = {};
        for (const p of rows) obj[p.a] = p.off;
        return obj;
      };
      mid.append(input);
      r.append(mid);
      const act = el('div', 'row');
      const save = el('button', 'go', 'SAVE');
      save.onclick = async () => {
        try { await post('/api/admin/config', { key: row.key, value: input.collect() }, 'PUT'); toast('Saved.'); show('config'); }
        catch (e) { oops(e); }
      };
      act.append(save);
      if (row.overridden) {
        const rst = el('button', null, 'RESET');
        rst.onclick = async () => {
          try { await post('/api/admin/config', { key: row.key, reset: true }, 'PUT'); toast('Back to default.'); show('config'); }
          catch (e) { oops(e); }
        };
        act.append(rst);
      }
      r.append(act);
      card.append(r);
      continue;
    }
    if (typeof row.value === 'boolean') {
      const t = el('button', row.value ? 'go' : '', row.value ? 'ON' : 'OFF');
      t.onclick = async () => {
        try { await post('/api/admin/config', { key: row.key, value: !row.value }, 'PUT'); toast('Saved.'); show('config'); }
        catch (e) { oops(e); }
      };
      mid.append(t);
    } else {
      mid.append(input);
      const note = el('div', 'why',
        row.overridden ? `changed by ${row.updatedBy} · ${when(row.updatedAt)} · default ${isObj ? JSON.stringify(row.default) : row.default}`
          : 'using the built-in default');
      mid.append(note);
    }
    r.append(mid);

    const act = el('div', 'row');
    if (typeof row.value !== 'boolean') {
      const save = el('button', 'go', 'SAVE');
      save.onclick = async () => {
        let value = input.value;
        if (isObj) { try { value = JSON.parse(value); } catch (e) { return oops(new Error('That is not valid JSON.')); } }
        try { await post('/api/admin/config', { key: row.key, value }, 'PUT'); toast('Saved.'); show('config'); }
        catch (e) { oops(e); }
      };
      act.append(save);
      if (row.overridden) {
        const rst = el('button', null, 'RESET');
        rst.onclick = async () => {
          try { await post('/api/admin/config', { key: row.key, reset: true }, 'PUT'); toast('Back to default.'); show('config'); }
          catch (e) { oops(e); }
        };
        act.append(rst);
      }
    }
    r.append(act);
    card.append(r);
  }
  main.append(card);
};

/* ── audit ────────────────────────────────────────────────────── */

RENDER.audit = async main => {
  main.innerHTML = '';
  main.append(el('h2', null, 'AUDIT LOG'));
  const bar = el('div', 'row');
  const actor = el('input');
  actor.placeholder = 'actor (admin:mohab, tg:…, user:12)';
  const action = el('select');
  const go = el('button', 'go', 'FILTER');
  bar.append(actor, action, go);
  main.append(bar);
  const host = el('div');
  host.style.marginTop = '12px';
  main.append(host);

  let filled = false;
  const load = async () => {
    const p = new URLSearchParams();
    if (actor.value) p.set('actor', actor.value);
    if (action.value) p.set('action', action.value);
    const d = await get(`/api/admin/events?${p}`);
    if (!filled) {
      action.innerHTML = '<option value="">any action</option>' +
        d.actions.map(a => `<option>${a}</option>`).join('');
      filled = true;
    }
    host.innerHTML = '';
    const t = el('table');
    t.innerHTML = '<thead><tr><th>WHEN</th><th>WHO</th><th>WHAT</th><th>DETAIL</th></tr></thead>';
    const body = el('tbody');
    for (const e of d.rows) {
      const tr = el('tr');
      tr.append(el('td', 'muted', when(e.ts)));
      tr.append(el('td', 'num', e.actor));
      tr.append(el('td', null, e.action));
      tr.append(el('td', 'payload', e.payload));
      body.append(tr);
    }
    t.append(body);
    host.append(t);
  };
  go.onclick = load;
  action.onchange = load;
  actor.onkeydown = e => { if (e.key === 'Enter') load(); };
  await load();
};

/* ── system ───────────────────────────────────────────────────── */

RENDER.system = async main => {
  const d = await get('/api/admin/system');
  main.innerHTML = '';

  const ops = el('div', 'card');
  ops.append(el('h2', null, 'OPERATIONS'));
  const row = el('div', 'row');
  const backup = el('button', 'go', 'TAKE A BACKUP NOW');
  backup.onclick = async () => {
    backup.disabled = true; backup.textContent = 'WORKING…';
    try { const r = await post('/api/admin/system/backup'); toast(`Wrote ${(r.bytes / 1048576).toFixed(1)} MB.`); show('system'); }
    catch (e) { oops(e); }
    finally { backup.disabled = false; backup.textContent = 'TAKE A BACKUP NOW'; }
  };
  const restart = el('button', null, 'RESTART TELEGRAM WORKER');
  restart.onclick = async () => {
    try { await post('/api/admin/system/worker-restart'); toast('Worker restarted.'); } catch (e) { oops(e); }
  };
  const revoke = el('button', 'bad', 'SIGN OUT EVERYWHERE');
  revoke.onclick = async () => {
    if (!sure('End every admin session you hold, including this one?')) return;
    try { await post('/api/admin/system/revoke'); leave(); } catch (e) { oops(e); }
  };
  row.append(backup, restart, revoke);
  ops.append(row);
  ops.append(el('p', 'muted', `node ${d.node} · database ${(d.db.bytes / 1048576).toFixed(1)} MB`));
  main.append(ops);

  const out = el('div', 'card');
  out.style.marginTop = '12px';
  out.append(el('h2', null, `TELEGRAM OUTBOX (${d.outbox.length})`));
  if (!d.outbox.length) out.append(el('p', 'muted', 'Empty — everything has gone out.'));
  else {
    const t = el('table');
    t.innerHTML = '<thead><tr><th>ID</th><th>METHOD</th><th>ABOUT</th><th>TRIES</th>' +
      '<th>NEXT</th><th>QUEUED</th><th></th></tr></thead>';
    const body = el('tbody');
    for (const r of d.outbox) {
      const tr = el('tr');
      tr.append(el('td', 'num', r.id));
      tr.append(el('td', null, r.method));
      tr.append(el('td', 'muted', r.about ? `${r.about.kind} ${r.about.id}` : '—'));
      tr.append(el('td', 'num', r.attempts));
      tr.append(el('td', 'muted', when(r.nextTry)));
      tr.append(el('td', 'muted', when(r.createdAt)));
      const act = el('td');
      const retry = el('button', null, 'RETRY');
      retry.onclick = async () => {
        try { await post('/api/admin/system/outbox-retry', { id: r.id }); toast('Retrying.'); show('system'); }
        catch (e) { oops(e); }
      };
      const drop = el('button', 'bad', 'DROP');
      drop.onclick = async () => {
        const reason = askReason(`Drop outbox item ${r.id}? It will never be sent.`);
        if (reason === null) return;
        try { await post('/api/admin/system/outbox-drop', { id: r.id, reason }); toast('Dropped.'); show('system'); }
        catch (e) { oops(e); }
      };
      act.append(retry, drop);
      tr.append(act);
      body.append(tr);
    }
    t.append(body);
    out.append(t);
  }
  main.append(out);

  const files = el('div', 'card');
  files.style.marginTop = '12px';
  files.append(el('h2', null, 'FILES'));
  files.append(el('p', 'muted', `Backups: ${d.backups.map(b => b.file).join(', ') || 'none yet'}`));
  files.append(el('p', 'muted', `Archives: ${d.archives.join(', ') || 'none yet'}`));
  main.append(files);
};

/* ── go ───────────────────────────────────────────────────────── */

/* The moderation cards no longer carry personal details — they carry a link
   here instead, of the form /admin#pay. So the hash has to mean something.
   Anything unrecognised falls back to the dashboard rather than erroring:
   the link came from a chat message and may be from an older version. */
const pageFromHash = () => {
  const want = (location.hash || '').replace(/^#/, '').split('-')[0];
  return PAGES.some(p => p.id === want) ? want : 'dash';
};

(async () => {
  me = await get('/api/admin/me');
  shell();
  await show(pageFromHash());
  /* tapping a second link while the panel is already open should move it */
  window.addEventListener('hashchange', () => show(pageFromHash()));
  /* the dashboard is the only page worth refreshing on its own — the rest
     are things somebody is reading, and moving under them is rude */
  setInterval(() => { if (current === 'dash') show('dash'); }, 30000);
})();
