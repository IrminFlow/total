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

// WP 10.4: the same words in Hindi (Devanagari transliterations — and गोदाम, the word "godown"
// comes from) and in Hinglish's Latin spellings. Each maps to the English word it stands for, so
// the result reads the same whatever the language. Devanagari has no \b (its letters are not
// \w), so the Hindi patterns are bounded by "no letter or vowel sign on either side".
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{M}])'
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{M}])'
const hiWord = (alternatives: string): RegExp => new RegExp(`${NOT_LETTER_BEFORE}(?:${alternatives})${NOT_LETTER_AFTER}`, 'u')

export const TRANSLATED_PATTERNS: { word: (typeof BANNED_WORDS)[number]; re: RegExp }[] = [
  { word: 'voucher', re: hiWord('वाउचर(?:ों)?|वाऊचर') },
  { word: 'voucher', re: /\bvou?cha?rs?\b|\bvauchars?\b/i },
  { word: 'ledger', re: hiWord('लेजर|लेज़र|लेडजर') },
  { word: 'ledger', re: /\blej(?:a|e)rs?\b|\blegers?\b/i },
  { word: 'journal', re: hiWord('जर्नल|जरनल') },
  { word: 'journal', re: /\bjarnals?\b/i },
  { word: 'contra', re: hiWord('कॉन्ट्रा|कांट्रा|कोन्ट्रा') },
  { word: 'particulars', re: hiWord('पर्टिकुलर(?:्स)?|पार्टिकुलर(?:्स)?') },
  { word: 'narration', re: hiWord('नैरेशन|नरेशन') },
  { word: 'sundry', re: hiWord('संड्री|सन्ड्री|सनड्री') },
  { word: 'group', re: hiWord('ग्रुप|ग्रूप') },
  { word: 'ITC', re: hiWord('आईटीसी') },
  { word: 'set-off', re: hiWord('सेट[- ]?ऑफ़?|सेटऑफ़?') },
  { word: 'ageing', re: hiWord('एजिंग') },
  { word: 'godown', re: hiWord('गोडाउन|गोदाम') },
  { word: 'godown', re: /\bgod(?:a)?ams?\b/i },
  { word: 'BOM', re: hiWord('बीओएम') },
  { word: 'BRS', re: hiWord('बीआरएस') },
  { word: 'SOA', re: hiWord('एसओए') }
]

/** The banned words found in `text` (empty when clean). `allow` removes phrases first — a
 *  glossary entry may name its own term ("Your accountant calls it ITC"). */
export function bannedWordsIn(text: string, allow: readonly string[] = []): string[] {
  let scan = text
  for (const phrase of allow) {
    if (phrase) scan = scan.split(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ')
  }
  const found = PATTERNS.filter((p) => p.re.test(scan)).map((p) => p.word)
  for (const p of TRANSLATED_PATTERNS) if (!found.includes(p.word) && p.re.test(scan)) found.push(p.word)
  return found
}
