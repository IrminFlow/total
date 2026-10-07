/**
 * Code-128 barcode encoding (WP 2.3 barcode labels), in-house — no dependency. Pure: text in,
 * symbol values / module widths / SVG out.
 *
 * Symbology (ISO/IEC 15417): every symbol is 3 bars + 3 spaces spanning 11 modules (the stop
 * symbol has a trailing 2-module bar: 13). Code set B covers printable ASCII 32–127; code set C
 * packs two digits per symbol. The check symbol is (start value + Σ position × value) mod 103,
 * positions counted from 1 after the start symbol. A quiet zone of 10 modules each side.
 *
 * Code-set choice (matches python-barcode's output, the test oracle): start in C when the text
 * opens with four or more digits, or is an even number of digits only, else B; in B, switch to C
 * when four or more digits follow; in C, encode digit pairs and switch back to B when fewer than two digits
 * follow (an odd run's last digit goes in B). Characters outside ASCII 32–127 are rejected (code
 * set A control characters are never needed on labels).
 */

/** Bar/space widths of symbol values 0–106 (106 = stop, 7 elements). */
const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
]

export const CODE128_START_B = 104
export const CODE128_START_C = 105
export const CODE128_CODE_B = 100 // "Code B" switch (from C)
export const CODE128_CODE_C = 99 // "Code C" switch (from B)
export const CODE128_STOP = 106

/** Exposed for tests (structure checks over the whole table). */
export const CODE128_PATTERNS = PATTERNS

const isDigit = (c: string): boolean => c >= '0' && c <= '9'

function digitRun(text: string, from: number): number {
  let n = 0
  while (from + n < text.length && isDigit(text[from + n]!)) n++
  return n
}

/**
 * Symbol values for `text`: start symbol, data (with any code-set switches), check symbol, stop.
 * Throws on an empty string or a character outside ASCII 32–127.
 */
export function code128Values(text: string): number[] {
  if (text.length === 0) throw new Error('Nothing to encode')
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 32 || c > 127) throw new Error(`Code-128 can't encode ${JSON.stringify(ch)}`)
  }
  const data: number[] = []
  let i = 0
  const lead = digitRun(text, 0)
  let set: 'B' | 'C' = lead >= 4 || (lead === text.length && lead % 2 === 0) ? 'C' : 'B'
  const start = set === 'C' ? CODE128_START_C : CODE128_START_B
  while (i < text.length) {
    const run = digitRun(text, i)
    if (set === 'C') {
      if (run >= 2) {
        data.push(Number(text.slice(i, i + 2)))
        i += 2
      } else {
        data.push(CODE128_CODE_B)
        set = 'B'
      }
    } else if (run >= 4) {
      data.push(CODE128_CODE_C)
      set = 'C'
    } else {
      data.push(text.charCodeAt(i) - 32)
      i++
    }
  }
  let sum = start
  data.forEach((v, k) => (sum += v * (k + 1)))
  return [start, ...data, sum % 103, CODE128_STOP]
}

/** Module widths (bar, space, bar, …) of the whole symbol, quiet zones excluded. */
export function code128Modules(text: string): number[] {
  return code128Values(text).flatMap((v) => [...PATTERNS[v]!].map(Number))
}

export interface Code128SvgOptions {
  /** Width of one module in px (default 2). */
  moduleWidth?: number
  /** Bar height in px (default 60). */
  height?: number
  /** Quiet zone each side, in modules (default 10). */
  quietZone?: number
}

/** A self-contained SVG of the barcode (black bars on a white quiet zone). */
export function code128Svg(text: string, opts: Code128SvgOptions = {}): string {
  const mw = opts.moduleWidth ?? 2
  const h = opts.height ?? 60
  const quiet = opts.quietZone ?? 10
  const modules = code128Modules(text)
  const total = modules.reduce((s, m) => s + m, 0) + quiet * 2
  let x = quiet
  const rects: string[] = []
  modules.forEach((w, k) => {
    if (k % 2 === 0) rects.push(`<rect x="${x * mw}" y="0" width="${w * mw}" height="${h}"/>`)
    x += w
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total * mw}" height="${h}" viewBox="0 0 ${total * mw} ${h}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
  )
}
