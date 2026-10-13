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
  'settings.language.title': 'Bhasha'
}
