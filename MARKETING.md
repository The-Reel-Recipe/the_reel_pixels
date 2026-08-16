# S37 — marketing context

Everything a marketing decision needs to be made against, taken from the
running code rather than from intentions. Written 2026-08-14.

Rule for anyone using this file: **the Facts sections are verified against
the source and the live database. The Gaps and Open decisions sections are
where the guessing is allowed.** Nothing in here is a claim you may make
publicly unless it appears under §1–§6; §7 lists what you must not say.

Live: <https://s37-production-582e.up.railway.app>

---

## 1. What it is, in thirty seconds

S37 — **شخبط على الحيط** (*shakhbat 3al 7eet*, "scribble on the wall") — is a
one-million-pixel wall that anyone can paint on from their phone, for free,
and that is **wiped clean on the 1st of every month**.

Three things happen on it:

1. **People paint.** 20 free pixels each, no account, no app. A person
   reviews every batch before it goes public.
2. **People buy paint** when the free pixels run out and they don't want to
   wait 30 minutes.
3. **Brands pre-order a block of the *next* month's wall** for their logo,
   which goes up the moment the wall resets and owns that spot all month.

The money comes from 2 and 3. The reason anyone shows up is 1.

---

## 2. The mechanic, exactly (facts)

| Thing | Value | Where it lives |
|---|---|---|
| Wall size | 1000 × 1000 = **1,000,000 pixels** | `config.js` `W`,`H` |
| Free pixels per person | **20** | `CAP` |
| Refill | a fresh 20, **30 minutes** after the last one is spent | `REFILL` |
| Reset | the **1st of every month**, whole wall to white | monthly cycle |
| Moderation | **every** batch reviewed by a human before it is public | Telegram bot |
| Account needed to paint | **none** | cookie identity |

**The pre-moderation is the spine of the product.** Your pixels go up
*pending* — shimmering, visible only to you — and become public when a
moderator approves them in Telegram. Rejected work never appears, and the
paint spent on it is refunded automatically. This is what makes the wall
safe to put in front of a brand, and it is the hardest thing for a copycat
to match, because it is operational, not technical.

Anti-abuse (relevant because it caps how fast a campaign can convert):
5 new identities per IP per day, 40 claim submissions per IP per day,
3 brand applications per IP per day. A shared office or a café will hit
the first one. It shows an explicit "too many visitors from your
connection" screen, not a broken page.

---

## 3. The money (facts)

**Paint** — prepaid pixels for individuals. **2 EGP per pixel.**

| Pack | Price | Effective | Saving |
|---|---|---|---|
| 25 paint | 45 EGP | 1.80/px | 10% |
| 100 paint | 160 EGP | 1.60/px | 20% |
| 500 paint | 700 EGP | 1.40/px | 30% |

500 is the largest pack. Paint never expires but the pixels it buys wipe
with the rest of the wall on the 1st.

**Brand pre-order** — **5 EGP per pixel**, on the *next* cycle, held 48
hours while the transfer arrives. Minimum 8×8. What the preset ladder in
the editor actually costs:

| Size | Pixels | Price |
|---|---|---|
| 8×8 (minimum) | 64 | **320 EGP** |
| 30×30 | 900 | 4,500 EGP |
| 50×30 | 1,500 | 7,500 EGP |
| 80×40 | 3,200 | 16,000 EGP |
| 120×60 | 7,200 | 36,000 EGP |
| 200×100 | 20,000 | 100,000 EGP |
| 300×150 | 45,000 | 225,000 EGP |

**A pricing observation worth acting on:** the presets jump from 4,500 EGP
to 225,000 EGP. The realistic Egyptian SME buy is the bottom two rows; the
top two are enterprise money nobody has been sold yet. The editor does have
a **"fit to budget" slider** — a brand can name a number and get a size —
which is the more honest way to sell this than the preset ladder. Consider
leading with the slider and a price like "your logo from 320 EGP" rather
than with sizes.

**Payment rail: InstaPay only.** No cards, no gateway. The buyer transfers
to `mohaby@instapay`, puts a short code in the note, and comes back and
types the reference; a human confirms it. Practically:

- Egypt-only in effect. Someone abroad cannot easily pay.
- There is a **human in the loop on every sale.** Verification is usually
  within the hour but it is not instant, and it is not staffed overnight.
- Marketing must never promise instant delivery of paint or a booking.

---

## 4. Who it is for

**Painters** — the Egyptian general public, overwhelmingly on phones,
arriving from a shared link. Impatient, casual, there to drop a few pixels
and show a friend. They are not the revenue; they are the reason the wall
is worth buying space on. Their job to be done is *"put something of mine
in a public place and show someone."*

**Brands** — Egyptian SMEs. Their job is *"be seen somewhere my customers
already are, cheaply, without an agency."* They apply once (reviewed by
hand), then can book any month. The gate is real: a person reads every
application, and unverifiable businesses are turned down.

**Moderators** (Mohab today) — operate entirely from Telegram. Approve or
reject with a reason, confirm payments. This is an operating cost that
scales with painter volume: **every batch is a tap.** A campaign that
brings 10,000 painters brings thousands of taps.

---

## 5. The monthly cycle is the marketing engine

This is the single most important structural fact for planning.

- The wall **fills** through the month → scarcity is real and visible.
- The wall **wipes** on the 1st → a hard, recurring, un-fakeable deadline.
- Brand spots are bought **for the next cycle** → the natural sales window
  is the back half of a month, closing at the reset.
- Every finished wall is **archived as a PNG** (`DATA_DIR/archive/YYYY-MM.png`,
  and `npm run export-wall` for the current one) → a free, monthly, highly
  shareable artefact that nobody has used yet.

A calendar falls straight out of this: build through the month, sell brand
space toward the end of it, publish the archive PNG on the 1st as the
"here's what we made" moment while the fresh wall is empty and inviting.

---

## 6. Positioning

r/place-style collective painting crossed with the Million Dollar Homepage,
built for Egypt specifically:

- Prices in EGP, paid by **InstaPay** — the rail people actually use.
- **Arabic first-class**, not a translation pass: the whole UI runs in
  Egyptian dialect with full RTL, switchable from the top bar.
- **Everything is pre-moderated**, so the wall is always safe to look at
  and safe to put a logo on.
- The name is Arabic and colloquial, and the product behaves like it.

The defensible bit is the third one. Anyone can clone a pixel canvas in a
weekend; nobody clones a moderation habit.

---

## 7. What you may NOT claim (hard constraints)

There is **no traction to cite yet.** The live database currently holds
342 guest identities, 1 brand account, and a few hundred submissions —
and essentially all of it is development and test traffic generated while
building. It is **not** an audience, and none of it may be presented as
users, sales, or growth.

Do not claim, until it is true and you can point to it:

- user numbers, pixels-painted totals, or growth of any kind
- customers, brands on the wall, or logos placed (one approved brand
  account exists; it is a test account)
- testimonials, press, ratings, awards
- funding, team size, or partnerships
- "instant" anything about payments — a human confirms every one
- availability outside Egypt — the payment rail is domestic

There is also no privacy policy or terms page. Anything that collects an
email in an ad probably needs one first.

---

## 8. Language

The product speaks **Egyptian Arabic and English**, toggled from a chip in
the top bar, with full RTL layout in Arabic. The Arabic is dialect, not
Modern Standard — "دوس وشخبط", "يلا نشخبط". Marketing copy should match
that register; MSA would sound like a different product.

The brand name should appear in both forms — **S37** and **شخبط على الحيط**
— together wherever there is room. The Arabic is the memorable half.

---

## 9. Assets that exist, and the gaps

**Exist:** the live site; the S37 mark and wordmark (`assets/`); the pixel
identity (Press Start 2P + Cairo, pink-on-plum, pixelarticons); the seeded
starting artwork; monthly wall archives as PNG; a `DESIGN.md` with the full
design system if anything else needs to look like the product.

**Gaps that will cost you conversions — in priority order:**

1. **No social preview.** `index.html` has no `og:` or `twitter:` tags, so
   a link shared to WhatsApp, Facebook or Instagram DM shows a bare URL
   with no image. For a product whose whole growth loop is "show a friend",
   this is the single highest-leverage fix and it is small. Better still:
   a preview image generated from the *current wall*.
2. **No share affordance in the app.** A painter who just placed pixels has
   no button that produces a shareable image or link to their spot. The
   moment of maximum enthusiasm currently ends in nothing.
3. **No landing page.** The URL opens straight into the wall. Good for
   painters, bad for a brand's decision-maker arriving from an ad — there
   is no page that explains, prices, and asks for the sale.
4. **No email capture** anywhere, and no way to tell a painter "the wall
   wipes tomorrow" once they've closed the tab.
5. **Free Railway subdomain**, not a real domain. `s37-production-582e.up.railway.app`
   is not memorable, not typeable on a poster, and reads as unfinished.

---

## 10. The funnel as it actually is today

```
link → wall loads → tap pixels → "SEND FOR REVIEW" → pending shimmer
                                                    → (human, minutes) → public
                                                    ↓
                                  runs out of 20 → buy paint (InstaPay, human)

MORE / BRAND button → apply (reviewed by hand) → approved → pre-order editor
                    → pick size or budget → upload logo → pick spot
                    → InstaPay (48h hold) → verified → live at next reset
```

Friction worth knowing about: the first pixel is genuinely fast — no
account, no permission prompt. The brand path has **two human gates**
(application, then payment) and a **calendar delay** (goes live at the
reset). Sell that delay as anticipation, not as a wait.

---

## 11. What you can actually measure

The admin panel (`/admin`) already surfaces: pixels taken, pending queue
depth, claims today, submissions by status, payments by status and kind,
brand applications by status. The database can answer anything else
directly.

Honest attribution is weak: there is **no analytics, no pixel, no UTM
handling.** You cannot currently tell which channel a painter came from.
If a campaign is going to be judged, decide how before it runs — the
cheapest option is a distinct short link per channel pointing at the same
site, counted at the link service.

---

## 12. Risks a campaign should plan around

- **Moderation is one person.** Painter volume converts directly into taps
  in Telegram. A spike without a second moderator means a growing pending
  queue and painters watching their work shimmer for hours. The admin
  panel warns above 40 waiting. Line up a second moderator *before* any
  push, not during.
- **Payments are manual and not staffed overnight.** A campaign that lands
  at 2am creates a queue of people who paid and are waiting.
- **Per-IP caps** will make the product look broken to anyone demoing it on
  a shared connection — a stand at an event, a classroom, an office.
- **The reset is destructive by design.** Anyone who does not understand it
  before they paint will feel robbed on the 1st. Every piece of creative
  should carry the wipe, not hide it — it is the hook, not the small print.
- **One InstaPay handle** receives everything. It is a personal handle
  (`mohaby@instapay`), which a cautious business buyer may hesitate over
  for a 7,500 EGP transfer.

---

## 13. Open decisions marketing should make

1. **Custom domain?** Currently the free Railway subdomain. Anything
   printed or spoken needs a real one.
2. **Which brand price is the headline** — "from 320 EGP" (true, minimum
   buy) or a preset size? The former converts; the latter anchors higher.
3. **Launch shape** — soft-launch to a small circle to prove the
   moderation loop holds, or push straight for volume? The moderation
   constraint argues for the former.
4. **Who is the first real brand?** One friendly logo on the wall makes
   every subsequent pitch concrete, and there is currently nothing to show
   a prospect.
5. **What happens on the 1st** — is the wipe an event with an archive
   post, a countdown, a "last chance" push? It is the product's only
   built-in recurring moment and it is currently unmarked.
