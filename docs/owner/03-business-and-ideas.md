# Total — the business, the product and the ideas

15 October 2026 · For the owner (IrminFlow, irminlabs@gmail.com) · Site: https://devjindal.tech

This is a plain-language guide to Total as a business: what it is, who it is for, who else sells something similar, how it could make money, how to get it in front of people, what could go wrong, and what to build next. It ends with the decisions only you can take, and with a short list of things to count once people are using it.

It was written from the project's own documents (the feature list, the roadmap, the "simple for everyone" plan, the open to-do list, the beginner study, the website) and two earlier outside reviews: one by another AI model that read the code (the "GPT review") and one by a tester who used the app as a first-time shopkeeper (the "UX audit"). Prices of other products are from general knowledge and are marked **(check)** wherever they should be confirmed before you quote them anywhere.

---

## 1. The product in one page

**Total is accounting software for small Indian businesses that runs on your own computer.** It keeps proper books, the same kind of books Tally keeps, but it also lets someone who knows nothing about accounting use it.

**The promise:** *Tally-grade books anyone can keep, offline, on your own computer.*

- **Tally-grade** means real double-entry books: every rupee goes in on one side and out on another, and the trial balance, profit and loss, balance sheet and GST returns are all worked out from the entries themselves. Nothing is typed in twice, so reports built on the same calculation agree with each other. A few small known exceptions are in the to-do list.
- **Anyone can keep** means a kirana owner who has never heard the word "ledger" can make a bill, record money coming in, and see who owes them, in plain words, in English, Hindi or Hinglish.
- **Offline, on your own computer** means each business is one file in the Documents folder (`Documents/total`). There is no sign-up, no cloud copy and no monthly server. The internet is used only for the optional AI helper and optional live e-invoice filing, which the user turns on, and for the update check, which is on by default and can be turned off. Nothing downloads or installs without a click.

### The core idea: two modes over the same books

| | Simple mode | Accountant view |
|---|---|---|
| Who it is for | Owners, shop staff, freelancers, beginners | Accountants, CAs, experienced Tally users |
| What it looks like | Nine short sections: Home, Sell, Buy, Money, Stock, People, Reports, Taxes, Settings | The full app: vouchers, ledgers, every report, Tally-style keys (F4–F9) |
| Words used | "Make a bill", "Money in", "Who owes me", "GST to pay" | Voucher, ledger, journal, Dr/Cr, GSTR-3B tables |
| Help | "Why?" under every figure, Undo for 24 hours, Ask Total, a help panel, a first-run tour | Audit trail, full controls, TDS/TCS, payroll, consolidation, report builder |

Both modes write to **the same books**. A shopkeeper records sales in simple mode; their CA opens the same file in the accountant view and sees proper vouchers, ready for the year-end. Every simple screen has an "Accountant view" button, and every full screen has "Back to simple". This is the heart of the product: **the owner and the accountant no longer need two different programs.**

What is already in the box (both modes together): bills and invoices with PDF printing, purchases, money in and out, bank statement import and matching, stock and simple manufacturing, customers and suppliers with reminders, GST workings (GSTR-1, GSTR-3B, GSTR-9, GSTR-2B check), e-invoice and e-way bill files, TDS and TCS, payroll with PF/ESI/PT, multi-currency, budgets, loans, Tally import, Excel import/export, backups (with an optional passphrase lock), users and roles, an audit trail of every change, and an optional AI helper that uses the user's own key.

Today the version on GitHub is 0.12.0 (22 October 2026): the simple screens for selling, buying, money, bank, stock, people, reports, taxes, Ask Total and Hindi are all in that release.

---

## 2. Who the customers are

There are roughly seven kinds of customer. The setup wizard already has a preset for the first five.

| Segment | Example | Main pains | Mode they use |
|---|---|---|---|
| **Kirana / retail shop** | A grocery or medical shop with one counter | Fast cash/UPI billing, knowing what is in stock, udhaar (credit) customers who pay late, no time to learn software | Simple |
| **Trader / wholesaler** | A distributor selling on credit to shops | Who owes how much and since when, supplier bills, GST credit, stock across purchases, bills of the same number twice | Simple, with a CA in the accountant view |
| **Service business / freelancer** | Designer, tutor, consultant, repair service | Invoices for work (not products), expenses, clients who deduct TDS, "am I making money?" | Simple |
| **Restaurant / food** | A dhaba or small café, often composition GST | Daily UPI settlements, gas and supplies bought for cash, simple stock | Simple |
| **Small manufacturer** | A namkeen maker or small workshop | What was made and from what, raw-material bills with GST, labour, the real cost of a product | Simple for daily work, accountant for costing |
| **CAs and accountants serving them** | A CA firm with 20–200 small clients | Clients send messy records; data arrives late; Tally licences are costly; checking GST every month | Accountant view, opening clients' files |
| **Tally users who want to leave** | A business on an old Tally, or one that moved to a Mac | Tally does not run natively on a Mac; renewal fees; proprietary data; old-fashioned screens | Accountant view first, simple mode for staff |

A few points that matter for the business:

- **The owner is the user, but the CA is often the decision-maker.** Many small businesses use whatever their CA tells them to use. A product that makes the CA's life easier gets recommended.
- **Mac users are a small but under-served group.** Tally has no native Mac version. Small but real: designers, consultants, younger founders, export houses.
- **Windows is where the volume is.** Most Indian shops and CA offices run Windows. Total already has a Windows installer and tests it in the cloud, but nobody has yet checked it on a real Windows machine.
- **Mobile-first shopkeepers** (who live on Khatabook or Vyapar on their phone) are the hardest to win, because Total has no phone app. They are not the first target.

---

## 3. The market and competitors in India

India has tens of millions of small businesses and around 1.4 crore GST registrations (check the current figure). Most small shops still keep a paper bahi khata or a phone app; most accountants use Tally. The main products:

| Product | What it is | How it is priced (roughly — **check every figure**) | Strengths | Weaknesses vs Total |
|---|---|---|---|---|
| **Tally Prime** | The market standard desktop accounting for 30+ years. Windows only. | One-time licence about ₹22,500 + GST (single user, "Silver") or about ₹67,500 + GST (multi-user, "Gold"), plus a yearly renewal (TSS) of a few thousand rupees for updates; rental plans from about ₹750 a month **(check)** | Every CA knows it; deep features; huge partner network | Accounting words everywhere; no native Mac; proprietary data; staff need training |
| **Zoho Books** | Cloud accounting from Zoho, browser and phone | Free plan for very small businesses; paid plans from roughly ₹750–₹1,000 a month per organisation, more for higher tiers **(check)** | Modern, integrates with other Zoho apps, e-invoicing, bank feeds | Needs internet; data on Zoho's servers; monthly bill forever |
| **Vyapar** | Billing and stock app for small shops, phone and desktop | Yearly plans roughly ₹3,000–₹7,000 a year depending on tier and devices **(check)** | Very easy, mobile, Hindi, WhatsApp sharing | Light on real accounting and GST workings; yearly fee |
| **Busy** | Desktop accounting popular with traders and distributors, Windows | One-time licences roughly ₹10,000–₹40,000 depending on edition, plus yearly update charges **(check)** | Strong inventory and GST; trusted by traders | Old-style screens; Windows only; training needed |
| **myBillBook** | Phone and web billing app for small businesses | Yearly plans roughly ₹400–₹3,500 a year **(check)** | Cheap, easy, quick invoices | Billing-first; limited books; cloud-only |
| **Marg ERP** | Desktop software strong in pharmacy, FMCG distribution and retail | One-time licences roughly ₹8,000–₹25,000 plus yearly charges **(check)** | Industry features (batches, expiry, schemes), big dealer network | Complex; Windows only |
| **Khatabook** | Free phone app for recording udhaar (who owes what), with paid add-ons | Free core; paid plans/features for billing and staff **(check)** | Huge user base; WhatsApp reminders; very simple | Not real accounting; no GST returns; cloud |

### Where Total stands

| Strength | Why it matters |
|---|---|
| **Fully offline, file on your own computer** | No monthly server bill, works in a power cut or with no internet, nobody else holds the data. This is the bahi khata feeling. |
| **No subscription (so far)** | Most competitors charge every year. Small businesses hate recurring fees. |
| **Two modes in one product** | The shopkeeper and the CA use the same file. Nobody else offers a beginner-friendly app that is also Tally-grade underneath. |
| **Explainable figures** | Every number on Home has a "Why?" sentence ("₹4,200 is what 3 customers owe you; the oldest is Ramesh, 12 days") and a link to the report behind it. |
| **Hindi and Hinglish** | Simple mode is fully translated (machine-drafted, waiting for a native speaker). Prints can be in Hindi with amounts in words in lakh and crore. |
| **AI is optional** | Ask Total answers common questions with no key and no internet. The AI helper (with the user's own key) is extra, never required. |
| **Privacy by design** | No account, no tracking. When AI is on, GSTINs, PAN and account numbers in the text sent are masked first. A photo or PDF of a bill is sent as the file and cannot be masked; item names, account names, notes and amounts can also leave (see `docs/ai-and-privacy.md`). |
| **Native Mac app** | Tally does not have one. |

| Weakness | Honest note |
|---|---|
| Young, one developer, no track record | The site already says this honestly ("buy Tally if you need…"). |
| No phone app | Most small shopkeepers live on their phone. |
| Builds are not signed | Mac users have to type a command in Terminal to open it today. This alone will stop most beginners. |
| No network multi-user | Several users can sign in, but on one computer, not over an office network. |
| Live e-invoice filing never tested on the real portal | It makes the files; live filing is experimental. |
| No support team | Nobody to call yet. |

**Positioning in one line:** *"Real books like Tally, easy like Khatabook, and the file stays on your computer — no subscription."*

---

## 4. Why it was built, and the principles

Total was built because small Indian businesses are stuck between two bad choices: **easy apps that are not real accounting** (and live on someone else's server, with a yearly fee), and **real accounting that only an accountant can use** (Tally and Busy). The goal set in the plan is that *someone who has never used Tally, and knows no accounting, law or tax, can run a shop, trade, practice or small factory in Total without a course — while the books, GST, TDS and audit trail stay exactly as correct as they are for an accountant.*

The principles, as they are written into the project:

1. **No cloud, no accounts.** The app never requires a login or an internet connection. Books are never uploaded.
2. **The user owns the file.** One file per business, in a normal folder, in an open format (SQLite). Copy the folder and you have backed up the business. No lock-in.
3. **Every figure can explain itself.** "Why?" sentences are worked out from the same figures, never written by an AI.
4. **Correctness over features.** Money is stored in whole paise (never decimals that can drift). Every report is worked out from the entries each time it opens, so no stored total can go stale. An unregistered business cannot accidentally charge GST.
5. **Tax rules are cited, never written from memory.** Every rate, due date and threshold sits next to the official notification it came from. Anything that could not be checked against the official text is labelled UNVERIFIED and listed for a CA to confirm.
6. **Never claim what we did not do.** Total *prepares* GST files; you *file* them. Credit "awaiting confirmation" is not called "claimable". One known exception: in Simple mode a purchase can still count GST that the law blocks (section 17(5)) as claimable, so purchase GST needs an accountant's review.
7. **Undo and safety.** Every save can be undone for 24 hours (while nothing else depends on it). Deleted entries go to a bin. Every change is recorded in an audit log that cannot be quietly edited (this is also a legal requirement — see section 7).
8. **AI is optional and on a short leash.** The AI can read and draft, never post to the books. The user opens the draft and saves it themselves, and every figure the AI quotes is checked against the books.
9. **Plain words in simple mode.** A list of banned words (voucher, ledger, journal, Dr/Cr, ITC, godown, BOM…) is checked automatically on every simple screen, in all three languages.

These principles are also the best marketing material: they are what makes Total different, and they are true.

---

## 5. Business model options

The site today says **"free while in beta"** and shows **"₹0 / month"**. Before launch you need to decide what happens after the beta. Note also: the code is public on GitHub, but it has **no licence file** and `package.json` says "UNLICENSED". Legally that means "you can look, but all rights reserved". Whatever model you choose, add a clear licence.

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **A. Free + paid Pro** | Simple mode and basic books free forever; accountant tools (GST workings, payroll, TDS, multi-company, consolidation, report builder) in a paid Pro | Lots of installs; easy word of mouth; shopkeepers never pay a rupee to start | Must decide carefully what is "Pro"; most small shops may never upgrade |
| **B. One-time licence** | Pay once, use forever; optional paid upgrade to the next big version | Matches "no subscription" promise; shopkeepers like it; easy to explain | Uneven income; must keep winning new buyers |
| **C. Yearly licence** | Pay every year for updates (like Tally's TSS) | Steady income; pays for keeping GST rules current | Feels like the subscription people want to escape |
| **D. CA / firm licence** | A CA firm pays once or yearly to open any number of client files in the accountant view | CAs bring clients; one sale = many businesses | Need features CAs care about (many clients, quick switching, checking) |
| **E. Paid AI add-on** | AI helper with a key Total supplies, paid per month or per bill read | Easy for users who don't want an OpenAI key | Breaks "no cloud"; you pay the AI bill; needs a server, billing, privacy work |
| **F. Paid support and setup** | Charge for moving from Tally, opening balances, training, a phone/WhatsApp support line | Real need; good margins; builds trust | Needs people and time; doesn't scale with one developer |
| **G. Open-source core + paid builds** | Code under an open licence; sell signed, auto-updating builds, support and the Pro features | Trust ("you can see what it does with your data"); community fixes | Anyone can rebuild and give it away; needs a careful licence |

### Recommendation (a suggestion, to discuss)

Combine **A + B + D + F**: free simple mode, a **one-time** Pro licence, a CA licence, and paid setup help. Keep AI as "bring your own key" (free) for now — option E can come later if many users ask.

Why: "no subscription" is the strongest promise against Zoho, Vyapar and Tally's yearly fees, so a one-time price fits the brand. A free simple mode gets shopkeepers in without risk. CAs are the channel, so they deserve their own licence. A small yearly "tax updates" fee can be optional rather than required, so the promise stays true.

### Sample price ladder (SUGGESTION ONLY — not decided, prices before GST)

| Plan | Who | Price (suggestion) | What it includes |
|---|---|---|---|
| **Free** | Kirana, freelancers, tutors, anyone starting | ₹0, forever | Simple mode, one business, bills, money, stock, people, reports, GST summary, backups, Ask Total |
| **Pro** | Traders, manufacturers, GST-registered businesses that want everything | ₹4,999 one-time (launch offer ₹2,999) | Accountant view in full, GST workings and files, TDS/TCS, payroll, up to 3 businesses, Tally import, a year of updates included |
| **Pro updates** (optional) | Pro users who want the next year's tax changes | ₹1,499 a year | New rates, forms and due dates as the law changes; skipping it keeps the old version working |
| **CA / firm** | CA firms and accountants | ₹14,999 one-time per office or ₹4,999 a year | Unlimited client files on the firm's computers, client-file switching, priority help |
| **Setup help** | Anyone moving from Tally or paper | ₹1,999 per business | Import, opening balances, a 30-minute call |

Compare: Tally Silver is about ₹22,500 + GST one-time plus yearly renewals (check). Pricing well below that, with no required yearly fee, is a clear message.

One rule worth keeping: **never lock someone out of their own books.** If a Pro licence ends or is missing, the user can still open, print and export everything.

---

## 6. Go-to-market ideas

1. **CA network first.** Find 10 friendly CAs. Give them the CA licence free for a year in return for honest feedback and putting 3–5 clients on simple mode. One CA can bring dozens of businesses. Make a one-page "for your CA" leaflet (the repo already has a CA migration guide).
2. **Tally migration as a headline.** "Bring your Tally data across in one step" is already a feature. Make a short video of a real Tally export coming in, and a page "Leaving Tally? Here's how". Target Mac users first (Tally doesn't run natively on a Mac).
3. **WhatsApp-first marketing.** Indian small businesses live on WhatsApp. A WhatsApp Business number for questions; short forwardable videos ("make a GST bill in 30 seconds"); a WhatsApp community for early users. Total can already open WhatsApp with a ready reminder message for a late customer — show that.
4. **YouTube in Hindi.** Short how-to videos in Hindi and Hinglish: "dukaan ka hisaab computer pe", "GST kitna dena hai, ek click mein". Hindi accounting tutorials are a huge category on YouTube.
5. **Local shop and trade associations.** Vyapari mandals, chambers of commerce, distributor associations. A free 1-hour session with a demo; a group discount.
6. **Early-access beta.** A named "Founders' beta" of 50–100 businesses: free Pro for life in return for regular feedback and permission to quote them. This also gives you the real beginner study (decision D5).
7. **Testimonials.** Collect short videos from real shopkeepers and CAs. Nothing sells to a shopkeeper like another shopkeeper.
8. **The site.** It is good and honest, but it still talks only to accountants ("Vouchers", "Particulars", function keys) and does not mention simple mode, Hindi, Ask Total or "Why?". Update it before launch (see section 7: it also says "nothing leaves the machine", which is not true once AI or live filing is on).
9. **GitHub.** The public repo is a trust signal for tech-minded users and CAs: "you can see exactly what it does with your data". Add a licence, a short "Why Total" in the README, and good first issues if you want help.
10. **Comparison pages.** "Total vs Tally" exists. Add "vs Vyapar", "vs Zoho Books", "vs Busy" — honest, including where they are ahead.
11. **Seasonal moments.** The start of the financial year (April), GST due dates (11th / 20th each month), and the annual return season are when people look for help.

---

## 7. Risks, and what must be true before launch

| Risk | Why it matters | What to do before launch |
|---|---|---|
| **Unsigned builds** | On a Mac, users must type `xattr -cr …` in Terminal to open the app; on Windows they see "Windows protected your PC". Most beginners will give up. On a Mac, updates go through the download page instead of installing in place. | Buy an **Apple Developer ID** (about USD 99 a year, check) and a **Windows code-signing certificate**. This is the single biggest blocker. |
| **Unverified tax points** | The to-do list has about 25 groups of tax points marked UNVERIFIED (new GST slabs from Sept 2025, some due dates, TDS rules under the new Income-tax Act, payroll ceilings, GSTR-9 layouts, ARN format). Wrong tax advice could harm users and your name. | Have a **CA review** the UNVERIFIED list and sign off. Keep "ask your CA" wording. |
| **Changed figures in the next release** | Several fixes change numbers people may already have (outstandings with advances, GST on amount-only bills, due dates, the new database driver). | You (with a CA) sign off section 2 of the to-do list before publishing the next release. |
| **Machine-drafted Hindi** | All Hindi and Hinglish text was written by a machine. Wrong or odd words will look unprofessional and could mislead. 28 phrases are already flagged as unsure. | A native Hindi speaker (and a second reader) checks the text, help and prints. Until then, keep the existing machine-drafted warning; a "beta" label on Hinglish is a proposal, not in the app today. |
| **No real beginner study yet** | The "beginner study" was six scripted personas, not real people. Scripts don't get confused or bored. | Five or more real first-time users per business type use it unaided; fix what they trip on. |
| **NIC live filing never run** | The e-invoice/e-way live connection was built from the published specification but never talked to the real government portal. | Keep it labelled experimental, or test it on the NIC sandbox with real credentials first. The offline JSON files are the safe path. |
| **No support process** | When something goes wrong with someone's books, they need a human. | A support email and WhatsApp number, a simple ticket list, a promise of response time (e.g. within one working day), and a way for users to send a backup safely. |
| **Legal: audit trail rule** | Companies must keep an edit log that cannot be switched off (MCA rule under the Companies (Accounts) Rules, rule 3(1)). Total keeps one (append-only, chained so tampering shows) and it is on by default, but the exact legal wording is marked unverified. | CA or lawyer confirms Total's audit trail meets the rule. Until then say "an audit trail built to the rule", never "certified compliant". |
| **Legal: GST rule changes** | GST rates and forms change several times a year. An out-of-date app gives wrong answers. | Someone must watch notifications and ship updates. This is also why a "tax updates" plan has value. Add a disclaimer: Total prepares, you file. |
| **Backups and data loss** | Offline means the user is responsible for their own copy. Automatic backups sit on the same disk; a dead laptop or theft loses both. If the passphrase lock is on, a single backup file cannot be opened alone: the whole business folder, or a `.totalbak` export with its own passphrase, is needed. | Make "copy your backup to a pen drive / Google Drive / another computer" very visible (the whole folder, or the `.totalbak`); consider a backup-to-USB reminder. A schema-version guard so an older version can't open a newer file (not done yet). |
| **Site claims** | The FAQ says "nothing leaves the machine", which is false when AI, capture or live NIC filing is on. | Fix the wording before any launch. |
| **Single developer dependency** | One person (helped by AI agents) builds everything. If you stop, users are stranded. | Keep the code public, keep the docs (CLAUDE.md is very complete), choose a licence that lets users keep using it, and consider a second developer or partner later. Promise users their file always opens and exports. |
| **Performance on large books** | Opening to Home takes about 6.5 seconds against a 2-second target; at 500,000 entries some reports take more than 3 seconds. | Fine for small businesses; fix before courting large traders. |
| **Security gaps** | Attachments and exports are not encrypted. The Phase 7 hardening work is done, but some outside-review (GPT review) items remain open: freezing each bill's tax facts, a safe copy before an upgrade, external backups, and Electron hardening (window sandbox, checking which window sent a request). | Decide which of these are required for 1.0 (decision D7). The recommendation is the pre-upgrade copy and the downgrade guard; the rest after 1.0. |

**Launch gates (one list, the same as document 04, section 3.6).**

- **Required before tagging:** your test week done and its blockers fixed; your sign-off on the changed figures; the changelog finished; main's automatic tests green; your "go".
- **Recommended, you approve or waive each:** CA review of the UNVERIFIED tax points (or keep the "ask your CA" wording); the downgrade guard and a safe pre-upgrade copy; native Hindi review (or keep the machine-drafted warning); an Apple Developer ID; a real Windows PC check (or label Windows "preview"); support email and WhatsApp; a licence file; the site wording fixed; a clear backup message.
- **Undecided, your call:** real beginner study before or after 1.0; any "beta" label on Hinglish; which remaining outside-review items are required for 1.0.

---

## 8. Product ideas backlog

Size: **S** = days, **M** = one to three weeks, **L** = a month or more. Fit: **Simple**, **Accountant**, or **Both**.

### Money and collections

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 1 | **UPI QR code printed on every bill** (the business's UPI ID, the amount filled in) | Every shop and freelancer | S | Both |
| 2 | Polite "payment coming due" reminder before the due date, not only after | Udhaar shops, traders | S | Simple |
| 3 | Refund to a customer outside a return (money out against their credit) | Shops | S | Simple |
| 4 | Customer pays less because they deducted TDS: record bank + TDS receivable in one go | Freelancers, service firms | M | Both |
| 5 | Daily cash-drawer closing ("what should be in the drawer vs what is there") | Kirana, restaurants | M | Simple |
| 6 | Restaurant UPI settlement read as "counter sales", not "other money in" | Restaurants | S | Simple |
| 7 | Scheduled reminders list: "these 5 customers are late, send all" | Traders | M | Simple |

### GST and compliance

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 8 | Bundled HSN/SAC list so products can be searched by name ("sugar" → 1701, 5%) | Every GST business | M | Both |
| 9 | Quarterly (QRMP) file preparation and the PMT-06 amount in simple mode | Small quarterly filers | M | Simple |
| 10 | "Filed" and "paid" marked clearly, Home tile updated after filing | GST businesses | S | Both |
| 11 | Freeze each bill's tax facts at the time of the bill, so changing a product later never changes an old return | Accountants, everyone | L | Both |
| 12 | Proper e-invoice correction flow (cancel within 24 hours, lock amounts after an IRN) | Larger businesses | M | Accountant |
| 13 | Business profile for e-invoice applicability (turnover thresholds) | Growing businesses | M | Accountant |
| 14 | GST calendar on Home with reminders a few days before each due date | Everyone registered | S | Simple |
| 15 | "Do I need GST registration?" guide with cited limits | Unregistered / "not sure" | S | Simple |

### Stock

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 16 | Reorder-level editor and a "what to buy" list | Kirana, traders | S | Simple |
| 17 | Simple recipe editor for made goods | Small manufacturers, restaurants | M | Simple |
| 18 | Barcode scanning with a phone camera as a scanner | Shops | M | Both |
| 19 | Selling before the purchase is recorded: re-cost from the next purchase instead of ₹0 | Shops that bill first | M | Both |
| 20 | Expiry alerts on Home (batches about to expire) | Medical, FMCG | S | Simple |

### People

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 21 | Customer credit limit with a warning on the bill | Traders | S | Simple |
| 22 | Staff attendance and simple salary (without full payroll) | Shops with 1–5 helpers | M | Simple |
| 23 | Supplier price history ("last time you paid ₹42/kg") | Traders, restaurants | S | Both |

### Reports

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 24 | One-page monthly summary PDF to send to the CA or a partner | Owners, CAs | S | Both |
| 25 | Best-selling products and best customers | Shops, traders | S | Simple |
| 26 | Loan-ready report pack for a bank (P&L, balance sheet, GST summary) | Businesses applying for credit | M | Both |
| 27 | Drill-down in the cash flow statement | Accountants | S | Accountant |

### AI

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 28 | Attach a phone photo of a bill even without an AI key (no reading, just keep the picture) | Phone-camera users | S | Simple |
| 29 | Voice entry in Hindi ("aaj Ramesh ko 500 ka saaman diya") read by Ask Total | Shopkeepers who don't type | L | Simple |
| 30 | Ask Total understands payroll, TDS and "show bill 45" questions | Everyone | M | Both |
| 31 | Optional hosted AI with Total's own key, paid (option E) | Users who don't want an OpenAI account | L | Both |
| 32 | PDF bank statements read directly | Everyone with a bank | M | Both |

### Platform

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 33 | Signed Mac and Windows builds with in-place updates (after the user approves) | Everyone | S (once certificates exist) | Both |
| 34 | Linux build | Tech-minded users, some CA offices | M | Both |
| 35 | Phone companion app: see Home, make a bill, record money in — syncing over the local Wi-Fi only (no cloud) | Owners away from the desk | L | Simple |
| 36 | Office network multi-user (two computers on one file) | Shops with a counter and a back office | L | Both |
| 37 | Optional private sync between the owner's own two computers (encrypted, user-chosen folder like a pen drive or their own Drive) | Owners with a laptop and a shop PC | L | Both |
| 38 | "Remember passphrase on this computer" | Users of the lock | S | Both |
| 39 | Faster opening (under 2 seconds) | Everyone | M | Both |

### Integrations

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 40 | Share bill on WhatsApp as a PDF in one click | Every shop | S | Simple |
| 41 | Payment links on bills (Razorpay / PhonePe / UPI intent) | Freelancers, traders | M | Both |
| 42 | Bank statement import presets for the top 10 Indian banks | Everyone | M | Both |
| 43 | Better Tally, Busy and Marg import with real sample files | Switchers | M | Accountant |
| 44 | E-commerce sales import (Amazon / Flipkart / Meesho settlement reports) | Online sellers | L | Both |
| 45 | Thermal receipt printer support for Quick bill | Kirana, restaurants | M | Simple |

### Onboarding

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 46 | Tour for existing companies and accountant-view users | Upgraders | S | Both |
| 47 | "Bring your Khatabook / Vyapar data" import | Phone-app switchers | M | Simple |
| 48 | In-app video help (short, offline, in Hindi) | Beginners | M | Simple |
| 49 | Sample bills and a practice company ("try it with no risk") in each business type | Beginners | S | Simple |

### Community

| # | Idea | Who it helps | Size | Fit |
|---|---|---|---|---|
| 50 | Public roadmap and "vote for the next feature" page | Early users | S | Both |
| 51 | CA partner directory on the site ("find a CA who uses Total") | Owners and CAs | M | Both |
| 52 | Community print templates (bill designs) to share | Shops | M | Both |

The quickest wins with the biggest effect: **1 (UPI QR on bills), 40 (WhatsApp share), 33 (signed builds), 14 (GST calendar), 2 (polite reminder), 28 (photo without AI)**.

---

## 9. Decisions you must take now

Each has a recommended default (most are already what the code does, so "keep the default" changes nothing).

**About the product (plan decisions D1–D7)**

1. **D1 — Let the correctness fixes change behaviour in both modes?** (e.g. an unregistered business can no longer charge GST; "who owes me" is worked out as of today.) *Recommended: yes.* Old entries are untouched.
2. **D2 — Which mode do new companies and the sample company start in?** *Recommended: simple*, with "I have an accountant — show the full app" in setup.
3. **D3 — Who can switch a company's mode?** *Recommended: the owner only*; anyone may open the accountant view on a single screen.
4. **D4 — Bundle an official HSN/SAC list for searching products by name?** *Recommended: not yet* — keep the code-only field; add the list (idea 8) after a CA confirms the source.
5. **D5 — Recruit real beginner testers.** *Recommended: start recruiting now. If you can find five before launch, run the study first; otherwise run it right after 1.0.* At least 5 per business type; the early-access beta can supply them. The code does not force either timing.
6. **D6 — Native review of Hindi and Hinglish.** *Recommended: yes.* Until then the app says the text is machine-drafted. Adding a "beta" label on Hinglish is a proposal for you to approve.
7. **D7 — Treat the outside review's hardening items as required for 1.0?** The Phase 7 packages are done, but some review items are still open (see section 7, Security gaps). *Recommended: require the pre-upgrade copy and the downgrade guard; leave the rest until after 1.0.*

**Smaller product choices (to-do section 1)**

8. **Selling before buying costs the sale at ₹0.** *Recommended: keep the warning for now*; consider re-costing from the next purchase later (idea 19).
9. **Default price level when "Selling price" exists but isn't the default.** *Recommended: keep as is.*
10. **Reopening a closed year moves the lock date.** *Recommended: keep*; the confirmation already says so.
11. **AI cost in US dollars unless a rate is set.** *Recommended: no default rate* (avoid guessing).
12. **Use a product's "usual cost" to pre-fill purchases?** *Recommended: no*, for now.
13. **Tour for existing companies?** *Recommended: from Help/Settings only*, as now.
14. **Block opening a newer file in an older version?** *Recommended: yes, add the guard before 1.0.*
15. **Delete old, replaced branches?** *Recommended: yes*, after one last look (housekeeping).
16. **Leave the missing v0.6.0 / v0.9.0 tags?** *Recommended: leave.*

**Sign-offs before the next release (to-do section 2)** — *Recommended: review each with a CA and approve or hold:*

17. Outstandings now treat advances and a return's own bill as credits (numbers move for some books).
18. GST on "just an amount" bills is read from the tax actually posted (one test company's payable went from ₹0 to ₹750 — intended).
19. New due dates (quarterly GSTR-3B 22nd/24th by state, March TDS 30 April, PMT-06 25th, CMP-08 18th, GSTR-4 30 June).
20. The new database driver (needed for the passphrase lock).
21. Earlier changes: GSTR-3B table treatment, payroll rounding, TDS thresholds, year-end close of stock profit.

**Things only you can supply (to-do section 3)**

22. Apple Developer ID and a Windows signing certificate — *recommended: buy the Apple ID before launch; the Windows certificate when you publish Windows.*
23. A CA (and a payroll adviser) for the UNVERIFIED list.
24. A native Hindi speaker plus a second reader.
25. Five or more real first-time users per business type.
26. A real Windows computer for testing.
27. NIC sandbox credentials (only if you want live e-invoice filing).
28. An OpenAI key for a live AI test (optional).
29. Real (consented) export files from Tally, Busy, Zoho, Marg to test importers.
30. Tell existing testers: backups made before 0.5.0 hold e-invoice passwords in plain text — make a new backup and delete the old ones.

**Business decisions (new)**

31. **Price model.** *Recommended: free simple mode + one-time Pro + CA licence + paid setup* (section 5).
32. **Licence for the public code.** *Recommended: pick one now* (source-available or open-source with a commercial build), so the "UNLICENSED" state ends.
33. **Support channel.** *Recommended: one email + one WhatsApp Business number, reply within a working day.*
34. **Launch order.** *Recommended: Mac + CA beta first, Windows public launch once tested on a real PC.*

---

## 10. Measures of success

Count only what tells you something. Because Total is offline and has no accounts, you cannot see usage automatically — and should not secretly track it. So measure in two ways: what the website and GitHub see, and what users choose to tell you (an optional, clearly explained, opt-in "send anonymous usage counts" setting is possible later, but only with the user's yes).

| What to count | How | A good early target (suggestion) |
|---|---|---|
| **Downloads** | GitHub release download counts. The site's download link only redirects and counts nothing, so counting there needs hosting analytics. Installs are unknown unless you ask in a beta survey. | 1,000 downloads in the first 3 months |
| **Companies created** | Opt-in counts, beta survey | 60 % of installs create a real (not sample) business |
| **Bills per week** | Opt-in counts or beta check-ins | An active shop makes 20+ bills a week |
| **Retention** | Who is still using it after 1, 4 and 12 weeks (beta group) | 40 % still active at 12 weeks |
| **Unaided first bill** | Real beginner study | 9 out of 10 make their first bill without help |
| **Support tickets** | Count and tag by topic (install, GST, backup, bug) | Fewer than 1 ticket per 10 active users a month; install tickets fall to near zero once builds are signed |
| **Upgrade rate** | Free → Pro, and CAs buying the firm licence | 5–10 % of active businesses upgrade |
| **CA referrals** | Ask "how did you hear about us?" | 30 % of new businesses come through a CA |
| **Tally switchers** | Tally imports reported in the beta | 50 businesses move from Tally in the first 6 months |
| **Wrong-tax incidents** | Reported cases where a figure was wrong | Zero; each one fixed and explained publicly |
| **Data-loss incidents** | Reported lost books | Zero |

The one number to watch above all is **"still using it after 12 weeks"**. If shopkeepers and their CAs keep their books in Total for three months, the rest — word of mouth, upgrades, CA referrals — follows.
