// Hinglish (Hindi in Latin script, mixed with everyday English) — a STUB until Phase 10.
// Same rules as hi.ts: keys optional, en fallback per key, no key outside `en`, same variables.

import type { MessageKey } from './en'

export const hinglish: Partial<Record<MessageKey, string>> = {
  'common.save': 'Save karein',
  'common.search': 'Search karein',
  'simple.home.moneyIn': 'Paise aaye',
  'simple.home.moneyOut': 'Paise gaye',
  'simple.home.customersOwe': 'Lena baaki',
  'simple.home.youOweSuppliers': 'Dena baaki',
  'palette.searching': 'Dhoondh rahe hain…',
  'palette.empty': 'Koi command ya match nahi mila',
  'settings.language.title': 'Bhasha',
  'simple.people.msg.hello': 'Namaste {party} ji,',
  'simple.people.msg.gentle': '{company} ki taraf se ek yaad: {amount} ka payment baaki hai aur uski date nikal chuki hai.',
  'simple.people.msg.firm': '{company} ki taraf se dobara yaad: {amount} abhi bhi baaki hai, sabse purana bill {days, plural, one {# din} other {# din}} late hai.',
  'simple.people.msg.final': '{company} ki taraf se aakhri yaad: {amount} {days, plural, one {# din} other {# din}} se baaki hai. Kripya 7 din mein payment kar dein.',
  'simple.people.msg.bill': '• Bill {bill}, {date}: {amount}',
  'simple.people.msg.more': '…aur {count, plural, one {# bill} other {# bill}}',
  'simple.people.msg.thanks': 'Agar aap payment kar chuke hain, to dhanyavaad — is message ko ignore karein.',
  // WP 10.2 — "Why?" sentences
  'simple.why.link.pnl': '{from} se {to} tak ki profit-loss report kholein',
  'simple.why.link.cashToday': 'Aaj har account ka balance dekhein',
  'simple.why.link.forecast': 'Poora cash forecast kholein',
  'simple.why.link.outstandings': 'Har khula bill, har party ke hisaab se dekhein',
  'simple.why.link.registers': 'Sales aur purchase ki list kholein',
  'simple.why.link.gstr1': 'Full app mein GSTR-1 kholein',
  'simple.why.link.gstr3b': 'Full app mein GSTR-3B kholein',
  'simple.why.link.tds': 'Full app mein TDS kholein',
  'simple.why.link.tcs': 'Full app mein TCS kholein',
  'simple.why.link.payroll': 'Full app mein payroll kholein',
  'simple.why.home.profit':
    '{from} se aaj tak aapne {sales} ki sale ki; maal ki laagat {cost} rahi{hasOther, select, yes {, doosri income {other} judi} other {}}{hasExpenses, select, yes { aur chalane ke kharche {expenses} rahe} other {}}, isliye {result, select, profit {profit {amount} hai} loss {loss {amount} hai} other {na profit hai na loss}}.',
  'simple.why.home.stockUp': 'Profit sale minus purchase se zyada hai, kyunki aapka khareeda hua {amount} ka maal shuru se zyada abhi bhi dukaan mein rakha hai.',
  'simple.why.home.stockDown': 'Profit sale minus purchase se kam hai, kyunki aapne shuru mein rakhe maal mein se bhi {amount} ka maal becha.',
  'simple.why.home.topExpense': 'Sabse bada kharcha {name} raha: {amount}.',
  'simple.why.compare':
    '{when, select, month {Is mahine ka result} other {Result}} {when, select, month {pichhle mahine ke inhi dinon} other {pichhli period}} ({from} se {to}) {dir, select, up {se {amount} behtar hai} down {se {amount} kamzor hai} other {jaisa hi hai}}{part, select, sales {, zyadatar isliye ki sale {partAmount} {partDir, select, up {badhi} other {ghati}}} costOfGoods {, zyadatar isliye ki maal ki laagat {partAmount} {partDir, select, up {badhi} other {ghati}}} otherIncome {, zyadatar isliye ki doosri income {partAmount} {partDir, select, up {badhi} other {ghati}}} expenses {, zyadatar isliye ki chalane ke kharche {partAmount} {partDir, select, up {badhe} other {ghate}}} other {}}.',
  'simple.why.deadline.tds': 'Kisi mahine mein kaata gaya TDS (source par kaata gaya tax) agle mahine ki 7 tareekh tak sarkar ko jama hota hai, aur March ka 30 April tak. Agli tareekh {date} hai.',
  'simple.why.deadline.pf': 'Pichhle mahine ki salary ka PF (provident fund) {date} tak jama hota hai; kitna, yeh payroll screen batati hai.',
  'simple.why.deadline.esi': 'Pichhle mahine ki salary ka ESI (employees’ state insurance) {date} tak jama hota hai; kitna, yeh payroll screen batati hai.',
  'simple.why.deadline.advanceTax': 'Is saal ke profit par income tax saal bhar kishton mein bhara jaata hai (advance tax). Agli kisht {date} ko hai; amount aapke CA batate hain.',
  'simple.why.deadline.other': '{form} ki tareekh {date} hai.',
  'simple.why.cash.in': '{date} tak lagbhag {amount} aane chahiye: {list}.',
  'simple.why.cash.out': '{date} tak lagbhag {amount} jaane chahiye: {list}.',
  'simple.why.cash.inNone': '{date} tak kuch aane ki ummeed nahi hai.',
  'simple.why.cash.outNone': '{date} tak kuch jaane ki ummeed nahi hai.',
  'simple.why.cash.biggestIn': 'Sabse badi amount: {name}, lagbhag {amount}, {date} ko.',
  'simple.why.cash.biggestOut': 'Sabse badi amount: {name}, lagbhag {amount}, {date} ko.',
  'simple.why.cash.end': 'Aaj {now}, lagbhag {in} aayenge aur lagbhag {out} jaayenge, to {date} ko lagbhag {end} bachenge.',
  'simple.why.cash.belowZero': '{date} ko yeh zero se {amount} neeche chala jaayega — usse pehle intezaam kar lein.',
  'simple.why.owed.biggestReceivable': 'Sabse zyada {name} par baaki hai: {amount}.',
  'simple.why.owed.biggestPayable': 'Sabse zyada aapko {name} ko dena hai: {amount}.',
  'simple.why.byMonth.change': '{month} mein sale {previous} {dir, select, up {se {amount} zyada rahi} down {se {amount} kam rahi} other {jitni hi rahi}}.',
  'simple.why.taxes.toPay':
    'Aapne jo {collected} collect kiye, unmein se {used} aapki purchase par diye GST se cover ho jaate hain, to {cash} bachte hain{rcm, select, yes {; reverse charge ke {rcmAmount} (jo hamesha cash mein bhare jaate hain) milakar {total}} other {}} — {date} tak bharne hain.',
  'simple.why.taxes.toPayRcmOnly': 'Aapki purchase par diya GST collect kiye GST ko cover kar deta hai; reverse charge ke {amount} hamesha cash mein bhare jaate hain — {date} tak.',
  'simple.why.taxes.creditLeft': 'Aapki purchase par diye GST mein se {amount} bache hain; yeh agle return mein kaam aayenge.',
  'simple.why.due.gstr1':
    'GSTR-1 mein {period} ke har sale bill ki list hoti hai; iski tareekh {date} hai{quarterly, select, yes {, quarter ke baad ki 13 tareekh, kyunki aap har teen mahine mein bharte hain} other {, agle mahine ki 11 tareekh}}.',
  'simple.why.due.gstr3b':
    'GSTR-3B mein {period} ka total hota hai aur iske saath {amount} ka payment jaata hai; iski tareekh {date} hai{quarterly, select, yes {, quarter ke baad ki 22 ya 24 tareekh, aapke state ke hisaab se} other {, agle mahine ki 20 tareekh}}.',
  'simple.why.due.pmt06': 'Har teen mahine mein bharne par bhi, quarter ke pehle do mahinon ka GST agle mahine ki 25 tareekh tak bharna hota hai (form PMT-06): {dates}.',
  'simple.why.due.cmp08': 'Composition mein aap apni sale ka tay hissa bharte hain; CMP-08 mein {from} se {to} ka hisaab hota hai aur iski tareekh {date} hai, quarter ke baad ki 18 tareekh.',
  'simple.why.due.gstr4': 'GSTR-4 {fy} ka saalana return hai; iski tareekh {date} hai.',
  'simple.why.withholding':
    '{kind, select, tds {Aapka kaata hua TDS} other {Aapka collect kiya TCS}} sarkar ka paisa hai jo bharne tak aapke paas rehta hai: {total} bharna baaki hai{late, select, yes {, jismein se {lateAmount} ki tareekh nikal chuki hai} other {}}.',
  'simple.why.withholdingAllPaid': 'Ab tak {kind, select, tds {kaata hua} other {collect kiya}} sab bhar diya gaya hai; is mahine ke {amount} ki tareekh {date} hai.',
  'simple.why.withholdingOldest': 'Sabse purana {month} ka hai, tareekh {date}.'
}
