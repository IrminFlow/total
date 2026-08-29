/**
 * ESC/P bytes for a dot-matrix printer (roadmap #379).
 *
 * A large share of this market prints invoices on a decade-old impact printer loaded with
 * pre-printed multi-part stationery. A PDF does not reach that printer in any useful way: the
 * carbon copies only exist because the head strikes through them, and a rasterised page prints at
 * a tenth of the speed and tears the perforation alignment apart. What reaches it is a byte
 * stream in Epson's ESC/P sent raw to the device.
 *
 * So this module emits bytes, not a document. Everything is 8-bit; the layout is monospaced
 * columns counted in characters, because that is the only unit the printer has.
 *
 * WHAT IS NOT VERIFIED: this has never been sent to a physical printer. The escape sequences are
 * transcribed from the Epson ESC/P reference and unit-tested byte for byte, and the layout is
 * tested for column alignment — but "the sequences are the documented ones" is a weaker claim
 * than "the paper came out right", and nobody should assume the second from the first.
 */

// ---------- the control codes ----------

export const ESC = 0x1b
export const NUL = 0x00
export const CR = 0x0d
export const LF = 0x0a
/** Form feed — advances to the top of the next page/form. */
export const FF = 0x0c
/** Condensed on (17.1 cpi at 10 cpi pitch), the only way 132 columns fit on 80-column paper. */
export const SI = 0x0f
/** Condensed off. */
export const DC2 = 0x12

/**
 * The command set, as documented in the Epson ESC/P reference manual.
 *
 * Deliberately a small set: every sequence here is in the original ESC/P (1980s) command set that
 * every impact printer and every ESC/P emulation understands. The later ESC/P2 additions (scalable
 * fonts, raster graphics) are exactly the ones a fifteen-year-old printer will print as literal
 * garbage across the customer's invoice.
 */
export const CMD = {
  /** ESC @ — reset. Clears whatever the last job left set. */
  init: [ESC, 0x40],
  boldOn: [ESC, 0x45],
  boldOff: [ESC, 0x46],
  underlineOn: [ESC, 0x2d, 0x01],
  underlineOff: [ESC, 0x2d, 0x00],
  doubleWidthOn: [ESC, 0x57, 0x01],
  doubleWidthOff: [ESC, 0x57, 0x00],
  condensedOn: [SI],
  condensedOff: [DC2],
  /** ESC P — 10 cpi (pica). */
  pica: [ESC, 0x50],
  /** ESC M — 12 cpi (elite). */
  elite: [ESC, 0x4d],
  /** ESC 0 — 1/8" line spacing: eight lines to the inch, the usual invoice setting. */
  lineSpacing8: [ESC, 0x30],
  /** ESC 2 — 1/6" line spacing, the printer's default. */
  lineSpacing6: [ESC, 0x32],
  /** ESC x 0 — draft quality, which on an impact printer is the fast one. */
  draft: [ESC, 0x78, 0x00],
  /** ESC x 1 — near letter quality: slower, and worth it on the top copy only. */
  nlq: [ESC, 0x78, 0x01]
} as const

/** ESC C n — form length in lines (n = 1..127). The stationery's length, not the paper's. */
export function formLengthLines(lines: number): number[] {
  if (lines < 1 || lines > 127) throw new Error('Form length must be 1–127 lines')
  return [ESC, 0x43, lines]
}

/** ESC C NUL n — form length in inches (n = 1..22), for stationery measured that way. */
export function formLengthInches(inches: number): number[] {
  if (inches < 1 || inches > 22) throw new Error('Form length must be 1–22 inches')
  return [ESC, 0x43, NUL, inches]
}

/** ESC N n — skip n lines over the perforation, so text never straddles the tear. */
export function skipPerforation(lines: number): number[] {
  if (lines < 1 || lines > 127) throw new Error('Perforation skip must be 1–127 lines')
  return [ESC, 0x4e, lines]
}

/** ESC t n — character table. 1 selects the printer's extended graphics table. */
export function characterTable(n: 0 | 1 | 2 | 3): number[] {
  return [ESC, 0x74, n]
}

// ---------- building a stream ----------

export class EscpDoc {
  private readonly bytes: number[] = []

  /** Characters per line at the current pitch. Used by the layout helpers. */
  constructor(readonly width: number = 80) {}

  raw(seq: readonly number[]): this {
    this.bytes.push(...seq)
    return this
  }

  /**
   * Write text, transliterated to the printer's 8-bit world.
   *
   * A rupee sign is not in any ESC/P character table — it was standardised in 2010, long after
   * the last of these printers was designed — so it becomes "Rs.". Anything else outside Latin-1
   * becomes '?' rather than a random glyph, because a wrong character on a tax invoice is worse
   * than a visibly missing one.
   */
  text(s: string): this {
    for (const ch of s.replace(/₹/g, 'Rs.')) {
      const code = ch.codePointAt(0)!
      this.bytes.push(code <= 0xff ? code : 0x3f)
    }
    return this
  }

  line(s = ''): this {
    return this.text(s).raw([CR, LF])
  }

  bold(s: string): this {
    return this.raw(CMD.boldOn).text(s).raw(CMD.boldOff)
  }

  /** A rule of `-` the full width of the line. */
  rule(ch = '-'): this {
    return this.line(ch.repeat(this.width))
  }

  /** Eject to the top of the next form. Continuous stationery is aligned by form, never by count. */
  formFeed(): this {
    return this.raw([FF])
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }

  /** For tests and for showing the operator what will be sent. */
  toDebugString(): string {
    return this.bytes
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, '0')}>`))
      .join('')
  }
}

/**
 * A byte stream as a person can read it: printable characters as themselves, everything else in
 * angle brackets. The only honest preview of a job whose whole point is that it is not a page.
 */
export function escpDebug(bytes: Uint8Array): string {
  return [...bytes]
    .map((b) => (b === LF ? '\n' : b === CR ? '' : b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, '0')}>`))
    .join('')
}

// ---------- fixed-width column layout ----------

export interface Column {
  width: number
  align?: 'left' | 'right'
}

/** Pad or truncate to exactly `width`. Truncation is silent by design — see `row`. */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const s = text.length > width ? text.slice(0, width) : text
  return align === 'right' ? s.padStart(width, ' ') : s.padEnd(width, ' ')
}

/**
 * One row of columns, separated by a single space.
 *
 * Truncation rather than wrapping, because a column that wraps pushes every following line out of
 * alignment with the pre-printed boxes on the stationery — which is the one failure that makes
 * the whole run unusable rather than merely ugly. Callers that need the full text wrap it
 * themselves with `wrap` and emit continuation rows.
 */
export function row(cells: string[], cols: Column[]): string {
  return cols.map((c, i) => fit(cells[i] ?? '', c.width, c.align ?? 'left')).join(' ')
}

/** Break `text` into lines of at most `width`, on word boundaries where it can. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if (line === '') line = w
    else if (line.length + 1 + w.length <= width) line += ` ${w}`
    else {
      out.push(line)
      line = w
    }
    while (line.length > width) {
      out.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

// ---------- an invoice on continuous stationery ----------

export interface EscpInvoiceLine {
  description: string
  hsn: string | null
  /** Already formatted — the caller owns quantity formatting, this module owns columns. */
  qty: string
  rate: string
  amount: string
}

export interface EscpInvoice {
  companyName: string
  companyAddress: string[]
  gstin: string | null
  title: string
  number: string
  date: string
  partyName: string
  partyAddress: string[]
  partyGstin: string | null
  lines: EscpInvoiceLine[]
  /** Label/value pairs printed under the line total: taxable, CGST, SGST, round off … */
  totals: { label: string; value: string }[]
  grandTotalLabel: string
  grandTotalValue: string
  amountInWords: string
  footer: string[]
}

export interface EscpOptions {
  /** Characters per line. 80 for standard stationery, 132 for wide. */
  width?: 80 | 132
  /** Lines on one form. 66 at 6 lpi on 11" paper; 12" stationery is 72. */
  formLines?: number
  /** Lines to leave blank over the perforation. */
  perforationSkip?: number
  /** Condensed print, which is how 132 columns reach 80-column paper. */
  condensed?: boolean
  /** Skip the header block — pre-printed stationery already has the company on it. */
  preprintedHeader?: boolean
  /** Copies to print, each on its own form: Original / Duplicate / Triplicate. */
  copies?: string[]
}

/**
 * Lay an invoice out in characters and emit the bytes.
 *
 * The copy labels matter more than they look: multi-part stationery makes physical copies, but a
 * shop printing on plain continuous paper needs three separately-labelled forms, and rule 46 of
 * the CGST Rules requires the copies to be marked. Defaulting to a single unlabelled copy would
 * quietly produce an invoice that is not a valid one.
 */
export function renderInvoiceEscp(inv: EscpInvoice, opts: EscpOptions = {}): Uint8Array {
  const width = opts.width ?? 80
  const copies = opts.copies?.length ? opts.copies : ['ORIGINAL FOR RECIPIENT']
  const doc = new EscpDoc(width)

  doc.raw(CMD.init).raw(CMD.draft).raw(CMD.lineSpacing6)
  if (opts.formLines) doc.raw(formLengthLines(opts.formLines))
  if (opts.perforationSkip) doc.raw(skipPerforation(opts.perforationSkip))
  if (opts.condensed) doc.raw(CMD.condensedOn)

  // Amount columns are the last thing that may be squeezed: a rupee figure that loses a digit is
  // a wrong invoice, so the description absorbs the whole of any width shortfall.
  const amtW = 12
  const rateW = 10
  const qtyW = 8
  const hsnW = 8
  const descW = Math.max(12, width - (amtW + rateW + qtyW + hsnW + 4))
  const cols: Column[] = [
    { width: descW },
    { width: hsnW },
    { width: qtyW, align: 'right' },
    { width: rateW, align: 'right' },
    { width: amtW, align: 'right' }
  ]

  copies.forEach((copy, index) => {
    if (!opts.preprintedHeader) {
      doc.raw(CMD.doubleWidthOn).bold(fit(inv.companyName, Math.floor(width / 2))).raw(CMD.doubleWidthOff).line()
      for (const l of inv.companyAddress) doc.line(l)
      if (inv.gstin) doc.line(`GSTIN: ${inv.gstin}`)
    }
    doc.line()
    doc.line(fit(inv.title, width, 'left'))
    doc.line(fit(copy, width, 'right'))
    doc.rule('=')

    doc.line(row([`Invoice: ${inv.number}`, '', '', '', `Date: ${inv.date}`], [
      { width: descW }, { width: hsnW }, { width: qtyW }, { width: rateW }, { width: amtW, align: 'right' }
    ]))
    doc.line(`To: ${inv.partyName}`)
    for (const l of inv.partyAddress) doc.line(`    ${l}`)
    if (inv.partyGstin) doc.line(`    GSTIN: ${inv.partyGstin}`)
    doc.rule()

    doc.bold(row(['Description', 'HSN', 'Qty', 'Rate', 'Amount'], cols)).raw([CR, LF])
    doc.rule()
    for (const l of inv.lines) {
      const [first, ...rest] = wrap(l.description, descW)
      doc.line(row([first ?? '', l.hsn ?? '', l.qty, l.rate, l.amount], cols))
      for (const cont of rest) doc.line(row([cont, '', '', '', ''], cols))
    }
    doc.rule()

    const labelW = width - amtW - 1
    for (const t of inv.totals) {
      doc.line(row([t.label, t.value], [{ width: labelW, align: 'right' }, { width: amtW, align: 'right' }]))
    }
    doc
      .bold(row([inv.grandTotalLabel, inv.grandTotalValue], [{ width: labelW, align: 'right' }, { width: amtW, align: 'right' }]))
      .raw([CR, LF])
    doc.rule('=')
    for (const l of wrap(inv.amountInWords, width)) doc.line(l)
    doc.line()
    for (const l of inv.footer) doc.line(l)

    // A form feed after every copy, including the last: the next job must start at the top of a
    // form, and leaving the paper mid-form is how the following invoice prints across a tear.
    doc.formFeed()
    if (index === copies.length - 1 && opts.condensed) doc.raw(CMD.condensedOff)
  })

  doc.raw(CMD.init)
  return doc.toBytes()
}
