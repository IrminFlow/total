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
  'settings.language.title': 'भाषा'
}
