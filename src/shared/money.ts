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

/** Amounts in words (Indian system) for invoice printing. Integer-rupee focus with paise tail. */
export function amountInWords(paise: number): string {
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
