// Hindi catalogue — a STUB until Phase 10 (plan 2026-10-13 §7, WP 10.x). Every key is optional:
// a key missing here falls back to `en` (index.ts), so a half-translated screen still reads.
// A key that is not in `en` is a type error and fails the parity test. Keep the variables of the
// `en` message (the parity test checks them too).

import type { MessageKey } from './en'

export const hi: Partial<Record<MessageKey, string>> = {
  'common.save': 'सेव करें',
  'common.cancel': 'रद्द करें',
  'common.search': 'खोजें',
  'simple.nav.home': 'होम',
  'simple.home.moneyIn': 'पैसे आए',
  'simple.home.moneyOut': 'पैसे गए',
  'simple.home.customersOwe': 'लेना बाकी',
  'simple.home.youOweSuppliers': 'देना बाकी',
  'palette.placeholder': 'कमांड लिखें, या बही में खोजें — नाम, नंबर, GSTIN, रकम…',
  'palette.searching': 'खोज रहे हैं…',
  'palette.empty': 'कोई कमांड या नतीजा नहीं मिला',
  'settings.language.title': 'भाषा',
  'simple.people.msg.hello': 'नमस्ते {party} जी,',
  'simple.people.msg.gentle': '{company} की ओर से एक याद: {amount} का भुगतान बाकी है और उसकी तारीख निकल चुकी है।',
  'simple.people.msg.firm': '{company} की ओर से दोबारा याद: {amount} अभी भी बाकी है, सबसे पुराना बिल {days, plural, one {# दिन} other {# दिन}} देर से है।',
  'simple.people.msg.final': '{company} की ओर से आखिरी याद: {amount} {days, plural, one {# दिन} other {# दिन}} से बाकी है। कृपया 7 दिन में भुगतान करें।',
  'simple.people.msg.bill': '• बिल {bill}, {date}: {amount}',
  'simple.people.msg.more': '…और {count, plural, one {# बिल} other {# बिल}}',
  'simple.people.msg.thanks': 'अगर आप भुगतान कर चुके हैं, तो धन्यवाद — इस संदेश को अनदेखा करें।',
  // WP 10.2 — "Why?" sentences
  'simple.why.link.pnl': '{from} से {to} तक की लाभ-हानि रिपोर्ट खोलें',
  'simple.why.link.cashToday': 'आज हर खाते का बैलेंस देखें',
  'simple.why.link.forecast': 'पूरा कैश अनुमान खोलें',
  'simple.why.link.outstandings': 'हर खुला बिल, हर पार्टी के हिसाब से देखें',
  'simple.why.link.registers': 'बिक्री और खरीद की सूची खोलें',
  'simple.why.link.gstr1': 'पूरे ऐप में GSTR-1 खोलें',
  'simple.why.link.gstr3b': 'पूरे ऐप में GSTR-3B खोलें',
  'simple.why.link.tds': 'पूरे ऐप में TDS खोलें',
  'simple.why.link.tcs': 'पूरे ऐप में TCS खोलें',
  'simple.why.link.payroll': 'पूरे ऐप में पेरोल खोलें',
  'simple.why.home.profit':
    '{from} से आज तक आपने {sales} की बिक्री की; माल की लागत {cost} रही{hasOther, select, yes {, दूसरी आमदनी {other} जुड़ी} other {}} और चलाने के खर्च {expenses} रहे, इसलिए {result, select, profit {मुनाफ़ा {amount} है} loss {घाटा {amount} है} other {न मुनाफ़ा है न घाटा}}।',
  'simple.why.home.stockUp': 'मुनाफ़ा बिक्री घटा खरीद से ज़्यादा है, क्योंकि आपका खरीदा हुआ {amount} का माल शुरुआत से ज़्यादा अभी भी दुकान में रखा है।',
  'simple.why.home.stockDown': 'मुनाफ़ा बिक्री घटा खरीद से कम है, क्योंकि आपने शुरुआत में रखे माल में से भी {amount} का माल बेचा।',
  'simple.why.home.topExpense': 'सबसे बड़ा खर्च {name} रहा: {amount}।',
  'simple.why.compare':
    '{when, select, month {इस महीने का नतीजा} other {नतीजा}} {when, select, month {पिछले महीने के इन्हीं दिनों} other {पिछली अवधि}} ({from} से {to}) {dir, select, up {से {amount} बेहतर है} down {से {amount} कमज़ोर है} other {जैसा ही है}}{part, select, sales {, ज़्यादातर इसलिए कि बिक्री {partAmount} {partDir, select, up {बढ़ी} other {घटी}}} costOfGoods {, ज़्यादातर इसलिए कि माल की लागत {partAmount} {partDir, select, up {बढ़ी} other {घटी}}} otherIncome {, ज़्यादातर इसलिए कि दूसरी आमदनी {partAmount} {partDir, select, up {बढ़ी} other {घटी}}} expenses {, ज़्यादातर इसलिए कि चलाने के खर्च {partAmount} {partDir, select, up {बढ़े} other {घटे}}} other {}}।',
  'simple.why.deadline.tds': 'किसी महीने में काटा गया TDS (स्रोत पर काटा गया टैक्स) अगले महीने की 7 तारीख तक सरकार को जमा होता है, और मार्च का 30 अप्रैल तक। अगली तारीख {date} है।',
  'simple.why.deadline.pf': 'पिछले महीने की तनख्वाह का PF (भविष्य निधि) {date} तक जमा होता है; कितना, यह पेरोल स्क्रीन बताती है।',
  'simple.why.deadline.esi': 'पिछले महीने की तनख्वाह का ESI (कर्मचारी राज्य बीमा) {date} तक जमा होता है; कितना, यह पेरोल स्क्रीन बताती है।',
  'simple.why.deadline.advanceTax': 'इस साल के मुनाफ़े पर इनकम टैक्स साल के दौरान किस्तों में भरा जाता है (एडवांस टैक्स)। अगली किस्त {date} को है; रकम आपके CA तय करते हैं।',
  'simple.why.deadline.other': '{form} की तारीख {date} है।',
  'simple.why.cash.in': '{date} तक लगभग {amount} आने चाहिए: {list}।',
  'simple.why.cash.out': '{date} तक लगभग {amount} जाने चाहिए: {list}।',
  'simple.why.cash.inNone': '{date} तक कुछ आने की उम्मीद नहीं है।',
  'simple.why.cash.outNone': '{date} तक कुछ जाने की उम्मीद नहीं है।',
  'simple.why.cash.biggestIn': 'सबसे बड़ी रकम: {name}, लगभग {amount}, {date} को।',
  'simple.why.cash.biggestOut': 'सबसे बड़ी रकम: {name}, लगभग {amount}, {date} को।',
  'simple.why.cash.end': 'आज {now}, लगभग {in} आएँगे और लगभग {out} जाएँगे, तो {date} को लगभग {end} बचेंगे।',
  'simple.why.cash.belowZero': '{date} को यह शून्य से {amount} नीचे चला जाएगा — उससे पहले इंतज़ाम कर लें।',
  'simple.why.owed.biggestReceivable': 'सबसे ज़्यादा {name} पर बाकी है: {amount}।',
  'simple.why.owed.biggestPayable': 'सबसे ज़्यादा आपको {name} को देना है: {amount}।',
  'simple.why.byMonth.change': '{month} में बिक्री {previous} {dir, select, up {से {amount} ज़्यादा रही} down {से {amount} कम रही} other {जितनी ही रही}}।',
  'simple.why.taxes.toPay':
    'आपने जो {collected} वसूले, उनमें से {used} आपकी खरीद पर दिए GST से पूरे हो जाते हैं, तो {cash} बचते हैं{rcm, select, yes {; रिवर्स चार्ज के {rcmAmount} (जो हमेशा नकद भरे जाते हैं) मिलाकर {total}} other {}} — {date} तक भरने हैं।',
  'simple.why.taxes.toPayRcmOnly': 'आपकी खरीद पर दिया GST वसूले गए GST को पूरा कर देता है; रिवर्स चार्ज के {amount} हमेशा नकद भरे जाते हैं — {date} तक।',
  'simple.why.taxes.creditLeft': 'आपकी खरीद पर दिए GST में से {amount} बचे हैं; ये अगले रिटर्न में काम आएँगे।',
  'simple.why.due.gstr1':
    'GSTR-1 में {period} के हर बिक्री बिल की सूची होती है; इसकी तारीख {date} है{quarterly, select, yes {, तिमाही के बाद की 13 तारीख, क्योंकि आप हर तीन महीने में भरते हैं} other {, अगले महीने की 11 तारीख}}।',
  'simple.why.due.gstr3b':
    'GSTR-3B में {period} का जोड़ होता है और इसके साथ {amount} का भुगतान जाता है; इसकी तारीख {date} है{quarterly, select, yes {, तिमाही के बाद की 22 या 24 तारीख, आपके राज्य के हिसाब से} other {, अगले महीने की 20 तारीख}}।',
  'simple.why.due.pmt06': 'हर तीन महीने में भरने पर भी, तिमाही के पहले दो महीनों का GST अगले महीने की 25 तारीख तक भरना होता है (फ़ॉर्म PMT-06): {dates}।',
  'simple.why.due.cmp08': 'कंपोज़िशन में आप अपनी बिक्री का तय हिस्सा भरते हैं; CMP-08 में {from} से {to} का हिसाब होता है और इसकी तारीख {date} है, तिमाही के बाद की 18 तारीख।',
  'simple.why.due.gstr4': 'GSTR-4 {fy} का सालाना रिटर्न है; इसकी तारीख {date} है।',
  'simple.why.withholding':
    '{kind, select, tds {आपका काटा हुआ TDS} other {आपका वसूला हुआ TCS}} सरकार का पैसा है जो भरने तक आपके पास रहता है: {total} भरना बाकी है{late, select, yes {, जिसमें से {lateAmount} की तारीख निकल चुकी है} other {}}।',
  'simple.why.withholdingAllPaid': 'अब तक {kind, select, tds {काटा हुआ} other {वसूला हुआ}} सब भर दिया गया है; इस महीने के {amount} की तारीख {date} है।',
  'simple.why.withholdingOldest': 'सबसे पुराना {month} का है, तारीख {date}।'
}
