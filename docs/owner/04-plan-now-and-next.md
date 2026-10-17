# Total — the plan: what we do right now and what comes next

**15 October 2026.** Written for the owner (IrminFlow). No technical knowledge needed. Words like
"PR" (a proposed change, reviewed before it goes in) and "CI" (the automatic tests GitHub runs on
every change) are explained where they first appear.

---

## 1. Where we are today

- **The planned building work is merged.** The "simple for everyone" revamp (Phases 8, 9 and 10) and the Phase 7 hardening (speed, security, Windows, tests, documents, clean-up) are all in the main copy of the code, and the automatic tests pass. Some acceptance checks are still open: real beginner testing, a native Hindi review, a full check on a real Windows PC, the launch-speed target and some deferred coverage (`to-do.md` sections 3, 6 and 8).
- **A test copy is on your Desktop:** `~/Desktop/Total-dev-bdf44fa0.dmg`. It is unsigned (Apple doesn't know who made it yet) and its About screen still says **0.11.0**, because the version number has not been raised. This build was made on 17 October and holds everything merged up to pull request #159, including the cheque-register fill-in (#146) and #148 to #159. It covers fixes across the simple screens, security checks, faster launch, bank / money / returns / stock polish, Hindi leftovers, data-folder move, remember-on-this-computer, CLI passphrase, and trade and reports fixes. The test kit in `~/Desktop/Total-test-kit` is unchanged.
- **What changed overnight is in `08-what-changed-16-17-oct.md`:** a one-page summary grouped by what you will notice while testing, with the eight checks to look at twice.
- **Nothing has been published.** No new version number, no tag, no GitHub release, no release notes, no website change. That is your standing rule: nothing goes out until you have tested it on your laptop and said "go".
- **The full list of open items is `to-do.md`** at the top of the repo (184 item lines in 8 sections. 59 of them have something struck through as done, a few only in part, so up to 125 are fully open. Under sections 4 to 8, the bugs, tax points, deferred work and test gaps, 58 of 145 have something struck through, so up to 87 are fully open). This document picks out what matters for the next few weeks and turns it into steps.
- **The next two steps are publishing 1.0.0 (plan item 7.6) and the website message (plan item 10.7).** Both wait for your test.

---

## 2. RIGHT NOW — your test week

The aim of this week: use Total the way a shop owner would, then the way an accountant would, and
write down anything that looks wrong, confusing or slow. You don't need to judge the code. If
something makes you stop and think "huh?", that's a finding.

### 2.1 Before you start: protect anything you already have

Total keeps all its data in the folder **Documents → total** on your Mac.

- [ ] If that folder exists (you have used 0.11.0 or older on this laptop), **copy the whole folder** to somewhere safe, for example `Desktop/total-before-1.0`. The new build upgrades company files when it opens them. Going back to 0.11.0 on an upgraded file is not supported: 0.11.0 does not refuse to open it, but it may misread it.
- [ ] If the folder doesn't exist, that's fine — you'll start from nothing. (For the upgrade test in 2.5 you can first install 0.11.0 from the GitHub releases page, make a company, then install the new build.)

### 2.2 Install the test build

- [ ] Double-click `Total-dev-bdf44fa0.dmg` on your Desktop.
- [ ] Drag **Total** into the **Applications** folder (say "Replace" if it asks).
- [ ] Open the **Terminal** app (press ⌘ Space, type "Terminal", press Enter) and paste this line, then press Enter:

  ```
  xattr -cr /Applications/Total.app
  ```

  This tells macOS to stop treating the app as "downloaded from the internet". It is needed because the build isn't signed by Apple yet. It prints nothing when it works.
- [ ] Open Total from Applications. If macOS still says it can't check the developer, right-click the app → **Open** → **Open**.
- [ ] Settings → About should say 0.11.0. That's expected for this test build.

### 2.3 Where to write what you find

Pick one way and stick to it:

- **Easiest:** keep a note on your laptop with one line per finding: *what you did → what you saw → what you expected*. Add a screenshot (⌘ Shift 4) when you can. Hand the note to Claude at the end of the week; Claude will copy each item into a new section **"9. Owner test, October 2026"** at the bottom of `to-do.md`.
- **Or:** open a GitHub issue per finding on `IrminFlow/total` (title = the short problem, body = the three parts above). Remember the repo is public — don't paste real customer names, GSTINs or phone numbers.

Mark each finding **Blocker** (must be fixed before 1.0), **Should fix**, or **Later**. If you're not sure, leave it blank and Claude will suggest one.

### 2.4 Simple mode — 34 things to try

Use made-up names and amounts. Do this in one sitting if you can (about 2 hours), or spread it
over a few days — which is closer to real use.

**Setting up**

- [ ] 1. **Setup wizard.** On the first screen choose a language (try English first), then make a business: a trader, GST "regular", monthly filing, with stock, started "earlier" (an already running business). *Looks right:* every question is in plain words, nothing asks for "ledger" or "voucher", and you land on Home with a short 4-step tour.
- [ ] 2. **The tour.** Press Enter through it, then run it again from Help → "Show the tour of Home". *Looks right:* each card points at the thing it describes and never blocks a click.
- [ ] 3. **What you had on day one (openings).** From Home, enter cash in hand, one bank balance, two customers who owe you (one with two old bills), one supplier you owe, and two products in stock with their GST rate. *Looks right:* the last step says in one sentence how much is "owner's money", and after saving Home shows those amounts.

**Daily work**

- [ ] 4. **Make a bill, cash customer.** + Sale, no customer, one product, paid by Cash. *Looks right:* the total at the bottom matches your own sum (price × quantity + GST), the save card appears with Print / PDF / Undo.
- [ ] 5. **Print that bill.** Click Print. *Looks right:* it says TAX INVOICE, shows your business name, the GST split (CGST + SGST), and the amount in words.
- [ ] 6. **Make a bill on credit (udhaar).** A named customer, "On credit". *Looks right:* the line under the total says when it's due, and Home's "customers owe you" goes up by exactly that bill.
- [ ] 7. **Partly paid bill.** Same, but "Partly paid" with half the amount by UPI. *Looks right:* only the other half is still owed.
- [ ] 8. **Undo.** Make a bill and press Undo on the save card. *Looks right:* the bill disappears from the Sales list and Home goes back to what it was.
- [ ] 9. **New customer from the picker.** Type a name that's close to an existing one (e.g. "Sharmaji Store" when "Sharma Stores" exists). *Looks right:* it asks "Did you mean Sharma Stores?". Pressing Enter must never create a new customer by itself.
- [ ] 10. **Record a purchase with GST, part paid.** + Purchase, supplier bill number and date, a product, "the bill shows GST", pay part now. *Looks right:* the total matches the paper bill you imagined; Home's "you owe" rises by the unpaid part.
- [ ] 11. **Same supplier bill twice.** Enter the same supplier and bill number again. *Looks right:* refused, with a button to open the bill already recorded.
- [ ] 12. **Money in.** A customer pays part of what they owe. *Looks right:* the oldest bill gets ticked first; after saving that customer owes less by exactly that amount.
- [ ] 13. **Money out — an expense with a GST bill.** Rent or electricity, "Do you have a GST bill? Yes". *Looks right:* you pay exactly what you typed (no rounding surprise), and the preview names the expense.
- [ ] 14. **Money out — owner takes money home.** Choose "the owner". *Looks right:* it says this is not a business expense.
- [ ] 15. **Move money.** Cash deposited into the bank. *Looks right:* cash goes down, bank goes up, profit doesn't change.
- [ ] 16. **Bank statement.** Money → Bank, drop a bank statement file (CSV or Excel from your bank, or ask Claude for the test file). For each line answer "What is this?". *Looks right:* lines you already recorded say "Already recorded"; at the end one sentence says whether books and bank agree.
- [ ] 17. **Return a sale.** Sell → Sale returns, pick the credit bill from step 6, return one item, keep it as credit. *Looks right:* it says "a credit of ₹X to use on the next bill", and stock goes back up.
- [ ] 18. **Count your stock.** Stock → Count stock, change one product's count. *Looks right:* the product list then shows exactly the counted quantity.
- [ ] 19. **Sell more than you have.** Make a bill for more pieces than are in stock. *Looks right:* a warning that profit will be wrong until the purchase is recorded; Home lists it under "Needs attention".
- [ ] 20. **People.** Open a customer with an overdue bill. *Looks right:* balance in words ("owes you ₹…"), bills oldest first with "N days overdue".
- [ ] 21. **Reminder.** On that customer, make a reminder and choose Copy for WhatsApp (or Open in WhatsApp). *Looks right:* a polite message with the amount; Total itself sends nothing.
- [ ] 22. **Bills to pay.** People → Bills to pay. *Looks right:* the supplier bill from step 10 with its unpaid part.

**Knowing where you stand**

- [ ] 23. **Home tiles and "Why?".** Click "Why?" on three tiles (customers owe you, cash, profit this month). *Looks right:* one sentence that adds up, and the link opens the report that shows the same number.
- [ ] 24. **Reports → How is my business doing.** This month and this year. *Looks right:* sales, cost, profit in plain words; profit matches Home.
- [ ] 25. **Reports → Cash in the next 30 days** and **Who owes me.** *Looks right:* Who owes me equals Home's tile.
- [ ] 26. **Taxes.** *Looks right:* three separate figures (GST on sales, GST on purchases, cash to pay) and the due date, with "Total prepares; you file on gst.gov.in". The month shown should not be before your books started.
- [ ] 27. **Ask Total (⌘J).** Ask: "kis par kitna baaki hai?", "kitna profit hua is mahine", "how much GST do I owe", "chai ke 500 cash mein diye". *Looks right:* the first three answer with the same figures as the screens; the last opens Money out filled in, and nothing is saved until you press Save.
- [ ] 28. **Ask Total with a name it can't decide.** "5000 Ramesh" when there are two Rameshes, or no direction. *Looks right:* it asks "which one?" or "money in or out?" — it never guesses.
- [ ] 29. **Help.** Press `?` on Home, then on the Make a bill screen. *Looks right:* the article for that screen, readable, links work.

**Language, safety, switching**

- [ ] 30. **Hindi.** Settings → How Total looks → Language → हिन्दी. Walk through Home, make a bill, print it. *Looks right:* Devanagari everywhere in simple screens, the print shows the amount in words in Hindi (lakh / crore). Note any sentence that sounds odd — a native speaker hasn't checked these yet. Then try Hinglish, then back to English.
- [ ] 31. **Backup.** Settings → Backups → Back up now. *Looks right:* "checked OK" after a few seconds; Home stops nudging you about backups.
- [ ] 32. **Passphrase lock.** Settings → Lock and safety → turn on the passphrase. Close Total, open it again. *Looks right:* it asks for the passphrase and opens the books with it. **Write the passphrase down first** — if it's lost, nobody can open those books. Turn it off again afterwards if you like.
- [ ] 33. **Accountant view and back.** On Make a bill, type a bill but don't save, press Accountant view. *Looks right:* the full editor opens with what you typed and a banner saying nothing is saved yet. Press "Back to simple". Then open a saved bill, Accountant view, Back to simple — you should land on that same bill.
- [ ] 34. **Small window.** Make the Total window narrow (drag its corner). *Looks right:* the sidebar shrinks to icons, nothing is cut off, the Save bar stays visible.

### 2.5 Accountant mode — 13 things to try

- [ ] 35. **The old demo.** From the company list choose "Sample data in the full app". *Looks right:* the sidebar is exactly the one you know from 0.11.0; the Gateway dashboard opens.
- [ ] 36. **Upgrade of a 0.11.0 company.** Open a company made in 0.11.0 (your own, from the copy in 2.1, or one you make in 0.11.0 first). *Looks right:* it opens without errors and the trial balance totals are the same as before. Compare against the copy you made in 2.1. The automatic backup on open is taken after the upgrade runs, so it is not a before-upgrade copy.
- [ ] 37. **Upgrade of a 0.11.0 backup.** Settings → Backups → restore an older backup file. *Looks right:* it restores and the figures are what that backup held.
- [ ] 38. **After the upgrade — check 1: Outstandings sign.** Open Outstandings for a company that has **advances** (money received before the bill) or **returns with their own bill**. *Looks right:* an advance shows as the party's credit (reduces what they owe), not as an extra bill. Companies without advances or such returns must show exactly the same figures as in 0.11.0. Note any party whose figure moved and whether the new figure is right.
- [ ] 39. **After the upgrade — check 2: GSTR-1 / GSTR-3B for "amount only" bills.** Find a month with sales entered as just an amount on a Sales account plus CGST / SGST lines (not item invoices). Open GSTR-1 and GSTR-3B for that month. *Looks right:* those bills now appear at their real rate (e.g. 5 % or 18 %) with their tax, instead of as "nil rated" with ₹0. In our test company, Sep–Oct net payable moved from ₹0.00 to ₹750.00 — that's the intended fix. Write down the before / after for one month.
- [ ] 40. **Make a sales invoice and a payment in the full editor.** *Looks right:* works exactly as in 0.11.0; Enter in a picker picks the highlighted name and never creates a new one.
- [ ] 41. **GSTR-1 export.** Export GSTR-1 JSON for a finished month. *Looks right:* a file is written; if you have a GST portal test login, the offline tool accepts it.
- [ ] 42. **Profit & Loss and Balance Sheet.** *Looks right:* P&L profit equals the Balance Sheet's profit line; the accountant's two-column version of the P&L opens.
- [ ] 43. **Day book and a voucher round trip.** Open an old voucher, change nothing, save. *Looks right:* nothing changes in any report.
- [ ] 44. **Bin and restore.** Delete a voucher, find it in Settings → Bin, restore it. *Looks right:* figures go back exactly.
- [ ] 45. **Year-end close on a copy.** On the demo company, close the year. *Looks right:* income and expense start from zero in the new year; the closing entry can't be edited. Then bin the closing entry: it should first ask to move the lock date back, and say so.
- [ ] 46. **Due dates.** Gateway compliance card. *Looks right:* March TDS due 30 April (was 7 April); a quarterly filer's GSTR-3B on the 22nd or 24th.
- [ ] 47. **Roles.** Settings → People & roles: add a viewer with a PIN, sign in as them. *Looks right:* they can look but not save; simple screens say "your sign-in can't save" instead of a Save button that fails. ⌘L locks the screen.

When you're done, tell Claude **"test done"** and hand over your notes.

---

## 3. THEN — your decisions

Each decision shows a **default**. For most, it is what the app already does. Where nothing is built yet (the timing of the beginner study, signing, the Hinglish "beta" label), the default is a **recommendation** from Claude that waits for your approval. If you agree, say "default". Only the ones you want changed need words.

### 3.1 Figure and rule changes to accept (before publishing)

These change numbers an existing user would see after the upgrade. They're believed correct, but
by our own rule nothing that changes figures goes out without your sign-off.

1. **Outstandings: advances and a return's own bill count as the party's credit** (#85). Default: **accept.** Only books with advances or such returns change.
2. **GST returns read an amount-only bill's rate from the tax it posted** (#93). Default: **accept.** Some old months will show more GST payable — because the tax was always in the books but missing from the return. Tell any existing user to re-check those months.
3. **Side effect of 2: interest charged on overdue amount-only bills now carries the bill's real GST.** Default: **accept.**
4. **Due dates** (#94): quarterly GSTR-3B 22nd / 24th by state, March TDS 30 April, PMT-06 25th, CMP-08 18th, GSTR-4 30 June. Default: **accept.**
5. **Binning a closing journal moves the period lock back** (#107), with a confirm. Default: **accept**; the earlier lock is not remembered.
6. **New database driver** that allows the passphrase lock (#112). Plain companies open unchanged. Default: **accept.**
7. **Older rule changes never signed off**: GSTR-3B ITC tables per Circular 170; payroll EPF rounding and ESI on Code wages; TDS thresholds from dated rates; year-end close moving only ledger profit (stock profit stays as a balance-sheet line). Default: **accept now, and ask a CA** (see 3.5).

### 3.2 The seven plan decisions (D1–D7)

1. **D1 — Correctness fixes apply in both modes.** Default: **yes** (old entries round-trip unchanged).
2. **D2 — Sample company and new companies start in Simple mode**, with "show the full app" in setup. Default: **yes.**
3. **D3 — Only the owner can switch a whole business's mode**; anyone can open the Accountant view per screen. Default: **yes.**
4. **D4 — HSN code search by product name.** Default: **no bundled HSN list**; the field takes a code and the user picks the GST rate. Change it only if you can get the official CBIC HSN / SAC list.
5. **D5 — The real beginner study (5+ first-time users per business type).** A scripted stand-in study was done (`docs/beginner-study-2026-10.md`). Nothing in the app fixes the timing. Recommendation: start recruiting now. If you find five before launch, run the study first; otherwise run it right after 1.0. Decide: before 1.0 or after?
6. **D6 — Hindi / Hinglish reviewed by a native speaker.** Default: **ship the machine-drafted text**; Settings already says it is machine-drafted. Proposal: also add a "beta" label to Hinglish (not in the app today). The 28 phrases we were unsure of are listed in PR #105.
7. **D7 — The GPT-review hardening items are required for 1.0.** Default: **yes**, but be clear what "done" means. The Phase 7 packages are done. Some outside-review items are still open: freezing each bill's tax facts, a safe copy before an upgrade, external backups, and Electron hardening (window sandbox, checking which window sent a request). Recommendation: require the pre-upgrade copy and the downgrade guard (3.3, item 5) for 1.0, and leave the others until after 1.0. You decide which are required.

### 3.3 Other choices

1. **What to call the two modes.** Today they're "Simple" and "Accountant". Alternative: "Basic / Professional". Default: **keep Simple / Accountant.** (A rename is a small change but touches every language and the help.)
2. **The version number.** Default: **1.0.0** (the plan's number for "Phases 7–10 done").
3. **Selling before the purchase is recorded** values that sale's cost at ₹0. Default: **warning only** (as now). The alternative — re-cost from the next purchase — is a bigger engine change.
4. **AI cost shown in US dollars** unless the business has a dollar rate saved. Default: **no default rate.**
5. **Block opening a 1.0 company in 0.11?** (Downgrades aren't blocked today.) Nothing is built yet. If you say nothing: no guard; tell users to restore a backup instead. Recommendation: add the guard before 1.0 — it's small.
6. **Tour for existing companies.** Default: **only from Help / Settings.**

### 3.4 Housekeeping on GitHub

1. **Open Dependabot PRs** (automatic "please update this library" requests):
   - **#3 Electron 37 → 43** (fixes ~50 security alerts). Default: **its own work package right after 1.0** — it needs the database driver rebuilt and a full test on Mac and Windows.
   - **#7 and #14 vitest 3 → 5** (test tool only, never reaches users). Default: **its own small work package after 1.0.**
   - **#13, #16, #63 for the website** (next 16.3.8 fixes critical alerts). Default: **merge when the website work (10.7) starts.**
2. **Old branches.** Two local ones (`perf-lane-work`, `worktree-agent-acf44857d65a8b1ae`) and three on GitHub from closed PRs #1, #2, #4. Everything useful in them is already in main. Default: **kept** — Claude suggests **delete** after 1.0.
3. **Missing tags 0.6.0 and 0.9.0.** Default: **leave as is** (the changelog explains).
4. **Account housekeeping:** GitHub Actions storage was full; CodeRabbit's free plan reviews 1 PR an hour (upgrade or turn off); Vercel twice said the account was "blocked". Default: **you check the Vercel account before the website step.**

### 3.5 Keys and people only you can supply

1. **OpenAI API key** — so the optional AI helper can be tested against a real model once (only a stand-in has been used). Default: **ship with AI marked optional and untested live.**
2. **NIC sandbox credentials** — for live e-invoice / e-way bill filing, which has never talked to the real government portal. Default: **keep it labelled "experimental".**
3. **Apple Developer ID** (about US$99 a year) — so the Mac app is signed, updates install in place after the user approves, and nobody needs the Terminal line. If you don't decide: **ship unsigned; updates go through the download page.** Recommendation: buy it before launch.
4. **A Windows code-signing certificate and a real Windows PC** for the checks CI can't do. Default: **Windows stays "preview" until then.**
5. **A CA** to read the tax points marked UNVERIFIED (to-do.md section 5) and **an HR / payroll adviser** for payroll.
6. **A native Hindi speaker** (D6) and **5+ beginners per business type** (D5).
7. **Consented real export files** from Tally / Busy / Zoho / Marg, to test the importers.

### 3.6 Launch gates — one agreed list

The earlier sections mix requirements and recommendations. This is the single list; document 03
(section 7) repeats it. You approve it or change it.

- **Required before tagging** (these follow the project's own rules): your test week done and its
  blockers fixed; your sign-off on the figure changes in 3.1; the changelog finished (step 5);
  main's automatic tests green (step 6); your "go".
- **Recommended, you approve or waive each:** a CA review of the UNVERIFIED tax points (otherwise
  keep the "ask your CA" wording); the downgrade guard and a safe copy before an upgrade; a native
  Hindi review (otherwise keep the machine-drafted warning); an Apple Developer ID; a real Windows PC
  check (otherwise Windows is labelled "preview"); a support email; a licence file for the code;
  telling early testers to renew backups made before 0.5.0.
- **Undecided, your call:** the real beginner study before or after 1.0 (D5); a "beta" label on
  Hinglish (D6); which remaining outside-review items are required for 1.0 (D7); the version number.

---

## 4. NEXT — release 1.0.0 (plan item 7.6)

Nothing in this section starts until you say **"go"**. You decide; Claude does the work and shows
you each result.

| # | Step | Who |
|---|---|---|
| 1 | Sort your test findings into Blocker / Should fix / Later and add them to `to-do.md` section 9. | Claude, you confirm |
| 2 | Fix every Blocker (and the cheap Should-fix items), each as its own PR with an independent review and CI green. Any fix that changes a figure comes back to you first. | Claude |
| 3 | Build a fresh test DMG from the fixed code; you re-check just your findings (an hour, not a week). | Claude builds, you check |
| 4 | You give the go, with your answers to section 3. | **You** |
| 5 | **Finish `CHANGELOG.md`'s Unreleased section.** It has no entries for #107, #108, #110, #111 and #112, and it still calls #104 open (#109's Windows text is there but has no PR link). Every entry links its PR. | Claude |
| 6 | **Confirm main's automatic tests are green on all five jobs** (the full end-to-end and speed checks run there, not when the tag is pushed). | Claude |
| 7 | Move the CHANGELOG's "Unreleased" section under **1.0.0 — <date>**, with the sign-off items worded for existing users ("re-check GST for months with amount-only bills"). | Claude |
| 8 | Raise the version: `npm version major` (0.11.0 → 1.0.0). This makes a commit and the tag `v1.0.0`. | Claude |
| 9 | `git push --follow-tags`. GitHub Actions re-runs the unit, screen, database and smoke tests (not the full end-to-end or speed checks, which is why step 6 comes first) and builds the Mac DMG / ZIP and the Windows EXE, and publishes the release (never as a draft — drafts are invisible to the update check). | Claude watches it |
| 10 | Check the release page: three files present, the Windows installer named `Total-Setup-1.0.0.exe` with no space, and the release text matches the changelog. | Claude |
| 11 | **Check the update path:** on a Mac with 0.11.0 installed, open it — it should say a new version is ready and offer the download; install, open an old company, figures unchanged except the signed-off changes. Also the site's `/api/latest` and `/api/download` must point at 1.0.0. | Claude, you watch one run |
| 12 | **Website (plan item 10.7):** move the message from "Tally-grade" to "easy books for any shop"; change "fully offline" to "works fully offline; AI and e-invoice filing are optional and send data only when you turn them on"; Windows described as preview; merge the website library updates (#13, #16, #63). Shown to you as a preview link before it goes live. | Claude, **you approve** |
| 13 | Announce: a short post (WhatsApp groups, LinkedIn, CA contacts) with the download link and a 2-minute "first bill" video. | **You**, Claude drafts |
| 14 | Watch for a week: GitHub issues, download numbers, anything users report. A 1.0.1 for urgent fixes if needed. | Claude watches, you decide on a 1.0.1 |

If anything in steps 9–11 fails, we stop, fix, and bump to 1.0.1 — a published tag is never
rewritten.

---

## 5. AFTER 1.0 — a roadmap suggestion, October 2026 to September 2027

Sizes: **S** = a few days, **M** = one to three weeks, **L** = a month or more. "Depends on" says
what must happen first. This is a suggestion to react to, not a promise.

### Quarter 1 — October to December 2026: make it trustworthy

| Item | Why | Size | Depends on |
|---|---|---|---|
| **Mac code signing and notarisation** | No Terminal line, no scary warning, updates that install in place after the user approves. The single biggest thing for first impressions. | S | Apple Developer ID (you) |
| **Electron upgrade (PR #3) + vitest upgrade (#7 / #14)** | Clears ~50 security alerts in the app shell; keeps the test tools current. | M | 1.0 out |
| **The real beginner study (D5)** — 5+ first-time users per business type, watched while they use it | The scripted study can't be confused; real people can. This tells us what to fix next better than anything else. | M | You recruit; Claude prepares the tasks and the note sheet |
| **Native Hindi review (D6)** | Hindi is machine-drafted; one bad word on a bill costs trust. Then remove the machine-drafted warning (and any "beta" label you chose to add). | S (for us) | A native speaker (you) |
| **CA review of the UNVERIFIED tax points** | Shopkeepers will rely on the GST and TDS dates and rates. | M (for the CA) | A CA (you) |
| **Simple-mode leftovers from to-do.md section 4** (expense name in the Money list, bank "Undo" on a done line, etc.) | The rough edges a beginner hits first. | M | Study findings to set the order |

### Quarter 2 — January to March 2027: reach more shops

| Item | Why | Size | Depends on |
|---|---|---|---|
| **Windows public release** | Most Indian shops use Windows PCs. | M | Windows signing certificate + a real Windows PC for the manual checks |
| **UPI QR code on bills and payment links** | Customers pay faster; the business gets paid sooner. The QR is just text printed on the bill — no bank integration needed. | S | none |
| **WhatsApp bill sharing** (send the PDF through WhatsApp from the save card) | How Indian shops actually send bills. Today reminders can be copied into WhatsApp; bills only as PDF. | S–M | none |
| **NIC sandbox live run** | Turns e-invoice / e-way filing from "experimental" into a real feature for larger businesses. | M | NIC sandbox credentials (you) |
| **Year-end season help** (31 March): a guided close in simple mode, the TDS / GST year-end checklist | The first year-end is when beginners panic. | M | CA review |
| **Speed: launch to Home under 2 seconds** (now ~6.5 s) | First impression every morning. | M | none |

### Quarter 3 — April to June 2027: connect

| Item | Why | Size | Depends on |
|---|---|---|---|
| **Bank feeds** (statements fetched automatically through India's Account Aggregator system) | No more downloading statement files. | L | A licensed Account Aggregator partner and its terms; privacy notice |
| **Mobile companion, view only** (who owes me, today's sales, cash) | Owners want to check from home. View-only keeps the books on the laptop. | L | Encrypted sync below, or a local-network-only first version |
| **Optional encrypted sync between the owner's own devices** | A second laptop at the shop, the phone app, and protection against a lost laptop. Encrypted on the device; no account on our side holds readable data. | L | Security design + your decision on whether any server is acceptable |
| **CA multi-company dashboard** | A CA with 50 clients is the best salesperson Total can have. | M | Users asking for it in the study |

### Quarter 4 — July to September 2027: grow

| Item | Why | Size | Depends on |
|---|---|---|---|
| **More languages: Gujarati, Marathi, Tamil** | The trading communities Total suits best. The translation system already handles any language. | M each | A native reviewer per language |
| **Linux build** | Some CAs and schools use it; cheap to add to the build. | S | Windows release done (same work) |
| **Performance to 1 million entries** | Large traders and CA offices. Today's measured limit is 500,000 with some reports over 3 s. | L | Real large books to test with |
| **Pricing and licensing** | Decide: free forever, a paid "Pro" tier (e-invoice filing, multi-company, sync), or a one-time licence. Needs a licence check that works offline. | M | Your decision; ideally after the study and some real users |
| **Support process** | A help address, a "send a problem report" button that attaches logs (never the books) only when the user agrees, and a weekly look at issues. | S | Start from 1.0; grows with users |

---

## 6. How we work — the rules carried forward

These are the rules that got Phases 7–10 to green without breaking anyone's books. They stay.

1. **Every change goes through a PR** (a proposed change). A second, independent reviewer tries hard to break it before it goes in, and CI (the automatic test run) must be green on Mac and Windows.
2. **No figure changes without your sign-off.** If a change moves any number an existing user sees, it's listed for you in plain words with a before / after, like section 3.1.
3. **Tax rules are never written from memory.** Each rate or date cites the official notification or rule next to it; anything we couldn't check is marked UNVERIFIED and listed in `to-do.md` section 5.
4. **Local build before publishing.** You test a DMG on your laptop first. Nothing is tagged, released or put on the website until you say so.
5. **Old books keep working.** An existing company or backup opens with the same figures; database changes are only ever added, never edited.
6. **Usage and laptop limits.** On long runs Claude checks usage about every 10 minutes and stops and reschedules below 10 % left; no more than 3–4 helpers at once; old working copies and scratch folders are removed promptly because the laptop is short on disk.
7. **Only Opus, Sonnet and Haiku do the work**, and the goal stays the same: Total must be usable by anyone.
8. **`to-do.md` is the single list.** Every open item, decision and finding lives there, one line each with a pointer. This document points to it; it doesn't replace it.

---

## 7. Open questions for you

1. **When can you do the test week**, and do you want Claude on hand during it (to explain screens), or only afterwards?
2. **Do you have real books on this laptop** (a company used with 0.11.0 or older) for the upgrade test, or should Claude prepare a test company in 0.11.0 for you?
3. **Version number: 1.0.0?** Or a 0.12.0 first, with 1.0.0 after the real beginner study?
4. **Mode names:** keep "Simple / Accountant", or rename (e.g. "Basic / Professional")?
5. **Real beginner study before or after 1.0?** And can you find 5 people per business type (or at least 5 overall to start)?
6. **Will you buy the Apple Developer ID now** (so 1.0 is signed), or ship 1.0 unsigned?
7. **Windows:** publish the EXE with 1.0 marked "preview", or hold it until it's signed and checked on a real PC?
8. **Who will review the Hindi and the tax rules** — do you know a native speaker and a CA we can ask?
9. **Is a server ever acceptable** (for sync, bank feeds or licence checks), or must Total stay strictly "nothing on our side"?
10. **Money:** do you want Total free, paid, or free with a paid tier — and should we design for that before the website messaging goes out?
