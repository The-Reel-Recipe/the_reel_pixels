# S37 — Privacy Notice

**شخبط على الحيط**

Version [[VERSION]] · In force from [[EFFECTIVE DATE]]

Arabic version: [[ARABIC PRIVACY URL]]. **The Arabic version is the one that applies.**

---

## What this says, in short

S37 is a public wall of a million pixels. This page says exactly what we record, why, who else sees it, and how long we keep it.

1. **We record something the moment the page loads**, before you tap anything: an anonymous account, a cookie, and your IP address. Section 3 explains why.
2. **There is no analytics and no advertising tracking here.** No Google Analytics, no Meta pixel, no third-party script, no external fonts, no CDN. Everything is served from our own server, including the "Continue with Google" button — it is a plain link, not Google's code, so Google is not watching this page. This is verifiable: open your browser's network tab.
3. **Everything you paint is reviewed by a person over Telegram** before it goes public. Your artwork and your display name go to Telegram. Your contact details, bank details and payment screenshots do not. Section 6.
4. **The wall is wiped every month. Our records are not.** Section 7.
5. **Signing in is optional, and so is who it involves.** Painting needs no account. If you make one, you choose whether that goes through Google or through a code we email you — section 6.
6. **You have rights over your data and we honour them by hand**, because there is no self-service button yet. Section 9 says exactly what we can and cannot undo.

---

## 1. Who is responsible

S37 is run by **[[OPERATOR LEGAL NAME]]**, [[OPERATOR LEGAL FORM]], of [[OPERATOR ADDRESS]]. [[COMMERCIAL / TAX REGISTRATION NUMBER]]

Under Egypt's Personal Data Protection Law No. 151 of 2020 ("the PDPL") that person is the **controller** of your personal data.

- Data protection and requests about your data: **[[PRIVACY CONTACT EMAIL]]**
- Everything else: **[[CONTACT EMAIL]]**

S37 is run by one person. There is no support team; requests are read and answered by hand.

## 2. What this covers

The S37 website at [[SITE URL]] and the private admin panel used to run it. It does not cover your own bank or InstaPay app — when you pay you leave our site and pay inside your bank's app, and we never see your bank sign-in, card number, PIN or InstaPay password. It does not cover websites a brand links to from its pixels.

## 3. What we collect, and when

### 3.1 The moment you open the site — before you tap anything

As soon as your browser asks our server for the wall, three things happen.

**An anonymous account is created.** It holds an internal number, a public name of the form `Pixel fan #1234` calculated from that number, the time it was made and the time you were last seen. It is not calculated from your name, your email or your IP.

**A cookie called `uid` is set** on your device, holding your account number and a signature. Details in section 12.

**Your IP address is recorded**, specifically:

- in a daily counter table, with the date and how many new identities, submissions and brand applications came from it that day — this is what stops one person clearing cookies for unlimited free pixels;
- in a second table holding the free-pixel clock, so a fresh browser tab does not reset your allowance;
- permanently in our activity log at the moment your account is created (section 3.7), subject to the retention in section 7;
- in the server's memory for a few minutes, for rate limiting. That copy is never written to disk.

IPv6 addresses are shortened to their first four blocks before storing. IPv4 addresses are stored whole.

### 3.2 When you paint

- The exact pixels: their positions and colours, stored both as individual wall squares linked to your account and as one packed copy inside the record of your submission.
- How many pixels, whether they were free or paid paint, and the box they fit in.
- The times it was submitted and decided, the decision, and the reason if it was refused.
- Which moderator decided it.
- A picture of your batch as it would look on the wall, rendered by our server and saved as a file.

**Every wall square carries your account number.** Anyone who taps a pixel sees the display name of whoever painted it.

### 3.3 When you choose a display name

If you have an account with an email address, you can replace `Pixel fan #1234` with a name of your choice, 2 to 24 characters. Guests without an email cannot; brands publish under their approved business name and cannot rename.

**That name is public to everyone.** It is sent to every visitor's browser with the wall, not only to people who tap your pixels. Both the old and the new name are written into our activity log.

Please do not use your full real name unless you want strangers to have it.

### 3.4 When you make a painter account

- Your email address, used as your sign-in name and to reach you about money you have paid us.
- Your password, stored only as a scrambled value (scrypt) that cannot be turned back into your password.

### 3.5 When you apply as a brand

In one form: business name and category; a description of at least 200 characters; website and/or social links; a contact person's name; a phone number; a commercial registration or tax number (optional); an InstaPay handle; an email address and a password.

None of this goes on the wall. It is used to check the business is real and to handle bookings and refunds. Only the business name, the category and the website reach our moderator over Telegram; the rest stays in our own admin panel — section 6.

### 3.6 When you pay

Payment is an InstaPay bank transfer made inside your own bank app. We record:

- the order: what you bought, the amount in EGP, a reference code, and its status;
- **the InstaPay transaction reference** you type in;
- **the handle or number you paid from** — usually a phone number or a `name@instapay` handle;
- **a screenshot of the transfer, if you choose to attach one**;
- who confirmed or refunded it, and when.

**About the screenshot.** Before storing it we check the file really is an image and strip the hidden data files carry — location, camera details and similar. We do **not** change what the picture shows. A banking screenshot usually shows your full name, part of your account number, your balance and other recent transactions. **If you would rather not share that, do not attach a screenshot.** The transaction reference alone is enough; the screenshot only makes it faster.

### 3.7 The activity log

Every important action writes one line into a log: who did it, what it was, a small block of details, and the time. Lines containing personal data include: account created (**your IP address**); brand application (email, business name, category); sign-in (email); painter account created (email); display name changed (old and new name); payment reported (**the InstaPay reference and the handle you paid from**); refund sent (the handle it went to); painting, booking and ordering (pixel counts, brand names, links, amounts); admin actions (the account acted on and the operator's written reason); admin sign-in (the operator's IP address).

The log is append-only: nothing in the software edits a line. Lines are removed or redacted only by the retention sweeps and erasure described in sections 7 and 9.

### 3.8 Moderators and operators

People who moderate S37 are data subjects too. We store their Telegram numeric ID and username against every decision they make, and their IP address when they sign in to the admin panel.

### 3.9 What we do not collect

- **No analytics or advertising trackers of any kind.** No Google Analytics, Tag Manager, Meta pixel, Plausible, PostHog, Sentry or Hotjar.
- **No third-party scripts and no font CDN.** Our two typefaces are on our own server; your browser is never told to contact Google or anyone else.
- No location data, no device fingerprinting, no advertising ID, no contacts.
- No date of birth (see section 11), no gender, no national ID.
- **No logo file is ever uploaded.** When a brand picks a logo image the whole conversion into pixels happens inside your browser. Only the finished coloured squares reach our server; the image file never leaves your device.
- No card details and no bank credentials. There is no payment gateway here.

The only file you can ever upload to us is the payment screenshot in 3.6.

## 4. Why we process each thing, and on what basis

| What | Why | Basis |
|---|---|---|
| Anonymous account and `uid` cookie | So your pixels, history and paint balance stay yours across visits, with no sign-up | Necessary to provide the service you asked for — the wall cannot tell your pixels from anyone else's without it |
| IP address: daily caps, allowance clock, rate limits | To stop one person taking everyone's free pixels, and to keep the site standing | Necessary to provide the service on the terms it is offered — a free allowance only exists because it can be rationed |
| IP address kept in the activity log | To investigate abuse and answer a lawful demand | A legal obligation on service providers to retain data identifying users (section 7) |
| Pixels, colours, submission record | To draw the wall and let a person review it before it becomes public | Necessary to provide the service |
| Display name | To show who painted what | **Your consent** — you choose to set it, and the app tells you it is public before you do |
| Email and password | To let you sign in from another device, to allow paint purchases, and to reach you about money you paid us | Necessary to provide the service |
| Brand application details | To check a paying business is real and to reach you about a booking or refund | Necessary to prepare and perform a contract |
| Payment details and screenshot | To match your transfer to your order and settle a dispute later | Necessary to perform a contract, and a legal obligation to keep tax records |
| Moderator identity | So every decision on the wall is traceable to a person | Necessary to operate a moderated service, and to answer a legal demand |

**When we start recording.** The account, the cookie and the IP record in 3.1 are created on your very first request, before you can have agreed to anything, because the wall cannot work otherwise. **We show you a short notice about it, with a link to this page, before your first pixel.** We do not use any of it for advertising, for analytics, or to follow you anywhere else.

## 5. Where your data is stored

The site runs on **Railway**, a hosting company, on servers in the **Netherlands, in the European Union**. The database, the payment screenshots, the moderation preview images and the monthly wall archives all sit on a disk attached to that server. **Your data leaves Egypt the moment you use the site.**

Two more companies hold a little of it, and only because you chose a way of signing in that involves them:

- **Google**, in the **United States and wherever else Google operates**, if you sign in with a Google account. Google knows you signed in to this site. We hold the account identifier Google gives us and the address on it — see 6.2.
- **Brevo**, in the **European Union**, if you ask for a sign-in code by email. Brevo is given your address and the message, because that is what sending an email to you means — see 6.3.

Neither is used for anything else, and neither is involved at all if you paint as a guest.

## 6. Who else receives it

### 6.1 Telegram — the moderation channel

Every human review happens in a private Telegram group. Telegram is a messaging company outside Egypt.

What we send there is deliberately thin.

**For every batch of pixels:** a picture of your artwork as it would appear on the wall, your display name or brand name, the pixel count, how many of your batches were approved or refused before, and — if it was paid for — the order code and its status.

**For every brand application:** the business name, the category, and the website if you gave one. Then a link.

**For every payment:** the amount, the order code and its status. Then a link. Where a refund is owed, a reminder repeating the amount and the order code is sent every 24 hours until it is paid.

**What we do not send there:** phone numbers, email addresses, commercial registration numbers, InstaPay handles, transaction references, and payment screenshots. None of those reach Telegram. The moderator opens the link and signs in to our own admin panel with a password and a one-time code, and sees them there.

Once a message is in Telegram, Telegram stores it and everyone in that moderation group can see it. We can delete our own copy. **We cannot promise every copy inside Telegram is gone.** Telegram's own handling of that data is governed by Telegram's privacy policy, not ours.

### 6.2 Google — signing in

If you sign in with a Google account, your browser goes to Google, you approve it there, and Google sends us back a signed statement of who you are. **We never see your Google password**, and we ask Google for the least it will give: that you are signed in, your email address, and your name. Nothing else — not your contacts, not your files, not anything in your Google account.

What we keep from that is the account identifier Google gives us and your email address. The identifier is what recognises you next time; the address is what connects a Google sign-in to an account you already had here, so your pixels and your paint are still yours.

**Google knows you signed in to this site.** That is inherent to signing in with Google and we cannot prevent it. What Google does with that is governed by Google's privacy policy, not ours. If you would rather they did not know, do not use that button — painting needs no account at all.

### 6.3 Brevo — the emails that carry a sign-in code

If you ask for a code by email, we hand your address and the message to **Brevo**, an email company in the European Union, because that is what sending you an email means. They are given nothing else: no name, no pixels, no payment details.

We do not send marketing, we have no mailing list, and there is nothing to unsubscribe from. The only email this site sends is the one carrying a code you asked for.

### 6.2 Railway — hosting

Railway runs the server, holds the disk, terminates the encryption on your connection, and keeps its own record of requests, which normally includes IP addresses. Those records are Railway's, not ours; we cannot read or delete them.

### 6.3 InstaPay

We show you a link so you can pay. **We send no data to InstaPay** and the link carries no referrer. You pay inside your own bank app, and your bank tells us nothing except what you type back to us.

### 6.4 Offsite backup

[[BACKUP DESTINATION AND STATUS — see FILL-IN. This section must describe what actually runs on the day this is published, and must be updated **before** any new destination is switched on.]]

### 6.5 Nobody else

We do not sell your data. We do not share it for advertising. We run no advertising on the site. We would disclose data where an Egyptian court or a competent authority lawfully required it, and where the law allows, we would tell you.

## 7. How long we keep things

### 7.1 The monthly wipe — what it really does

On the 1st of every month the wall is cleared. Before it is cleared, our server **saves a picture of the whole wall as it looked**. That picture is kept permanently. **It is a flat image of one million colours: it contains no names, no account numbers and no identifiers of any kind.**

The wipe deletes **only the coloured squares that were on public display.** It does not delete the record of your submission — which contains **a copy of the exact pixels you painted** — the moderation preview image, your account, your email, your display name, brand application details, payment records, payment screenshots, or the activity log.

So "the wall is wiped clean every month" is true about **what you can see**, and not true about **what we store**. We would rather say that than let you assume otherwise.

### 7.2 Item by item

- **Your account, email, password hash and display name** — kept until you ask us to erase them, or until [[DORMANT ACCOUNT MONTHS]] months after your last visit if you never come back and have no payments with us.
- **Submission records, including the stored copy of your pixels, the bounding box, the decision and the reason** — kept for [[SUBMISSION RETENTION]], then deleted. **This is true whether the batch was approved, refused or expired.** A refusal deletes the squares from the wall immediately; the record of the submission is kept for that period so we can answer a complaint or a legal demand about it.
- **Moderation preview images** — deleted with the submission record.
- **Monthly wall archive pictures** — kept permanently, by design. They contain no personal data.
- **Payment records** — kept for [[TAX RECORD RETENTION]], because Egyptian tax and commercial law requires it. This is why we cannot delete a payment record when you ask us to erase your data.
- **Payment screenshots** — deleted [[SCREENSHOT RETENTION]] after the payment reaches a final state, whether that is confirmed, refunded, refused or expired. Until then they are what settles a dispute over whether money arrived.
- **IP addresses in the activity log** — kept for [[IP RETENTION]], then the address is removed from the log line while the rest of the line stays. We keep them for that period because Egyptian law requires service providers to retain data identifying users.
- **IP daily counters** — the row for an address and a day is deleted [[IP RETENTION]] after that day.
- **IP free-pixel clock** — emptied at every monthly wipe.
- **Rate-limiting memory** — dropped about ten minutes after your last request; never written to disk.
- **Backups** — [[BACKUP RETENTION — see FILL-IN]]. A backup contains everything above as it stood when it was taken.
- **Messages in Telegram** — outside our control (6.1).

## 8. How we protect it

- **Passwords** are stored with scrypt and a random salt. We never store the password itself and cannot recover it. Minimum 10 characters.
- **Sign-in cookies are signed**, marked `HttpOnly` so page scripts cannot read them, and sent only over an encrypted connection in production.
- **A session can be revoked** without waiting for the cookie to expire, by bumping a counter on the account.
- **The admin panel requires a password and a one-time code** from an authenticator app. Codes cannot be replayed. Attempts are limited to five per 15 minutes per address. Admin accounts cannot be created from the web. Admin sessions last 12 hours.
- **Payment screenshots are never served publicly.** They can only be fetched through an authenticated admin route, and the server refuses to serve any file from the data folder over the web.
- **Uploads are checked by their actual contents**, not by what they claim to be. Only PNG, JPEG and WebP are accepted, at most 5 MB, and hidden metadata is stripped.
- **Database queries use prepared statements**, which closes off SQL injection.
- **Strict browser security headers**, including a content security policy forbidding the page from loading any script, style, font or connection from anywhere but our own server.
- **Request size limits and rate limits** on every route.
- **The connection is encrypted (HTTPS)** and browsers are told to keep using it.

No system is completely safe. Section 13 says what we do if something goes wrong.

## 9. Your rights, and what happens when you use them

Under the PDPL you have the right to know what we hold, to get a copy, to have mistakes corrected, to have data erased, to object to a use, to limit a use, and to withdraw consent where consent is what we relied on.

**To use any of them, email [[PRIVACY CONTACT EMAIL]]** from the address on your account, or describe your pixels well enough for us to find them. We aim to reply within [[DSR REPLY DAYS]] days.

Here is the state of each right, honestly.

**See your data — partly self-service.** MY PIXELS already shows your batches, their status, the reason if one was refused, and a summary of your payments; the ME screen shows the email on your account. Neither shows the IP records, the activity log or your payment screenshots. Ask us and we put those together by hand.

**Get a copy in a portable file.** There is no download button. Ask us and we send you a file.

**Correct your data.** If you have an account with an email address you can change your display name in the app. Guests without an email and brand accounts cannot — brands publish under the approved business name. Everything else, including a wrong email or a wrong phone number on a brand application, is corrected by hand. Ask us.

**Erase your data.** There is no delete-account button. Signing out only removes the cookie from your device. When you ask us to erase you, a person does it, and this is what it does:

> We delete your email, your password, your display name and your brand application; we delete the records of your submissions including the stored copies of your pixels and the rendered preview images; we delete your pixels from the wall; we delete your payment screenshots; and we remove your details from the activity log.
>
> **The monthly archive pictures stay.** They are flat images of a million colours with no names, no accounts and no identifiers in them. Once your submission records are gone, nothing connects any square in those pictures to you.
>
> **Two things we cannot fully undo.** Messages already delivered to our moderators' Telegram group are stored by Telegram: we delete what we can and stop sending more, but we cannot guarantee every copy there is gone. And we keep the payment record itself for [[TAX RECORD RETENTION]] because tax and commercial law requires it — stripped of the reference, the handle and the screenshot.
>
> **We do not erase anything while a legal matter about it is open.** If a court, a prosecutor or an authority has required us to preserve material, or a complaint about it is live, we hold it until that is resolved and we tell you so.
>
> We tell you exactly what we deleted and what we kept, and why.

**Object, or limit a use.** Email us. Since almost everything here is needed to run the wall, objecting usually means asking us to erase your account and stop.

**Withdraw consent.** Where we relied on your consent — chiefly your public display name — you can withdraw it. Ask us and we reset your name to an anonymous `Pixel fan #NNNN`. Archive pictures are colours only, so there is nothing there to change.

**Complain.** If you are not satisfied you may complain to Egypt's Personal Data Protection Centre: [[DATA PROTECTION CENTRE CONTACT]].

## 10. Automated decisions

**Nothing is published without a person.** Every batch of pixels, every brand application and every payment confirmation is decided by a person. There is no profiling, no scoring, and no automated approval.

Some things are **removed or closed automatically, by a timer:**

- Work still waiting for a decision when its month ends is expired by our system.
- An order whose transfer never arrives is closed by our system when its deadline passes, and a brand booking waiting on it is cancelled with it — you see this as a refusal with the reason "payment never arrived".
- Our system records automatically that a refund has become due when a paid booking does not go up.
- A visitor is refused a new identity, and requests are refused, when the daily limits or the rate limits in section 3.1 are reached.

None of those look at who you are. Section 12 of the Terms says what comes back in each case. If you think a timer got it wrong, write to [[CONTACT EMAIL]] and a person will look.

The software has a setting that would make submissions approve themselves automatically. **It is switched off, and the service refuses to start in production with it on.**

## 11. Children

**There is no age check on this site.** Anyone who opens the page can paint without an account. We do not ask for a date of birth and we cannot tell a child from an adult. We ask for an age confirmation before an account can buy paint, but we cannot verify it.

We are telling you this plainly rather than writing a rule we do not enforce.

If you are a parent or guardian and your child has used S37, email **[[PRIVACY CONTACT EMAIL]]** and we will delete their account and their data. If they have paid us, we return the money — see section 5 of the Terms.

## 12. Cookies and things stored on your device

We use **two** cookies. Both are ours and both exist to keep you signed in. Neither is used for advertising, analytics, or following you across other sites.

**`uid` — your identity on the wall**

- Holds: your account number, an expiry date and a signature. No name, no email, no IP address.
- Lifetime: **[[GUEST COOKIE LIFETIME]]** for a guest, **[[BRAND COOKIE LIFETIME]]** for a brand account. Once past halfway, visiting the site quietly extends it.
- Flags: `HttpOnly` (page scripts cannot read it), `SameSite=Lax` (not sent from other sites), `Secure` over HTTPS.
- Set on your very first request, before you interact with anything, because the wall cannot draw your pixels without knowing they are yours. **We show you a notice about it before your first pixel.**
- Delete it and you get a new blank account; your old pixels and paint are no longer reachable from that browser.

**`adm` — operators only.** Set only after signing in to the private admin panel, never for a visitor. Lifetime 12 hours; `HttpOnly`, `SameSite=Strict`, `Secure`.

**Stored in your browser, never sent to us.** Three small values live in your browser's local storage and our server never receives them. They stay until you clear your browser data: `s37.help` (that you have closed the help screen once), `s37.recent` (the last 12 colours you used), `s37.lang` (English or Arabic).

Both cookies are strictly necessary to run the wall and neither tracks you, so we show you a notice rather than a consent pop-up.

## 13. If there is a data breach

If personal data here is exposed, lost or stolen we will find out what happened and stop it; write down what we found, when, and what data was involved; **notify Egypt's Personal Data Protection Centre within [[BREACH DEADLINE]] of becoming aware of it**; and, where the breach puts you at risk — for example if payment screenshots were exposed — **tell affected users without delay, in the app and by email where we hold one for you**. We will say what happened, what data was involved, what we have done and what you should do.

## 14. Changes to this notice

If we change how we handle your data we update this page and the version and date at the top. For anything significant — a new company receiving your data, a new use of what we hold, switching on an offsite backup — we show a notice in the app **before** the change takes effect.

## 15. Contact

- Data protection and requests about your data: **[[PRIVACY CONTACT EMAIL]]**
- Everything else: **[[CONTACT EMAIL]]**
- Postal address: **[[OPERATOR ADDRESS]]**
- Egypt's Personal Data Protection Centre: **[[DATA PROTECTION CENTRE CONTACT]]**

This notice describes how S37 handles personal data. Nothing in it limits any right you have under Egyptian law.
