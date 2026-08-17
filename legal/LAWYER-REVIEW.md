# LAWYER-REVIEW — questions for Egyptian counsel, in priority order

Take these in order. **The first four decide whether the product can operate as designed.** Everything after that decides whether a particular clause survives, which matters much less if one of the first four comes back badly.

Bring to the meeting: `legal/TERMS.md`, `legal/PRIVACY.md`, `legal/REFUNDS.md`, their Arabic versions, and this file. Where a document already takes a position, it is named so counsel can attack it rather than start from nothing.

Confidence markers: **[verified]** = confirmed in the S37 source code · **[legal-uncertain]** = I do not know the Egyptian answer and have flagged rather than guessed.

---

## 1. Is a non-expiring prepaid EGP balance, taken into a personal account, a licensable activity?

**The question.** Does accepting money from the public against a service to be delivered later — held indefinitely, denominated in EGP, redeemable only inside one service, with no cash-out — engage payment-services, stored-value or e-money licensing under **CBE Law 194/2020** or CBE regulations? Is there a closed-loop / single-merchant carve-out in Egypt, and if so what are its limits (per-balance cap, aggregate float, expiry)?

**Why it matters.** This is the only question on the list that can stop the product rather than change a sentence.

**The facts.** [verified] `identity.clearAllowances` is `UPDATE allowances SET used = 0, refill_at = 0` — the `paint` column is deliberately untouched by the monthly reset, so balances are perpetual. There is no expiry job, no TTL, no sweeper. `settings.js` caps a pack at `int(1, 1000000)` pixels; at the default 2 EGP/px that is a theoretically valid EGP 2,000,000 single order, and nothing anywhere caps aggregate float. There is no code path converting paint back to money.

**Exposure if wrong.** Unlicensed practice of a licensed activity — criminal, not merely regulatory. Every clause in REFUNDS becomes moot.

**If the answer is bad, the fixes are commercial, not drafting:** a per-account balance cap, a much lower maximum pack size, an expiry period (which contradicts the Arabic «البوية ما بتنتهيش» and so needs the string changed first), and segregation of receipts into a separate account.

## 2. Is a personal InstaPay handle lawful for commercial acceptance — and what is the registration and tax position?

**The question.** (a) Does using a personal IPN handle to accept payments from strangers, at volume, with an order-reference scheme, breach the bank's account terms or IPN rules? (b) Is the operator required to register commercially and for tax before continuing? (c) Does **Law 152/2020 (MSME)** offer a simplified route to registration and a temporary licence?

**Why it matters.** Realistically this bites before any regulator does, and the failure mode is the worst available: **the account frozen with customers' prepayments inside it.** At that moment the operator owes every paint balance and can pay none of them, and TERMS §20/REFUNDS §9 (refund unspent paint on closure) become unperformable.

**The facts.** `INSTAPAY_HANDLE=mohaby@instapay`, a personal handle. Nothing in the repository names an entity. The app requires a phone, an InstaPay handle and (optionally) a commercial registration number from every brand applicant, and publishes none of its own.

**Exposure if wrong.** Frozen funds; unregistered trading penalties; personal liability with no corporate shield. Incorporating is also the single strongest mitigation for item 11 below, which is why registration is worth its cost twice over.

**Specific instruction:** FILL-IN warns against publishing the words "Commercial registration: not registered". Confirm the minimum lawful disclosure for an unincorporated individual trading online.

## 3. Must consumer-facing terms be in Arabic, and does an "Arabic governs" clause bind?

**The question.** Does CPL 181/2018 (and its executive regulations) require that information given to the consumer be in Arabic? Is a clause making the Arabic version prevail enforceable — and, conversely, would an English-prevails clause be struck against an Egyptian consumer?

**Why it matters.** All six documents currently say **the Arabic version applies**. If that is right, the Arabic is the operative legal text and must be reviewed by counsel with the same care as the English — not proofread as a translation. If it is wrong, three edits reverse it.

**The trap this position closes.** [verified] The only contractual statements the app makes in Arabic today are two unqualified promises, shown at the moment of purchase:

- `app.js:2744` — «البوية ما بتنتهيش. لو دفعة اترفضت، البوية بترجعلك فورًا.» ("paint never expires; a rejected batch's paint comes straight back")
- `app.js:2769` — «لو اترفض، الفلوس بترجع لحساب إنستاباي اللي دفعت منه.» ("if refused, the money goes back to the handle you paid from")

No cap, no exclusion, no as-is, no wipe warning attached to the paint purchase. **If the English drafts are unaccepted and unlinked, and the Arabic strings are what the consumer actually saw, those two sentences are the contract.** «البوية ما بتنتهيش» in particular reads as a perpetual obligation and sits badly against TERMS §20 / REFUNDS §9.

**Exposure if wrong.** The operator's only binding terms are two consumer-favourable sentences with none of the protections.

## 4. Cross-border transfer, and whether the Telegram workflow is defensible at all

**The question.** Does the PDPL require a licence or permit from the Personal Data Protection Centre for (a) hosting Egyptian personal data in the EU and (b) transmitting it to Telegram? Is such a permit obtainable in practice today? Is the executive regulation in force and is the Centre operational?

**And separately, the harder one:** may the operator lawfully hold and forward **another person's bank screenshot** — showing their name, part of an account number, a balance and unrelated transactions — to a third-party chat group under no contract? Consider banking-secrecy rules independently of the PDPL.

**Why it matters.** PRIVACY §6.1 discloses this fully and honestly. **Disclosure is not permission.** No wording makes "we send bank screenshots to a chat group and keep them forever" defensible; only re-architecture does.

**The facts.** [verified] `telegram.js:330-341` pushes a brand applicant's contact name, phone, email, commercial registration number and InstaPay handle into the group in plain text. `telegram.js:420-427` attaches the payment screenshot itself via `sendPhoto`. `remindRefund` re-broadcasts the payer's handle every 24 hours until someone taps a button. The same payload also sits in `tg_outbox.payload` until delivered. There is no processor agreement, no deletion control, and group membership is mutable.

**Exposure if wrong.** Unlawful cross-border transfer plus unlawful disclosure of financial data — and PRIVACY, as drafted, is an accurate written account of it, addressed to a regulator.

**The mitigation is small and already specified:** CODE-CHANGES M6 sends a link into the authenticated admin panel instead of the data. It collapses most of this exposure in about five edits to `telegram.js`. Ask counsel whether that is sufficient or whether the Telegram channel has to go entirely.

---

## 5. Does CPL's return / withdrawal right reach an immediately-delivered digital service?

**The question.** Does the consumer's right of return or withdrawal under CPL 181/2018 apply to paint? Is there an immediate-performance exception, as EU law has, where the consumer expressly asks for delivery to begin at once? What is the article, and what is the period?

**Why it matters.** This decides whether REFUNDS §6 — the operator's core commercial position — survives.

**How §6 is drafted to survive.** It rests on four legs: (a) delivery is genuinely immediate and the buyer expressly asks for it on the payment screen, and that request is recorded; (b) the in-product remedy is real — paint comes back on rejection, [verified] `submissions.js:199` `creditPaintRaw`; (c) §6.1 lists five named cases where money *does* come back, so the clause refuses change-of-mind, not undelivered service; (d) §15 severs cleanly and says the law wins.

**What weakens it.** [verified] There is no consent record anywhere in the product today. The only checkbox in the entire frontend is `#bgRemove`. Leg (a) does not exist until CODE-CHANGES M3 ships.

**The concession to have ready.** If counsel says the withdrawal right reaches paint, the smallest change that keeps the operator's position is: **unspent paint refundable in money within 14 days of purchase; spent paint never.** Most balances are small and most are spent, so the cost is low, and it is the version most likely to survive. Note the code cannot perform it — see CODE-CHANGES M4.

**Exposure if wrong.** REFUNDS §6 struck as an unfair term; refunds ordered; a CPA finding that the term was drafted to defeat a statutory right, which colours everything else.

## 6. PDPL registration, DPO, and whether the complaint route in PRIVACY §9 is real

**The question.** Does the PDPL's licensing/registration requirement apply to a controller at this scale? Can an unincorporated individual register? Must a data protection officer be designated? And — before publishing PRIVACY §9 and §15 — **can a data subject actually file a complaint with the Centre today?**

**Why it matters.** PRIVACY names the Centre as the escalation route twice. Pointing consumers at a body that cannot receive complaints is itself a misleading statement.

**Drafting note.** PRIVACY deliberately does **not** contain a line reading "Data protection officer: none", for the same reason FILL-IN forbids "not registered". If none is appointed, the line stays out; do not volunteer the gap.

## 7. Age of capacity: is it 21, and what happens to a minor's purchase?

**The question.** Confirm the age of full civil capacity for contracting (I believe **21** full Gregorian years under the Civil Code, not 18). Confirm the treatment of a discerning minor's contract — my understanding is void if purely prejudicial, valid if purely beneficial, **voidable at the minor's election** in between, which is where a paint purchase sits. Confirm whether an emancipated minor authorised to manage property is treated differently.

**Why it matters.** Both TERMS §5 and REFUNDS §16 are drafted to **capacity** rather than to a number, precisely because 18 is probably the wrong figure for a purchase, and both make the unwind **mandatory** ("we return") rather than discretionary ("we may"). A discretion to refund a minor is the clause a regulator reads as designed to keep a child's money.

**The facts.** [verified] There is no age mechanism in the code at all — no date-of-birth field, no attestation, no minimum-age statement. `POST /api/paint/order` gates only on `identity.paintGate`, which is `e && e.email ? null : PAINT_GATE`: an email address, nothing more. A self-asserted warranty of capacity, given by the person whose capacity is in question, is circular and has close to no evidential value.

**Exposure if wrong.** Voidable purchases with a restitution obligation regardless of the term; and, given the product is marketed on social media to an audience skewing young, a pattern rather than an incident.

**Note the code cannot currently perform the promise.** [verified] There is no reachable transition from a verified paint-pack payment to `refund_due`; the `OVERRIDES` whitelist in `admin.js:561` is `rejected>submitted`, `expired>awaiting_transfer`, `refunded>refund_due` and nothing else. See CODE-CHANGES M4.

## 8. IP retention: is there a statutory floor, and is S37 caught by it?

**The question.** Confirm that **Anti-Cyber Crime Law 175/2018 obliges service providers to retain data identifying users for 180 consecutive days**, and confirm whether S37 is a "service provider" for that purpose. Then confirm what the PDPL requires be done at the end of it.

**Why it matters.** This is the number that fixes PRIVACY §7.2 in both directions at once. Today [verified] `ip_guests` is never deleted (no `DELETE FROM ip_guests` exists anywhere in the tree) and `events` rows carrying `{ip}` from `guest-mint`, `legacy-adopt` and `admin-login` are never pruned. Indefinite retention of a daily abuse counter is indefensible on storage-limitation grounds — **but "as short as possible" may also be unlawful.** A confirmed 180 days converts a compliance failure into a compliance justification.

**Exposure if wrong in either direction.** Too long: a storage-limitation finding. Too short: destroying data you were required to keep.

## 9. Tax: registration, VAT, e-invoicing, and the record-retention period

**The questions.**
- Is trading income here taxable and is registration required at current volume?
- What is the **current VAT registration threshold** (commonly cited as EGP 500,000 turnover; thresholds move)? If crossed: are the published EGP/px prices VAT-inclusive or exclusive, and what must the app say?
- Does the e-invoicing mandate apply once registered, and what does that require of a manual bank-transfer flow?
- **What is the statutory retention period for books and documents?** (Commonly cited as 5 years.)

**Why it matters.** The last one fills `[[TAX RECORD RETENTION]]`, which appears in REFUNDS §1 and PRIVACY §7.2 and §9. It is the single number that converts "we keep payment records indefinitely" into "we keep them for N years because the law requires it", and it is the lawful basis for keeping a payment row after an erasure request. Nothing else in the document set does that work.

**Exposure if wrong.** Penalties on unregistered trading; a consumer-disclosure problem if prices silently exclude tax; and a privacy notice whose retention justification collapses.

## 10. Do the liability and indemnity clauses survive Civil Code arts. 149 and 217?

**The questions.**
- Confirm **art. 149** (oppressive conditions in a contract of adhesion; the judge may modify or relieve **notwithstanding any agreement to the contrary**) is the correct citation and scope.
- Confirm **art. 217(2)** voids any agreement exempting liability for **fraud (غش) and gross fault (خطأ جسيم)**.
- Is the cap in TERMS §22 — *greater of* EGP [[LIABILITY FLOOR]] *or* 12 months' payments — enforceable against a consumer? Against a business?
- Is the business-only indemnity in TERMS §14 enforceable, and is a 5× cap the right shape?

**Why it matters, and what changed from the earlier drafts.** §22 now names **gross fault** explicitly, and carves the **return of price paid** out of the cap. Both were omissions in the earlier draft and both are dangerous omissions: a cap that could bar the return of the price is likely void on its own and drags the rest down with it, and a clause that appears drafted to exclude precisely what cannot be excluded invites a court to strike the whole provision rather than read it down.

The floor is a *greater-of*, not a fallback, so a paying customer is never worse off than a free one. The earlier "EGP 500 if you never paid us" inverted that — lowest cap for the person with the strongest non-financial claim — and that inversion is what a claimant's lawyer leads with.

The indemnity has been **removed entirely for consumers** and kept for businesses with a cap, prompt-notice obligations both ways, and a no-unilateral-settlement covenant. An uncapped indemnity from a consumer who paid EGP 45 is close to a textbook oppressive clause, is economically absurd on its face, and is worth almost nothing in practice.

**Exposure if wrong.** The cap disapplied entirely, and — more expensively — a finding that the risk allocation as a whole is one-sided, which is the finding that makes neighbouring clauses fail too.

## 11. The operator's personal criminal exposure as **publisher** of everything on the wall

**This is the highest-risk item on the list, and the only one with a person in it rather than a number.**

**The questions.**
- What is the operator's exposure under **Penal Code art. 98(f)** (contempt of religion / exploiting religion) and public-morals provisions for content he personally approved?
- What duties does **Anti-Cyber Crime Law 175/2018** put on him as a service provider?
- Does **Law 180/2018** (Supreme Council for Media Regulation) supervision attach to a site like this, and at what threshold?
- Do the documents need to say more about cooperation with authorities and evidence preservation?

**Why the exposure is unusually high here.** The product is engineered to forfeit intermediary status and markets that as its moat. `PRODUCT.md`: *"everything is pre-moderated before it appears."* `MARKETING.md:45-49` calls the pre-moderation "the spine of the product". Where a platform's protection depends on not selecting content before publication, S37 has deliberately built the opposite and sells it. **Every pixel on the wall is there because a person looked at it and pressed Approve.**

And that person is identified permanently by the operator's own database. [verified] `submissions.decided_by` stores `tg:<numeric id> (<username>)`; the `events` journal is append-only by design. The best engineering property in this repository is, in a criminal matter, a ready-made exhibit list on a database a court can order produced.

**The realistic failure mode is routine.** One person, on a phone, at speed, with five canned reject reasons and a backlog warning that fires only at 40 pending. A 4×4 batch that spells something is missable at Telegram card size. And [verified] `http.js:331` exposes `/api/admin/submissions/bulk`, which **approves up to 200 submissions in one tap with no preview rendered anywhere in that path** — converting "I am behind" into "I published two hundred things I did not look at", with the operator's name recorded against all two hundred.

**What the documents now do about it.** TERMS §11A ("Legal demands, reports and evidence") is new: it commits to following lawful orders, preserving evidence, not warning the subject where that would be unlawful, and **not deleting anything while a legal matter is open** — including at the request of the person who posted it. That last clause matters because it interacts with erasure: the moment CODE-CHANGES M7 ships an erasure path, an erasure request becomes a way for a bad actor to destroy the record of their own post. The legal hold must ship in the same commit.

TERMS §10 no longer says *"We decide what falls into these categories. We do not have to prove it to you"*, and §11 no longer says *"or for any other reason"*. Both were deleted deliberately: an unfettered discretion sitting three lines above a criminal-referral clause reads very badly, and it is the sentence most likely to make a court decline to apply the surrounding provisions at all.

**Ask counsel specifically:** whether the mitigations that are not drafting — deleting bulk *approve* (keeping bulk reject), recruiting a second moderator, a hard rule of refusing anything religious rather than judging it, and **incorporating so that the first defendant is a company** — are sufficient, and in what order.

## 12. Closing the service: is the wind-down in TERMS §20 / REFUNDS §9 adequate?

**The question.** Is a 60-day notice, a spend-down window, and a refund of the price paid for unspent paint sufficient? What is the position if the operator is a natural person — personal liability, no corporate shield, no reserve, unsegregated funds?

**Why this departs from the operator's stated instruction.** The brief says "no cash refunds for paint". The earlier draft applied that to closure as well: *"After S37 closes, unspent paint has no cash value and gives you no claim to money."* **That sentence is not published here, deliberately.** A court looks at substance: the consumer paid EGP for a benefit, the supplier withdrew the benefit, the supplier kept the EGP. Calling it a licence does not change that, and refusing to promise the refund does not make the liability disappear — it makes it an unquantified liability with an unenforceable clause on top.

REFUNDS §6 therefore keeps the operator's position **while the service runs**, which is defensible, and §6.1(3) concedes it **on closure**, which is not. If counsel disagrees, this is a one-paragraph reversal — but ask for the reasoning, not just the conclusion.

**Note the cost is lower than it looks:** the refund is of *price paid*, not replacement value, and a 60-day spend-down window will clear most of the float before any money moves.

## 13. Brand bookings: 100% refund with no proration, and whether a small business is a consumer

**The questions.** (a) Is a term refunding 100% of a booking taken down on day 28, identically to day 1, acceptable in both directions? (b) Is a small trader booking EGP 320 of pixels outside CPL protection?

**Why (a) is drafted this way.** [verified] It is what the code does: `settlePayment` → `oweRefund` sets `refund_due` on the whole `payments.amount`, and there is no partial-refund status or amount column anywhere in the schema. It also matches the unconditional Arabic promise at `app.js:2769`. **Do not introduce a pro-rata term in drafting before the ledger can express one** — see CODE-CHANGES S9. A generous term the software can perform beats a fair one it cannot.

**Why (b) is drafted softly.** TERMS §17 no longer asserts "you are not a consumer". It now says the consumer protections *may* not apply and that nothing takes them away where they do. The assertion invited an argument the operator cannot reliably win, and — if it had succeeded — it would have pushed brands out of the CPA route and into litigation, which is worse for the operator, not better, because a brand can afford litigation.

**One clause to check against public-policy limits:** REFUNDS §12.6 refunds in full even where the takedown was caused by the brand's own link or artwork. Commercially the operator may want a carve-out. It is not drafted, because the app promises the opposite in both languages at the moment of purchase; any deduction needs the UI strings changed first and would then need checking as a penalty clause.

## 14. Notice by in-app message only, for changes affecting money already paid

**The question.** Can a change to terms governing a prepaid balance be validly notified by in-app notice alone, with acceptance inferred from continued use?

**Why it matters.** [verified] There is no email transport anywhere in `server/` or `tools/`. Most data subjects are guests with no email stored at all. TERMS §24 is drafted so that a change affecting existing paint or a paid booking **does not apply unless accepted**, precisely because acceptance-by-silence over a prepaid balance is the version a court is least likely to recognise. Confirm that is enough.

**Related, and cleaner as a CPL finding than anything else in the product:** [verified] five shipped strings promise emails the codebase cannot send — `app.js:2495`, `app.js:2497`, `app.js:2517`, `app.js:2520`, and `server/identity.js:652`. A brand applicant is told they will be emailed, in a flow that then collects their phone, email, registration number and InstaPay handle. **That is a false statement made to induce an application.** It is CODE-CHANGES M2 and it costs nothing to fix.

## 15. Jurisdiction, and the erasure carve-outs

**Jurisdiction.** Does a clause naming one city bind an Egyptian consumer? Both TERMS §26 and REFUNDS §18 already preserve the right to sue where the consumer lives, which is the saving that stops the clause failing outright. Confirm it is enough.

**Erasure.** PRIVACY §9 states that the monthly archive pictures stay, on the ground that they contain **no personal data at all**. [verified] this is true: `wall.js:520-529` writes `[idx, p.c]` pairs and `tools/export-wall-png.js:render()` writes raw RGBA from an index and a 24-bit colour — no names, no owner ids, no text layer of any kind. Once a user's `submissions` and `cells` rows are deleted there is no re-identification path left, so the archive is anonymised rather than merely retained.

**This corrects an error in the earlier drafts**, which said the opposite ("your name is saved into the monthly archive picture", "we cannot cut your squares out"). That was factually wrong and it gave away the strongest erasure argument available. Confirm the anonymisation reasoning holds — specifically, that deleting the mapping tables is sufficient to take the archive outside the definition of personal data.

**The two genuine carve-outs are stated as what they are:** Telegram copies outside the operator's control (a technical limitation, not a legal exemption — ask what an erasure request must actually produce), and payment records kept under the statutory tax period from item 9 (a lawful basis, if the period is confirmed).
