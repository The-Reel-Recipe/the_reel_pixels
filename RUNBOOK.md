# S37 — runbook

Shakhbat 3al 7eet. A 1,000,000-pixel wall, moderated by hand, paid for
through InstaPay, wiped on the 1st of every month.

This is the operations half. [PLAN.md](PLAN.md) is why it is built the
way it is; this is what to do on a Tuesday.

**The one thing to know:** it is one process on one box. That is a
deliberate design decision, not a stage it is growing out of — see
PLAN §4 — and it is what makes the concurrency correct. Do not run two.

---

## Cutover — the first time

Roughly an hour, most of it waiting for DNS.

Before you start, you need: a VPS, a domain, a Cloudflare R2 bucket
with an S3 key pair, a Telegram bot from BotFather, and the InstaPay
QR you already have.

### 1. The box

Ubuntu LTS, smallest tier that is not free (Hetzner CX22 or
equivalent).

**Host it in Europe, not Egypt.** The moderation bot needs a clean route
to `api.telegram.org`, and Egyptian networks do not reliably have one —
see the note in step 7. Latency to Cairo from Falkenstein is ~60ms,
which nobody painting a pixel will notice.

Then:

```bash
adduser --disabled-password --gecos "" s37
apt update && apt install -y nodejs npm caddy git
ufw allow 80,443/tcp && ufw --force enable
systemctl enable --now unattended-upgrades
```

Node must be 22.x — check `node -v` against [.nvmrc](.nvmrc). Ubuntu's
default is usually older; use nodesource if so.

### 2. The code

```bash
git clone <the fork> /srv/s37
chown -R s37:s37 /srv/s37
cd /srv/s37 && sudo -u s37 npm ci --omit=dev
```

### 3. The environment

```bash
sudo -u s37 npm run env -- /etc/s37.env
sudo chown root:s37 /etc/s37.env && sudo chmod 640 /etc/s37.env
```

That writes the file from [.env.example](.env.example) with real
generated secrets, sets everything production always wants the same way
(`TRUST_PROXY=1`, `COOKIE_SECURE=1`, `NODE_ENV=production`, the paths),
and leaves a `# TODO` line above each value that can only come from
somewhere else. It refuses to overwrite an existing file — regenerating
would mint a new `SESSION_SECRET` and sign out every visitor on the
wall.

Fill in the TODOs, then:

```bash
npm run env -- --check /etc/s37.env
```

which separates "the boot will refuse to start without this" from "the
app runs but replication does not".

`SESSION_SECRET` is the one that matters most: change it later and
every guest loses their history, because the cookie *is* the identity.
Put a copy somewhere you will still have it if the box is gone —
[the restore drill](tools/restore-drill.md) needs it.

The boot refuses to start in production with any required value
missing, and names the ones it wants. That is the real checklist; the
`--check` above is just a friendlier way to read it.

> Hints live on their own line, never after the value. systemd's
> `EnvironmentFile` only treats a line *starting* with `#` as a comment,
> so `KEY=value # note` would set `KEY` to `value # note`.

### 4. The InstaPay QR

Save the official QR PNG to `assets/instapay-qr.png`. **Do not
regenerate it** — it encodes an IPN payload, and a QR you generate
from the link is not the same thing. Without the file the checkout
still works; it shows the link and the handle and no QR.

### 5. Brand assets and fonts

```bash
sudo -u s37 npm run fonts     # self-hosts the two typefaces, tightens the CSP
```

### 6. Services

```bash
cp deploy/s37.service deploy/s37-litestream.service \
   deploy/s37-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now s37 s37-litestream s37-backup.timer
curl -s localhost:5174/healthz
```

Then Caddy — edit the domain in [deploy/Caddyfile](deploy/Caddyfile)
first:

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Point the A record at the box. Caddy gets a certificate within seconds
of DNS resolving.

**Decide now, and write it in the Caddyfile comment:** behind
Cloudflare's proxy, or plain Caddy? It changes which header carries
the real client address. Plain Caddy: `TRUST_PROXY=1` and Caddy sets
`X-Forwarded-For`, replacing anything inbound. Behind Cloudflare: also
`TRUST_PROXY=1`, and the app prefers `CF-Connecting-IP`. Getting this
wrong means either everyone shares one IP (every cap applies to the
whole internet at once) or anyone can spoof theirs (no cap applies to
anybody).

### 7. Telegram

> **Check the route before anything else**, on the box itself:
>
> ```bash
> node tools/tg-setup.js --doctor --token <the token>
> ```
>
> Some networks — Egyptian ISPs among them — reach Telegram's front door
> but not the datacentre behind it. The signature is confusing: an
> implausible token is refused in under a second while a valid one hangs
> forever, because the edge rejects a malformed bot id without touching a
> backend and everything else is routed to the DC hosting that bot.
>
> It looks exactly like a bad token and it is not. `--doctor` compares
> the two and tells you which one you have. If the route is blocked, the
> wall must be hosted somewhere it is not — a European VPS is fine.

1. **@BotFather** → `/newbot` → keep the token
2. Create a private group, add the bot to it
3. **Every moderator posts a message in it** — that is how the bot learns
   who they are, and anyone who has not posted will not be able to press
   the buttons

Then one command reads the group id and the moderator ids off those
messages and writes all three values into the env file:

```bash
cd /srv/s37
sudo -u s37 node tools/tg-setup.js --init /etc/s37.env --token <the token>
systemctl restart s37
sudo -u s37 node tools/tg-setup.js --webhook
sudo -u s37 node tools/tg-setup.js --test      # a message should appear in the group
```

> `node tools/tg-setup.js` rather than `npm run tg --`: npm swallows any
> argument that looks like one of its own config flags, `--init` and
> `--token` included, and passes the rest along stripped of both.

`--init` refuses rather than guesses: if the bot has heard from two
groups, or from no humans, it says so and writes nothing. Telegram will
not tell you a group's id any other way — somebody has to speak in
front of the bot first.

### 8. Admin accounts

```bash
sudo -u s37 npm run admin -- mohab
```

Add the setup key to an authenticator **before closing the terminal**.
Make a second account on a second phone — there is no recovery path,
and one lost phone should not lock you out of your own wall.

### 9. Before you tell anyone

- [ ] [restore drill](tools/restore-drill.md) run end to end, and the
      time it took written down
- [ ] one real free claim from a phone → card → Approve → visible
- [ ] one real paint pack, paid with a real transfer, verified by hand
- [ ] `/admin` reachable, TOTP working, audit log filling
- [ ] uptime monitor on `https://<domain>/healthz`, alerting to a phone
- [ ] the Vercel project pointed here or deleted (see below)
- [ ] pricing confirmed — the wall says 10 EGP/px in several places

### 10. Retire Vercel

**This is not tidying.** The server holds the wall in memory, runs the
Telegram worker on an interval and keeps every SSE client on one
process. Serverless runs N copies of that, and N copies means N
divergent wall caches and N workers racing the same queue. Leaving it
up means two versions of the wall on the internet, one of them wrong.

Point the Vercel project at the VPS (or delete it), then delete
`api/` and `vercel.json` from the fork.

---

## Every day

**Watch the moderation group.** That is the job. Cards arrive as people
claim; tap Approve or Reject. A rejection asks what for — pick a
reason, it goes to the submitter verbatim.

**Verify payments.** A card says `SAYS THEY HAVE PAID` with an amount
and a code. Open your own InstaPay app, look for that amount with that
code in the note, then tap **Money received**. Paint is credited the
instant you do.

Never tap it because a screenshot looks convincing. The screenshot is
a hint; your own transaction list is the fact.

**Clear the refunds.** A `💸 Still owed` card re-posts every 24 hours
until somebody taps it. Send the money from InstaPay to the handle on
the card, then tap **Refund sent**. The nagging is deliberate — a
manual refund nobody is reminded about quietly does not happen.

---

## When something is wrong

### The bot has gone quiet

Nothing is lost. Cards queue in `tg_outbox` and go out when it comes
back.

```bash
journalctl -u s37 -n 100 | grep -i telegram
curl -s localhost:5174/healthz | jq '.outbox, .outboxStuck'
```

Moderate from `/admin` → **QUEUE** meanwhile; it is full parity, and a
decision made there edits the Telegram card when the bot returns.

If the queue is stuck rather than merely behind, `/admin` → **SYSTEM**
lists every waiting send with its error count, and can retry one or
drop a poison message.

Common causes, in order of likelihood: the bot was removed from the
group; the token was rotated; the webhook points at the old host after
a move (`npm run tg` shows where it points).

### The wall is down

```bash
systemctl status s37
journalctl -u s37 -n 200
curl -s localhost:5174/healthz
```

`Restart=always` means a crash is already being retried. If it is
flapping, the journal has the crash event and so does the `events`
table.

If it will not start at all, the boot is usually telling you which
environment variable is missing — it refuses rather than limping.

### Somebody painted something vile

`/admin` → **WALL** → click the pixel. The whole chain is there: who,
when, which submission, what paid for it. **TAKE DOWN** erases it
everywhere within a second, and if it was paid for, the payment
becomes `refund_due` automatically.

For a whole region, drag a rectangle instead. It takes down every
submission it touches, with the same refund handling.

Then `/admin` → **USERS** → **BAN**, which also invalidates their
cookie, so they are signed out rather than merely marked.

### The wall needs to stop right now

`/freeze` in the moderation group, or the button on the panel
dashboard. Reading keeps working; claims, bookings and orders answer
"back soon". `/unfreeze` when it is over.

### A payment is stuck in the wrong state

`/admin` → **PAYMENTS** → **OVERRIDE**. Only three moves are allowed,
each needs a reason, and all of them are audited:

- `rejected → submitted` — they say it did arrive, take another look
- `expired → awaiting_transfer` — reopening a hold that lapsed
- `refunded → refund_due` — the refund bounced

Anything else is deliberately impossible. If you need a fourth, that
is a code change, not a database edit.

### Prices need to change

`/admin` → **CONFIG**. It takes effect on the next page load — no
deploy, no restart. Every change records who made it.

Bookings already taken keep the price they were quoted; the ledger's
reconciliation will show the difference as drift, which is expected
and not a bug.

---

## Every month

The wall wipes itself at 00:00 on the 1st. Nothing to do — but the
group gets a warning 48h and 6h beforehand listing anything still
waiting, and **that list wants clearing**. Anything still pending at
the reset is settled automatically: free work expires, paint comes
back as paint, and a booking that was paid for and never approved is
refunded. All correct, all avoidable.

The outgoing wall is archived to `data/archive/YYYY-MM.png` before
anything is deleted. That is the only copy of the month as it looked —
worth keeping somewhere off the box.

---

## Every quarter

Run the [restore drill](tools/restore-drill.md). Properly, on a fresh
box, with the clock running.

---

## Where things are

| | |
|---|---|
| code | `/srv/s37` |
| database | `/srv/s37/data/pixels.db` |
| nightly snapshots | `/srv/s37/data/backup/` (30 days) |
| monthly archives | `/srv/s37/data/archive/` |
| payment screenshots | `/srv/s37/data/uploads/` |
| moderation card images | `/srv/s37/data/previews/` |
| secrets | `/etc/s37.env` |
| app logs | `journalctl -u s37` |
| access logs | `/var/log/caddy/s37.log` |

Nothing under `data/` is ever served over HTTP — the static handler
serves an allowlist of four files plus `assets/`, and screenshots
reach the panel through an authenticated route.

## What to watch

Point an uptime monitor at `https://<domain>/healthz`. It returns 503
if the database has gone, and a body worth alerting on:

| field | alert when |
|---|---|
| `ok` | false |
| `outboxStuck` | true (nothing has sent in 15 minutes) |
| `maintenance` | true for longer than you meant |
| `pending` | climbing past ~40 and staying there |

Also worth an alert: disk above 80%, and litestream logging errors.
The panel dashboard shows all of it too, with red banners — it doubles
as a status page.

---

## Notes for whoever is next

**One process.** Two would corrupt the allowance ledger and split the
wall cache. If it ever needs to scale, the answer is a CDN in front of
the snapshot, not a second instance — the wall is 9 MB fully painted,
and bandwidth is the wall you hit first, not SQLite.

**Every decision is idempotent.** Tap Approve twice, tap it from the
panel while somebody taps it in Telegram — one decision happens and
the loser is told who won. You cannot double-approve anything, so when
in doubt, tap it.

**The audit log is complete.** Every moderation decision, every admin
action, every config change, every payment transition, with who and
when. `/admin` → **AUDIT**. If you are wondering whether something
happened, it is in there.

**InstaPay has no API.** Not an oversight, not a TODO. There is no
merchant API for a personal handle: no webhook confirms a transfer and
no call reverses one. Every payment decision in this system is a
person looking at their own banking app, and the design leans into
that rather than pretending otherwise.
