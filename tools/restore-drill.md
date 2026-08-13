# Restore drill

PLAN §10.5. **Run this once before launch and once a quarter after.**
A backup nobody has restored is a hypothesis, and the morning you find
out it was wrong is the worst possible morning to find out.

Target: **a fresh box serving the wall in under 30 minutes**, with no
access to the old one — assume it is gone, not merely broken. Do the
whole thing on a throwaway VPS or a laptop; do not practise on
production.

You need, and this is most of the point of the drill — if you cannot
lay hands on all four in ten minutes, the answer is to fix that
first:

- the R2 bucket name, endpoint, and an access key pair
- `SESSION_SECRET` (a different one invalidates every visitor's cookie,
  and every guest loses their history)
- the Telegram bot token, chat id and webhook secret
- DNS access for the domain

---

## 1. Get a box and the code

```bash
adduser --system --group --home /srv/s37 s37
apt install -y nodejs git
git clone <the fork> /srv/s37 && cd /srv/s37
npm ci --omit=dev
```

Litestream is a single static binary — `https://litestream.io/install`.

## 2. Write the environment

`/etc/s37.env`, from `.env.example`. **Use the real `SESSION_SECRET`.**
Everything else can be new; that one cannot.

## 3. Pull the database back

```bash
mkdir -p /srv/s37/data && chown s37:s37 /srv/s37/data
sudo -u s37 litestream restore \
  -config /srv/s37/deploy/litestream.yml \
  -o /srv/s37/data/pixels.db
```

Litestream refuses to overwrite an existing file, which is the
behaviour you want — if it complains, you are restoring over something.

**Check what you got before starting anything:**

```bash
sudo -u s37 sqlite3 /srv/s37/data/pixels.db \
  "select (select count(*) from cells where state='live') live,
          (select count(*) from submissions where status='pending') waiting,
          (select count(*) from payments where status='refund_due') owed,
          (select v from meta where k='cycle') cycle;"
```

`live` should be within a few hundred of what the wall had. If it is
zero, or the file will not open, stop and use the nightly snapshot
instead — see *If litestream has nothing* below.

## 4. Start it

```bash
cp deploy/s37.service deploy/s37-litestream.service \
   deploy/s37-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now s37 s37-litestream s37-backup.timer
curl -s localhost:5174/healthz
```

`{"ok":true,"db":"ok",...}` and a plausible `wall` count.

## 5. Put it back on the internet

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain
systemctl reload caddy
```

Point the A record at the new box. Then re-register the webhook —
Telegram is still pointing at the dead machine:

```bash
sudo -u s37 npm run tg -- --webhook
sudo -u s37 npm run tg                     # confirm it took
```

## 6. Prove it actually works

Not "the page loads". Prove the round trip:

- [ ] the wall renders, and the artwork is the one you remember
- [ ] claim a pixel from a phone → a card arrives in the moderation group
- [ ] tap **Approve** → the pixel appears for everyone within a second
- [ ] `/admin` signs in with password + code
- [ ] the audit log has history in it, not just today
- [ ] `systemctl start s37-backup` writes a file to `data/backup/`
- [ ] `litestream databases -config deploy/litestream.yml` shows it replicating again

**Write down how long it took**, from step 1 to the last box ticked.
That number is the real RTO, and it is the only honest input to "how
bad would losing the box be".

---

## If litestream has nothing

The fallback is the nightly `VACUUM INTO` snapshot, which is a plain
SQLite file and needs no replay:

```bash
# from R2, or from data/backup/ if the disk survived
cp wall-YYYYMMDD.db /srv/s37/data/pixels.db
chown s37:s37 /srv/s37/data/pixels.db
```

You lose up to a day. Everything else is identical from step 4.

## If both are gone

`seed.bin` is committed, so the wall comes back as the starting
artwork and nothing else. Every claim, account and payment since
launch is gone. Say so publicly rather than letting people work it out
— the wall wipes monthly anyway, and people mind a stated loss far
less than a silent one.

If it comes to this, `events` is worth reading before you decide: it
is append-only and it is in whichever backup you *do* have, so even a
stale copy tells you who was owed money.

---

## Notes

**Restoring does not replay Telegram.** Cards sent before the failure
are still in the group with live buttons. Tapping one works — the
submission ids came back with the database — unless the decision was
made in the window the restore lost, in which case the button will
answer "already decided". That is correct and needs no action.

**`refund_due` reminders resume on their own** and will re-post within
24h of the restore. Check that page in the panel first: if a refund
was sent but the confirmation was in the lost window, mark it refunded
again rather than sending the money twice.

**The paint balances are in the database**, so a restore that loses an
hour loses an hour of purchases. Cross-check the ledger against the
InstaPay app for that window before opening the wall back up.
