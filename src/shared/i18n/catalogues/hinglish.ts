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
  'assist.panel.byTotal': 'Total ne khud jawab diya',
  'assist.panel.ask': 'Poochhein',
  'assist.home.ask': 'Poochhein',
  'assist.unknown': 'Iska jawab abhi nahi de sakta. Inme se koi poochh kar dekhiye:',
  'assist.figure.profit': '{period} aapka profit {amount} hua.',
  'assist.figure.loss': '{period} aapko {amount} ka nuksan hua.',
  'assist.money.cash': 'Galle mein {amount} cash hai.',
  'assist.entry.notSaved': 'Abhi kuch save nahi hua — {screen} kholiye, check kijiye aur Save dabaiye.',
  'simple.people.msg.thanks': 'Agar aap payment kar chuke hain, to dhanyavaad — is message ko ignore karein.'
}
