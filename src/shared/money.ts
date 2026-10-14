/**
 * All monetary amounts in Total are integers in paise (1 rupee = 100 paise).
 * Floats never touch money.
 */

/** Parse a user-entered rupee string ("1,234.56") into paise. Returns null on invalid input. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[,\s₹]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned)) return null
  const [wholeRaw = '', fracRaw = ''] = cleaned.replace('-', '').split('.')
  const whole = wholeRaw === '' ? 0 : parseInt(wholeRaw, 10)
  const frac = fracRaw === '' ? 0 : parseInt(fracRaw.padEnd(2, '0'), 10)
  if (!Number.isSafeInteger(whole * 100)) return null
  const paise = whole * 100 + frac
  return cleaned.startsWith('-') ? -paise : paise
}

/** Format paise using Indian digit grouping: 12345678 -> "1,23,456.78" */
export function formatPaise(paise: number, opts: { symbol?: boolean; zeroDash?: boolean } = {}): string {
  if (paise === 0 && opts.zeroDash) return '–'
  const negative = paise < 0
  const abs = Math.abs(paise)
  const whole = Math.floor(abs / 100).toString()
  const frac = (abs % 100).toString().padStart(2, '0')
  let grouped: string
  if (whole.length <= 3) {
    grouped = whole
  } else {
    const last3 = whole.slice(-3)
    const rest = whole.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
  }
  const prefix = (negative ? '-' : '') + (opts.symbol ? '₹' : '')
  return `${prefix}${grouped}.${frac}`
}

/**
 * Format paise as a plain rupee decimal string — no digit grouping, no currency symbol — for
 * numeric CSV/portal columns (e.g. NSDL RPU imports) that reject grouped or symbol-prefixed
 * numbers. Pure integer math throughout; never divides paise as a float.
 */
export function plainRupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const whole = Math.trunc(abs / 100)
  const frac = (abs % 100).toString().padStart(2, '0')
  return `${sign}${whole}.${frac}`
}

/**
 * Format quantity thousandths as a plain 3-decimal string — no digit grouping, no unit suffix —
 * e.g. for Tally XML export (ACTUALQTY/OPENINGBALANCE). Pure integer math throughout; mirrors
 * plainRupees but at 3-decimal (milli) precision instead of 2-decimal (paise -> rupees).
 */
export function plainMilli(qtyMilli: number): string {
  const sign = qtyMilli < 0 ? '-' : ''
  const abs = Math.abs(qtyMilli)
  const whole = Math.trunc(abs / 1000)
  const frac = (abs % 1000).toString().padStart(3, '0')
  return `${sign}${whole}.${frac}`
}

/**
 * Compact Indian-unit label for chart axes and dense tiles: "₹950", "₹45.2K", "₹1.2L", "₹3.4Cr".
 * One decimal, trailing ".0" dropped, half away from zero — integer math on paise throughout.
 * Never for amounts a user reads as exact (tooltips and tables use formatPaise).
 */
export function formatPaiseCompact(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const units: [number, string][] = [[100_00000_00, 'Cr'], [100_000_00, 'L'], [1_000_00, 'K']]
  // Under ₹1,000 the exact rupee figure is already short.
  for (const [unit, suffix] of abs >= 1_000_00 ? units : []) {
    // Decide the unit on the ROUNDED value, so ₹99,960 reads "₹1L", not "₹100K".
    const tenths = Math.floor((abs * 10 + unit / 2) / unit)
    if (tenths >= 10) {
      const whole = Math.floor(tenths / 10)
      const frac = tenths % 10
      return `${sign}₹${whole}${frac ? `.${frac}` : ''}${suffix}`
    }
  }
  return `${sign}₹${Math.floor((abs + 50) / 100)}`
}

/** Round a fractional paise value to an integer, half away from zero (GST convention). */
export function roundPaise(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

/** Round paise to the nearest whole rupee, half up (invoice round-off). Returns paise. */
export function roundToRupee(paise: number): number {
  return Math.sign(paise) * Math.round(Math.abs(paise) / 100) * 100
}

/**
 * Percentage of an amount in paise, rounded half away from zero.
 * `ratePercent` may be fractional (e.g. 0.25, 2.5, 18).
 */
export function percentOf(paise: number, ratePercent: number): number {
  return roundPaise((paise * ratePercent) / 100)
}

/** Amounts in words (Indian system) for invoice printing. Integer-rupee focus with paise tail.
 *  WP 10.4: `lang` 'hi' writes Hindi (एक लाख बीस हज़ार रुपये केवल), 'hinglish' the same words in
 *  Latin script (Ek lakh bees hazaar rupaye); anything else is the English text, unchanged. */
export function amountInWords(paise: number, lang?: string): string {
  if (lang === 'hi' || lang === 'hinglish') return indicAmountInWords(paise, lang)
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  function twoDigits(n: number): string {
    if (n < 20) return ones[n] ?? ''
    const t = tens[Math.floor(n / 10)] ?? ''
    const o = ones[n % 10] ?? ''
    return o ? `${t} ${o}` : t
  }
  function threeDigits(n: number): string {
    const h = Math.floor(n / 100)
    const rest = n % 100
    const parts: string[] = []
    if (h) parts.push(`${ones[h]} Hundred`)
    if (rest) parts.push(twoDigits(rest))
    return parts.join(' ')
  }
  function integerWords(n: number): string {
    if (n === 0) return 'Zero'
    const crore = Math.floor(n / 10000000)
    const lakh = Math.floor((n % 10000000) / 100000)
    const thousand = Math.floor((n % 100000) / 1000)
    const rest = n % 1000
    const parts: string[] = []
    if (crore) parts.push(`${integerWords(crore)} Crore`)
    if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
    if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
    if (rest) parts.push(threeDigits(rest))
    return parts.join(' ')
  }

  const negative = paise < 0
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const p = abs % 100
  let words = `${integerWords(rupees)} Rupees`
  if (p) words += ` and ${twoDigits(p)} Paise`
  words += ' Only'
  return (negative ? 'Minus ' : '') + words
}

// Hindi numbers 0–99 are one word each (no tens + ones rule), so they are listed in full.
// Spellings: the common modern forms (Kendriya Hindi Nideshalaya standard); Hinglish is their
// everyday Latin transliteration. Pending native review (plan D6).
const HI_0_99 = (
  'शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस ' +
  'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस ' +
  'पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस ' +
  'सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ ' +
  'बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर ' +
  'छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी ' +
  'नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'
).split(' ')
const HINGLISH_0_99 = (
  'shunya ek do teen chaar paanch chhah saat aath nau das gyaarah baarah terah chaudah pandrah solah ' +
  'satrah athaarah unnees bees ikkees baais teis chaubees pachchees chhabbees sattaais atthaais untees ' +
  'tees ikattees battees taintees chauntees paintees chhattees saintees adtees untaalees chaalees ' +
  'iktaalees bayaalees taintaalees chavaalees paintaalees chhiyaalees saintaalees adtaalees unchaas ' +
  'pachaas ikyaavan baavan tirpan chauvan pachpan chhappan sattaavan atthaavan unsath saath iksath ' +
  'baasath tirsath chaunsath painsath chhiyaasath sadsath adsath unhattar sattar ikhattar bahattar ' +
  'tihattar chauhattar pachhattar chhihattar sathattar athhattar unyaasi assi ikyaasi bayaasi tiraasi ' +
  'chauraasi pachaasi chhiyaasi sattaasi atthaasi navaasi nabbe ikyaanve baanve tiraanve chauraanve ' +
  'pachaanve chhiyaanve sattaanve atthaanve ninyaanve'
).split(' ')

const INDIC_WORDS = {
  hi: { n: HI_0_99, hundred: 'सौ', thousand: 'हज़ार', lakh: 'लाख', crore: 'करोड़', rupee: 'रुपया', rupees: 'रुपये', paisa: 'पैसा', paise: 'पैसे', and: 'और', only: ' केवल', minus: 'ऋण ' },
  hinglish: { n: HINGLISH_0_99, hundred: 'sau', thousand: 'hazaar', lakh: 'lakh', crore: 'crore', rupee: 'rupaya', rupees: 'rupaye', paisa: 'paisa', paise: 'paise', and: 'aur', only: '', minus: 'minus ' }
} as const

function indicAmountInWords(paise: number, lang: 'hi' | 'hinglish'): string {
  const w = INDIC_WORDS[lang]
  const below100 = (n: number): string => w.n[n]!
  const below1000 = (n: number): string => {
    const h = Math.floor(n / 100)
    const rest = n % 100
    const parts: string[] = []
    if (h) parts.push(`${below100(h)} ${w.hundred}`)
    if (rest) parts.push(below100(rest))
    return parts.join(' ')
  }
  const integerWords = (n: number): string => {
    if (n === 0) return below100(0)
    const crore = Math.floor(n / 10000000)
    const lakh = Math.floor((n % 10000000) / 100000)
    const thousand = Math.floor((n % 100000) / 1000)
    const rest = n % 1000
    const parts: string[] = []
    if (crore) parts.push(`${integerWords(crore)} ${w.crore}`)
    if (lakh) parts.push(`${below100(lakh)} ${w.lakh}`)
    if (thousand) parts.push(`${below100(thousand)} ${w.thousand}`)
    if (rest) parts.push(below1000(rest))
    return parts.join(' ')
  }
  const negative = paise < 0
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const p = abs % 100
  let words = `${integerWords(rupees)} ${rupees === 1 ? w.rupee : w.rupees}`
  if (p) words += ` ${w.and} ${below100(p)} ${p === 1 ? w.paisa : w.paise}`
  words = (negative ? w.minus : '') + words + w.only
  // Hinglish is a sentence in Latin script: capitalise its first letter (as the English is).
  return lang === 'hinglish' ? words.charAt(0).toUpperCase() + words.slice(1) : words
}

/**
 * Quantity thousandths as the shortest decimal string — trailing zeros trimmed, no grouping:
 * 2000 -> "2", 2500 -> "2.5", 1 -> "0.001". Integer math only. Used by the printed documents'
 * quantity cell (src/shared/print/render.ts); identical to the old `qtyMilli / 1000`
 * interpolation for every integer input.
 */
export function formatQtyMilli(qtyMilli: number): string {
  const sign = qtyMilli < 0 ? '-' : ''
  const abs = Math.abs(qtyMilli)
  const whole = Math.trunc(abs / 1000)
  const frac = (abs % 1000).toString().padStart(3, '0').replace(/0+$/, '')
  return `${sign}${whole}${frac ? '.' + frac : ''}`
}

/** Digits as typed: no commas, or commas only in Indian (12,34,567) or Western (1,234,567)
 *  grouping — "45,00" or "1,2,3" are refused rather than read as ₹4,500 / ₹123. */
export function validDigitGrouping(digits: string): boolean {
  if (!digits.includes(',')) return /^\d+$/.test(digits)
  return /^\d{1,2}(,\d{2})*,\d{3}$/.test(digits) || /^\d{1,3}(,\d{3})+$/.test(digits)
}

/** Indian shorthand multipliers in rupees (WP 5.3): "1.5 lakh", "2 cr", "45k". */
const AMOUNT_UNITS: [RegExp, number][] = [
  [/^(crores?|cr|crs)$/, 1_00_00_000],
  [/^(lakhs?|lacs?|lakh|l)$/, 1_00_000],
  [/^(thousands?|k)$/, 1_000]
]

/**
 * Parse an amount as a person types it into paise (WP 5.3 drafting): "45,000", "₹45,000.50",
 * "Rs. 45000/-", "INR 1,20,000", "1.5 lakh", "1.5L", "2 crore", "2cr", "45k". Integer string
 * maths only — the fraction is scaled by the unit and must land on whole paise ("1.234 lakh" is
 * ₹1,23,400.00; "1.005" rupees is refused). Returns null for anything else (negative, empty,
 * words like "ten", two numbers).
 */
export function parseAmountText(input: string): number | null {
  let t = input.trim().toLowerCase()
  t = t.replace(/^(₹|rs\.?|inr|rupees?)\s*/, '')
  t = t.replace(/\s*\/-$/, '').replace(/\s+(rupees?|only|rs\.?|inr)$/, '').trim()
  const m = /^(\d[\d,]*)(?:\.(\d+))?\s*([a-z]+)?$/.exec(t)
  if (!m) return null
  const digits = m[1]!
  if (!validDigitGrouping(digits)) return null
  const whole = digits.replace(/,/g, '')
  const frac = m[2] ?? ''
  let unit = 1
  if (m[3]) {
    const u = AMOUNT_UNITS.find(([re]) => re.test(m[3]!))
    if (!u) return null
    unit = u[1]
  }
  // paise = (whole + frac / 10^n) × unit × 100, exactly — or refused.
  const scale = unit * 100
  if (frac.length > 9) return null
  const fracDen = 10 ** frac.length
  const fracNum = frac === '' ? 0 : parseInt(frac, 10)
  if ((fracNum * scale) % fracDen !== 0) return null
  const paise = parseInt(whole, 10) * scale + (fracNum * scale) / fracDen
  return Number.isSafeInteger(paise) ? paise : null
}
