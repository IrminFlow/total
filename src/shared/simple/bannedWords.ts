// The plan §1.2 banned list (2026-10-13 simple-for-everyone plan): accounting vocabulary that
// must never appear in a simple-mode string. Checked by i18n.test.ts over the `common.*`,
// `simple.*` and `errors.*` catalogue values, and by glossary.test.ts over plain words.
//
// GST, GSTIN, HSN and TDS are NOT banned (the law makes them unavoidable) — a screen writes them
// out the first time it uses them.

export const BANNED_WORDS = [
  'voucher',
  'ledger',
  'journal',
  'contra',
  'Dr/Cr',
  'particulars',
  'narration',
  'sundry',
  'group',
  'ITC',
  'set-off',
  'ageing',
  'BRS',
  'godown',
  'BOM',
  'SOA'
] as const

// One pattern per banned word, word-bounded, plurals and common spellings included. Dr / Cr
// are case-sensitive (so "dry" or "credit" never match); note "Cr" also catches a crore suffix,
// which simple strings must spell out ("crore") anyway.
const PATTERNS: { word: (typeof BANNED_WORDS)[number]; re: RegExp }[] = [
  { word: 'voucher', re: /\bvouchers?\b/i },
  { word: 'ledger', re: /\bledgers?\b/i },
  { word: 'journal', re: /\bjournals?\b/i },
  { word: 'contra', re: /\bcontras?\b/i },
  { word: 'Dr/Cr', re: /\b(?:Dr|Cr)\b/ },
  { word: 'particulars', re: /\bparticulars?\b/i },
  { word: 'narration', re: /\bnarrations?\b/i },
  { word: 'sundry', re: /\bsundry\b/i },
  { word: 'group', re: /\bgroups?\b/i },
  { word: 'ITC', re: /\bITC\b/i },
  { word: 'set-off', re: /\bset[- ]?offs?\b/i },
  { word: 'ageing', re: /\bag(?:e)?ing\b/i },
  { word: 'BRS', re: /\bBRS\b/i },
  { word: 'godown', re: /\bgodowns?\b/i },
  { word: 'BOM', re: /\bBOMs?\b/i },
  { word: 'SOA', re: /\bSOA\b/i }
]

/** The banned words found in `text` (empty when clean). `allow` removes phrases first — a
 *  glossary entry may name its own term ("Your accountant calls it ITC"). */
export function bannedWordsIn(text: string, allow: readonly string[] = []): string[] {
  let scan = text
  for (const phrase of allow) {
    if (phrase) scan = scan.split(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ')
  }
  return PATTERNS.filter((p) => p.re.test(scan)).map((p) => p.word)
}
