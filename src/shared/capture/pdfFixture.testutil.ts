// Builds small, valid PDFs with a real text layer for the capture tests (not a test file).
// `simple`: Helvetica (WinAnsi, one byte per glyph). `cid`: a Type0 font whose two-byte codes are
// mapped back by a /ToUnicode CMap — the way Tally / Zoho / Busy PDFs usually carry text.
// `deflate` (zlib from the test) compresses the content streams like real files do.

export interface FixtureOptions {
  font?: 'simple' | 'cid'
  deflate?: (b: Uint8Array) => Uint8Array
  /** Put the font + page objects in an /ObjStm (PDF 1.5 object streams). */
  objectStream?: boolean
  pages?: string[][]
  /** 'glyphs': every character placed by its own Tm (how some billing software writes text). */
  layout?: 'lines' | 'glyphs'
}

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function makeTestPdf(lines: string[], opts: FixtureOptions = {}): Uint8Array {
  const pages = opts.pages ?? [lines]
  const font = opts.font ?? 'simple'
  // Glyph codes for the CID font: each distinct character gets a two-byte code from 0x0101.
  const chars = [...new Set(pages.flat().join(''))]
  const code = new Map(chars.map((c, i) => [c, 0x0101 + i]))
  const show = (s: string): string =>
    font === 'cid' ? `<${[...s].map((c) => code.get(c)!.toString(16).padStart(4, '0')).join('')}> Tj` : `(${esc(s)}) Tj`
  const contentOf = (ls: string[]): string =>
    opts.layout === 'glyphs'
      ? `BT\n/F1 10 Tf\n${ls.map((l, li) => [...l].map((c, ci) => `1 0 0 1 ${50 + ci * 6} ${800 - li * 14} Tm ${show(c)}\n`).join('')).join('')}ET\n`
      : `BT\n/F1 10 Tf\n50 800 Td\n14 TL\n${ls.map((l, i) => (i === 0 ? `${show(l)}\n` : `T*\n${show(l)}\n`)).join('')}ET\n`

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 tounicode (cid), 5.. page + content pairs.
  const objects: { num: number; body: string; stream?: Uint8Array; inStm?: boolean }[] = []
  const pageNums: number[] = []
  let next = 5
  const pageObjs: { num: number; body: string }[] = []
  for (const ls of pages) {
    const pageNum = next++
    const contentNum = next++
    pageNums.push(pageNum)
    let data = enc(contentOf(ls))
    let filter = ''
    if (opts.deflate) {
      data = opts.deflate(data)
      filter = ' /Filter /FlateDecode'
    }
    pageObjs.push({ num: pageNum, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>` })
    objects.push({ num: contentNum, body: `<< /Length ${data.length}${filter} >>`, stream: data })
  }
  objects.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' })
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`, inStm: true })
  if (font === 'cid') {
    objects.push({
      num: 3,
      body: '<< /Type /Font /Subtype /Type0 /BaseFont /NotoSans /Encoding /Identity-H /DescendantFonts [] /ToUnicode 4 0 R >>',
      inStm: true
    })
    const bf = chars.map((c) => `<${code.get(c)!.toString(16).padStart(4, '0')}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`)
    const cmap = enc(
      `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.join('\n')}\nendbfchar\nendcmap\nend\nend\n`
    )
    const data = opts.deflate ? opts.deflate(cmap) : cmap
    objects.push({ num: 4, body: `<< /Length ${data.length}${opts.deflate ? ' /Filter /FlateDecode' : ''} >>`, stream: data })
  } else {
    objects.push({ num: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', inStm: true })
  }
  for (const p of pageObjs) objects.push({ ...p, inStm: true })

  if (opts.objectStream && opts.deflate) {
    const packed = objects.filter((o) => o.inStm && !o.stream)
    const rest = objects.filter((o) => !(o.inStm && !o.stream))
    let head = ''
    let bodies = ''
    for (const o of packed) {
      head += `${o.num} ${bodies.length} `
      bodies += `${o.body}\n`
    }
    const raw = enc(head + bodies)
    const data = opts.deflate(raw)
    rest.push({ num: next++, body: `<< /Type /ObjStm /N ${packed.length} /First ${head.length} /Length ${data.length} /Filter /FlateDecode >>`, stream: data })
    objects.length = 0
    objects.push(...rest)
  }

  objects.sort((a, b) => a.num - b.num)
  const parts: Uint8Array[] = [enc('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n')]
  let offset = parts[0]!.length
  const xref: string[] = []
  for (const o of objects) {
    xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
    const headPart = enc(`${o.num} 0 obj\n${o.body}\n`)
    const chunk = o.stream ? concat([headPart, enc('stream\n'), o.stream, enc('\nendstream\nendobj\n')]) : concat([headPart, enc('endobj\n')])
    parts.push(chunk)
    offset += chunk.length
  }
  parts.push(enc(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref.join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`))
  return concat(parts)
}

/** The bill text used by the fixtures (Bharat Steel Suppliers → Demo Traders). */
export const FIXTURE_BILL_LINES = [
  'TAX INVOICE',
  'Bharat Steel Suppliers',
  'MIDC Bhosari, Pune 411026',
  'GSTIN: 27AABCG3456H1ZN',
  'Invoice No: BSS/2025-26/0142    Date: 12/08/2025',
  'Bill to: Demo Traders  GSTIN 27AAPFU0939F1ZV',
  'Place of supply: 27-Maharashtra',
  'Sl  Description            HSN    Qty   Rate       Amount',
  '1   Office Chair           9401   4     5,000.00   20,000.00',
  '2   Steel Filing Cabinet   9403   1     9,500.00   9,500.00',
  'Taxable value 29,500.00',
  'CGST 9% 1,800.00   CGST 6% 570.00',
  'SGST 9% 1,800.00   SGST 6% 570.00',
  'Round off 0.00',
  'Total Rs. 34,240.00',
  'Payment terms: 30 days'
]
