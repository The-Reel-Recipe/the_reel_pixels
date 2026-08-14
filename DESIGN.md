---
name: S37 — Shakhbat 3al 7eet
description: A million-pixel collaborative wall that fills the phone edge to edge, with every control floating over it as liquid glass.
colors:
  night-plum: "#150A10"
  plum-surface: "#1F1019"
  plum-raised: "#2C1722"
  hot-pink: "#FF4D9D"
  pink-deep: "#D81B60"
  ink-on-pink: "#22050F"
  rose: "#F5C4C1"
  rose-bright: "#FBE1DF"
  paper-pink: "#FAF2F4"
  dim-mauve: "#CDAFBA"
  mint-ok: "#8FE5AE"
  coral-danger: "#FF6A57"
  amber-warn: "#FFC24B"
  glass: "rgba(28, 14, 22, 0.58)"
  glass-hard: "rgba(28, 14, 22, 0.82)"
  glass-border: "rgba(255, 255, 255, 0.14)"
  hairline: "rgba(255, 255, 255, 0.10)"
  hairline-strong: "rgba(255, 255, 255, 0.18)"
typography:
  display:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  headline:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "13px"
    fontWeight: 400
    letterSpacing: "0.02em"
  title:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.04em"
    lineHeight: 1
  action:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "10px"
    fontWeight: 400
    letterSpacing: "0.02em"
  label:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "8px"
    fontWeight: 400
    letterSpacing: "0.06em"
  nav-label:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "6.5px"
    fontWeight: 400
    letterSpacing: "0.06em"
  body:
    fontFamily: "Figtree, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Figtree, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Figtree, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  input:
    fontFamily: "Figtree, sans-serif"
    fontSize: "16px"
    fontWeight: 400
rounded:
  xs: "6px"
  sm: "8px"
  r: "10px"
  r-lg: "18px"
  r-xl: "26px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "20px"
  3xl: "26px"
components:
  button-primary:
    backgroundColor: "{colors.hot-pink}"
    textColor: "{colors.ink-on-pink}"
    typography: "{typography.action}"
    rounded: "{rounded.pill}"
    padding: "13px 18px"
  button-primary-disabled:
    backgroundColor: "{colors.hot-pink}"
    textColor: "{colors.ink-on-pink}"
    typography: "{typography.action}"
    rounded: "{rounded.pill}"
    padding: "13px 18px"
  button-ghost:
    backgroundColor: "rgba(255, 255, 255, 0.05)"
    textColor: "{colors.rose}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "12px 16px"
    width: "100%"
  button-mini:
    backgroundColor: "rgba(255, 255, 255, 0.06)"
    textColor: "{colors.rose}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "9px 13px"
  nav-brush:
    backgroundColor: "{colors.hot-pink}"
    textColor: "{colors.ink-on-pink}"
    rounded: "{rounded.pill}"
    height: "58px"
    width: "58px"
  nav-brush-off:
    backgroundColor: "{colors.plum-raised}"
    textColor: "{colors.dim-mauve}"
    rounded: "{rounded.pill}"
    height: "58px"
    width: "58px"
  nav-item:
    textColor: "{colors.dim-mauve}"
    typography: "{typography.nav-label}"
    rounded: "{rounded.r-lg}"
    padding: "6px 0"
  nav-item-selected:
    textColor: "{colors.rose-bright}"
    typography: "{typography.nav-label}"
    rounded: "{rounded.r-lg}"
    padding: "6px 0"
  glass-chip:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.rose}"
    rounded: "{rounded.pill}"
    padding: "7px 12px"
  input-text:
    backgroundColor: "rgba(0, 0, 0, 0.28)"
    textColor: "{colors.paper-pink}"
    typography: "{typography.input}"
    rounded: "{rounded.r}"
    padding: "12px 14px"
    width: "100%"
  input-text-focus:
    backgroundColor: "rgba(0, 0, 0, 0.28)"
    textColor: "{colors.paper-pink}"
    typography: "{typography.input}"
    rounded: "{rounded.r}"
    padding: "12px 14px"
  swatch:
    rounded: "9px"
    height: "32px"
    width: "32px"
  swatch-selected:
    rounded: "9px"
    height: "32px"
    width: "32px"
  sheet:
    backgroundColor: "{colors.plum-surface}"
    textColor: "{colors.paper-pink}"
    rounded: "{rounded.r-xl}"
    padding: "26px 20px 20px"
    width: "100%"
  list-row:
    backgroundColor: "rgba(255, 255, 255, 0.045)"
    textColor: "{colors.paper-pink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-lg}"
    padding: "14px"
  status-chip:
    backgroundColor: "rgba(255, 255, 255, 0.08)"
    textColor: "{colors.dim-mauve}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
---

# Design System: S37 — Shakhbat 3al 7eet

## Overview

**Creative North Star: "The Lit Window on a Plum Night"**

The wall is the room; everything else is glass you look through to see it. A million pixels of other people's marks fill the phone from notch to home bar, and every control the app owns — the lockup, the countdown, the language toggle, the paint dock, the five-door nav — is a blurred, translucent, hairline-bordered pill floating on top of that artwork. Nothing is stacked above or below the canvas. There is no header band, no footer band, no letterboxed content well. Chrome is weather over the wall, not architecture around it.

The ground is a dark plum night (#150A10) with one warm radial lift toward the top of the canvas, so the surface never reads as flat black. Against it the system speaks in two registers: a rose family for everything that is merely *text* (#F5C4C1 into #FBE1DF), and one hot pink (#FF4D9D) reserved for the single thing you are meant to press. The pixel display face — Press Start 2P at 400, Cairo at 800 when the page speaks Arabic — never grows large; it lives from 6.5px to 15px and works as a label voice, while Figtree carries every real sentence at 12–16px. That inversion is the personality: the arcade voice is small and clipped, the human voice is bigger and softer.

Density is generous for thumbs and tight for pixels. Touch targets sit at 38–58px, sheets rise from the bottom edge on a phone and become centered dialogs at 760px, and every fixed offset carries a safe-area inset. Confirmed refusal: the category-default chrome sandwich — an opaque top bar over a scrolling content column over an opaque bottom bar — which shrinks the artwork to a window. That composition is not available in this system.

**Key Characteristics:**
- Full-bleed live canvas; all chrome floats over it
- Liquid glass as the single material: 20px blur, 160% saturation, hairline light border
- Dark plum night ground with one hot-pink primary action per surface
- Pixel display face used small (6.5–15px) as a label voice; Figtree used larger for prose
- Pill-shaped floating controls, panel-radius sheets, zero square corners outside the canvas
- Mobile-first, logical-property layout that mirrors whole for Arabic RTL
- Sprite-only pixelarticons, always sized in px

## Colors

A plum-dark night palette carrying one rose text family and one hot-pink action colour, plus a three-note semantic set for the pending / approved / rejected spine of the product.

### Primary
- **Hot Pink** (`{colors.hot-pink}`): the one action colour. It fills the raised brush in the nav, the primary CTA gradient, selected size presets and selected auth tabs; it tints focus rings, the crop box, list-row unseen states and every "this is yours / this costs money" accent. As a *fill*, only one control per surface may wear it.
- **Pink Deep** (`{colors.pink-deep}`): the bottom stop of the pink gradient and the resting colour of the custom-colour swatch in the paint dock. Also the wall's default paint colour, which is the one deliberate overlap between chrome and content.
- **Ink on Pink** (`{colors.ink-on-pink}`): the near-black plum that sits *on* pink fills. Never a background of its own.

### Secondary
- **Rose** (`{colors.rose}`): the text-level accent — links, ghost-button labels, the countdown chip, small icon glyphs inside sheets. It is the colour of "this is interactive but quiet".
- **Rose Bright** (`{colors.rose-bright}`): the display-type colour. Every pixel-face heading, brand name, sheet title, stat value and selected nav label lands here rather than on pure white.

### Tertiary
- **Mint OK** (`{colors.mint-ok}`): approved, live, saved, free-space-on-the-wall.
- **Amber Warn** (`{colors.amber-warn}`): pending, waiting, out-of-paint, offline. This is the most-used semantic colour in the app because pre-moderation means most states are waiting states.
- **Coral Danger** (`{colors.coral-danger}`): rejected, invalid field, booked space. Never used for a destructive *button*; only for status and validation.

### Neutral
- **Night Plum** (`{colors.night-plum}`): the page ground and the canvas floor, lifted by a single `radial-gradient(120% 90% at 50% 0%, #241119 0%, …58%)` so the top of the wall glows faintly warm.
- **Plum Surface** (`{colors.plum-surface}`): sheet bodies. Sheets are opaque surfaces, not glass.
- **Plum Raised** (`{colors.plum-raised}`): the only raised solid — the brush button when paint mode is off.
- **Paper Pink** (`{colors.paper-pink}`): body text. An off-white with a pink cast; pure #FFF appears only on crop-handle strokes, thumbnail backing and the custom-swatch border.
- **Dim Mauve** (`{colors.dim-mauve}`): secondary text, unselected nav, captions, placeholders (at 55% alpha).
- **Glass / Glass Hard / Glass Border / Hairline / Hairline Strong**: the material set. `glass` is the resting fill of anything floating over the canvas; `glass-hard` is for content that must stay readable at any zoom (toasts, tooltips); the two hairlines separate rows inside opaque surfaces where glass would be wrong.

### The wall paint set (content, not chrome)
The sixteen paint swatches in the dock are a separate palette owned by `app.js` (`PALETTE`), tuned for painting on a shared canvas, not for UI: `#D81B60 #F06292 #AD1457 #7B2D4B #E23B2E #FF8C42 #FFD23F #22C55E #14B8A6 #59C2FF #2E6BE6 #8B5CF6 #2B1620 #6E5A62 #B9A6AD #ECE4E7`. A seventeenth swatch is a conic-gradient door to the native colour picker.

### Named Rules
**The One Loud Thing Rule.** Exactly one hot-pink *filled* control per surface. On the wall that is the raised brush; inside a sheet it is the single primary CTA. Everything else that wants attention gets rose text, a pink hairline, or a pink icon — never a second pink fill.

**The Two Palettes Rule.** Chrome colours and wall-paint colours are separate sets and do not borrow from each other. The only sanctioned crossing is `#D81B60`, which is both the deep stop of the chrome pink and the default paint colour.

**The Veil, Not Blackout Rule.** Sheet scrims are `rgba(10, 4, 8, 0.30)` with `blur(2px)`. The wall stays alive and visible behind every overlay — a modal never turns the artwork off.

## Typography

**Display Font:** Press Start 2P, weight 400 (self-hosted; `monospace` fallback)
**Body Font:** Figtree, weights 300–700 (self-hosted; `sans-serif` fallback)
**Arabic:** Cairo carries *both* roles — weight 800 for display, regular weights for body

**Character:** An arcade cabinet that learned to write prose. The pixel face is clipped, all-caps, letter-spaced and deliberately small; Figtree underneath is round, warm and normal-sized. The contrast reads as "the machine speaks in labels, the people speak in sentences".

The swap is a custom-property mechanism, not a font-stack hack: `--fp`, `--fb` and `--fp-w` are redefined on `html[lang="ar"]`, and every display moment in the sheet is written as `font-family: var(--fp); font-weight: var(--fp-w)`. Because Cairo needs more height than Press Start 2P at the same nominal size, Arabic label sizes step up individually (nav labels 6.5px → 10px, row labels 8.5px → 13px, stat labels 7px → 11px, tabs 8px → 13px).

### Hierarchy
- **Display** (400, 15px): the largest pixel-face moment in the app — pack amounts in the paint shop and the InstaPay total. Nothing in this system sets the pixel face larger than 15px.
- **Headline** (400, 13px, 0.02em): sheet titles (`.modal h2`), each preceded by an 18px pink icon and given 40px of inline-end padding to clear the close button.
- **Title** (400, 12px, 0.04em, line-height 1): the S37 lockup, success headings, status-card headings, the pack price at 11px.
- **Action** (400, 10px, 0.02em): the primary CTA label, the pixel selection counter, step numerals, the checkout total.
- **Label** (400, 8px, 0.06em): field labels, chip text, mini/file/ghost buttons, the coordinate readout, the standing brand door. Sub-steps at 7.5px (status chips, preview labels, crop tools) and 7px (history chips, stat captions) exist for chips that must stay inside a 20–26px pill.
- **Nav Label** (400, 6.5px, 0.06em): bottom-nav doors only. This is the floor of the system and exists because five labels plus a raised centre button must fit a 430px pill — do not reuse it anywhere else.
- **Body** (400, 15px/1.5): the document default.
- **Body Small** (400, 13.5px): the working size inside sheets — descriptions, list rows, toasts, checkout lines.
- **Caption** (400, 12px, on Dim Mauve): hints, fine print, timestamps, character counts.
- **Input** (400, 16px): all text inputs and the stepper field.

### Named Rules
**The Small Pixel Rule.** The pixel display face never grows. It runs 6.5px to 15px and is always a label, a heading or a numeral — never a sentence, never a paragraph. Prose is Figtree, and Figtree is the *larger* of the two faces on screen.

**The Never Hardcode a Family Rule.** Every display moment goes through `var(--fp)` + `var(--fp-w)` and every body moment through `var(--fb)`. Writing `font-family: 'Press Start 2P'` directly breaks Arabic silently, because Press Start 2P has no Arabic glyphs.

**The 16px Input Rule.** Text inputs are 16px, always. Anything smaller makes iOS Safari zoom the viewport on focus and the full-bleed canvas never recovers its framing.

## Layout

Mobile-first: the base stylesheet is a 390px phone held in one hand, and `min-width` queries grow the same surfaces outward. The wall is `position: fixed; inset: 0` and owns the entire viewport; `body` is `overflow: hidden` with `overscroll-behavior: none`, so the page itself never scrolls — only sheets do.

The floating stack, bottom to top: glass nav (z 22) at `10px + safe-area-bottom`, a 64px-tall pill capped at `min(430px, 100% - 20px)` on a `1fr 1fr auto 1fr 1fr` grid; the paint dock (z 21) floating at `84px + safe-area-bottom` as a two-row 18px-radius panel; the glass top (z 20) at `8px + safe-area-top` as a space-between row of lockup and chips; the standing brand door and coordinate chip pinned above the dock; toasts (z 60) and sheets (z 50) above everything.

Rhythm is an even scale: 4 / 6 / 8 / 12 / 16 / 20 / 26px. 8px is the default gap between siblings, 12–14px is the padding of a list row, 16px of a card, `26px 20px` of a sheet. Vertical gaps between sections inside sheets are 14–18px.

Responsive steps actually implemented:
- **560px** — the pre-order editor's source image and preview move side by side.
- **760px** — sheets stop being bottom sheets and become centered dialogs (full radius, both borders, no grab handle, heavier shadow); auth form goes two-column; paint packs go three-across and each pack becomes a stacked block; the minimap grows 84px → 148px; lockup and countdown type step up ~1px; the paint dock becomes a centered `min(680px, 100% - 20px)`.
- **900px** — the pre-order editor becomes a two-column workspace (`minmax(280px, 340px)` form beside the stage) with its own scrolling form column.
- **1100px** — sheet widths settle: 620px default, 1140px for the wide editor, 480px for the alerts / me / more sheets.
- **max-height 500px landscape** — the lockup drops its text, the dock turns into a single row at 74px, the nav shrinks to 56px with a 48px brush, the minimap drops to 64px, coordinates hide.

### Named Rules
**The Safe-Area Rule.** Every fixed edge offset is written as `calc(<n>px + var(--sat|--sab|--sal|--sar))`. The page renders under the notch on purpose (`viewport-fit=cover`); the insets are what keeps controls out from under it.

**The Logical Property Rule.** Shell layout uses logical properties only — `inset-inline`, `padding-inline`, `margin-inline`, `text-align: start`, `border-inline-end`. Setting `dir="rtl"` must mirror the whole shell with no extra CSS. The only physical offsets in the system are the eight crop handles, which are geometric positions on an image rather than layout.

**The Hidden Property Rule.** Every conditional element — sheets, error lines, badges, optional rows — toggles via the HTML `hidden` property, backed by `[hidden] { display: none !important }`. Do not invent `.is-open` / `.d-none` classes; the attribute is the state.

## Elevation & Depth

Depth comes from a single material rule plus coloured light. `.glass` is the whole vocabulary for anything floating over the canvas: `rgba(28,14,22,0.58)` fill, `backdrop-filter: blur(20px) saturate(160%)` (with `-webkit-` twin), a 1px `rgba(255,255,255,0.14)` border, and a two-part shadow that pairs a soft dark drop with an inset top highlight — the highlight is what makes the pill read as a lit edge rather than a rectangle of fog. A `@supports not (backdrop-filter)` block swaps the fill to a 94%-opaque plum so unsupported browsers get a solid pill instead of an unreadable one.

Inside sheets the logic inverts: sheets are opaque `plum-surface` panels, and depth between their children comes from tonal layering — `rgba(255,255,255,0.045)` rows, `rgba(255,255,255,0.05)` cards, `rgba(0,0,0,0.28)` input wells — with hairline borders, not shadows. Only two elements cast a *coloured* shadow, and both are the pink primary action.

### Shadow Vocabulary
- **Glass lift** (`box-shadow: 0 12px 32px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.09)`): every `.glass` pill and the zoom rail.
- **Brush lift** (`0 10px 26px rgba(255,61,138,0.5), inset 0 1px 0 rgba(255,255,255,0.55)`): the raised nav brush only.
- **Pink lift** (`0 8px 22px rgba(255,61,138,0.38), inset 0 1px 0 rgba(255,255,255,0.5)`): the primary CTA. Removed entirely when disabled.
- **Sheet lift** (`0 -18px 60px rgba(0,0,0,0.55)` rising from the bottom edge; `0 30px 90px rgba(0,0,0,0.6)` once it is a centered dialog at 760px).
- **Toast lift** (`0 14px 34px rgba(0,0,0,0.45)`) and **minimap lift** (`0 10px 26px rgba(0,0,0,0.45)`).
- **Focus ring** (`0 0 0 3px rgba(255,77,157,0.22)` on inputs; `0 0 0 3px rgba(255,77,157,0.45)` on the selected swatch): a pink halo, paired with a pink border-colour shift.
- **Crop scrim** (`0 0 0 999px rgba(10,4,8,0.38)`): a spread shadow used as a dimmer for everything outside the crop box.

### Named Rules
**The Glass-Over-Canvas Rule.** If it floats above the wall, it wears `.glass`. If it lives inside a sheet, it is a tonal surface with a hairline border. Never nest glass inside glass — the second blur has nothing left to blur.

**The Pink Glow Rule.** Coloured shadows belong to the primary action alone. Two elements carry a pink glow (the raised brush and the CTA); a third would flatten both.

## Shapes

Two silhouettes and one exception. **Pills** (`999px`) are for anything that floats or reads as a control: the lockup, chips, the nav bar itself, the brush, buttons, badges, tabs, toast actions, size presets, status chips. **Panels** use the radius scale — 10px for compact objects (tools, inputs, thumbnails, the minimap, tooltips), 18px for cards, rows, toasts and the paint dock, 26px for sheets (top corners only on a phone, all four once centered at 760px). The exception is the wall itself: the canvas is square-cornered and full-bleed, and pixel-art surfaces inside sheets (`#cpSrc`, `#cpCanvas`, the InstaPay QR) take a token 6px so the pixels stay pixels.

Borders are hairlines, always 1px, always a translucent white rather than a grey: `rgba(255,255,255,0.10)` for dividers inside opaque surfaces, `0.18` for the edges of interactive objects, `0.14` for glass. When a border carries meaning it takes the semantic hue at 0.35–0.6 alpha (pink for selected or "yours", amber for pending, mint for approved, coral for rejected) — a coloured border always accompanies coloured text, never replaces it. The one dashed border in the system is the InstaPay reference code, marking it as something to copy.

Icons are `crispEdges`-rendered pixelarticons drawn from an inline sprite via `<use>`, sized in px on `.ic`: 12px inside small chips, 16px default, 18–22px in rows and nav, 26px in the brush, 44px for celebratory states. Chevrons and directional glyphs flip with `transform: scaleX(-1)` under `[dir="rtl"]`.

### Named Rules
**The Pill-or-Panel Rule.** Floating controls are pills; grouped content is a panel at 10 / 18 / 26px. There is no third shape and no square corner outside the canvas.

**The Sprite-Only Rule.** Every icon is `<svg class="ic"><use href="#i-…"/></svg>` from the generated pixelarticons sprite. New icons are added to the mapping in `tools/make-icons.js` and regenerated — never hand-drawn into the markup, and never sized in `em`/`rem`.

## Components

The family character: **soft-cornered, hairline-lit, and honest about state.** Nothing is heavy; everything is either a pill of light over the wall or a faintly-lifted tone inside a sheet. Pressed states are physical (scale down, brighten the fill) rather than colour swaps.

### Buttons
- **Shape:** fully rounded pills (999px) for every button in the system.
- **Primary** (`.btn-claim`): a vertical pink gradient (`#FF67AC → #FF4D9D 55% → #F02D85`) under ink-on-pink pixel type at 10px, `13px 18px` padding, pink lift shadow with an inset white top highlight. As a sheet CTA it goes full width at `15px 18px`.
- **Hover / Active:** `translateY(-1px)` on hover, `translateY(1px) scale(0.99)` on press, both on `cubic-bezier(0.16, 1, 0.3, 1)` over 160ms.
- **Disabled:** `filter: saturate(0.25) brightness(0.7)`, shadow removed, cursor default. The button stays in place and stays pink-shaped — it desaturates rather than disappearing, because its label is the instruction ("TAP PIXELS TO PAINT").
- **Ghost** (`.btn-ghost`): full-width, 5% white fill, `hairline-strong` border, rose pixel type at 9px. The secondary action inside sheets.
- **Mini / File** (`.btn-mini`, `.btn-file`): 6% white fill, hairline-strong border, rose label at 8px, `9px 13px`. Inline actions beside text.
- **Quiet** (`.btn-clear`): no fill, hairline border, dim label at 9px; 35% opacity when disabled.
- All of them brighten to `rgba(255,255,255,0.10–0.12)` on press, and only on `@media (hover: hover)` do they respond to hover at all.

### Chips
- **Glass chips** (countdown, language, coordinates, the standing brand door): `.glass` pills with 7–10px vertical padding, rose or rose-bright content, and 18px icons. The brand door additionally takes a pink border (`rgba(255,77,157,0.45)`) and a pink icon, because it is the revenue path and is not allowed to hide inside MORE.
- **Status chips** (`.status-chip`, `.hs-chip`): 7–7.5px pixel labels at 0.05em in a 999px pill, 8% white fill, and a semantic pair — amber text + amber border for pending, mint for approved, coral for rejected, dim for neutral. Colour never travels alone; the label always says the state in words too.
- **Selection chips** (size presets): unselected is a hairline pill with dim 12.5px text; selected flips to a solid hot-pink fill with ink-on-pink at weight 700.

### Cards / Containers
- **Corner Style:** 18px for rows, cards, stats and the paint dock; 10px for compact objects.
- **Background:** `rgba(255,255,255,0.045)` for list rows, `0.05` for cards. Feature cards (the "me" identity card, the MORE hero) add a pink radial wash from one corner: `radial-gradient(140% 150% at 0% 0%, rgba(255,77,157,0.22), transparent 55%)`.
- **Shadow Strategy:** none. Cards inside sheets are tonal, not lifted — see Elevation & Depth.
- **Border:** 1px hairline; hairline-strong or pink at 0.4 alpha when the card is a call to action.
- **Internal Padding:** 14px rows, 16px cards, 12px stat blocks.

### Inputs / Fields
- **Style:** a dark well — `rgba(0,0,0,0.28)` fill, hairline-strong border, 10px radius, `12px 14px` padding, 16px text. Labels sit above at 8px pixel type in dim mauve with 0.06em tracking.
- **Focus:** border shifts to hot pink and a 3px `rgba(255,77,157,0.22)` halo blooms, both over 200ms. The default outline is suppressed on fields only; `:focus-visible` elsewhere draws a 2px pink outline at 2px offset.
- **Error:** the border turns coral and a coral 12.5px message slides in beneath (`err-in`, 250ms). Errors are separate elements toggled with `hidden`, never injected text.
- **Placeholder:** dim mauve at 55% alpha.
- **Range inputs and checkboxes** take `accent-color: var(--pink)` and a 28px track height for thumbs.

### Navigation
The five doors — WALL, ALERTS, [brush], ME, MORE — live in one 64px glass pill floating 10px above the safe-area bottom, capped at 430px wide. Unselected items are dim mauve with a 6.5px pixel label under a 22px icon; the selected item goes rose-bright and grows a 14px × 3px hot-pink underline from `::after` at the bottom of the pill. Badges are 16px hot-pink circles pinned to the icon's inline-end, animating in with a 300ms overshoot pop. Hover exists only on pointer devices and only shifts the label to rose.

### Signature Components

**The raised brush.** The centre nav slot is a 58px pink-gradient circle lifted 26px above the bar (`margin-top: -26px`) with a white 35% border and a pink glow. It is the single primary action of the whole app, so it is the only control allowed to break the nav pill's silhouette. When paint mode is off (`aria-pressed="false"`) it goes flat plum-raised with a dim icon and a plain dark shadow — the app's one solid raised surface — so the difference between armed and idle is unmistakable at a glance.

**The paint dock.** A two-row 18px glass panel floating above the nav: tools and the horizontally-scrolling swatch strip on top, counter / clear / claim on the bottom. The strip hides its scrollbar and fades at both ends with a 12px linear-gradient mask, so colours run off the edge instead of stopping at a hard border. Swatches are 32px squircles at 9px radius with a 2px translucent border; the selected one takes a white border, `scale(1.12)`, and a 3px pink halo. When the app enters placement mode the whole dock, the nav, the brand door and the top row fade to zero opacity over 250ms — the wall gets the stage alone.

**Sheets.** Every destination is a bottom sheet: 26px top corners, opaque plum surface with a white 5% gradient fading out over the first 120px, a 40px grab handle at the top, `max-height: 88dvh`, and a sticky footer that fades from transparent into the surface colour so a long form never ends in a hard cut. They rise 46px on a 380ms expo curve. At 760px the same element becomes a centered dialog and drops the handle. Scrollbars inside are re-skinned thin and translucent-white — the stock light rail is never allowed on a plum surface.

**Toasts.** Hard-glass pills (`glass-hard`, 18px blur) stacked below the top chrome at z 60, entering with a 340ms drop-and-scale, exiting by translating up 8px at zero opacity. Warning and error variants recolour the border only; the text stays paper-pink. An optional inline action button is an 8px pink pixel label inside a pink hairline pill.

**Motion grammar.** One curve does almost everything: `--expo: cubic-bezier(0.16, 1, 0.3, 1)`, used for sheet entry (380ms), toast entry (340ms), dock hide (340ms), badge pop (300ms), success pop (500ms) and every press transform (160ms). Linear easing appears only on fades (`fade-in` 220ms). Feedback for a refused action is a 500ms horizontal shake on the counter, not a colour change. Everything collapses to 0.01ms under `prefers-reduced-motion: reduce`.

## Do's and Don'ts

### Do:
- **Do** keep the canvas full-bleed and float new chrome over it as a `.glass` pill positioned with `position: fixed` plus a safe-area inset.
- **Do** give each surface exactly one hot-pink filled control (The One Loud Thing Rule); express every other emphasis as rose text, a pink icon, or a pink hairline.
- **Do** write display type as `font-family: var(--fp); font-weight: var(--fp-w)` and add an Arabic size bump (`html[lang="ar"] .thing { font-size: … }`) whenever the Latin size is under 9px.
- **Do** use logical properties for every offset, padding and alignment so `dir="rtl"` mirrors the shell for free.
- **Do** toggle every conditional element with the `hidden` property, and keep error messages as pre-existing hidden elements rather than injected nodes.
- **Do** pair every semantic colour with words — a pending row says "pending" and is amber; the colour is reinforcement, not the message.
- **Do** size icons in px on a `.ic` override (12 / 16 / 18–22 / 26 / 44) and pull them from the inline sprite with `<use>`.
- **Do** keep text inputs at 16px and touch targets at 38px or larger (44px for standalone controls).
- **Do** keep behaviour in `app.js` — the page ships no inline script and no inline handlers.

### Don't:
- **Don't** build a chrome sandwich: no opaque top bar plus scrolling content column plus opaque bottom bar. Nothing may reduce the canvas to a letterboxed window.
- **Don't** blur a `.glass` surface inside another `.glass` surface, and don't apply glass to content that lives inside a sheet — sheets are opaque and layer tonally.
- **Don't** add a second pink-filled control, or a second coloured shadow, to a surface that already has one.
- **Don't** set the pixel display face above 15px, or use it for a sentence. Prose is Figtree.
- **Don't** hardcode `'Press Start 2P'` or `'Figtree'` anywhere — Arabic swaps both through custom properties and a hardcoded family renders tofu.
- **Don't** use physical `left` / `right` / `margin-left` in shell layout; the RTL mirror depends on logical properties.
- **Don't** hand-draw SVG path data into the markup — extend the mapping in `tools/make-icons.js` and regenerate the sprite.
- **Don't** blacken the wall behind an overlay; the scrim stays at 30% with a 2px blur so the artwork keeps showing through.
- **Don't** reuse the 6.5px nav label size outside the bottom nav — 8px with 0.06em tracking is the floor everywhere else.
- **Don't** leave a scrollable surface on the stock scrollbar; re-skin it thin and translucent-white like `.modal`.
