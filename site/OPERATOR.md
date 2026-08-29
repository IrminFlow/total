# What the operator has to supply

Everything in this site works with no configuration except the parts that cannot: taking money,
signing licence keys, sending mail, sending WhatsApp messages, and recording what arrives. Those
need credentials that do not belong in a repository, and none of them are invented here.

Every one of them fails visibly rather than quietly. A checkout with no key says payment is not
switched on and gives an email address. A feedback endpoint with no sink returns 503 with a
message the app can show. Nothing accepts a message and drops it.

## Already set, from before this work

| Variable | Used for |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT, read access to releases. Serves `/api/download`, `/api/latest`, the changelog, and the checksums on `/download`. |
| `GITHUB_REPO` | Overrides `IrminFlow/total`. |
| `NEXT_PUBLIC_SITE_URL` | Canonical URL for OG cards, the sitemap and robots.txt. Defaults to `https://devjindal.tech`. |

If the token cannot read release assets, the checksum table on `/download` shows an honest empty
state rather than a wrong hash.

## The price

**The number is not in the code.** `lib/product.ts` reads it from the environment, so a price is
never invented by whoever last edited a page, and a stale one cannot survive in a second file.

| Variable | Notes |
|---|---|
| `TOTAL_PRICE_ANNUAL_INR` | Whole rupees for the yearly plan, e.g. `4999`. A rupee sign, commas and spaces are tolerated. |
| `TOTAL_PRICE_PERPETUAL_INR` | Whole rupees for the perpetual plan, e.g. `14999`. |
| `TOTAL_PAYMENT_LINK` | Optional. A Razorpay Payment Page or UPI link, for selling before the full checkout keys exist. |

Server-side only, by design: there is no `NEXT_PUBLIC_` prefix, because the price is rendered
into HTML by server components and a price a browser can rewrite is not a price. Anything that is
not a positive whole number of rupees — unset, `0`, `TBD`, a typo — reads as **not yet
announced**, and every page that shows a price handles that state:

- `/pricing` prints "Not yet announced" in the sans face where the figure goes, explains in plain
  words that the number is being set, and offers the trial and an email address instead of a
  Buy button.
- `/buy` replaces the checkout form with the same explanation. Nobody can submit an order.
- `/api/checkout/order` returns 503 for an unpriced plan, so no order for zero rupees can exist
  even if somebody posts to it directly.
- `/compare` drops its "starting at" clause rather than printing "starting at ₹0 a year".

With `TOTAL_PAYMENT_LINK` set but no Razorpay keys, `/buy` shows the plans and a button to the
hosted payment page, and says keys are issued by hand. That is a complete way to take money on
day one; the full checkout is the upgrade, not the prerequisite.

`/pricing` and `/buy` are dynamic, but Vercel bakes environment variables at build, so **a price
change needs a redeploy** to reach `/compare`, which is static.

## Payments (Razorpay)

| Variable | Notes |
|---|---|
| `RAZORPAY_KEY_ID` | From the Razorpay dashboard. The publishable half; it reaches the browser. |
| `RAZORPAY_KEY_SECRET` | Server only. Signs orders and verifies the checkout callback. |
| `RAZORPAY_WEBHOOK_SECRET` | Server only. Set a webhook on the `payment.captured` event pointing at `/api/checkout/webhook`. |

Until `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are both present, `/buy` shows a panel with a
mail-to link instead of a payment button, and `/api/checkout/order` returns 503.

Do this before switching it on:

1. Complete Razorpay KYC. UPI is not available on a test-mode account, and UPI is the reason for
   choosing Razorpay.
2. Run one live payment of one rupee through `/buy` and refund it. The signature check on
   `/api/checkout/verify` has never seen a real Razorpay signature, only the documented recipe
   for one, and this is the cheapest way to find out that it works.
3. Register the webhook and confirm one event lands. Then close the browser tab mid-payment on a
   second test to confirm the webhook still records the order when the callback never fires.

Cashfree was the alternative and would work the same way. Razorpay was chosen because it settles
UPI and its order and signature API is two calls. Nothing in the flow is coupled to it beyond
`lib/payments.ts`.

## Licence keys

| Variable | Notes |
|---|---|
| `LICENCE_PRIVATE_KEY_PEM` | Optional. The PKCS8 PEM from `node scripts/make-license.mjs --keygen`. Newlines may be written as `\n`. |

**Deliberately optional, and off by default.** With it set, a paid order is signed and delivered
within the second. Without it, the payment is recorded, the buyer is told the key comes by hand,
and you mint it with `scripts/make-license.mjs` on your own machine.

Putting the private half of the signing key on a web host is a real decision with a real
downside: anyone who reaches that environment can mint licences for the product forever, and
rotating the key means every existing licence stops verifying. Signing by hand for the first
few dozen sales costs a few minutes each and tells you more about your buyers than a webhook
does. Turn it on when the volume makes it worth it.

The public half is a separate matter and belongs in the app build as `TOTAL_LICENSE_PUBKEY`.

## Email

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Resend. Any provider with a REST endpoint would do; swapping it is one function in `lib/store.ts` and one in `lib/licence.ts`. |
| `MAIL_FROM` | A verified sender on your own domain. |
| `MAIL_TO` | Comma-separated. Where feedback and trial reminders are forwarded. |

Verify the sending domain with SPF and DKIM before the first licence goes out. A licence key
landing in spam is a support ticket and a refund request.

## WhatsApp

| Variable | Notes |
|---|---|
| `WHATSAPP_TOKEN` | Meta Cloud API access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | The number registered in WhatsApp Manager. |
| `WHATSAPP_TEMPLATE_NAME` | An approved template with two body variables: buyer name, then the key. |
| `WHATSAPP_TEMPLATE_LOCALE` | Defaults to `en`. |

A message we start rather than reply to has to be an approved template, so this cannot work
until Meta approves one. Suggested body, which keeps the key on its own line:

> Hello {{1}}, here is your Total licence key. Open Total, go to Settings, then Licence, and
> paste it in. {{2}}

Without a template name the licence still goes by email and the WhatsApp step is skipped. The
buyer is never told a message was sent when it was not.

## Where feedback and reminders go

`/api/feedback` and `/api/reminder` store durably and forward. At least one of these must be
configured or both routes return 503.

| Variable | Notes |
|---|---|
| `FEEDBACK_GITHUB_TOKEN` | A PAT with issues write. Falls back to `GITHUB_TOKEN`, which is read-only for releases, so set this one separately. |
| `FEEDBACK_REPO` | Defaults to `GITHUB_REPO`. Point it at a separate private repo if you would rather not mix support with source. |
| `FORWARD_WEBHOOK_URL` | Optional. Anything that accepts `{"text": "..."}`, including a Slack incoming webhook. |

Storing support messages as issues in a private repo means they are searchable, they have a
history, and they cost nothing. It also means anyone with read access to that repo can read
what users sent, which may include a fragment of their error log. That is why `FEEDBACK_REPO`
exists.

## The recording

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_DEMO_VIDEO_URL` | Points `/demo` at a real file. |
| `NEXT_PUBLIC_DEMO_VIDEO_POSTER` | Optional still frame. |

The script is in `content/screencast-shot-list.md`: nine shots, ninety seconds, all of them
real screens of the real app. Until the file exists, `/demo` shows a still and says the
recording has not been made.

## Things left empty on purpose

**`lib/testimonials.ts` is an empty array.** Do not put a quote in it that a named person did
not write and give permission to publish. On a site selling accounting software to businesses, an
invented testimonial from a named firm is a false statement of fact, and it takes one phone call
to check. While it is empty the homepage says so in as many words and offers four things a
stranger can check instead — the screenshots, the public roadmap, the page listing what Tally
does better, and the trial. Add a real entry and that section becomes the quotes.

**`lib/coupons.ts` is an empty array.** Add a code when a partner signs up, and delete the line
to retire it. `/r/CODE` sets a first-party cookie and `/buy` reads it; that is the entire
tracking apparatus and there is no analytics script on this site.

**There is no WhatsApp number.** `NEXT_PUBLIC_WHATSAPP_NUMBER` is unset, so every page falls
back to email and the contact page says plainly that there is no number yet rather than showing
an invented one. Set it to international digits with no plus and no spaces (`919876543210`) and
it appears on the contact, CA, partner and buy pages. A visible number is a conversion feature in
this market, not a support cost.

## Things to keep current by hand

| File | What goes stale |
|---|---|
| `lib/roadmap.ts` | `ROADMAP_REVIEWED`, and the groups. Nothing goes under "Being built" that is not being built. |
| `app/compare/page.tsx` | `REVIEWED`, and the rows, against the current TallyPrime. |
| `lib/pricing.ts` | `RATES_REVIEWED` and the exchange rates. They are indicative and labelled as such, and they should still not be a year old. |
| `lib/product.ts` | The plan names and the three lines under each. The prices themselves are environment variables and are not in this file. |
