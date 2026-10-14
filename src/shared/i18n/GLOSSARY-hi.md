# Hindi / Hinglish term table (WP 10.4)

Machine-drafted, pending native review (plan 2026-10-13, decision D6). Every simple-mode string in
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
  कॉन्ट्रा, नैरेशन, पर्टिकुलर, संड्री, ग्रुप, गोडाउन / गोदाम, सेट-ऑफ, एजिंग, आईटीसी, बीओएम — nor
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
