# FILL-IN — everything the operator must supply

Nothing in `legal/` may be published with a `[[PLACEHOLDER]]` still in it. Every one below appears in at least one of TERMS, PRIVACY, REFUNDS and their Arabic versions. Fill it in **all six files at once** — the Arabic uses the same placeholder tokens on purpose.

Work top to bottom. Group A blocks publication outright. Group B needs a decision you can live with. Group C needs a number confirmed by someone other than you.

---

## A. Identity and contact — no document works without these

- [ ] **`[[OPERATOR LEGAL NAME]]`** — the full legal name that receives the money. If unincorporated, this is your name as it appears on your national ID. Appears in all six files.
  *Nothing in the repository names a person or an entity. Today the app identifies the seller as "S37" and a personal InstaPay handle, and nothing else.*

- [ ] **`[[OPERATOR LEGAL FORM]]`** — "an individual trader established in Egypt", a sole proprietorship, or a company form. This decides who is personally liable, which registration numbers exist, and whether Part 4 of the lawyer review applies to you personally.

- [ ] **`[[OPERATOR ADDRESS]]`** — a real street address for correspondence and service. Not a PO box if you can avoid it.

- [ ] **`[[COMMERCIAL REGISTRATION NUMBER]]`** and **`[[TAX REGISTRATION NUMBER]]`**
  ⚠️ **Do not write the words "not registered" here.** A published document saying so is a dated, signed admission handed to a regulator. If you are not registered, either register first (see LAWYER-REVIEW #2) or remove those two lines from the imprint entirely and take advice on what the minimum lawful disclosure is. Removing a line is neutral; volunteering an offence is not.

- [ ] **`[[CONTACT EMAIL]]`** — a mailbox you actually read. Referenced ten times across the three documents.
  *There is no email address, no `mailto:`, and no contact form anywhere in the frontend today. Grep returns only input placeholders (`hello@nile-soda.com`, `you@instapay`).*

- [ ] **`[[COMPLAINTS EMAIL]]`** — may be the same mailbox. Load-bearing: REFUNDS §10, §11, §14, §16 and TERMS §19, §25 all point at it.

- [ ] **`[[PRIVACY CONTACT EMAIL]]`** — may be the same mailbox. Every data-subject right in PRIVACY §9 routes here.

- [ ] **`[[PHONE / WHATSAPP]]`** and **`[[CONTACT HOURS]]`** — optional in law, expected by a phone-first Egyptian audience. If you will not answer a phone, delete the line rather than publishing a number that rings out.

- [ ] **`[[SITE URL]]`**, **`[[PRIVACY NOTICE URL]]`**, **`[[ARABIC TERMS URL]]`**, **`[[ARABIC PRIVACY URL]]`**, **`[[ARABIC REFUNDS URL]]`**, **`[[ENGLISH TERMS URL]]`**, **`[[ENGLISH PRIVACY URL]]`**, **`[[ENGLISH REFUNDS URL]]`**
  These become real once the pages ship. **They can ship today with no server change:** `server/http.js:195` already serves everything under `/assets/`, and `TYPES['.html']` is `text/html; charset=utf-8`. So `assets/terms.html`, `assets/terms.ar.html`, `assets/privacy.html`, `assets/privacy.ar.html`, `assets/refunds.html`, `assets/refunds.ar.html` all serve as-is. See CODE-CHANGES M1.

- [ ] **`[[VERSION]]`** and **`[[EFFECTIVE DATE]]`** — pick a scheme (`1.0`, ISO date) and use the *same* pair across all six files. The version has to be stamped on `users` and on every `payments` row (CODE-CHANGES M3), so choose something short and stable.

---

## B. Decisions only you can make

- [ ] **Arabic governs.** All six documents already say the Arabic version applies. This is a deliberate choice, not a default — see LAWYER-REVIEW #3. If your lawyer disagrees, one edit in three places (TERMS §3, REFUNDS §18, PRIVACY header) reverses it, but do not reverse it lightly: the only contractual promises the app makes in Arabic today are two unqualified ones at the moment of purchase.

- [ ] **`[[LIABILITY FLOOR]]`** — TERMS §22 is drafted as *the greater of* this figure *and* everything you were paid in the previous 12 months. **EGP 5,000 is the drafted suggestion.** It has to be non-trivial: the person with the lowest cap is the free guest, who is also the person with the strongest data-protection claim, and a cap that is lowest where the harm is highest is the shape courts strike.

- [ ] **`[[CLOSURE NOTICE DAYS]]`** — suggested **60**. Long enough that most paint gets spent before any money moves, which is what makes item 4 of TERMS §20 cheap.

- [ ] **`[[CLOSURE REFUND DAYS]]`** — suggested **30** from the day the wall closes.

- [ ] **`[[TERMINATION REFUND DAYS]]`** — suggested **30**. This is the refund when *you* end someone's access for something short of fraud.

- [ ] **`[[REFUND SEND DAYS]]`** — suggested **7 days**. `PLAN.md:703` records this as an unresolved question; this is the answer. Do not write "working days": the Egyptian week and public holidays make that an argument you cannot win. The 24-hour Telegram nag on `refund_due` is what makes 7 days achievable.

- [ ] **Transfer fees on refunds.** REFUNDS §13 currently says you deduct nothing and the receiving bank's charge is the customer's. Confirm that is true of your account. The other half of `PLAN.md:703`.

- [ ] **Response times — pick ONE number and use it everywhere.**
  - `[[GENERAL REPLY DAYS]]` (TERMS §25)
  - `[[COMPLAINT REPLY DAYS]]` (REFUNDS §14)
  - `[[DISPUTE REPLY DAYS]]` (TERMS §19)
  - `[[DSR REPLY DAYS]]` (PRIVACY §9)
  - `[[APPEAL REPLY DAYS]]` (TERMS §11)

  **Suggested: 7 days for all five.** One person with a phone cannot honour four different clocks, and a published deadline you miss is worse than a longer one you keep. `MARKETING.md:101` already says the truth internally — "within the hour but it is not instant, and it is not staffed overnight." Do not publish a promise the marketing copy contradicts.

- [ ] **`[[BACKUP DESTINATION AND STATUS]]`** (PRIVACY §6.4) and **`[[BACKUP RETENTION]]`** (PRIVACY §7.2).
  ⚠️ Today, on Railway, **nothing runs**. `deploy/s37-backup.timer` is a systemd unit for the VPS design and does not exist on Railway; `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` are blank in `.env.production`; and `tools/backup-nightly.js` writes into `DATA_DIR/backup` — **the same volume as the database it is backing up**.
  Two acceptable fills:
  - *If you fix it first (do this — CODE-CHANGES M9):* name the destination, the country, and the retention. Cloudflare R2 adds a third country to PRIVACY §5 and must be described before it is switched on, not after.
  - *If you publish before fixing it:* "We take copies of the database by hand. There is no automatic schedule and no copy stored outside the hosting provider." That is honest, and it is also a sentence you will not want to leave up.

- [ ] **`[[GUEST COOKIE LIFETIME]]`** / **`[[BRAND COOKIE LIFETIME]]`** — as shipped these are **365 days** and **180 days** (`config.js:196-197`), with rolling renewal past halfway. Write the truth. If you shorten `GUEST_TTL` (CODE-CHANGES S1 — recommended, a 365-day rolling identifier weakens the "strictly necessary" position in PRIVACY §12), change the number here in the same commit.

- [ ] **`[[DORMANT ACCOUNT MONTHS]]`** — how long an account with no email, no submissions and no payments survives before it is swept. Suggested **12**. There is no such sweep today (CODE-CHANGES S2); do not publish a number until it exists.

---

## C. Numbers you must not guess — get them confirmed

- [ ] **`[[TAX RECORD RETENTION]]`** — the period Egyptian tax and commercial law requires books and documents to be kept. Commonly cited as **5 years**; confirm with an accountant or lawyer. This one number appears in REFUNDS §1, PRIVACY §7.2 and PRIVACY §9, and it is what converts "we keep payment records indefinitely" (indefensible) into "we keep them because the law requires it" (unimpeachable). It is also the justification for keeping a payment row after an erasure request.

- [ ] **`[[IP RETENTION]]`** — drafted on the basis that Anti-Cyber Crime Law 175/2018 obliges service providers to retain data identifying users for **180 consecutive days**. Confirm the figure *and* confirm that S37 is a "service provider" for that purpose. This cuts both ways: it is a floor as well as a ceiling, and it is the answer to both "why do you keep IPs at all" and "why do you keep them forever". See LAWYER-REVIEW #8.

- [ ] **`[[BREACH DEADLINE]]`** — the PDPL notification deadline to the Personal Data Protection Centre. Commonly cited as **72 hours**. Confirm before publishing a number, and write the procedure into `RUNBOOK.md` at the same time (CODE-CHANGES S6).

- [ ] **`[[SUBMISSION RETENTION]]`** and **`[[SCREENSHOT RETENTION]]`** — your own choice, but **do not publish either until the sweep that enforces it exists** (CODE-CHANGES M7, M8). A retention period written and not implemented is worse than the honest "indefinitely" it replaced. Suggested: 24 months for submission records, 12 months after a payment reaches a final state for screenshots.

- [ ] **`[[CPA CONTACT]]`** — the Consumer Protection Agency channel you name. **Verify it is live and can receive a complaint before publishing it.** Pointing consumers at a body that cannot take their complaint is itself a misleading statement.

- [ ] **`[[DATA PROTECTION CENTRE CONTACT]]`** — same check for the Personal Data Protection Centre. See LAWYER-REVIEW #6.

- [ ] **`[[COURTS CITY]]`** — follows from your address. Note both TERMS §26 and REFUNDS §18 already preserve a consumer's right to sue where they live, which is what stops the clause failing outright.

---

## D. Non-placeholder decisions that must be made before publishing

- [ ] **Set `TZ=Africa/Cairo` on the Railway service.** TERMS §8 and REFUNDS §8 both state 00:00 Cairo. `wall.js:37-38` computes the cycle boundary with `new Date(y, m, 1)` in container-local time — UTC on Railway, so the reset actually lands at 02:00 or 03:00 Cairo and moves twice a year with DST. One environment variable makes both sentences true, and it also fixes the daily-cap reset message and the archive filename. **Until this is set, both documents contain a false statement about a material term.**

- [ ] **Have an Egyptian lawyer read the Arabic, not just the English.** The Arabic is the operative text by your own choice. It must be reviewed with the same care as the English, and it must be reviewed *as a legal document*, not proofread as a translation.

- [ ] **Fix the two Arabic in-app strings before publishing anything that qualifies them.** `ps.fine` (`app.js:2744`) and `cf.fine` (`app.js:2769`) are shown at the moment of purchase and are, today, the only Arabic contractual promises in the product. See CODE-CHANGES M5.

- [ ] **Decide whether prices are tax-inclusive**, and add one line to REFUNDS §2 saying which. A price shown to a consumer without stating whether tax is included is its own disclosure problem. See LAWYER-REVIEW #9.

- [ ] **Confirm the Railway region is still the Netherlands** before publishing PRIVACY §5, which states it as fact, and set yourself a reminder to re-check after any region migration.
