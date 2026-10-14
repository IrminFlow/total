# Hindi / Hinglish term table (WP 10.4)

Machine-drafted; first-pass native review done (WP 10.4 review, decisions below) — a second
native speaker should still read it before release (plan 2026-10-13, decision D6). Every simple-mode string in
`catalogues/hi.ts` (Devanagari) and `catalogues/hinglish.ts` (Latin script, everyday shop Hindi)
uses these words, so a screen never says the same thing two ways. Change a term here first, then
in both catalogues.

## Style

- **Hindi**: polite आप forms; buttons are short verbs ("बिल बनाएँ", "सेव करें"); simple everyday
  words over Sanskritised ones (खरीद, not क्रय; बिक्री, not विक्रय).
- **Hinglish**: Latin script, how a shopkeeper types on WhatsApp — Hindi grammar, English nouns
  where they are what people say ("bill", "stock", "payment", "GST"). Buttons are polite
  imperatives ending in -ein ("Bill banayein", "Save karein", "Kholein"). No Devanagari.
- Names stay as they are: Total, GST, GSTIN, HSN, SAC, TDS, TCS, PF, ESI, UPI, PAN, IFSC, PDF,
  CSV, Excel, WhatsApp, GSTR-1, GSTR-3B, CMP-08, ⌘ / Alt shortcuts.
- Amounts and dates arrive already formatted (`{amount}`, `{date}`) — never translate a variable
  name, a plural / select keyword (`plural`, `select`, `one`, `other`, `=0`) or a select branch key
  (`yes`, `profit`, `cash` …); translate only the text inside the branches. `#` stays.
- Hindi plural rule: 0 and 1 are both "one". Hindi nouns often do not change for the plural
  ("1 बिल", "5 बिल") — both branches may read the same.
- Banned (plan §1.2, `shared/simple/bannedWords.ts`): never write वाउचर, लेजर / लेज़र, जर्नल,
  कॉन्ट्रा, नैरेशन, पर्टिकुलर, संड्री, ग्रुप, गोडाउन / गोदाम, सेट-ऑफ, एजिंग, आईटीसी, बीओएम, बीआरएस, एसओए — nor
  their Latin spellings (voucher / vouchar, ledger / lejar, journal / jarnal, godam …).

## Terms

| English (en.ts)          | Hindi                 | Hinglish                |
| ------------------------ | --------------------- | ----------------------- |
| bill                     | बिल                   | bill                    |
| make a bill              | बिल बनाएँ             | Bill banayein           |
| sale / sales             | बिक्री                | sale / bikri            |
| purchase                 | खरीद                  | purchase / kharid       |
| customer                 | ग्राहक                | customer                |
| supplier                 | सप्लायर               | supplier                |
| customers owe you        | लेना बाकी             | Lena baaki              |
| you owe (suppliers)      | देना बाकी             | Dena baaki              |
| on credit (udhaar)       | उधार                  | udhaar                  |
| money in                 | पैसे आए               | Paise aaye              |
| money out                | पैसे गए               | Paise gaye              |
| move money               | पैसे एक जगह से दूसरी जगह | Paise transfer karein |
| payment                  | भुगतान                | payment                 |
| paid                     | चुकाया / भुगतान हुआ   | paid / chuka diya       |
| cash                     | नकद                   | cash                    |
| bank                     | बैंक                  | bank                    |
| account                  | खाता                  | account / khata         |
| entry                    | एंट्री                | entry                   |
| product / item           | सामान                 | item / saamaan          |
| stock                    | स्टॉक                 | stock / maal            |
| goods                    | माल                   | maal                    |
| stock count              | स्टॉक गिनती           | stock ginti             |
| made goods (manufacture) | तैयार माल             | taiyaar maal            |
| place (stock location)   | जगह                   | jagah                   |
| price / rate             | दाम                   | rate / daam             |
| quantity                 | मात्रा                | qty / maatra            |
| discount                 | छूट                   | discount                |
| amount                   | रकम                   | amount / rakam          |
| total                    | कुल                   | total / kul             |
| profit                   | मुनाफ़ा               | profit / munafa         |
| loss                     | घाटा                  | loss / ghaata           |
| expense                  | खर्च                  | kharcha                 |
| income                   | आमदनी                 | income / aamdani        |
| tax                      | टैक्स                 | tax                     |
| GST to pay               | भरने वाला GST         | GST bharna hai          |
| GST you paid on purchases| खरीद पर दिया GST      | purchase par diya GST   |
| return (goods back)      | वापसी                 | wapsi / return          |
| GST return (a form)      | रिटर्न                | return                  |
| refund                   | पैसे वापस             | refund / paise wapas    |
| advance                  | एडवांस                | advance                 |
| loan                     | लोन                   | loan                    |
| owner                    | मालिक                 | owner / maalik          |
| owner's money            | मालिक का पैसा         | owner ka paisa          |
| owner took money out     | मालिक ने पैसे निकाले  | owner ne paise nikaale  |
| accountant               | अकाउंटेंट             | accountant              |
| business                 | बिज़नेस               | business / dhandha      |
| date                     | तारीख                 | date / tareekh          |
| due date                 | आखिरी तारीख           | due date                |
| late / overdue           | देर से / तारीख निकल चुकी | late / date nikal gayi |
| reminder                 | याद दिलाना / रिमाइंडर | reminder / yaad dilana  |
| statement (bank)         | स्टेटमेंट             | statement               |
| report                   | रिपोर्ट               | report                  |
| backup                   | बैकअप                 | backup                  |
| settings                 | सेटिंग्स              | Settings                |
| help                     | मदद                   | Help / madad            |
| Home                     | होम                   | Home                    |
| full app                 | पूरा ऐप               | full app                |
| simple                   | आसान                  | simple / aasaan         |
| Ask Total                | Total से पूछें        | Total se poochhein      |
| Why?                     | क्यों?                | Kyun?                   |
| save                     | सेव करें              | Save karein             |
| cancel                   | रद्द करें             | Cancel karein           |
| close                    | बंद करें              | Band karein             |
| undo                     | वापस लें              | Undo karein             |
| edit                     | बदलें                 | Edit karein             |
| print                    | प्रिंट करें           | Print karein            |
| search                   | खोजें                 | Search karein           |
| draft (not counted)      | ड्राफ़्ट — गिना नहीं गया | draft — gina nahi gaya |
| bin                      | बिन (हटाई गई चीज़ें)  | bin                     |
| day one (openings)       | पहला दिन              | pehla din               |
| AI helper                | AI मददगार             | AI helper               |
| Accountant view (toggle)  | अकाउंटेंट व्यू         | Accountant view         |
| Back to simple (button)  | आसान स्क्रीन पर लौटें  | Simple screen par lautein |
| Not sure (wizard answer) | पक्का नहीं            | Pakka nahi              |
| People (screen)          | पार्टी                 | Party                   |
| Features (Settings)      | सुविधाएँ              | Features                |
| Help & tour / tour       | मदद और टूर / टूर      | Help aur tour / tour    |
| How Total looks          | Total कैसा दिखे        | Total kaisa dikhe       |
| People & roles (users)   | यूज़र और उनके अधिकार   | Users aur unke adhikaar |
| Bills & printing         | बिल और प्रिंट          | Bill aur print          |
| Record a purchase        | खरीद लिखें             | Purchase likhein        |
| Return a sale / purchase | बिक्री की वापसी / खरीद की वापसी | Sale return / Purchase return |
| Count your stock         | स्टॉक गिनें            | Stock ginein            |
| Running low (nav entry)  | कम बचा माल            | Kam bacha maal          |
| Cash in the next 30 days | अगले 30 दिन में नकद    | Agle 30 din mein cash   |
| Partly paid — purchase   | कुछ चुकाया            | Thoda chukaya           |
| Partly paid — sale       | कुछ पैसे मिले          | Thode paise mile        |
| Paid by — purchase       | कैसे चुकाया            | Kaise chukaya           |
| Paid by — sale           | कैसे मिले              | Kaise mile              |
| profit and loss (report) | मुनाफ़ा-घाटा           | profit-loss             |
| your books               | आपका हिसाब            | aapka hisaab            |
| walk-in / cash customer  | नकद ग्राहक            | Cash customer           |
| GST rate                 | GST रेट (prints: GST दर) | GST rate             |
| GST you collected        | आपने जो GST वसूला       | Aapne jo GST collect kiya       |
| TDS (tax deducted at source) | TDS (स्रोत पर काटा गया टैक्स) | TDS (source par kaata gaya tax) |
| TCS (tax collected at source) | TCS (स्रोत पर लिया गया टैक्स) | TCS (source par liya gaya tax) |
| ARN                      | पावती नंबर (ARN)       | Acknowledgement number (ARN) |
| Why this number?         | यह आँकड़ा क्यों?       | Yeh figure kyun?        |
| figure(s)                | आँकड़ा / आँकड़े (always with ँ) | figure(s)        |
| credit hold              | रोक (रोक लगाएँ / रोक लगी है) | hold (Hold par)  |
| kind of account (not "group") | खाते की किस्म      | account ki kism         |

## Decisions from the consistency pass (WP 10.4 review)

- **A label quoted inside a sentence uses the label's own words**, inside “…” (e.g. “सुविधाएँ”, “पैसे आए”,
  “आसान स्क्रीन पर लौटें”, “पार्टी”). Hinglish quotes the screen name too — “Party”.
- **Screens of the full app that are still English** (Settings → Backups: Export encrypted…, Restore…,
  Import encrypted backup…; Assistants; Manufacture) are quoted in English in Hindi text and help, with a
  Hindi gloss in brackets where useful.
- **What the user says is gender-neutral**: no "मैं … करता/करती हूँ", "समझ गया" or "kar raha hoon" in
  answers and buttons. Use the plural/noun form instead — "हाँ, स्टॉक रखते हैं", "माल बनाना
  (मैन्युफ़ैक्चरिंग)", "नहीं, शुरुआत Total से ही", "ठीक है, समझ आ गया" / "Theek hai, samajh aa gaya".
  Past forms with ने ("मैंने नया शुरू किया", "मैंने फ़ाइल कर दिया") are already neutral. Total itself speaks
  in the masculine ("Total … करता है", "मैं … नहीं दे सकता") — it is the app's name.
- **Direction of money**: a line shown for both customers and suppliers never says who pays —
  "{days} दिन में आखिरी तारीख" / "{days} din mein due", "आखिरी तारीख आज". "Who still has to pay" =
  "किसने अभी पैसे नहीं दिए" (not "किसे पैसे देने हैं", which means "whom you have to pay").

- People (customers + suppliers) in Hinglish = **Party** (what shops say; "Log" read as the English word log). Users of the app = Users.

## Native-review decisions (WP 10.4 review, first pass)

The PR's 28 "needs native review" phrases, resolved. Changed ones are in both catalogues and the
help; "kept" means the draft reads right to a native speaker.

| Phrase | Decision |
| --- | --- |
| People (nav / screen) | **पार्टी** in Hindi too (as in Hinglish "Party") — what every trader says; "लोग" was also used for app users, so the two screens read the same. App users = **यूज़र** ("यूज़र और उनके अधिकार"). |
| Accountant view | kept "अकाउंटेंट व्यू" (a toggle name; the help glosses it). |
| Move money | kept "पैसे एक जगह से दूसरी जगह" (used on 7 labels and the help; long but unambiguous). |
| ठीक है, समझ आ गया / हाँ, स्टॉक रखते हैं / माल बनाना (मैन्युफ़ैक्चरिंग) / नहीं, शुरुआत Total से ही | kept — natural and gender-neutral. |
| due in / due today (both sides) | kept "{days} दिन में आखिरी तारीख" / "आखिरी तारीख आज" — says no direction, right for customers and suppliers. |
| creditHeld (purchase return) | kept — "{name} पर आपके {amount} वापस बाकी हैं" is the supplier owing you, as the English. |
| tour.sale | kept (fixed in the draft). |
| walk-in = नकद ग्राहक | kept — the counter customer who pays now, whatever the method; it is the word shops use. |
| ARN = पावती नंबर (ARN) | kept with "(ARN)": पावती is on the portal's own Hindi pages; the code makes it findable. |
| TCS (स्रोत पर लिया गया टैक्स) | kept — plain; the official "स्रोत पर कर संग्रह" is government register. |
| GST you collected | **वसूला** (as in every Why sentence), not "लिया" (which also reads "took from"). Hinglish "collect kiya". |
| Partly paid / Paid by | split by side: purchase "कुछ चुकाया / कैसे चुकाया"; **sale "कुछ पैसे मिले / कैसे मिले"** (the customer pays — "चुकाया" read as if you paid). Hinglish "Thoda paid" → "Thoda chukaya" / "Thode paise mile". |
| Spacing = दूरी | kept ("जगह" is the stock-place word); quoted labels fixed to match. |
| peopleRoles = अधिकार | kept "अधिकार", with यूज़र (above). |
| depreciation = घिसाई (डेप्रिसिएशन) | kept. |
| input tax without "ITC" | "…वापस क्लेम कर सकते हैं" / "…GST में से घटा सकते हैं" kept; the one gloss that said "माल और सेवा कर" now says "वस्तु एवं सेवा कर" like the rest. |
| bank match "यह {date} की {name} है" | fixed — "{date} की एंट्री {name}" (the name can be masculine). |
| kind of account = किस्म | kept. |
| assist.suggest.entry "चाय के 500 नकद दिए" | kept; Ask Total now reads Devanagari questions (classify.ts), and every suggestion chip in every language is tested to be understood. |
| "key" in English | kept, made "AI key" (assist.panel.sub) so it is not read as a door key. |
| print Dr / Cr | **"देना है / लेना है"** (dena hai / lena hai) — from the reader's (the party's) side. "एडवांस" for Cr was wrong on a supplier's balance (we owe them). No नामे / जमा on balances. Receipt / payment prints head their LINES "नामे / जमा" (a voucher's two sides; the statement's "बिल / चुकाया" were wrong there). A supplier's statement swaps the columns (their bills are the credit side). |
| print titles | kept "आपका हमारे साथ हिसाब", "भुगतान पर्ची", "बिक्री वापसी (CREDIT NOTE)"; legal titles stay English. "Original for Recipient" keeps the rule 48 English: "ORIGINAL FOR RECIPIENT (ग्राहक की कॉपी)". |
| amount in words | spellings kept (उन्यासी, उनहत्तर, ऋण); **"मात्र" at the end, not "केवल"** — Hindi bills and cheques write "… रुपये मात्र" ("केवल" would go before the amount). Paise alone: "पाँच पैसे मात्र". Hinglish keeps no "only". |
| dates | **full month names in Hindi dates** (1 अक्तूबर 2026): the clipped forms without ॰ are other words (जन = people, नव = new). Chart axes use the short forms WITH ॰ (जन॰, अक्तू॰). Latin digits everywhere (Indian apps and prints use them). |
| Numbers | Latin digits in both languages — money.ts formats them; no Devanagari digits. |

