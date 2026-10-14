// Ask Total — the question classifier (WP 10.1). PURE: no DB, no network, no model.
//
// A question is lower-cased, its Hinglish / Hindi words are read into the English the rest of the
// app already understands ("is mahine" → "this month", "munafa" → "profit", "kitna" → "how much"),
// a few common typos are fixed, and then ONE of a fixed list of intents is picked with its slots
// (names and words as typed — main resolves them through the search service). Periods and
// measures go through the WP 5.5 deterministic phrase mapper (reportBuilder/nl.ts
// parseReportQuestion: relative periods, "in <month>"); amounts only through money.ts
// parseAmountText; dates only through dates.ts resolveDateText against the working date.
//
// Anything not recognised is `unknown` — the answer then offers suggestions and a help search,
// never a guess.
import type { AssistEntrySlots, AssistHowTo, AssistIntent, AssistMeasure, AssistPeriod, AssistPeriodRule } from '@shared/assist'
import type { MoneyHow } from '@shared/simple/intents'
import { parseAmountText } from '@shared/money'
import { addDaysISO, fyOf, resolveDateText } from '@shared/dates'
import { parseReportQuestion } from '@shared/reportBuilder/nl'
import { monthEnd, relativePeriod } from '@shared/reportBuilder/period'
import type { RelativePeriod } from '@shared/reportBuilder/model'

// ---------------------------------------------------------------- normalising

/** A Devanagari word on its own (JS \\b does not see Devanagari letters as word characters). */
function dv(words: string): RegExp {
  return new RegExp(`(?<=^|\\s)(?:${words})(?=\\s|$)`, 'g')
}

/** Hinglish / Hindi phrases → the English the matchers read. Longest first; word-bounded. */
const PHRASES: [RegExp, string][] = [
  [/\b(?:is|iss|ish|es)\s+(?:mahine|mahina|mahene|month)\b/g, 'this month'],
  [/\b(?:pichle|pichhle|pichla|pichhla|picchle|last)\s+(?:mahine|mahina|mahene)\b|\bpichle\s+month\b|\bpichhle\s+month\b/g, 'last month'],
  [/\b(?:is|iss|es)\s+(?:saal|sal|varsh|year)\b/g, 'this year'],
  [/\b(?:pichle|pichhle|pichla|pichhla|last)\s+(?:saal|sal|varsh)\b|\bpichle\s+year\b/g, 'last year'],
  [dv('इस\\s+महीने'), 'this month'],
  [dv('पिछले\\s+महीने'), 'last month'],
  [dv('इस\\s+साल'), 'this year'],
  [/\b(?:piad|payed|paied|pai)\b/g, 'paid'],
  [/\b(?:recived|recieved|recevied)\b/g, 'received'],
  [/\bparso\b/g, 'day before yesterday'],
  [dv('परसों'), 'day before yesterday'],
  [/\baaj\b|\baj\b/g, 'today'],
  [dv('आज'), 'today'],
  [/\bkal\b/g, 'yesterday'],
  [dv('कल'), 'yesterday'],
  [/\b(?:munafa|munaafa|munafaa|fayda|faayda|fayeda|faida|kamai|kamaai|kamayi|labh)\b/g, 'profit'],
  [dv('मुनाफ़ा|मुनाफा|लाभ|कमाई'), 'profit'],
  [/\b(?:nuksan|nuksaan|nuqsan|ghata|ghaata)\b/g, 'loss'],
  [dv('नुकसान|घाटा'), 'loss'],
  [/\b(?:bikri|bikree|bikkri)\b/g, 'sales'],
  [dv('बिक्री'), 'sales'],
  [/\b(?:kitna|kitni|kitne|kitnaa|ketna)\b/g, 'how much'],
  [dv('कितना|कितनी|कितने'), 'how much'],
  [/\b(?:kaun|kon|kaon)\b/g, 'who'],
  [dv('कौन'), 'who'],
  [/\b(?:nakad|nagad|nakd|galla|galle|gulla|gulle)\b/g, 'cash'],
  [dv('नकद|नक़द'), 'cash'],
  [dv('स्टॉक'), 'stock'],
  [dv('बैंक'), 'bank'],
  [dv('जीएसटी'), 'gst'],
  [dv('बकाया'), 'baki'],
  [dv('खर्च|खर्चा|खर्चे'), 'kharcha'],
  [dv('मिला|मिले|मिली'), 'mila'],
  [dv('दिया|दिए|दिये'), 'diya'],
  [dv('बेचा|बेचे|बेची'), 'becha'],
  [dv('भेजा|भेजे|भेजी'), 'bheja'],
  [dv('लिया'), 'liya'],
  [dv('खरीदा|खरीदे|खरीदी'), 'kharida'],
  [dv('रुपये|रुपए|रुपया'), 'rupees'],
  [dv('को'), 'ko'],
  [dv('से'), 'se'],
  [dv('ने'), 'ne'],
  [dv('का|के|की'), 'ka'],
  [dv('है|हैं'), 'hai']
]

/** Words people mistype, by the word they meant (edit distance 1, words of 5+ letters). */
const VOCAB = [
  'profit', 'sales', 'purchases', 'purchase', 'expenses', 'expense', 'outstanding', 'customers', 'customer', 'suppliers', 'supplier',
  'balance', 'stock', 'received', 'receive', 'payment', 'payments', 'collect', 'invoice', 'running', 'month', 'today', 'yesterday',
  'income', 'bought', 'spent', 'kharcha', 'kharida', 'becha', 'owes'
]

function editDistance1(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      // a transposition counts as one edit too ("porfit")
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
        i += 2
        j += 2
        continue
      }
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

const KNOWN = new Set(VOCAB)

function fixTypo(word: string): string {
  if (word.length < 5 || KNOWN.has(word) || !/^[a-z]+$/.test(word)) return word
  return VOCAB.find((v) => v.length >= 5 && editDistance1(word, v)) ?? word
}

export interface Normalised {
  /** Lower-case, Hinglish read into English, typos fixed, punctuation trimmed. */
  q: string
  /** The question ended with "?" (or reads as one). */
  question: boolean
}

export function normalise(text: string): Normalised {
  let s = text.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"')
  const question = /\?\s*$/.test(s)
  s = s.replace(/₹\s*/g, ' rs ').replace(/\brs\.\s*/g, 'rs ').replace(/(\d)\s*\/-/g, '$1 ')
  s = s.replace(/(\d)(rs|rupees?|rupaye)\b/g, '$1 $2')
  s = s.replace(/[?!;:]+/g, ' ').replace(/\s+[.]+\s*|[.]+$/g, ' ').replace(/,(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()
  for (const [re, to] of PHRASES) s = s.replace(re, to)
  s = s
    .split(' ')
    .map((w) => fixTypo(w))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { q: s, question }
}

// ---------------------------------------------------------------- periods

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = new RegExp(`\\b(${MONTH_NAMES.map((m) => (m.length > 3 ? `${m}|${m.slice(0, 3)}` : m)).join('|')})\\b`)

/** The period a question names, through nl.ts's phrase mapper; null = none said. */
export function periodOf(q: string, today: string): AssistPeriod | null {
  if (/\bday before yesterday\b/.test(q)) {
    const d = addDaysISO(today, -2)
    return { rule: 'yesterday', from: d, to: d }
  }
  if (/\byesterday\b/.test(q)) {
    const d = addDaysISO(today, -1)
    return { rule: 'yesterday', from: d, to: d }
  }
  if (/\btoday\b/.test(q)) return { rule: 'today', from: today, to: today }
  // nl.ts reads "in <month>" — "july mein", "july ki", a bare "july" mean the same.
  let mq = q.replace(new RegExp(`${MONTH_RE.source}\\s+(?:mein|me|main|ka|ki|ke)\\b`, 'g'), 'in $1')
  if (MONTH_RE.test(mq) && !new RegExp(`\\b(?:in|for|during)\\s+${MONTH_RE.source}`).test(mq)) mq = mq.replace(MONTH_RE, 'in $1')
  mq = mq.replace(/\bthis year\b/g, 'this financial year').replace(/\blast year\b/g, 'last financial year')
  const fy = fyOf(today)
  const req = parseReportQuestion(`profit ${mq}`, { from: fy.from, to: fy.to })
  const p = req?.period
  if (!p) return null
  if (p.kind === 'relative' && p.rule) {
    const r = relativePeriod(p.rule as RelativePeriod, today)
    // "This month / quarter" so far: never past today.
    return { rule: p.rule as AssistPeriodRule, from: r.from, to: r.to > today ? today : r.to }
  }
  if (p.kind === 'range' && p.from && p.to) {
    // A month later than today in this FY means last year's ("sales in December" asked in October).
    let from = p.from
    if (from > today) from = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`
    const to = monthEnd(from)
    return { rule: 'month', from, to: to > today ? today : to }
  }
  return null
}

const defaultPeriod = (today: string): AssistPeriod => {
  const r = relativePeriod('thisMonth', today)
  return { rule: 'thisMonth', from: r.from, to: today }
}

// ---------------------------------------------------------------- slots

const HOW_WORDS: [RegExp, MoneyHow][] = [
  [/\b(?:upi|gpay|g pay|google pay|phonepe|phone pe|paytm|bhim|qr)\b/, 'upi'],
  [/\b(?:card|debit card|credit card|swipe)\b/, 'card'],
  [/\b(?:bank|neft|rtgs|imps|cheque|check|transfer|online|account se|net banking)\b/, 'bank'],
  [/\bcash\b/, 'cash']
]

export function howOf(q: string): MoneyHow | undefined {
  return HOW_WORDS.find(([re]) => re.test(q))?.[1]
}

const UNIT_WORDS = new Set(['k', 'l', 'lakh', 'lakhs', 'lac', 'lacs', 'cr', 'crore', 'crores', 'thousand'])
const MONEY_WORDS = new Set(['rs', 'rupees', 'rupee', 'rupaye', 'rupaiye', 'rupay', 'inr', 'only'])
const NUM = /^\d[\d,]*(?:\.\d+)?(?:k|l|cr)?$/

interface NumberHit {
  index: number
  /** Tokens it spans. */
  span: number
  text: string
  paise: number | null
  /** A money marker sits next to it ("rs 500", "500 rupees", "for 900", "900 mein"). */
  money: boolean
  /** The word after it, when it is not a unit / money word (the product of "3 bags"). */
  noun?: string
  /** "300 each", "@ 300", "at 300 per bag": the price of one. */
  perUnit?: boolean
}

const MONEY_BEFORE = new Set(['rs', 'inr', 'for', 'at', 'worth', 'of', '@', 'amount', 'total', 'paid', 'received', 'got', 'diya', 'mila', 'diye'])
const MONEY_AFTER = new Set(['rs', 'rupees', 'rupee', 'rupaye', 'rupaiye', 'rupay', 'mein', 'me', 'main', 'ka', 'ke', 'ki', 'only'])
const NOT_NOUN = new Set([...UNIT_WORDS, ...MONEY_WORDS, 'mein', 'me', 'main', 'ka', 'ke', 'ki', 'ko', 'se', 'ne', 'for', 'to', 'from', 'in', 'on', 'by', 'via', 'at', 'cash', 'upi', 'card', 'bank', 'paid', 'received', 'mila', 'diya', 'diye', 'mile', 'mili', 'today', 'yesterday', 'and', 'the', 'a', 'an', 'ka', 'aur', 'hai', 'kiye', 'kiya', 'liye', 'pe', 'par', 'de', 'di', 'do', 'bheja', 'bheje', 'bheji', 'liya', 'each', 'per', 'apiece', 'only'])
/** Words after a number that make it a time span, not money ("last 30 days", "2 mahine"). */
const TIME_WORDS = new Set(['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours', 'din', 'hafte', 'mahine', 'mahina', 'saal', 'sal', 'baje'])
/** Words before a number that make it a year or a span ("in 2025", "since 2024", "last 30"). */
const YEAR_BEFORE = new Set(['in', 'since', 'year', 'saal', 'fy', 'during', 'till', 'until'])
const SPAN_BEFORE = new Set(['last', 'past', 'next', 'pichle', 'agle'])
/** Units of measure: "10 kg rice" — the product is the word after the unit. */
const QTY_UNITS = new Set([
  'kg', 'kgs', 'kilo', 'kilos', 'g', 'gm', 'gms', 'gram', 'grams', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters', 'ml', 'pcs', 'pc', 'piece', 'pieces',
  'nos', 'no', 'dozen', 'box', 'boxes', 'packet', 'packets', 'pkt', 'pkts', 'meter', 'meters', 'metre', 'metres', 'mtr', 'ton', 'tons', 'tonne', 'tonnes', 'quintal', 'quintals', 'sq', 'ft', 'feet'
])
const PER_AFTER = new Set(['each', 'per', 'apiece', 'har'])
/** Amount units, largest first — "2 lakh 50 thousand" adds up only in that order. */
const UNIT_RANK: Record<string, number> = { cr: 3, crore: 3, crores: 3, l: 2, lakh: 2, lakhs: 2, lac: 2, lacs: 2, k: 1, thousand: 1 }

function numbersIn(tokens: string[]): NumberHit[] {
  const out: NumberHit[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!NUM.test(tok)) continue
    const before = tokens[i - 1]
    // A year ("in 2025") or a time span ("last 30 days", "2 mahine") is not an amount.
    if ((before && YEAR_BEFORE.has(before) && /^(?:19|20)\d\d$/.test(tok)) || (before && SPAN_BEFORE.has(before)) || TIME_WORDS.has(tokens[i + 1] ?? '')) continue
    let span = 1
    let text = tok
    let paise: number | null
    const next = tokens[i + 1]
    if (next && UNIT_WORDS.has(next)) {
      text = `${tok} ${next}`
      span = 2
      paise = parseAmountText(text)
      // "2 lakh 50 thousand": each part through parseAmountText, added in integer paise, only
      // while the units get smaller.
      let rank = UNIT_RANK[next] ?? 0
      while (paise != null && NUM.test(tokens[i + span] ?? '') && UNIT_WORDS.has(tokens[i + span + 1] ?? '') && (UNIT_RANK[tokens[i + span + 1]!] ?? 0) < rank) {
        const part = parseAmountText(`${tokens[i + span]} ${tokens[i + span + 1]}`)
        if (part == null) break
        paise += part
        rank = UNIT_RANK[tokens[i + span + 1]!] ?? 0
        text = `${text} ${tokens[i + span]} ${tokens[i + span + 1]}`
        span += 2
      }
    } else paise = parseAmountText(text)
    let k = i + span
    while (tokens[k] && MONEY_WORDS.has(tokens[k]!) && tokens[k] !== 'only') k++
    const after = tokens[i + span]
    const money = (!!before && MONEY_BEFORE.has(before)) || (!!after && MONEY_AFTER.has(after)) || span >= 2 || /[klr]$/.test(tok)
    let noun = tokens[k] && !NOT_NOUN.has(tokens[k]!) && /^[a-zऀ-ॿ][a-zऀ-ॿ'-]*$/.test(tokens[k]!) ? tokens[k] : undefined
    // "10 kg rice" / "2 dozen of eggs": the product follows the unit.
    if (noun && QTY_UNITS.has(noun)) {
      const j = tokens[k + 1] === 'of' ? k + 2 : k + 1
      const w = tokens[j]
      noun = w && !NOT_NOUN.has(w) && !QTY_UNITS.has(w) && /^[a-zऀ-ॿ][a-zऀ-ॿ'-]*$/.test(w) ? w : undefined
      if (!noun) noun = undefined
    }
    const perUnit = before === '@' || PER_AFTER.has(tokens[k] ?? '') || (tokens[k] === 'a' && /^(?:piece|bag|kg|unit|pc)$/.test(tokens[k + 1] ?? ''))
    out.push({ index: i, span, text, paise, money: money || perUnit, ...(noun ? { noun } : {}), ...(perUnit ? { perUnit } : {}) })
    i += span - 1
  }
  return out
}

/** Words that never start or form a name. */
const NAME_STOP = new Set([
  ...NOT_NOUN, 'i', 'me', 'my', 'we', 'maine', 'mene', 'humne', 'mai', 'main', 'mera', 'meri', 'mere', 'hum', 'paid', 'pay', 'sold', 'bought', 'gave',
  'spent', 'got', 'received', 'receive', 'sell', 'buy', 'becha', 'beche', 'bechi', 'kharida', 'kharide', 'kharidi', 'kharcha', 'kharch', 'kharche',
  'bhara', 'bhare', 'chukaya', 'aaya', 'aaye', 'aya', 'aye', 'jama', 'collected', 'payment', 'money', 'paisa', 'paise', 'rent', 'please', 'record', 'add',
  'entry', 'bill', 'just', 'now', 'this', 'that', 'it', 'him', 'her', 'them', 'is', 'was', 'he', 'she', 'with', 'as', 'of', 'kiye', 'kiya', 'karo', 'diye',
  'di', 'de', 'do', 'did', 'liye', 'wala', 'wale', 'udhaar', 'udhar', 'advance', 'tomorrow', 'last', 'past', 'next', 'bills', 'over', 'above',
  'below', 'under', 'more', 'than', 'less', 'maal', 'saman', 'samaan', 'us', 'each', 'per'
])

const isNameWord = (w: string | undefined): w is string => !!w && !NAME_STOP.has(w) && !NUM.test(w) && /^[a-zऀ-ॿ][a-zऀ-ॿ.&'-]*$/.test(w)

/** Up to 4 name words starting at `from` (forward). */
function nameAfter(tokens: string[], from: number): string | undefined {
  const words: string[] = []
  for (let i = from; i < tokens.length && words.length < 4; i++) {
    if (!isNameWord(tokens[i])) break
    words.push(tokens[i]!)
  }
  return words.length ? words.join(' ') : undefined
}

/** Up to 3 name words ending just before `before` (backward) — "ramesh kumar ko". */
function nameBefore(tokens: string[], before: number): string | undefined {
  const words: string[] = []
  for (let i = before - 1; i >= 0 && words.length < 3; i--) {
    if (!isNameWord(tokens[i])) break
    words.unshift(tokens[i]!)
  }
  return words.length ? words.join(' ') : undefined
}

const DATE_PHRASE = new RegExp(
  `\\b(?:on\\s+)?(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_NAMES.map((m) => m.slice(0, 3)).join('|')})[a-z]*(?:\\s+\\d{4})?|(?:${MONTH_NAMES.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|day before yesterday|yesterday|today|tomorrow|\\d{1,2} days? ago)\\b`
)

// ---------------------------------------------------------------- entries

const OUT_VERB = /\b(?:paid|pay|spent|spend|gave|given|sent|diya|diye|di|de diya|bhara|bhare|bhari|chukaya|chukaye|kharch|kharcha|kharche|kharach|bheja|bheje|bheji|bhej diya)\b/
const IN_VERB = /\b(?:received|receive|got|mila|mile|mili|aaya|aaye|aayi|aya|aye|collected|liya)\b/
const SALE_VERB = /\b(?:sold|sell|becha|beche|bechi|bech|bechaa)\b/
const BUY_VERB = /\b(?:bought|buy|purchased|kharida|kharide|kharidi|khareeda|khareede)\b|\b(?:maal|saman|samaan)\b.*\b(?:liya|liye|mangaya|mangwaya)\b/
// A request for a figure or a list ("show me what I sold…", "total I received from Sita in 2025")
// is a question too — never an entry.
const QUESTION_START = /^(?:how|what|did|do|does|was|were|when|why|who|which|should|can|kya|kab|kyun|kyon|kaise|tell|show|list|find|search|give me|total|check|report|summary)\b|^how much\b/

/** What a money-out line was for: "for tea", "tea ke liye", "chai pe", "2,500 rent". */
function purposeOf(tokens: string[], nums: NumberHit[], skip: Set<number>): string | undefined {
  const forAt = tokens.findIndex((w, i) => (w === 'for' || w === 'towards') && !skip.has(i))
  if (forAt >= 0) {
    const n = nameAfter(tokens, forAt + 1)
    if (n) return n
  }
  const liye = tokens.findIndex((w, i) => (w === 'liye' && tokens[i - 1] === 'ke') || w === 'pe' || w === 'par')
  if (liye > 0) {
    const n = nameBefore(tokens, tokens[liye] === 'liye' ? liye - 1 : liye)
    if (n) return n
  }
  const amount = nums.find((n) => n.paise != null)
  if (amount?.noun) return amount.noun
  // "500 ka petrol" / "paid rent 2500"
  if (amount) {
    const after = tokens[amount.index + amount.span]
    if ((after === 'ka' || after === 'ki' || after === 'ke') && isNameWord(tokens[amount.index + amount.span + 1])) return tokens[amount.index + amount.span + 1]
  }
  // "paid rent 2,500", "electricity paid 2000": a known expense word anywhere.
  return tokens.find((w, i) => !skip.has(i) && Object.prototype.hasOwnProperty.call(EXPENSE_WORDS, w))
}

export function entryOf(raw: string, n: Normalised, today: string): AssistEntrySlots | null {
  const q = n.q
  if (n.question || QUESTION_START.test(q)) return null
  const sale = SALE_VERB.test(q)
  const buy = !sale && BUY_VERB.test(q)
  const neDiya = /\bne\b/.test(q) && OUT_VERB.test(q)
  // "Ramesh paid me 5000", "Sita gave 2000 by UPI": a person BEFORE the paying verb paid YOU —
  // money in from them (never "rent paid 500": an expense word is not a person).
  const subject = OUT_VERB.test(q) && !neDiya ? payerBefore(q.split(' ')) : undefined
  const paidMe = /\b(?:paid|gave|sent|given) (?:me|us)\b/.test(q)
  const inV = IN_VERB.test(q) || neDiya || !!subject || paidMe
  const outV = !inV && OUT_VERB.test(q)
  if (!sale && !buy && !inV && !outV) return null

  // The date first (its digits are not an amount).
  let date: string | undefined
  let body = q
  const dm = DATE_PHRASE.exec(q)
  if (dm) {
    const r = resolveDateText(dm[1]!, today)
    if (r) {
      date = r.date
      body = q.replace(dm[0], ' ').replace(/\s+/g, ' ').trim()
    }
  }
  const tokens = body.split(' ')
  const nums = numbersIn(tokens)
  if (nums.length === 0) return null
  const how = howOf(body)
  const slots: AssistEntrySlots = { action: sale ? 'sale' : buy ? 'purchase' : inV ? 'money_in' : 'money_out' }
  if (date) slots.date = date
  if (how) slots.how = how

  if (sale || buy) {
    // "sold 3 bags to Sita for 900": a number with a noun is the quantity; a marked one the amount.
    const qty = nums.find((x) => x.noun && !x.money && x.span === 1)
    const money = nums.find((x) => x !== qty && x.paise != null && (x.money || qty != null)) ?? (qty ? undefined : nums.find((x) => x.paise != null))
    if (qty) {
      const milli = qtyMilliOf(qty.text)
      if (milli != null) slots.qtyMilli = milli
      slots.what = qty.noun
    }
    if (money?.paise != null) slots.amount = money.paise
    // "3 bags at 300 each": 300 is the price of one bag, not the bill.
    if (money?.perUnit && slots.qtyMilli != null) slots.perUnit = true
    if (!slots.what) {
      // "5 kg of rice", or the word right after the verb ("sold rice for 500").
      const of = tokens.indexOf('of')
      const verbAt = tokens.findIndex((w) => SALE_VERB.test(w) || BUY_VERB.test(w))
      const w = (of >= 0 ? nameAfter(tokens, of + 1) : undefined) ?? (verbAt >= 0 && isNameWord(tokens[verbAt + 1]) ? tokens[verbAt + 1] : undefined)
      if (w) slots.what = w
    }
  } else {
    const money = nums.find((x) => x.paise != null && x.paise > 0)
    if (!money) return null
    slots.amount = money.paise!
  }

  // The person: "to / from X", "X ko / se / ne", or the word right after the verb ("paid Mohan 2000").
  const skip = new Set<number>()
  let party: string | undefined
  const toFrom = tokens.findIndex((w) => w === 'to' || w === 'from')
  if (toFrom >= 0) {
    party = nameAfter(tokens, toFrom + 1)
    if (party) for (let i = toFrom; i <= toFrom + party.split(' ').length; i++) skip.add(i)
  }
  if (!party && subject) party = subject
  if (!party) {
    const marker = tokens.findIndex((w) => w === 'ko' || w === 'se' || w === 'ne' || (inV && w === 'ka'))
    if (marker > 0) {
      party = nameBefore(tokens, marker)
      if (party && tokens[marker] === 'ko' && inV && !neDiya) slots.readAs = 'koMila'
    }
  }
  if (!party && !sale && !buy) {
    const verbAt = tokens.findIndex((w) => /^(?:paid|gave|pay)$/.test(w))
    const next = verbAt >= 0 ? tokens[verbAt + 1] : undefined
    if (isNameWord(next) && next !== slots.what && !Object.keys(EXPENSE_WORDS).includes(next)) party = nameAfter(tokens, verbAt + 1)
  }
  if (party) {
    // "to Sita for 900" — never the purpose word.
    party = party.replace(/\s+(?:for|ke|ki|ka)$/, '')
    slots.party = party
  }
  if (slots.action === 'money_out' || slots.action === 'money_in') {
    const what = purposeOf(tokens, nums, skip)
    if (what && what !== party) slots.what = what
  }
  if (slots.what && HOW_WORDS.some(([re]) => re.test(slots.what!))) delete slots.what
  if (slots.what && slots.what === slots.party) delete slots.what
  return slots
}

/** The person who paid you, when the sentence starts with them: "ramesh kumar paid 5000". */
function payerBefore(tokens: string[]): string | undefined {
  const at = tokens.findIndex((w) => /^(?:paid|gave|sent|given|pay)$/.test(w))
  if (at <= 0 || at > 3) return undefined
  const words = tokens.slice(0, at)
  if (!words.every((w) => isNameWord(w) && !(w in EXPENSE_WORDS))) return undefined
  return words.join(' ')
}

/** "3", "2.5", "1,000" → thousandths (integer maths); null otherwise. */
export function qtyMilliOf(text: string): number | null {
  const m = /^(\d[\d,]*)(?:\.(\d{1,3}))?$/.exec(text.trim())
  if (!m) return null
  const whole = Number(m[1]!.replace(/,/g, ''))
  const frac = (m[2] ?? '').padEnd(3, '0')
  const v = whole * 1000 + Number(frac || '0')
  return Number.isSafeInteger(v) && v > 0 ? v : null
}

/** What a money-out purpose word is, as a simple category key (shared/simple/categories.ts). */
export const EXPENSE_WORDS: Record<string, string> = {
  rent: 'rent', kiraya: 'rent', bhada: 'rent', bhaada: 'rent',
  electricity: 'electricity', bijli: 'electricity', light: 'electricity', power: 'electricity',
  salary: 'salary', salaries: 'salary', wages: 'salary', tankhwah: 'salary', tankha: 'salary', pagar: 'salary',
  transport: 'transport', petrol: 'transport', diesel: 'transport', fuel: 'transport', auto: 'transport', taxi: 'transport', freight: 'transport', bhada_gaadi: 'transport', courier: 'transport',
  phone: 'phone_internet', mobile: 'phone_internet', recharge: 'phone_internet', internet: 'phone_internet', wifi: 'phone_internet', broadband: 'phone_internet',
  repair: 'repairs', repairs: 'repairs', marammat: 'repairs',
  tea: 'office', chai: 'office', coffee: 'office', snacks: 'office', nashta: 'office', stationery: 'office', office: 'office', water: 'office', pani: 'office', printing: 'office',
  packing: 'packing', packaging: 'packing',
  commission: 'commission_paid',
  travel: 'travel', train: 'travel', flight: 'travel', hotel: 'travel',
  software: 'software', subscription: 'software',
  ca: 'professional_fees', accountant: 'professional_fees', lawyer: 'professional_fees', fees: 'professional_fees',
  labour: 'labour', mazdoori: 'labour', majdoori: 'labour',
  shop: 'shop_expenses', cleaning: 'shop_expenses', safai: 'shop_expenses'
}

// ---------------------------------------------------------------- questions

const MEANING = /^(?:what is|what's|whats|what are|what does|meaning of|define|explain)\s+(?:an?\s+|the\s+)?(.+?)(?:\s+mean)?$|^(.+?)\s+(?:kya hai|kya hota hai|kya hote hai|ka matlab|ka matlab kya hai|matlab|means|meaning)$/

const HOWTO = /\bhow (?:do|can|should|to|would)\b|\bkaise\b|\bkese\b|\bkaisey\b|\bsteps? to\b|\bhelp me\b/
const HOWTO_TASKS: [RegExp, AssistHowTo][] = [
  [/\breturn/, 'returnSale'],
  [/\b(?:bill|invoice|sale|sell|becha|bikri)\b/, 'bill'],
  [/\b(?:purchase|bought|buy|kharid|supplier bill)/, 'purchase'],
  [/\b(?:move money|transfer|deposit|withdraw)\b/, 'moveMoney'],
  [/\b(?:receive|received|got paid|collect|payment from|money in|mila)\b/, 'moneyIn'],
  [/\b(?:pay|paid|payment|expense|money out|kharcha|diya)\b/, 'moneyOut'],
  [/\b(?:bank statement|statement|bank)\b/, 'bank'],
  [/\b(?:customer|supplier|party|person|contact)\b/, 'customer'],
  [/\b(?:product|item|stock item)\b/, 'product'],
  [/\b(?:count|stock)\b/, 'stockCount'],
  [/\bgst\b|\btax\b|\breturn file\b/, 'gst'],
  [/\bbackup|back up\b/, 'backup'],
  [/\b(?:language|hindi|hinglish|english|dark|theme)\b/, 'language'],
  [/\b(?:opening|day one|starting balance|old balance)\b/, 'openings'],
  [/\b(?:undo|delete|mistake|wrong|galti|cancel)\b/, 'undo'],
  [/\b(?:turn on|feature|payroll|tds)\b/, 'features'],
  [/\b(?:remind|reminder|whatsapp)\b/, 'reminder']
]

const GST_Q = /\bgst\b|\bgstr\b|\btax (?:due|to pay|payable)\b/
const GST_DUE = /\b(?:due|pay|payable|bharna|bharni|bhar|jama|how much|when|kab|return|file|filing|owe|liability|dena|deni|baki|deadline|tax|kitna)\b/

const RECEIVABLE = /\b(?:who owes|owes? me|does .+ owe|how much does .+ owe|owe me|customers? owe|debtors|receivables?|outstanding|to collect|collect from|lena|leni|lene|udhaar|udhar|udhari|baki|baaki|dues|pending from)\b|लेना/
const PAYABLE = /\b(?:i owe|do i owe|what do i owe|we owe|i have to pay|i need to pay|payables?|creditors|bills to pay|suppliers? owed|dena|deni|dene|chukana|pay to suppliers)\b|देना/

const NOBODY = new Set(['me', 'i', 'us', 'who', 'customers', 'customer', 'suppliers', 'supplier', 'everyone', 'anyone', 'log', 'people', 'kis', 'kisko', 'kisse', 'kaun', 'mera', 'mere', 'meri', 'mujhe', 'humein', 'total', 'all', 'sab', 'how much', 'how', 'much', 'the', 'my'])

function ownerName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const words = raw.trim().split(/\s+/).filter((w) => w && !NOBODY.has(w))
  if (!words.length || words.some((w) => ['how', 'much', 'what', 'do', 'does'].includes(w))) return undefined
  const name = words.join(' ').replace(/'s$/, '')
  return name.length >= 2 ? name : undefined
}

function owedParty(q: string, side: 'receivable' | 'payable'): string | undefined {
  const pats =
    side === 'receivable'
      ? [
          /\bdoes (.+?) (?:still )?owe\b/, /\bhow much (?:does|do) (.+?) owe\b/, /\bwhat does (.+?) owe\b/, /^(.+?) owes? me\b/,
          /^(?:how much )?(.+?) (?:ka|ke|ki|pe|par|se) (?:how much )?(?:baki|baaki|lena|leni|lene|udhaar|udhar|outstanding)\b/,
          /\b(?:balance|outstanding|dues) (?:of|for|from) (.+)$/, /^(.+?)(?:'s)? (?:balance|outstanding|dues)$/
        ]
      : [/\bdo i owe (.+?)(?: anything| money| how much)?$/, /\bwhat do i owe (.+)$/, /\bhow much do i owe (.+)$/, /^(.+?) (?:ko|ka|ke) (?:how much )?(?:dena|deni|dene)\b/]
  for (const re of pats) {
    const m = re.exec(q)
    const name = ownerName(m?.[1])
    if (name) return name
  }
  return undefined
}

const STOCK_LOW = /\b(?:running low|low stock|stock low|out of stock|khatam|kam ho|kam hai|kam bacha|reorder|finishing|running out)\b/
const STOCK_ITEM = [
  /\bstock of (.+)$/, /\bhow many (.+?) (?:do i have|are left|left|in stock|hai|hain|bache|bacha|bachi)\b/, /^(.+?) (?:ka|ki|ke) stock\b/,
  /^how much (.+?) (?:hai|hain|bache|bacha|bachi|left|in stock)\b/, /^(.+?) how much (?:hai|hain|bache|bacha|bachi|left)\b/, /\bstock (?:for|in) (.+)$/
]

const CASH_Q = /\bcash (?:in hand|balance|hai|how much|kitna|do i have|left|available)\b|\bhow much cash\b|\bcash in hand\b|\bin (?:the )?cash\b|^cash$/
const BANK_Q = /\bbank (?:balance|me|mein|main|account|how much|kitna|mai|hai)\b|\bin (?:the |my )?bank\b|\bhow much (?:money )?(?:is )?in (?:the |my )?bank\b|^bank balance$/
const BOTH_Q = /\bhow much money\b|\bpaisa how much\b|\bpaise how much\b|\bhow much paisa\b|\bhow much paise\b|\btotal money\b|\bmoney do i have\b|\bcash and bank\b/

const MEASURE_WORDS: [RegExp, AssistMeasure][] = [
  [/\bprofit|\bloss\b|\bearn(?:ed|ing)?\b|\bmargin\b|\b(?:make|made) (?:any )?money\b|\bmoney did i make\b/, 'profit'],
  [/\bsales?\b|\bsold\b|\bsell\b|\brevenue\b|\bturnover\b|\bbecha\b|\bselling\b/, 'sales'],
  [/\bpurchases?\b|\bbought\b|\bkharida\b|\bkharidi\b|\bbuying\b/, 'purchases'],
  [/\bexpenses?\b|\bspent\b|\bspend(?:ing)?\b|\bcosts?\b|\bkharcha\b|\bkharche\b|\bdid i pay\b/, 'expenses']
]

const OPEN = /^(?:please\s+)?(?:open|go to|goto|take me to|jump to|show me|show|kholo|khol do|khol|dikhao|dikha do|dikhaao)\s+(.+)$|^(.+?)\s+(?:kholo|khol do|dikhao|dikha do|kholiye|dikhaiye|open karo|open)$/

/** The intent of a question (or an entry request). */
export function classify(text: string, today: string): AssistIntent {
  const n = normalise(text)
  const q = n.q
  if (!q) return { kind: 'unknown' }

  const entry = entryOf(text, n, today)
  if (entry) return { kind: 'entry', entry }

  if (HOWTO.test(q)) {
    const task = HOWTO_TASKS.find(([re]) => re.test(q))?.[1]
    if (task) return { kind: 'howto', task: task === 'returnSale' && /\b(?:supplier|purchase|bought)\b/.test(q) ? 'returnPurchase' : task }
  }

  const meaning = MEANING.exec(q)
  const open = OPEN.exec(q)
  if (open && /^(?:please\s+)?(?:open|go to|goto|take me to|jump to|kholo|khol)\b|(?:kholo|khol do|kholiye|open karo|open)$/.test(q)) {
    const target = (open[1] ?? open[2] ?? '').replace(/^(?:the|my|a)\s+/, '').trim()
    if (target) return { kind: 'open', target }
  }

  if (GST_Q.test(q) && (GST_DUE.test(q) || q === 'gst')) return { kind: 'gst' }

  if (PAYABLE.test(q)) return { kind: 'owed', side: 'payable', ...partyOpt(owedParty(q, 'payable')) }
  if (RECEIVABLE.test(q)) return { kind: 'owed', side: 'receivable', ...partyOpt(owedParty(q, 'receivable')) }

  if (STOCK_LOW.test(q)) return { kind: 'stock', low: true }

  const measure = MEASURE_WORDS.find(([re]) => re.test(q))?.[1]
  if (measure) {
    const said = periodOf(q, today)
    return { kind: 'figure', measure, period: said ?? defaultPeriod(today), periodSaid: !!said }
  }

  if (BOTH_Q.test(q)) return { kind: 'money', which: 'both' }
  if (CASH_Q.test(q)) return { kind: 'money', which: 'cash' }
  if (BANK_Q.test(q)) return { kind: 'money', which: 'bank' }

  if (/\bstock\b/.test(q) || /\bhow (?:many|much)\b.*\b(?:left|bache|bacha|bachi|in stock|do i have)\b/.test(q)) {
    for (const re of STOCK_ITEM) {
      const m = re.exec(q)
      const item = m?.[1]?.replace(/^(?:the|my)\s+/, '').trim()
      if (item && !/\b(?:stock|what|how|much|many)\b/.test(item)) return { kind: 'stock', item }
    }
    return { kind: 'stock' }
  }

  if (meaning) {
    const term = (meaning[1] ?? meaning[2] ?? '').trim()
    if (term && term.split(' ').length <= 4) return { kind: 'meaning', term }
  }
  // "show <something>" that matched nothing above → open it.
  if (open) {
    const target = (open[1] ?? open[2] ?? '').replace(/^(?:the|my|a)\s+/, '').trim()
    if (target) return { kind: 'open', target }
  }
  return { kind: 'unknown' }
}

const partyOpt = (party: string | undefined): { party?: string } => (party ? { party } : {})
