# Human-only work

This file contains only work that requires a person's identity, money, legal authority, private
credentials, permission from another person, professional judgement, or physical hardware that the
agent cannot access. Engineering and verification work belongs in `TASKS.md`.

Do not put ordinary coding, research, browser work, CI work, screenshots, recordings, or automated
testing here merely because they are difficult. The agent owns those.

## Start now — procurement lead times

- [ ] **Apple Developer Program and Developer ID.** Enrol the person or company, pay the programme
  fee, complete Apple's identity checks, create a Developer ID Application certificate, export the
  password-protected `.p12`, and create an Apple app-specific password. Add these GitHub Actions
  secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID`. The agent will verify signing, notarization, installation and updates after the
  secrets exist.
- [ ] **Windows code signing.** Buy/activate Azure Trusted Signing or an OV certificate and complete
  the provider's identity or organisation vetting. Add `WIN_CSC_LINK` and
  `WIN_CSC_KEY_PASSWORD`, or provide the equivalent Azure signing access. The agent will verify the
  signed installer and update flow after access exists.

These two items have external lead times measured in days or weeks. Start them before the software
work finishes.

## Product and commercial decisions

- [ ] Choose annual and/or perpetual pricing, whether a free tier exists, and the trial duration.
  Provide values for `TOTAL_PRICE_ANNUAL_INR` and `TOTAL_PRICE_PERPETUAL_INR`.
- [ ] Choose the payment path: a hosted Razorpay/UPI payment link or the full in-page Razorpay
  checkout.
- [ ] Complete Razorpay KYC and create the selected live payment configuration. For full checkout,
  provide `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. A real payment,
  refund, or other financial transaction must be performed or explicitly approved by you at action
  time; the agent can prepare and inspect the flow.
- [ ] Decide the v1 AI position: ship the BYO-key/local-model assistant off by default, bundle a
  local model, or postpone AI to a later release.
- [ ] Decide whether Windows is a launch platform. If it is, signed Windows installation and
  physical-laptop validation remain release gates.
- [ ] Supply a public support phone/WhatsApp number if the site should advertise one.

## Accounts, credentials, and persistent access

- [ ] Obtain NIC/GSP sandbox credentials for e-invoice/e-way validation (#107). The agent will run
  the sandbox protocol checks once credentials are supplied through an approved secret channel.
- [ ] Download a current Challan Status Inquiry (`.csi`) file for a non-production TAN test identity
  authorized for TDS validation. Protean FVU 1.2 mandates the CSI and matches its TAN/name to the
  statement; obtaining it requires the TAN holder's authenticated identity. Do not commit or paste
  the file. Give the agent temporary approved access so it can run the generated Form 138/140
  fixture, after which the agent can remove the `.unverified.txt` suffix only on real pass evidence.
- [ ] Configure at least one real feedback sink. Create the needed account/token and add one of:
  `FEEDBACK_GITHUB_TOKEN`, Resend credentials (`RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO`), or
  `FORWARD_WEBHOOK_URL`. Creating credentials and granting persistent access requires you to
  approve or perform the credential step; the agent can verify delivery afterwards.
- [ ] Ensure Vercel has a read-only `GITHUB_TOKEN` for private-repository release metadata and give
  the agent access to inspect the deployed project when verification begins.
- [ ] Provide any private test identities or GSTINs needed for NIC/portal checks in a safe test
  environment. Do not place production credentials in the repository.
- [ ] Validate the checked-in ITC-04 v2.15 golden on a Windows machine with desktop Microsoft
  Excel, then import its generated JSON into an authorized signed-in GST test/portal account and
  return the utility validation result plus sanitized portal acknowledgement. Computer Use on
  macOS reproduced GSTN&rsquo;s own workbook failing with `Compile error in hidden module:
  MainModule`, so the VBA pass cannot be completed on this host. Do not provide a production GST
  password or OTP in chat; the agent will compare the returned evidence and enable export only if
  both the Windows utility and portal accept it.

## Real people and professional judgement

- [ ] Obtain one or two genuine customer testimonials and written permission to publish their
  names, firm names, and words (#307). The agent will format and add approved copy.
- [ ] Record or commission the real 90-second GSTR-1 walkthrough using
  `site/content/screencast-shot-list.md`, including the approved human voice/performance, and approve
  its public hosting destination. The agent will validate, encode, wire and publish the supplied
  recording; it will not fabricate a customer/operator performance.
- [ ] Recruit at least one shopkeeper, one accountant, and one CA for an uncoached usability and
  parallel-books trial. Obtain their consent and provide a sanitized or authorized Tally export.
  The agent will prepare the test script, capture findings, and implement verified fixes.
- [ ] Have a practising CA review the final GST/TDS outputs and compare one parallel month to the
  existing accounting system to the paise.
- [ ] Have fluent Hindi and Marathi accounting users complete
  `docs/native-language-review.md`, including KEEP/REPLACE/CONTEXT for every row and reviewer/date
  attribution. The agent will apply only their approved invoice-label and amount-in-words changes.
- [ ] Obtain legal/professional approval for final licence, privacy, refund, tax, and statutory
  representations before commercial publication.

## Physical hardware that must be provided

- [ ] Provide access to a real inexpensive Windows laptop at 1366x768 and 125% display scaling
  (#347). A VM or CI runner is not a substitute. The agent can drive it remotely if Computer Use is
  available; otherwise a person must follow the supplied checklist and return screenshots/results.
- [ ] Provide representative TSPL barcode-label, ESC/P dot-matrix, and 58/80 mm thermal printers,
  with the drivers used by target customers. The agent will generate test jobs and analyse output;
  a person must confirm the physical print.
- [ ] Provide a clean macOS machine and clean Windows machine for signed installer/update testing,
  or grant the agent remote Computer Use access to them.
- [ ] Perform or supervise the real WhatsApp PDF paste/send check. Sending a document to a real
  recipient requires an identified recipient and approval at action time.

## Final owner gates

- [ ] Approve the release price, public claims, testimonials, support contacts, and refund policy.
- [ ] Approve any real payment/refund test before the transaction is submitted.
- [ ] Approve publishing the final release and merging work when the agent presents current green
  evidence. The two large rewrite PRs are deliberately outside the current goal and will be handled
  in a later, separately authorized merge project.

## What to send back

As items become available, send only the non-secret decision or a statement that the secret has
been configured. Do not paste certificate passwords, API secrets, private keys, PANs, or production
GST credentials into chat or commit them to Git.
