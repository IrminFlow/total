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
  'simple.people.msg.thanks': 'अगर आप भुगतान कर चुके हैं, तो धन्यवाद — इस संदेश को अनदेखा करें।'
}
