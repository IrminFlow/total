# Things only you can do

Everything in this file is blocked on a human: an account, a payment, a signature, a real
person's permission, or a physical machine. None of it is blocked on code — where code was
needed it is already written and waiting for a value.

Ordered by how long the wait is, not by how much it matters. The first two gate the launch date
and have procurement times measured in weeks, so start them today even if you do nothing else on
this list.

---

## 1. Apple Developer Program — start today

**Why it blocks everything:** until this is done, macOS shows every person who downloads Total
*"Total.app cannot be opened because Apple cannot check it for malicious software."* That is the
first thing a buyer sees after clicking your ad. There is no way around it and no way to explain
it away in the download page copy.

**What to do**

1. Enrol at <https://developer.apple.com/programs/enroll/> — $99/year. An individual enrolment is
   fine; a company enrolment needs a D-U-N-S number and takes longer.
2. Approval usually takes 24–48 hours.
3. Once approved, create a **Developer ID Application** certificate and export it as a `.p12`
   file with a password.
4. Create an **app-specific password** at <https://appleid.apple.com> → Sign-In and Security →
   App-Specific Passwords. This is not your Apple ID password.
5. Add five secrets at <https://github.com/IrminFlow/total/settings/secrets/actions>:

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | the `.p12` file, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
   | `CSC_KEY_PASSWORD` | the password you set when exporting the `.p12` |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 4 |
   | `APPLE_TEAM_ID` | the 10-character Team ID on your developer account page |

**Then nothing else.** The release workflow, the hardened runtime and the entitlements file
already read all five names. Every build today logs a `::warning::` saying it is unsigned; the
next tag after the secrets exist is signed and notarized with no code change.

---

## 2. Windows code signing — start today, it is the slow one

**Why it blocks:** unsigned Windows installers get a full-screen SmartScreen block on the
platform most of this market runs. It is worse than the macOS message because it takes two
clicks to get past and looks like a virus warning.

**What to do** — pick one:

- **Azure Trusted Signing** (~$10/month, the modern option). Needs an Azure subscription and an
  identity validation. Fastest if you already have Azure.
- **An OV code-signing certificate** from Sectigo, DigiCert or SSL.com (~$200–400/year).
  Organisation vetting takes **one to three weeks** — they verify your business exists, usually
  by phone against a public directory listing.

Either way you end up with a certificate file and a password. Add two secrets:
`WIN_CSC_LINK` (base64 of the file) and `WIN_CSC_KEY_PASSWORD`.

> If you are not selling to Windows users at launch, say so and I will cut the Windows build from
> the release workflow rather than shipping an installer that frightens people.

---

## 3. Decide the price, and how people pay

The licence machinery is built: Ed25519-signed keys, verified offline, no server, no phone-home.
An expired licence never locks the books — it degrades to read-only-plus-export, forever, and the
pricing page now says that in the largest type on the page. What does not exist is a number.

**Decisions only you can make**

- The price. One perpetual price with a year of updates, an annual subscription, or both — the
  site is built for both and shows whichever you fill in.
- Whether there is a free tier, and what it withholds.
- The trial length (30 days is currently assumed everywhere in the copy).

**Then set two environment variables and the site starts quoting it.** The price is no longer
written in the code: every page reads it from the environment, so there is nothing to edit and
nothing that can go stale in a second file. In Vercel → your project → Settings → Environment
Variables, for Production and Preview:

| Variable | Value |
|---|---|
| `TOTAL_PRICE_ANNUAL_INR` | Whole rupees for the yearly plan, e.g. `4999`. `₹4,999` also works. |
| `TOTAL_PRICE_PERPETUAL_INR` | Whole rupees for the perpetual plan, e.g. `14999`. |
| `TOTAL_PAYMENT_LINK` | Optional, see below. A Razorpay Payment Page or UPI link. |

Redeploy after setting them — Vercel bakes environment variables at build.

**Until you do, nothing is broken and nothing lies.** `/pricing` prints "Not yet announced" where
the figure goes and explains that the number is being set; `/buy` says the same instead of showing
a checkout; and `/api/checkout/order` refuses an unpriced plan, so no order for zero rupees can be
created even by posting to it directly. There is no placeholder price anywhere to forget about.

**How people pay.** Razorpay, not Stripe: UPI is how this market pays for something priced at a
few thousand rupees, and Stripe does not settle it. There are two ways in, and the cheap one is
enough to start:

1. **A payment link, today.** Create a Razorpay Payment Page (or any UPI link), put it in
   `TOTAL_PAYMENT_LINK`, and `/buy` shows the plans and a button to it. You mint each key by hand
   with `scripts/make-license.mjs` and email it. This works with no other credentials at all.
2. **The full checkout, when volume justifies it.** Add `RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` and `/buy` becomes a real in-page checkout
   that verifies the signature and records the order. `site/OPERATOR.md` has the full list and the
   three things to test with one live rupee before switching it on.

Razorpay KYC has to be complete before either: UPI is not available on a test-mode account.

---

## 4. Three things on the site that need a real person

These are marked ✗ on the roadmap rather than done, because inventing them would be a false
statement about a named business and I will not write one.

- **Testimonials (#307).** I need one or two real customers' words with their written
  permission, and their firm's name. While `site/lib/testimonials.ts` is empty the homepage now
  says so in as many words and offers four things a stranger can check instead — the screenshots
  are of the real app, the roadmap is public, the page listing what Tally does better is public,
  and the trial needs no card. Add one real entry and that section becomes the quotes.
- **A 90-second GSTR-1 recording (#308).** `/demo` has the slot and shows an honest placeholder
  until `NEXT_PUBLIC_DEMO_VIDEO_URL` is set. The nine-shot script is written out in
  `site/content/screencast-shot-list.md` — it is a screen recording, not a production.
- **A support phone number.** A visible WhatsApp number is a conversion feature in this market,
  not a support cost. Set `NEXT_PUBLIC_WHATSAPP_NUMBER` in Vercel to the number in international
  digits with no plus and no spaces (`919876543210`) and it appears on the contact, CA, partner
  and buy pages. Until it is set, those pages fall back to email and the contact page says plainly
  that there is no number yet, rather than showing an invented one.

---

## 5. Set up the feedback endpoint's sinks

The in-app Support form and the site's own contact form both post to `/api/feedback`, so there is
one inbox rather than two. That route deliberately answers with an error rather than swallowing a
message when it has nowhere to put it — a support form that silently discards a bug report is
worse than no support form. **Until you set one of the variables below, every message sent from
the contact page fails**; the form tells the sender so and hands back what they typed as a
pre-filled email, but nobody should have to do that twice.

Add to the Vercel project (Settings → Environment Variables):

- `FEEDBACK_GITHUB_TOKEN` — a fine-grained PAT with **Issues: write** on `IrminFlow/total`, so
  each message is filed as an issue. It falls back to `GITHUB_TOKEN`, which is read-only for
  releases, so set this one separately rather than widening that one.
- `FEEDBACK_REPO` — optional. A separate private repo, if you would rather not mix support
  messages with source.
- `RESEND_API_KEY`, `MAIL_FROM` and `MAIL_TO` — optional, so a message also reaches your inbox the
  same minute.
- `FORWARD_WEBHOOK_URL` — optional. Anything accepting `{"text": "..."}`, including Slack.

`site/OPERATOR.md` is the complete list of every variable this site reads, with what breaks
visibly when each one is missing.

---

## 6. Electron is seven majors behind, and the reason is written down

Not urgent, and not yours to do — but you should know it exists, because it is the
one piece of technical debt with a security dimension. Electron 37 → 44 is seven majors
of Chromium, which is seven majors of browser security fixes the app is not getting.

An upgrade was attempted and **deliberately reverted**. Both API breaks were found and fixed,
and every unit, database and renderer test passed on Electron 44. What stopped it is a
three-line reproducer: navigate to a screen, away, and back, and the second synthesised click
never returns — the whole debug connection wedges. It passes on 37 and hangs identically on 43
and 44, so it bisects into Electron 38–43, and it is the test harness rather than the app.

It was reverted rather than shipped because the E2E suite is the only thing covering the
keychain, the clipboard, PDF printing and the app's launch path — all of which that upgrade
touches. Shipping the bump without that net is how a signed release turns out to be broken on
somebody else's machine.

The full diagnosis is in the merge commit for `zod 4 and openai 7`. Whoever picks it up starts
from a reproducer rather than from scratch.

---

## 7. Test it on a cheap Windows laptop (#347)

Not a VM. A real ₹40,000 machine at 1366×768 with 125% display scaling, which is what a large
part of this market actually runs. Half an hour of clicking is enough. What I want to know:

- Do the modals fit, or do their buttons fall below the fold?
- Is the sidebar readable at 125%, or is it cut off?
- Does the ledger table need horizontal scrolling on the screens you use most?

I can test everything else in CI. I cannot test this.

---

## 8. Validate NIC e-invoicing on the sandbox (#349, #107)

`src/main/services/nic.ts` is built to the published NIC API spec — RSA plus AES-ECB session
crypto, the lot — and **has never run against the real portal**, because there are no
credentials. Everywhere it is mentioned in the app and on the site it says so.

To promote it from experimental you need NIC sandbox credentials, which come through a GSP or
directly if your GSTIN is eligible. Get them, give them to me, and I will run one invoice
through end to end. Until then, keep leading with the offline JSON export, which works.

---

## 9. One decision I need from you soon

The app currently talks to a **local Ollama or an OpenAI-compatible endpoint using your own API
key**. There is no hosted service and no account. That is the right design and I do not want to
change it, but it means the assistant is off and empty for anyone who has not set up a model.

Tell me which you want:

- **Ship it as is** — the assistant is a power-user feature, documented, off by default.
- **Bundle a small local model** — adds ~2GB to the download and makes it work out of the box.
- **Cut it from v5** and ship the AI in 5.1, so the launch is about the books.

---

## Nothing else on the roadmap is waiting for you

113 items are open and every one of them is mine to write. This list is the whole of what a
human has to do, and items 1 and 2 are the only ones with a clock running.
