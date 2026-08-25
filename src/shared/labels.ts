/**
 * Barcode labels for a thermal printer (roadmap E #111).
 *
 * A thermal label printer is not a small A4 printer. It has no page, no margins and no fonts
 * worth the name; it has a roll of gapped stock, a print head, and a command language. Sending it
 * a PDF gets a label with a scaled-down A4 page on it, or nothing at all.
 *
 * The language here is **TSPL** (TSC Printer Language), which is what the desktop label printers
 * sold into this market speak — TSC, and the Godex/Argox machines that emulate it. It is chosen
 * over ZPL for one reason: TSPL's `BARCODE` command encodes Code 128 in the printer's own
 * firmware, so this module never has to rasterise a symbology. A hand-rolled Code 128 encoder
 * with a wrong check digit produces a label that looks perfect and does not scan, and the shop
 * finds out at the till.
 *
 * WHAT IS NOT VERIFIED: like `escp.ts`, no physical printer has ever received these bytes. Every
 * command is transcribed from the TSPL/TSPL2 programming manual and unit-tested byte for byte,
 * and the layout arithmetic is tested — but "the commands are the documented ones" is a weaker
 * claim than "the label came out right". Hence `labelPreview`, which renders what each label will
 * say in plain text, and the save-to-file path in the service: the first person to try this on
 * real hardware can read the job before sending it.
 */

import { formatPaise, plainMilli } from './money'

/** Dots per millimetre. 203 dpi is the near-universal desktop label printer; 300 dpi exists. */
export const DPI_203 = 203 / 25.4
export const DPI_300 = 300 / 25.4

export type LabelDpi = 203 | 300

export interface LabelSize {
  id: string
  label: string
  /** Label face, millimetres. */
  widthMm: number
  heightMm: number
  /** Gap between labels down the roll, millimetres. 2 mm is the common die-cut gap. */
  gapMm: number
  /** Labels across the roll. Two-across stock exists and prints as one wider label. */
  across: number
}

/**
 * The stock sizes actually sold pre-cut in India, so nobody has to measure a roll with a ruler to
 * print a shelf label. A size not on this list is typed in millimetres instead — the presets are
 * a convenience, never a constraint.
 */
export const LABEL_SIZES: LabelSize[] = [
  { id: '50x25', label: '50 × 25 mm (shelf)', widthMm: 50, heightMm: 25, gapMm: 2, across: 1 },
  { id: '38x25', label: '38 × 25 mm (small)', widthMm: 38, heightMm: 25, gapMm: 2, across: 1 },
  { id: '75x50', label: '75 × 50 mm (carton)', widthMm: 75, heightMm: 50, gapMm: 3, across: 1 },
  { id: '100x50', label: '100 × 50 mm (pallet)', widthMm: 100, heightMm: 50, gapMm: 3, across: 1 }
]

export function labelSize(id: string): LabelSize | null {
  return LABEL_SIZES.find((s) => s.id === id) ?? null
}

/** What goes on one label. Every field is optional except the barcode data itself. */
export interface LabelSpec {
  /** The scannable string. Code 128 subset B, so printable ASCII only. */
  barcode: string
  /** Item name, first line, truncated to fit rather than wrapped off the edge. */
  name?: string
  /** Second line: a batch, a size, an expiry — whatever the shop writes on the shelf. */
  detail?: string
  /** Selling price, integer paise. Printed with the rupee word, not the glyph — see below. */
  pricePaise?: number
  /** Quantity, integer thousandths, printed with its unit when both are given. */
  qtyMilli?: number
  unitSymbol?: string
  /** How many copies of THIS label. A shelf gets one; a carton run gets forty. */
  copies?: number
}

export interface LabelOptions {
  size?: LabelSize
  dpi?: LabelDpi
  /** Print speed in inches/second and darkness 0-15, the two settings that get changed on site. */
  speed?: number
  density?: number
  /** Print the human-readable digits under the bars. Off for a very small label. */
  humanReadable?: boolean
  /** Direction 1 prints "head first", which is what a peeler expects. */
  direction?: 0 | 1
}

/**
 * Code 128 subset B covers ASCII 32–126 and nothing else.
 *
 * The check is here rather than left to the printer because a TSPL printer given a byte it cannot
 * encode prints a blank label and reports nothing. An item code with a rupee sign or a Devanagari
 * name in it has to be refused where a person can still fix it.
 */
export function isCode128Printable(data: string): boolean {
  return data.length > 0 && [...data].every((c) => {
    const code = c.charCodeAt(0)
    return code >= 32 && code <= 126
  })
}

/**
 * Text that is safe inside a TSPL quoted string.
 *
 * Two separate problems. A double quote or a backslash ends or escapes the string and turns the
 * rest of the label into commands — that is an injection, not a typo, and an item named `12" pipe`
 * is a perfectly ordinary thing to sell. And the printer's built-in bitmap fonts are Latin-1 only,
 * so a Devanagari name renders as a row of boxes; it is dropped to `?` here so the label is
 * obviously incomplete rather than subtly wrong.
 */
export function tsplText(text: string): string {
  return [...text]
    .map((c) => {
      const code = c.charCodeAt(0)
      if (c === '"' || c === '\\') return "'"
      if (code < 32 || code > 126) return '?'
      return c
    })
    .join('')
}

/** Cut a string to `max` characters, ending in an ellipsis when it had to lose something. */
export function fitText(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return `${text.slice(0, max - 1)}…`
}

/** Millimetres to printer dots, rounded to a whole dot — there is no half dot. */
export function dots(mm: number, dpi: LabelDpi = 203): number {
  return Math.round(mm * (dpi === 300 ? DPI_300 : DPI_203))
}

/**
 * The price line.
 *
 * `Rs.` rather than `₹`: the glyph is not in a thermal printer's built-in font and prints as a
 * box, and a shelf label whose price begins with a box is the one thing on the label a customer
 * definitely reads.
 */
export function labelPrice(pricePaise: number): string {
  return `Rs.${formatPaise(pricePaise, { symbol: false })}`
}

/**
 * How many characters of each built-in font fit across the label face.
 *
 * Shared by the renderer and the preview deliberately. A preview with its own idea of the width
 * is a preview that shows a name in full and then prints it cut in half, which is worse than no
 * preview at all: the operator has already decided the label is fine.
 */
export function labelColumns(size: LabelSize, dpi: LabelDpi = 203): { font2: number; font1: number } {
  // Built-in bitmap font metrics from the TSPL manual: font "2" is 12×20 dots, font "1" is 8×12.
  const inner = dots(size.widthMm, dpi) - dots(2, dpi) * 2
  return { font2: Math.max(4, Math.floor(inner / 12)), font1: Math.max(4, Math.floor(inner / 8)) }
}

/** The plain-text rendering of a label, for the on-screen preview and for the tests. */
export function labelPreview(spec: LabelSpec, size: LabelSize = LABEL_SIZES[0]!): string[] {
  const cols = labelColumns(size)
  const lines: string[] = []
  if (spec.name) lines.push(fitText(tsplText(spec.name), cols.font2))
  if (spec.detail) lines.push(fitText(tsplText(spec.detail), cols.font1))
  lines.push(`|||| ${tsplText(spec.barcode)} ||||`)
  const foot: string[] = []
  if (spec.qtyMilli != null) foot.push(`${plainMilli(spec.qtyMilli)}${spec.unitSymbol ? ` ${spec.unitSymbol}` : ''}`)
  if (spec.pricePaise != null) foot.push(labelPrice(spec.pricePaise))
  if (foot.length) lines.push(foot.join('   '))
  return lines
}

export interface LabelPlan {
  specs: LabelSpec[]
  totalLabels: number
  errors: string[]
}

/**
 * Check a batch of labels before a single byte is sent.
 *
 * A printer given fifty labels of which the eleventh is unencodable prints ten and stops, and the
 * operator has ten labels, a jammed job and no message. All the reasons come back at once.
 */
export function planLabels(specs: LabelSpec[], opts: { maxTotal?: number } = {}): LabelPlan {
  const maxTotal = opts.maxTotal ?? 2000
  const errors: string[] = []
  let totalLabels = 0
  for (const spec of specs) {
    const copies = spec.copies ?? 1
    if (!Number.isInteger(copies) || copies < 1 || copies > 500) {
      errors.push(`${spec.name ?? spec.barcode}: ${copies} copies is not a number of labels to print`)
      continue
    }
    if (!isCode128Printable(spec.barcode)) {
      errors.push(
        `${spec.name ?? 'This item'} has a barcode Code 128 cannot carry (${spec.barcode || 'blank'}) — it must be plain ASCII`
      )
      continue
    }
    totalLabels += copies
  }
  if (specs.length === 0) errors.push('Nothing selected to print')
  if (totalLabels > maxTotal) {
    errors.push(`${totalLabels} labels is more than one job should be — the limit is ${maxTotal}`)
  }
  return { specs, totalLabels, errors }
}

const CRLF = '\r\n'

/**
 * The TSPL job for a batch of labels.
 *
 * Layout, in dots from the top-left of the label face, with a 2 mm quiet margin all round:
 *
 *   name        font 2, one line
 *   detail      font 1, one line, only when given
 *   barcode     Code 128, whatever height is left over
 *   price/qty   font 2, baseline-aligned along the bottom
 *
 * The barcode gets the leftover height rather than a fixed one because a 25 mm label with two text
 * lines has about 8 mm of bar left and a 50 mm label has 30 — a fixed height is either unscannably
 * short on the small stock or runs off the bottom of it.
 */
export function renderLabelsTspl(specs: LabelSpec[], opts: LabelOptions = {}): Uint8Array {
  const size = opts.size ?? LABEL_SIZES[0]!
  const dpi = opts.dpi ?? 203
  const plan = planLabels(specs)
  if (plan.errors.length) throw new Error(plan.errors.join('; '))

  const out: string[] = []
  // Job setup. Sent once: SIZE and GAP re-run the printer's calibration, and doing that per label
  // makes it feed a blank one between every print.
  out.push(`SIZE ${size.widthMm} mm,${size.heightMm} mm`)
  out.push(`GAP ${size.gapMm} mm,0 mm`)
  out.push(`DIRECTION ${opts.direction ?? 1}`)
  out.push(`SPEED ${opts.speed ?? 4}`)
  out.push(`DENSITY ${opts.density ?? 8}`)
  out.push('REFERENCE 0,0')

  const margin = dots(2, dpi)
  const height = dots(size.heightMm, dpi)
  // Glyph heights for the same two built-in fonts `labelColumns` measures the widths of.
  const font2 = 20
  const font1 = 12
  const { font2: cols2, font1: cols1 } = labelColumns(size, dpi)

  for (const spec of plan.specs) {
    out.push('CLS')
    let y = margin
    if (spec.name) {
      out.push(`TEXT ${margin},${y},"2",0,1,1,"${tsplText(fitText(spec.name, cols2))}"`)
      y += font2 + 4
    }
    if (spec.detail) {
      out.push(`TEXT ${margin},${y},"1",0,1,1,"${tsplText(fitText(spec.detail, cols1))}"`)
      y += font1 + 4
    }
    const footText: string[] = []
    if (spec.qtyMilli != null) {
      footText.push(`${plainMilli(spec.qtyMilli)}${spec.unitSymbol ? ` ${spec.unitSymbol}` : ''}`)
    }
    if (spec.pricePaise != null) footText.push(labelPrice(spec.pricePaise))
    const footHeight = footText.length ? font2 + 4 : 0
    const human = opts.humanReadable === false ? 0 : 1
    // The printer draws the human-readable digits BELOW the bars, inside the height it was given,
    // so the reserved band has to allow for them or the digits land on the price line.
    const barHeight = Math.max(24, height - margin - y - footHeight - (human ? font1 + 2 : 0))
    out.push(`BARCODE ${margin},${y},"128",${barHeight},${human},0,2,4,"${tsplText(spec.barcode)}"`)
    if (footText.length) {
      out.push(`TEXT ${margin},${height - margin - font2},"2",0,1,1,"${tsplText(footText.join('  '))}"`)
    }
    out.push(`PRINT ${spec.copies ?? 1},1`)
  }

  // One byte per character, which is safe because `tsplText` has already reduced everything to
  // printable ASCII. Built by hand rather than through Buffer or TextEncoder: this module is
  // imported by the renderer, where Node's Buffer does not exist and TextEncoder would emit
  // multi-byte UTF-8 for a character the printer reads one byte at a time.
  const text = `${out.join(CRLF)}${CRLF}`
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}
