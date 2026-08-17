# CODE-CHANGES — what the app must do for these documents to be true

Every item names the file, the sentence it falsifies, and what to do. All line references verified against `production`.

- **MUST** — a published document is **untrue** or the practice is **unlawful** without it. Do not publish with any MUST open, except where the item says otherwise.
- **SHOULD** — the documents survive without it; it is the risk the documents expose.

**First, a correction to earlier advice.** Every previous draft called "the server cannot serve a legal page" the #1 blocker. It is not one. `server/http.js:195` is `const PUBLIC_DIRS = ['/assets/'];` and the allowlist check is `PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some(d => rel.startsWith(d))`. `TYPES['.html']` is `'text/html; charset=utf-8'`. **`assets/terms.html` serves today, at a stable URL, under the existing CSP, with no code change.** Ship files, not a modal: a modal is a second copy to keep in sync, cannot be deep-linked, and cannot be cited in a dispute.

---

# MUST

## M1 — Publish the six pages and link them

**Falsifies:** TERMS §4 ("shown to you, in both languages"), §25; PRIVACY §1, §9; REFUNDS §14. All three documents are unreachable and unlinked today — `index.html` contains zero occurrences of "terms", "privacy" or "cookie".

Render `legal/*.md` to `assets/terms.html`, `assets/privacy.html`, `assets/refunds.html` and `assets/terms.ar.html`, `assets/privacy.ar.html`, `assets/refunds.ar.html`. Self-contained, inline CSS (`style-src 'self' 'unsafe-inline'` permits it), each linking its counterpart language.

Then:

1. Add a row to the MORE sheet's `.me-rows` block (`index.html:451-467`, beside `#moreShop`, `#btnHelp`, `#langToggleMore`) reading **LEGAL** and opening the three links in the current language.
2. Replace `<p class="fine more-about">` (`index.html:474`) — currently `S37 · شخبط على الحيط · 1,000,000 pixels, wiped clean on the 1st of every month.` — with a real imprint: legal name, address, registration numbers, contact email, and the three links. This is the only place in the product that could name the seller, and it names nobody.
3. Add a link line to `.help-notes` (`index.html:208-212`), since the help modal is the first-run surface.

## M2 — Delete the five email promises

**Falsifies:** TERMS §11 and §25 (which route complaints to email while the app claims we already emailed you); the whole of the brand-application flow.

There is no SMTP or mail API client anywhere in `server/` or `tools/`. These five strings promise otherwise, in both languages:

| Where | String |
|---|---|
| `app.js:2495` / `2661` (AR) | `brand.note.pending` — "You will get an email the moment it is approved." |
| `app.js:2497` / `2663` (AR) | `brand.note.rejected` — "Reply to the email we sent…" |
| `app.js:2517` / `2683` (AR) | `au.applyFine` — "…and to send booking receipts." |
| `app.js:2520` / `2686` (AR) | `toast.applied` — "We will email you as soon as it is reviewed." |
| `server/identity.js:652` | `pending: '…We will email you the moment it is approved.'` |

*(Note: earlier annexes cited `app.js:2496` and `2519`. Those are `brand.note.approved` and `au.book: 'START A PRE-ORDER'`. The list above is the correct one.)*

Point them at the notifications feed, which exists (`server/notifications.js`) and already carries brand-application decisions in its `FEED` union. Suggested:

- `toast.applied` → EN `Application sent. Watch the bell — the decision appears there.` / AR «طلبك اتبعت. تابع الجرس — القرار بينزل هناك.»
- `identity.js:652` → `Your brand application is still being reviewed. The decision appears in your notifications.`
- `identity.js:653` → replace "Reply to the team" with the real contact address.

If you later build a transport, TERMS §24's "where we have an email address we use it as well" becomes true rather than aspirational.

## M3 — Take acceptance, and stamp the version on the payment

**Falsifies:** TERMS §4 in full — it describes checkboxes and a recorded version that do not exist. Also removes the strongest attack on REFUNDS §6 (see LAWYER-REVIEW #5): without a recorded request for immediate delivery, the immediate-performance defence does not exist.

The only checkbox in the entire product today is `#bgRemove`.

1. **Acceptance line + required tick** above `#btnRegister` (`index.html:505`), above `#btnSignup` (`index.html:578`), and above `#btnPay` (`#coFine`, written at `app.js:777`).
2. **The one that matters most:** above `#pySubmit` (`index.html:312`, the "I'VE SENT IT" button) and above the pack buttons built at `app.js:875-887`, with the wording REFUNDS §6 relies on — *"I want my paint as soon as the transfer is confirmed, and I have read the refund policy."* / «عايز البوية أول ما التحويل يتأكد، وقرأت سياسة الاسترداد.»
3. **Persist it.** `ALTER TABLE users ADD COLUMN terms_version TEXT; ALTER TABLE users ADD COLUMN terms_at INTEGER;` and `ALTER TABLE payments ADD COLUMN terms_version TEXT;` written inside `payments.createOrder()` (`server/payments.js:113-124`).

The `payments` column is the one that answers "which version applied to order S37-XXXX", which is the only question a CPA complaint asks.

## M4 — Make a cash refund of a paint pack reachable

**Falsifies:** TERMS §5 ("we return the full amount"), §20 item 4, §21; REFUNDS §6.1 items 2–4, §9, §16. Six clauses promise money back for a paint pack in named cases, and **the software has no path that can do it.**

Verified: `http.js:729` calls `payments.createOrder(row.id, 'paint_pack', { pack })` with **no `sid`**, so `submissions.payment_id` is never set for a pack. `settlePayment` (`submissions.js:144`) is the only writer of `refund_due` and needs a submission. `admin.js:561 OVERRIDES` is `{'rejected>submitted', 'expired>awaiting_transfer', 'refunded>refund_due'}`.

Add `'verified>refund_due'` to `OVERRIDES` with a mandatory reason (`override()` already enforces `reason.trim().length >= 3` and logs to `events`). **And debit the paint in the same transaction** — decrement `allowances.paint` by the pack amount and refuse the override if the balance is now short. Without the debit you hand back the money and leave the paint, and `admin.reconcile()` (`admin.js:391-406`), the only instrument tracking money-in against value-out, stops meaning anything.

Add a `refund_amount` column while you are there, so a partial refund is expressible at all.

## M5 — Fix the purchase screens: the hold, the language, the two Arabic promises

**Falsifies:** REFUNDS §5 ("your order screen shows a deadline — that deadline is the promise"), §12.3; TERMS §16, §17.

Three separate defects on the screen where money changes hands:

1. `cf.hold` (`app.js:2602` EN / `2768` AR) hardcodes **"48 hours"** / «٤٨ ساعة». The live value is `S.HOLD_TTL`, admin-editable from 60 s to 30 days (`settings.js:69`). Change the panel and the UI lies. `payments.instructionsFor()` already returns the true `holdHours` and `holdExpires` (`payments.js:146`) — use them.
2. `app.js:928-931` writes `"Your spot is held until …"` in **hardcoded English, outside the i18n table** — shown to Arabic-language users, and shown to **paint-pack buyers who reserve no spot at all** (`createOrder` sets `hold_expires` for both kinds). Same for `#pySentSub`, `#pyShotName` and the `#pySubmit` labels around `app.js:999-1007`.
3. **`ps.fine` and `cf.fine` are the operative Arabic contract** (LAWYER-REVIEW #3). Update both languages to match the published documents *before* publishing anything that qualifies them:

   > EN `ps.fine`: `Paid by InstaPay and confirmed by a person — usually within the hour, but there is no guaranteed time. Paint stays on your account for as long as S37 runs. If a batch is turned down, the paint comes straight back. Pixels you paint are erased with the whole wall on the 1st.`
   > AR: «الدفع بإنستاباي وحد بيأكده — غالبًا خلال ساعة، بس من غير وقت مضمون. البوية بتفضل في حسابك طول ما S37 شغّالة. لو دفعة اترفضت، البوية بترجعلك فورًا. البكسلات اللي بترسمها بتتمسح مع الحيط كله يوم ١.»

## M6 — Stop sending personal data and bank screenshots to Telegram

**Unlawful limb.** PRIVACY §6.1 as drafted is *truthful*, so publishing is not a falsehood — but it is an accurate written account of a practice that is hard to defend under both the PDPL and banking-confidentiality rules, addressed to a regulator. See LAWYER-REVIEW #4.

Verified: `telegram.js:330-341` sends `contact: {name} · {phone} · {email}`, `reg: {reg_number}`, `instapay: {handle}` in plain text. `telegram.js:420-427` attaches `params.photoPath = p.screenshot_path` via `sendPhoto`. `remindRefund` (`telegram.js:461-475`) re-broadcasts `payer_handle` every 24 h. The same payload sits in `tg_outbox.payload` until delivered.

`cfg.PUBLIC_URL` is already available in `telegram.js`. Five edits:

1. Brand card body → business name, category, and a link into the admin panel. Nothing else.
2. `cardForPayment` → amount, order code, link. **Never the screenshot** — it is already served securely at `/api/admin/payments/:id/screenshot` (`http.js:404-416`) behind password + TOTP + 12-hour session.
3. `remindRefund` → "order S37-XXXX, EGP N — details in the panel". No handle.
4. Purge `tg_outbox.payload` after successful delivery.
5. Fix `PUBLIC_URL=` — it is **empty** in `.env.production:113`, which breaks the links on every card. This is a prerequisite, not a nicety.

**Then swap PRIVACY §6.1 for this:**

> Every human review starts with a message in a private Telegram group. Telegram is a messaging company outside Egypt. What we send there is deliberately thin: for a batch of pixels, a picture of the artwork as it would appear on the wall, the display name or brand name shown beside it, the pixel count, and a link; for a brand application, the business name and category, and a link; for a payment, the amount, the order code, and a link.
>
> **What we do not send there:** phone numbers, email addresses, commercial registration numbers, InstaPay handles, transaction references, and payment screenshots. Those are never in Telegram. The moderator opens the link, signs in to our private admin panel with a password and a one-time code, and sees them there.
>
> Once a message is in Telegram, Telegram stores it and everyone in that group can see it. We can delete our own copy. We cannot promise that every copy inside Telegram is gone.

## M7 — Build erasure, and the legal hold, in the same commit

**Falsifies:** PRIVACY §9's erasure box, which describes a procedure in detail. There is no delete path anywhere: `http.js:586-752` has no `DELETE` route; `server/admin.js` implements only `setBan` and `adjust`; the admin router at `http.js:368` matches `(ban|unban|adjust)` and nothing else.

One audited admin action, `eraseUser(userId, actor, reason)`:

```
users:          email = NULL, pass_hash = NULL, handle = 'Pixel fan #NNNN',
                status = 'erased', token_epoch += 1
brand_profiles: delete row
submissions:    delete rows for user, unlink each preview_path
                  ← this is what anonymises the archive PNGs
cells:          delete rows for user
payments:       KEEP the row (tax retention) but NULL instapay_ref, payer_handle;
                unlink and NULL screenshot_path
events:         json_remove ip / email / handle / ref from payload
logEvent(actor, 'user-erase', { user, kept: ['payments'], reason })
```

Two things that will otherwise bite:

- **Patch the in-memory owner table.** `wall.owners` is an interned name table; the only thing that updates it is `wall.renameOwner(was, handle)`, called from `http.js:641` on `/api/me/name`. A direct database edit leaves every open tab and every fresh snapshot serving the old name until a restart. Call `renameOwner` from `eraseUser` too — this is also what makes PRIVACY §9's "we reset your name to `Pixel fan #NNNN`" real.
- **Ship the legal hold at the same time.** TERMS §11A and PRIVACY §9 both say nothing is deleted while a legal matter is open. Without a hold flag, the erasure route becomes the mechanism by which someone destroys the record of their own post. A `legal_hold` boolean on `users` and on `submissions`, checked by `eraseUser` and by every retention sweep in M8, is enough.

## M8 — Implement the retention periods before publishing them

**Falsifies:** PRIVACY §7.2 item by item. A retention period written and not implemented is worse than the honest "indefinitely" it replaced.

Four sweeps, one scheduled job:

| What | Statement |
|---|---|
| Submission records | delete `submissions` + unlink `preview_path` where `decided_at < cutoff` and no legal hold. **Note `eraseTx` deletes only `cells`** (`submissions.js:194` `dropCells.run(sid)`) — the `submissions` row and its `pixels BLOB NOT NULL` survive a rejection today, which is why MY PIXELS can still render a thumbnail of a refused batch. |
| Payment screenshots | unlink `uploads/p<id>.*` and NULL `screenshot_path` for payments in a terminal state older than the cutoff. There is **no `unlink` for `uploads/` anywhere in the tree** — the only `fs.rmSync` calls are `tools/backup-nightly.js:46,67`. |
| IP daily counters | `DELETE FROM ip_guests WHERE day < :cutoffDay` — no such statement exists anywhere today. |
| IP in the log | `UPDATE events SET payload = json_remove(payload, '$.ip') WHERE ts < :cutoffMs AND json_extract(payload, '$.ip') IS NOT NULL` (JSON1 is available in better-sqlite3). Sources: `identity.js:349` `guest-mint`, `identity.js:339` `legacy-adopt`, `admin.js:258` `admin-login`. |
| Dormant guests | delete `users` rows with no email, no submissions, no payments, `last_seen < cutoff` — required only if you publish `[[DORMANT ACCOUNT MONTHS]]`. |

Set the cutoffs from FILL-IN group C, and read LAWYER-REVIEW #8 first: the IP retention has a statutory **floor** as well as a ceiling.

## M9 — Get a copy of the database off the volume

**Falsifies:** REFUNDS §1 ("we keep a record of every order, transfer, decision and refund for [[TAX RECORD RETENTION]]"), PRIVACY §7.2, and every dispute promise that depends on records existing.

There is no backup running in production. `RUNBOOK.md` describes `deploy/s37-backup.timer` and `deploy/s37-litestream.service` — systemd units for the VPS design that Railway does not run. `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` are blank in `.env.production:125-127`. And `tools/backup-nightly.js` writes into `cfg.BACKUP_DIR` = `DATA_DIR/backup` — **the same volume as the database.** A volume loss takes the wall, every account, every paint balance, every payment record, every refund owed and every screenshot at once.

Cheapest thing that works this week: a scheduled off-box pull of `GET /api/admin/payments?format=csv` (the route exists, `http.js:392`) plus a manual database snapshot. Then wire Litestream/R2 properly — and update PRIVACY §5, §6.4 and §7.2 **before** you fill in those keys, because doing so silently adds a third country to §5.

Also fix `.env.production:29`, which still says `DATA_DIR=/srv/s37/data` (the VPS path) while Railway is set to `/data`. That is a trap for whoever deploys from that file next.

## M10 — `TZ=Africa/Cairo` on the Railway service

**Falsifies:** TERMS §8 and REFUNDS §8, which both state 00:00 Cairo — a material term, since it decides whether a purchase made last night was worth anything.

`wall.js:37-38` computes cycle boundaries with `new Date(d.getFullYear(), d.getMonth(), 1)` in container-local time. On Railway that is UTC, so the reset actually lands at 02:00 or 03:00 Cairo and shifts twice a year with DST. The same clock drives `identity.dayKey` (so `CAPPED.claims`' "resets at midnight" is wrong too) and `monthKey`, the archive filename.

One environment variable fixes all three.

## M11 — Check ownership before writing the screenshot to disk

**Falsifies:** TERMS §19, REFUNDS §10 and §13 (which rest on the screenshot as the artefact that settles a dispute) and PRIVACY §8 (which claims protection against unauthorised alteration).

`server/http.js:740-744`:

```js
const raw = await readBody(req, uploads.MAX_BYTES + 1024);
const stored = uploads.store(raw, `p${id}`);          // ← writes the file
if (stored.error) return sendJson(res, 400, stored);
const r = payments.attachScreenshot(id, row.id, stored.file, now);  // ← then checks ownership
```

`uploads.store` writes `DATA_DIR/uploads/p<id>.<ext>` unconditionally. `attachScreenshot` does verify `p.user_id !== userId` and returns 404 — **after `fs.writeFileSync` has already run.** Any visitor (a guest identity is minted automatically on page load) can POST a PNG to another payer's payment id, receive a 404, and have already overwritten their receipt. The row still points at that path; the moderator sees the attacker's image. Payment ids are sequential.

Fix:

```js
const p = payments.get(id);
if (!p || p.user_id !== row.id) return sendJson(res, 404, { error: 'not-found' });
if (!['awaiting_transfer', 'submitted'].includes(p.status)) return sendJson(res, 409, { error: 'settled' });
const raw = await readBody(req, uploads.MAX_BYTES + 1024);
const stored = uploads.store(raw, `p${id}`);
```

Better still, name the file `p<id>_<random>.<ext>` so a second upload can never clobber a first.

## M12 — Stop voiding a payment the payer has asserted

**Falsifies:** REFUNDS §12.4 ("if we cannot give you the space you paid for — for any reason — we owe you your money back in full") and §5.

`submissions.js:144-151`:

```js
function settlePayment(sub, now) {
  if (!sub.payment_id) return null;
  if (oweRefund.run(now, sub.payment_id).changes) { … return 'refund_due'; }
  return voidPayment.run(now, sub.payment_id).changes ? 'expired' : null;
}
```

`oweRefund` fires only from `verified`. `voidPayment` fires from `('awaiting_transfer','submitted')` and writes **`expired`**. So: a brand pays, submits the reference (`status = 'submitted'`), the money **has arrived** but nobody has tapped "Money received" yet, and a moderator rejects the logo. The payment is voided to `expired`. **Money in the account, booking gone, zero debt recorded** — nothing nags, nothing appears in the owed-refunds alert at `admin.js:309-310`, and the only override available is `expired>awaiting_transfer`, which reopens a hold rather than recording a debt. Verification is manual and rejection is a button, so this is reachable by ordinary operation.

Fix: when the payment is in `submitted`, do not void it. Either move it to `refund_due` and let the operator confirm the money never arrived, or add a `needs_check` status surfaced in the panel's alert list beside "refunds owed". Voiding a payment the payer has asserted is the wrong default in every case.

## M13 — Build the report, contact and appeal routes

**Falsifies:** TERMS §11 ("the REPORT button on any pixel"), §11A, §25; PRIVACY §9, §11, §13; REFUNDS §10, §14, §16.

There is no `/api/report` anywhere in `http.js`, no `mailto:` anywhere in the frontend, and no affordance in the tooltip.

1. **Report.** `POST /api/report {idx, reason}` → `logEvent` + `telegram.enqueue` a card carrying the coordinates and the preview. Entry point: a `⚑ REPORT` chip in the tooltip (`app.js:2191-2211`, which already has the coordinates and the owner). Queue: a new page in `admin/panel.js` `PAGES` (line 84) so reports reach the person who can act. ~30 lines, and it is what makes §11 real for a phone user with no mail client configured.
2. **Contact.** A real mailbox in the imprint (M1), plus `mailto:` links from the MORE row, from the rejected-batch note (`.hs-note`, `app.js:1090-1108` — built with `textContent`, so append an element rather than interpolating), and from the payment-rejected state. Prefill the subject with the order code where one exists.
3. **Appeal.** TERMS §11 promises a person looks again within a stated window. The contact route plus the panel is enough; there is no need for a separate flow.

## M14 — Gate paint orders on a stored capacity affirmation

**Falsifies:** PRIVACY §11 ("we ask for an age confirmation before an account can buy paint") and supports TERMS §5.

Grep for `birth|age_|minor|over18` across `index.html`, `app.js` and `server/` returns only `Max-Age` on cookies. `POST /api/paint/order` (`http.js:722-731`) gates only on `identity.paintGate(row)`, which is `e && e.email ? null : PAINT_GATE`.

Add a plain statement plus a required tick at `#paneRegister` (`index.html:492-506`) and `#paneSignup`, store it (`ALTER TABLE users ADD COLUMN capacity_confirmed_at INTEGER;`), and gate `POST /api/paint/order` and `POST /api/book` on the **stored** flag, not a client-side tick. Note this only supports the term; M4 is what makes the unwind promise performable.

## M15 — Build a site-wide notice

**Falsifies:** TERMS §20 (closure notice), §24 (changes), and PRIVACY §14 — all three say "we show a notice in the app", and there is no mechanism that can.

`server/notifications.js` is a `UNION` over *the caller's own rows*; it structurally cannot carry a message to everyone. The help modal is one-shot, gated on `localStorage['s37.help']`.

Add a `notice` key to `settings.SPEC` (`settings.js:60-71` — it needs a `str(max)` validator beside the existing `int`/`bool`), surface it in the snapshot meta (`wall.js:180-188`, next to `prices`), and render it as a dismissible strip. This is also the surface the first-run storage-and-IP notice in PRIVACY §4 and §12 needs.

## M16 — Make human moderation structurally true

**Falsifies:** TERMS §11 ("nothing goes on the public wall until a person has approved it") and PRIVACY §10 ("the service refuses to start in production with it on").

Two independent failure modes, both fail **open**:

1. `submissions.js:259-271` — when `cfg.TG_MODE === 'off'`, every submission self-approves after `AUTO_APPROVE_MS` (default 2000 ms) with actor `system:auto`. One environment variable.
2. `telegram.js:480` — `const isMod = id => cfg.TG_MOD_IDS.length === 0 || cfg.TG_MOD_IDS.includes(Number(id));` — **an empty moderator list means every member of the Telegram group is a moderator.** `.env.production:81` holds exactly one id today; clear that line during an env migration and the promise silently becomes false with nothing logged.

Also: `onCallback` and `onCommand` (`telegram.js:496`, `581`) never check that the update came from `cfg.TG_CHAT_ID`. Anyone who adds the bot to a group by username gets `/pending` and `/stats` (which leak the queue with handles) and a `/freeze` button that sets `maintenance` — stopping claims, bookings and paint orders wall-wide.

Fix: `config.js` already has fail-fast machinery for required values — add "refuse to boot in production when `TG_MODE === 'off'` or `TG_MOD_IDS.length === 0`". Change `isMod` to fail closed. Check the chat id in both handlers.

---

# SHOULD

## S1 — Shorten the guest cookie
`config.js:196` sets `GUEST_TTL` to 365 days, with rolling renewal past halfway (`identity.js:374-377`). A year-long self-renewing identifier that is also the key to a monetary balance is a persistent identifier, and it weakens PRIVACY §12's "strictly necessary" position more than the function itself does. 90 days gives active users the same experience. If you change it, change `[[GUEST COOKIE LIFETIME]]` in both PRIVACY files in the same commit.

## S2 — Make a ban actually block
`admin.setBan` (`admin.js:475-485`) sets `users.status = 'banned'` and bumps `token_epoch`. **Nothing on the request path reads `users.status`** — `identity.verifyCookie` does not, and `identity.resolve` (`identity.js:364-386`) does not. The epoch bump invalidates the cookie, `verifyCookie` returns null, and `resolve` mints a **new** guest (seeded from `ip_allowances`, so not a wholly fresh 50, but a fresh identity). The ban logs them out and hands them a clean slate. Reject in `resolve` when `status !== 'active'` and return 403 rather than minting. TERMS §21 assumes this works.

## S3 — Bind the wall name to the approved business name
TERMS §15 says "Businesses must publish under the business name we approved". `wall.js:433` takes `String(meta.name || e.handle || 'YOUR BRAND').slice(0, 24).toUpperCase()` straight from the request body with no comparison to `brand_profiles.business_name`. An approved brand can publish 24 characters of anything — a competitor, a bank, a ministry. Also point `brandNamed` (`identity.js:670-671`, which checks `users.handle`) at `submissions.brand_name` as well, since that is the name actually shown.

## S4 — Validate the brand link on the server
`wall.js:412` stores `meta.url` raw. The only filter is client-side (`app.js:200-209` `safeUrl`), so the database and every API response carry whatever was sent. `identity.httpUrl()` already exists and is used for signup website/socials — use it here. TERMS §18 makes promises about links.

## S5 — Escape the CTA, show the destination, mark it sponsored
`app.js:2204` interpolates `b.cta` into `innerHTML` **unescaped** while the owner name beside it is escaped. CSP contains it today; use `esc(b.cta)`. Separately, `tapCell` (`app.js:2171-2175`) opens a brand's link on the **first** tap with no hostname shown and no sponsorship marker, while TERMS §18 tells the user to check where they are going. Make the first tap show the tooltip with the hostname and a *sponsored* marker; the second tap opens it. One change closes both §18 gaps.

## S6 — Write the breach procedure into RUNBOOK.md
PRIVACY §13 commits to a notification path that exists as a sentence and not as a procedure. Four paragraphs: who decides it is a breach, what gets recorded, who is told, in what order, by when. Confirm the deadline (LAWYER-REVIEW, FILL-IN group C) first.

## S7 — Protect `admins.totp_secret`
Stored as plaintext base32 (`migrations/001_init.sql:139`) in the same SQLite file that gets snapshotted and — once M9 lands — replicated offsite. PRIVACY §8 describes two-factor authentication as a protection; a database leak currently hands over the password hash and the second factor together.

## S8 — Stop trusting a header nobody sets
`identity.js:50-53` prefers `cf-connecting-ip` unconditionally when `TRUST_PROXY=1` (`.env.production:36`), but the deploy is Railway, not Cloudflare, and nothing strips that header. Any client can forge it, which means the per-IP caps in TERMS §9 are bypassable and the IP written to `events` — the one PRIVACY §3.1 says we record — is attacker-supplied. Verify what Railway's edge actually sets and trust only that.

## S9 — Distinguish a takedown from a rejection
`submissions.js:77-79` — `takeDown` writes `status = 'rejected'`. The ledger cannot tell "never published" from "published then removed", and `notifications.js`' FEED selects `('approved','rejected','expired')`, so a user whose approved work was removed on day 20 is told it was *rejected*. TERMS §12 and REFUNDS §12.5 vs §12.6 attach different consequences to the two. Add a `taken_down` status or a `taken_down_at` column, surface it in `historyFor` and the feed, and give it its own string in both languages.

## S10 — Sweep, or at least age-alert, `submitted` orders
`payments.js:96` — `staleOrders` selects `status = 'awaiting_transfer'` only, and `goExpired` guards the same. Once a payer submits a reference the row moves to `submitted` and becomes invisible to `sweep()` forever, holding its cells with no deadline, no nag and no settlement. REFUNDS §5 is drafted around this truthfully ("the order does not close on you"), but the operator needs to see it. Add two alerts to `admin.overview` (`admin.js:304-313`, which today alerts only on refunds owed and pending > 40): **oldest `submitted` payment age** and **oldest `pending` submission age**, with a Telegram digest. This is the cheapest operational protection in the whole review — it is what makes the response-time commitments in all three documents achievable.

## S11 — Record the outbound refund reference
`payments.markRefunded` (`payments.js:243-258`) records `refunded_by` and a timestamp and nothing else. The `OVERRIDES` entry `'refunded>refund_due': 'the refund bounced or never landed'` is the operator's own admission that this happens. REFUNDS §13 tells the customer they can ask for the reference. Require a `refund_ref`, same shape as `instapay_ref`.

## S12 — Tell users the things the documents say and the app does not
- **Free pixels do not come back.** TERMS §7 and REFUNDS §7 say it; the app never does. Add it to the rejection note (`app.js:1090-1108`) and to `co.fine`. Suggested AR: «البكسلات المجانية ما بترجعش لو الدفعة اترفضت — الـ٥٠ الجاية بتنزل على معادها زي ما هي.»
- **The reset date, in the paint shop.** `co.fineTail` discloses it at claim time; `#modalPaint` does not. A 500-pack bought on the 30th is one day of wall. This removes the single most likely refund argument and costs nothing.

## S13 — Fix the two strings that say the wrong thing
- `identity.js:676` returns `PAINT_GATE.message` when a guest tries to rename, so someone changing their name is told about paint balances. Give rename its own message.
- `co.fineTail` (`app.js:2465` EN / `2631` AR) promises *"Once it does, it stays until the reset on {d}"* in both languages, while `submissions.takedown()` and `admin.eraseRegion()` remove approved pixels and TERMS §11 reserves that right. Change both.

## S14 — Enforce the minimum booking server-side
`MIN_PX = 8` lives only at `app.js:1407`; `wall.bookBrand` (`wall.js:415-437`) enforces nothing, so a crafted request books 1 pixel. REFUNDS §12.1 says the app shows the range — enforce it in `bookBrand` so the server agrees with the screen.

## S15 — Delete bulk *approve*
`http.js:331-337` approves up to 200 submissions in one call with no preview rendered anywhere in that path. Keep bulk reject; bulk approve exists only to make a backlog feel smaller and it is an unreviewed-publication button. See LAWYER-REVIEW #11 — it is the highest-risk line of code in the repository.

## S16 — Assert the fonts are present at boot
`http.js:44-53` computes the CSP from `fs.existsSync(ROOT/assets/fonts)` and **silently falls back to `fonts.gstatic.com` / `fonts.googleapis.com`** if that directory is missing from a deploy. PRIVACY §3.9's "no third-party scripts and no font CDN" would become false with nobody noticing. Fail the boot, or the build, if the directory is absent in production.

## S17 — Bring the marketing down to what TERMS §11 says
`PRODUCT.md` — *"The wall is always safe to look at."* `MARKETING.md:152` — *"always safe to look at and safe to put a logo on."* An unqualified safety warranty backed by one person, zero automated scanning, and a config flag two seconds from auto-approving everything. TERMS §11 deliberately says the opposite ("we do not promise that nothing which breaks section 10 ever reaches the wall"), and under CPL an unqualified warranty in marketing is actionable independently of what the Terms say.

## S18 — Stamp the rate on the payment row
TERMS §16 and REFUNDS §12.2 both say the price you saw is the price that applies. Prices are runtime-mutable (`settings.js:166-172`; `S.PACKS` is recomputed on every read), and nothing writes the rate onto the `payments` row. Add it alongside `terms_version` from M3 — together they are what makes a later dispute answerable.
