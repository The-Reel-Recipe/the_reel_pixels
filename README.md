<p align="center">
  <img src="assets/logo-wordmark.png" alt="S37 — Shakhbat 3al 7eet" width="380">
</p>

# S37 — شخبط على الحيط

A million pixels. One wall. Wiped clean on the 1st of every month.

Twenty pixels are free, and a fresh twenty land half an hour after you
run out. Paint buys more. Brands book a logo spot on next month's wall.
**Every pixel is looked at by a person before it goes up.**

---

## Running it

```bash
npm ci
npm run dev
```

`http://localhost:5174`. A fresh database adopts the committed artwork
from `seed.bin`, and with no bot configured (`TG_MODE=off`, the
default outside production) submissions approve themselves after two
seconds — long enough to watch a claim shimmer as *pending* first,
which is the bit worth seeing.

```bash
npm test          # 117 tests, node:test, no framework
npm run admin -- <name>    # make an admin account (the only way)
npm run tg        # inspect / wire up the Telegram bot
npm run fonts     # self-host the two typefaces, tighten the CSP
npm run make-brand         # regenerate the logo, wordmark and seed artwork
```

Deploying is [RUNBOOK.md](RUNBOOK.md). Why it is built this way is
[PLAN.md](PLAN.md).

## How it fits together

```
server/
  index.js        boot, graceful shutdown, the crash handler
  config.js       env parsing; refuses to boot in production without its secrets
  settings.js     the knobs the admin panel can move without a deploy
  db.js           SQLite (WAL), migrations, the transaction helper
  wall.js         the pixel cache, the wire format, the monthly cycle
  identity.js     guest cookies, brand accounts, per-IP caps
  submissions.js  pending → approved | rejected | expired
  payments.js     InstaPay orders, verification, refunds
  telegram.js     the moderation group, and an outbox that will not lose a card
  render.js       the picture a moderator actually looks at
  admin.js        TOTP, sessions, and everything Telegram cannot do
  uploads.js      payment screenshots, sniffed and stripped
  http.js         routing, static files, SSE, rate limits, security headers
admin/            the panel (vanilla, behind the session)
```

Two dependencies, both argued for in PLAN §1: `better-sqlite3` and
`pngjs`. The client is vanilla JS and a canvas.

## The three things worth knowing

**One process.** Not a stage it is growing out of — it is what makes
the concurrency correct. Every mutation is one synchronous
`better-sqlite3` transaction, so there is no window for two requests to
interleave, and the `cells` primary key `(cycle, layer, idx)` makes
double-selling a pixel unrepresentable rather than merely unlikely.

**Nothing paints on submit.** A claim *reserves*: the cells go in as
`pending`, which holds the ground against every other claimant from
that instant while staying off the public wall. So the race is settled
when somebody clicks, and by the time a moderator taps Approve no other
submission can possibly be contending for those pixels.

**InstaPay has no API.** No webhook confirms a transfer and no call
reverses one, so every payment decision is a person checking their own
banking app. The design leans into that: a short code in the transfer
note, a card with the amount to look for, and a refund reminder that
re-posts every 24 hours until somebody says they sent it.

---

Not affiliated with any previous project of this name. Fonts are OFL;
everything else is Mohab Yasser's.
