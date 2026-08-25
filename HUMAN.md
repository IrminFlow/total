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
An expired licence never locks the books — it degrades to read-only-plus-export, forever. What
does not exist is a number and a payment link.

**Decisions only you can make**

- The price. One perpetual price with a year of updates, or an annual subscription.
- Whether there is a free tier, and what it withholds.
- The trial length (30 days is currently assumed everywhere in the copy).

**Then** create a Razorpay or Stripe account, add a payment link or checkout, and tell me the
URL — I will wire `/buy` and the in-app licence screen to it. Razorpay is the sensible default
here: UPI is how this market pays.

---

## 4. Three things on the site that need a real person

These are marked ✗ on the roadmap rather than done, because inventing them would be a false
statement about a named business and I will not write one.

- **Testimonials (#307).** The component and the data file exist and render nothing while empty.
  I need one or two real customers' words with their written permission, and their firm's name.
- **A 90-second GSTR-1 recording (#308).** `/demo` has the slot and shows an honest placeholder
  until `NEXT_PUBLIC_DEMO_VIDEO_URL` is set. The nine-shot script is written out in
  `site/content/screencast-shot-list.md` — it is a screen recording, not a production.
- **A support phone number.** A visible WhatsApp number is a conversion feature in this market,
  not a support cost. Say the number and I will put it on the site and in the app.

---

## 5. Set up the feedback endpoint's sinks

The in-app Support form now posts to the site's `/api/feedback`. That route deliberately answers
with an error rather than swallowing a message when it has nowhere to put it — a support form
that silently discards a bug report is worse than no support form.

Add to the Vercel project (Settings → Environment Variables):

- `GITHUB_TOKEN` — a fine-grained PAT with **Issues: write** on `IrminFlow/total`, so each
  message is filed as an issue. (You already need this token read-only for the download button;
  widen its permission or add a second one.)
- `RESEND_API_KEY` and `FEEDBACK_EMAIL` — optional, so a message also reaches your inbox the
  same minute.

---

## 6. Test it on a cheap Windows laptop (#347)

Not a VM. A real ₹40,000 machine at 1366×768 with 125% display scaling, which is what a large
part of this market actually runs. Half an hour of clicking is enough. What I want to know:

- Do the modals fit, or do their buttons fall below the fold?
- Is the sidebar readable at 125%, or is it cut off?
- Does the ledger table need horizontal scrolling on the screens you use most?

I can test everything else in CI. I cannot test this.

---

## 7. Validate NIC e-invoicing on the sandbox (#349, #107)

`src/main/services/nic.ts` is built to the published NIC API spec — RSA plus AES-ECB session
crypto, the lot — and **has never run against the real portal**, because there are no
credentials. Everywhere it is mentioned in the app and on the site it says so.

To promote it from experimental you need NIC sandbox credentials, which come through a GSP or
directly if your GSTIN is eligible. Get them, give them to me, and I will run one invoice
through end to end. Until then, keep leading with the offline JSON export, which works.

---

## 8. One decision I need from you soon

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
