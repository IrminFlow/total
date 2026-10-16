# Total 1.0: announcement drafts

> **DRAFT FOR LATER. Nothing here is published.** Version 1.0 is not out. Use these only after you
> have tested, said "go", and the release page and website are live (plan section 4, step 13).
> Replace `<download link>` with the real link. Check every claim against the release notes first.
> Price and licence are not decided yet (plan section 7, question 10; there is no licence file), so the drafts say nothing about cost. Add a line once you decide.

---

## 1. WhatsApp message (about 110 words)

> Namaste! I have made an accounting app for small shops, called **Total**. It runs on your own Mac or Windows computer, so your data stays with you and it works without internet.
>
> You make a bill, take payment, and Total keeps the books. GST bills, udhaar (who owes you), stock, bank match, and a plain "how is my business doing" screen are all there. No accounting words to learn. It speaks English, Hindi and Hinglish.
>
> Please download it, make one bill, and tell me what confused you. That helps more than anything.
>
> <download link>
>
> Total 1.0

(Windows is a preview. Say so if someone asks.)

---

## 2. LinkedIn post (about 170 words)

> I have been building **Total**, an accounting app for small Indian businesses, and version 1.0 is out.
>
> The idea: a shopkeeper who has never heard of a "ledger" should be able to make a GST bill, record udhaar, pay a supplier, match a bank statement and see what GST is due, in plain words.
>
> What it is:
> - Runs fully on your own computer. No account, no cloud, works offline.
> - Simple mode for shop owners, with English, Hindi and Hinglish.
> - Accountant mode with Tally-style double-entry books, GSTR-1 and GSTR-3B files, an edit log and Tally import.
> - AI help and e-invoice filing are optional and send data only when you turn them on.
>
> The code can be read on GitHub. Mac is the main build; Windows is a preview.
>
> I would love honest feedback, especially from shop owners and CAs: what felt confusing, what was missing?
>
> Download: <download link>

---

## 3. Note for CA contacts (6 lines)

1. **Books:** proper double-entry books, with trial balance, P&L, balance sheet, day book and ledgers, readable the way you read Tally.
2. **GST:** GSTR-1 and GSTR-3B JSON ready to upload, GSTR-2B reconciliation, e-invoice and e-way bill files. Tax rules cite their source and flag what is unverified, so please check those.
3. **Trail:** every change is logged (who, when, before and after) in a tamper-evident edit log, as the MCA rule asks.
4. **Your client's data:** one folder on their computer; backups can be checked and restored; an Excel export of the full books is built in.
5. **Tally:** import from Tally XML; your client can switch the whole app to the full accountant view with one button.
6. **Ask:** I need a CA to read the GST points marked UNVERIFIED. Reply if you can spare an hour. <download link>

---

## 4. The 2-minute "first bill" video: shot list

Screen recording, English voice-over, test company only. Button names are the real ones from the app.

| # | On screen | Said (about) |
|---|---|---|
| 1 | Total icon, then the first screen with the language buttons | "This is Total. Accounts for a small shop, on your own computer." (0:00) |
| 2 | Setup wizard: business name, state, "Shop (kirana / retail)" | "Tell it your shop's name and type. No accounting words." (0:10) |
| 3 | GST question: "Yes, regular", then the date question, then **Start using Total** | "Say whether you charge GST, and from when you want to record." (0:25) |
| 4 | Home with its short tour card | "This is Home. Who owes you, what you owe, cash, bank, all in one place." (0:40) |
| 5 | Click **+ Sale**; Make a bill opens | "To make a bill, click plus Sale." (0:50) |
| 6 | Type a name in the Customer box; pick or create from the list | "Choose the customer, or leave it empty for a cash customer." (1:00) |
| 7 | Product box: type a product, set the quantity; price and GST chip appear | "Add what you sold. GST is worked out for you." (1:15) |
| 8 | **Paid how?** buttons: Cash, UPI, Card, Bank transfer, On credit (udhaar), Partly paid; pick one; the line under the total updates | "Pick how they paid. Credit is udhaar: Total remembers who owes you." (1:30) |
| 9 | Click **Save bill**; the save card appears with Print, Save as PDF, Share, Undo | "Save. Done. You can print, save a PDF, or share it. Made a mistake? Undo." (1:42) |
| 10 | Click **Print**; the TAX INVOICE document with business name and GST split | "That is a proper GST tax invoice, with the amount in words." (1:52) |
| 11 | Back on Home: the tile numbers moved; end card with `<download link>` | "Home already shows it. Link below." (2:00) |

Record on a fresh test company. Use made-up names and a round amount. Do not show real customer data.
