# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Painters** — the Egyptian general public, overwhelmingly on phones, arriving from social links. Casual, impatient, here to have fun: they want to drop a few pixels, see them on the wall, and show friends. Anonymous by default (cookie identity); can now optionally create a free email+password account to keep pixels, history and paint balance across devices. *(confirmed 2026-08-14)*
- **Brands** — Egyptian businesses buying logo space on next month's wall. They apply for an account (reviewed by hand), pre-order a spot, pay by InstaPay, and expect a clear record of where their money and application stand.
- Moderators and the admin operate through Telegram and /admin respectively — not users of this public surface.

## Product Purpose

S37 (شخبط على الحيط — "scribble on the wall") is a 1,000,000-pixel collaborative wall that resets every month. Visitors paint free pixels, buy paint when the free ones run out, and brands prepay for logo spots on the next cycle. Success is a wall that fills with real people's marks every month and converts that attention into paint packs and brand bookings.

## Positioning

r/place-style collective painting crossed with million-dollar-homepage monetization, built natively for Egypt: EGP pricing, InstaPay payments (no cards), Arabic identity, and — the part neighbors can't truthfully copy — **everything is pre-moderated before it appears**. Your pixels go up pending (visible only to you), a human approves them via Telegram, then they're public. The wall is always safe to look at.

## Operating Context

- One shared live wall; updates stream in over SSE while the page is open.
- The monthly wipe is a real event: countdown runs all month, the old wall is archived as a PNG, brand pre-orders go live at the flip.
- Payments are manual-verification InstaPay transfers: the app shows a code + amount, the payer transfers in their banking app and submits the reference, a moderator confirms money arrived.
- Moderation decisions (approve / reject with reason) land minutes-to-hours later; painters learn the outcome in-app.

## Capabilities and Constraints

- 20 free pixels per visitor; refill 30 minutes after they run out. Per-IP daily caps against identity farming; fresh identities inherit the address's spent allowance clock.
- Paint packs: prepaid pixel balance bought via InstaPay, credited when a moderator verifies the transfer. Rejected submissions refund the paint spent.
- Brand bookings: 5 EGP/pixel on the *next* layer; two gates — payment verified, then content approved. Unpaid holds expire in 48h.
- Backend: single Node process, SQLite, no framework; frontend: vanilla JS + one big canvas. All existing HTTP/API contracts and canvas logic must keep working through any UI change.
- **New (confirmed):** optional painter accounts (email+password) that adopt the current guest identity — pixels, history, allowance and paint carry over; log in from any device. Brands keep the separate application flow.
- **New (confirmed):** in-app notifications feed only (no browser push): submission decisions with reasons, payment confirmations, refill ready, brand application status.
- **New (confirmed):** bilingual UI — Egyptian Arabic and English with a visible toggle; full RTL layout in Arabic.

## Brand Commitments

- Name: **S37**, tagline **شخبط على الحيط / SHAKHBAT 3AL 7EET**. Both forms appear; the Arabic is not decoration.
- Incumbent identity: pink pixel-art world (pixel display fonts, pixelarticons, dark plum + pink palette, S block logo in assets/).
- User-pinned for the remake *(2026-08-14)*: **mobile-first**, **modern and fun**, **very simple to navigate**, **floating bottom nav bar with liquid glass**, only the most important destinations on the bar — the rest behind a "more" area or the top of the screen.

## Evidence on Hand

- Live production app: https://s37-production-582e.up.railway.app (Railway, GitHub autodeploy from `production`).
- Real InstaPay destination: `mohaby@instapay` / https://ipn.eg/S/mohaby/instapay/0Nif30 (+ QR at assets/instapay-qr.png).
- assets/: pixel fonts (self-hosted), pixelarticons set, S37 logos, seed wall art.
- No testimonials, press, or usage numbers exist yet — do not fabricate any.

## Product Principles

1. **First pixel in seconds.** Nothing — not auth, not language, not onboarding — stands between a first-time phone visitor and painting. Accounts are an upgrade, never a gate.
2. **The wall is the hero.** Chrome floats over the canvas and gets out of the way; every screen that isn't the wall is one gesture from it.
3. **Honest pending states.** Pre-moderation is the product's spine — always show painters where their marks stand (pending / approved / rejected+why) without them having to hunt.
4. **Egypt-native, not localized.** EGP, InstaPay, Arabic voice and RTL are first-class, not a translation pass bolted on.
5. **The wipe is theater.** The monthly reset is anticipation — countdown, archive, "own next month's wall" — never buried small print.

## Accessibility & Inclusion

Touch-first (44px+ targets, thumb-reach bottom navigation, safe-area insets); full RTL mirroring in Arabic; legible at arm's length in sunlight (the audience is outdoors on phones). No formal WCAG target confirmed.
