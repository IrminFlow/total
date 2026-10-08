// WP 5.4 — the TOTAL_AI_MOCK script's capture half: plays the model for the two structured calls
// capture makes. Bill extraction: a text layer is transcribed with a few fixed patterns (the
// layout of the e2e / dbtest fixture bills — printed figures copied verbatim, never computed);
// an image or PDF sent as a file is matched by its bytes to a canned extraction. Statement
// categories: the first candidate of each line whose name shares a word with the narration, else
// null. Deterministic, offline.
import { createHash } from 'crypto'
import type { BillExtraction } from '@shared/capture/schema'
import type { ChatRequest } from '../types'
import type { MockStep } from '../mockProvider'

const empty = (over: Partial<BillExtraction>): BillExtraction => ({
  documentType: 'tax_invoice', supplier: { name: null, gstin: null, address: null, stateCode: null }, buyerGstin: null, invoiceNumber: null, invoiceDate: null,
  invoiceDateIso: null, placeOfSupply: null, paymentTerms: null, dueDate: null, currency: null, lines: [], taxSummary: [], roundOff: null, total: null,
  confidence: 'high', notes: null, ...over
})

/** The fixture bill (Bharat Steel Suppliers BSS/2025-26/0142) as a photo would be read. */
export const CANNED_BHARAT_BILL: BillExtraction = empty({
  supplier: { name: 'Bharat Steel Suppliers', gstin: '27AABCG3456H1ZN', address: 'MIDC Bhosari, Pune 411026', stateCode: '27' },
  buyerGstin: '27AAPFU0939F1ZV',
  invoiceNumber: 'BSS/2025-26/0142',
  invoiceDate: '12/08/2025',
  invoiceDateIso: '2025-08-12',
  placeOfSupply: '27-Maharashtra',
  paymentTerms: '30 days',
  currency: 'INR',
  lines: [
    { description: 'Office Chair', hsn: '9401', qty: '4', unit: 'Nos', rate: '5,000.00', discount: null, taxable: '20,000.00', gstRate: '18%', cgst: null, sgst: null, igst: null, cess: null, amount: '20,000.00' },
    { description: 'Steel Filing Cabinet', hsn: '9403', qty: '1', unit: 'Nos', rate: '9,500.00', discount: null, taxable: '9,500.00', gstRate: '12%', cgst: null, sgst: null, igst: null, cess: null, amount: '9,500.00' }
  ],
  taxSummary: [
    { rate: '18%', taxable: '20,000.00', cgst: '1,800.00', sgst: '1,800.00', igst: null, cess: null },
    { rate: '12%', taxable: '9,500.00', cgst: '570.00', sgst: '570.00', igst: null, cess: null }
  ],
  roundOff: '0.00',
  total: '₹ 34,240.00'
})

/** Transcribe a text layer laid out like the fixtures. */
export function transcribeFixtureText(text: string): BillExtraction {
  const lines = text.split('\n').map((l) => l.trim())
  const at = lines.findIndex((l) => /tax invoice/i.test(l))
  const gstins = text.match(/\[GSTIN …[0-9A-Z]{3}\]|\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g) ?? []
  const rows = lines.flatMap((l) => {
    const m = /^\d+\s+(.+?)\s+(\d{4,8})\s+(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/.exec(l)
    return m ? [{ description: m[1]!, hsn: m[2]!, qty: m[3]!, unit: null, rate: m[4]!, discount: null, taxable: m[5]!, gstRate: null, cgst: null, sgst: null, igst: null, cess: null, amount: m[5]! }] : []
  })
  const cg = [...text.matchAll(/CGST\s+(\d+(?:\.\d+)?)%\s+([\d,]+\.\d{2})/g)]
  const sg = [...text.matchAll(/SGST\s+(\d+(?:\.\d+)?)%\s+([\d,]+\.\d{2})/g)]
  const ig = [...text.matchAll(/IGST\s+(\d+(?:\.\d+)?)%\s+([\d,]+\.\d{2})/g)]
  const taxSummary = [
    ...cg.map((c, i) => ({ rate: `${Number(c[1]) * 2}%`, taxable: null, cgst: c[2]!, sgst: sg[i]?.[2] ?? null, igst: null, cess: null })),
    ...ig.map((g) => ({ rate: `${g[1]}%`, taxable: null, cgst: null, sgst: null, igst: g[2]!, cess: null }))
  ]
  const date = /Date:\s*([\d/.-]+)/.exec(text)?.[1] ?? null
  return empty({
    documentType: rows.length ? 'tax_invoice' : 'not_a_bill',
    supplier: { name: at >= 0 ? (lines[at + 1] ?? null) : null, gstin: gstins[0] ?? null, address: at >= 0 ? (lines[at + 2] ?? null) : null, stateCode: null },
    buyerGstin: gstins[1] ?? null,
    invoiceNumber: /Invoice No:\s*(\S+)/.exec(text)?.[1] ?? null,
    invoiceDate: date,
    placeOfSupply: /Place of supply:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null,
    paymentTerms: /Payment terms:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null,
    lines: rows,
    taxSummary,
    roundOff: /Round off\s+(-?[\d,]+\.\d{2})/i.exec(text)?.[1] ?? null,
    total: /Total\s+((?:Rs\.|₹)?\s*[\d,]+\.\d{2})/.exec(text)?.[1] ?? null
  })
}

/** SHA-256 of scripts/e2e/fixtures/bharat-steel-bill-photo.png — the photo the mock "reads"
 *  (file names are never sent, so the mock recognises the fixture by its bytes). */
export const FIXTURE_PHOTO_SHA256 = 'ff089ffc7ba871a5dd6f6099e6215afe1dc34916d53073e2d45c192f7966fd64'

function userText(req: ChatRequest): { content: string; attachmentSha: string | null } {
  const m = [...req.input].reverse().find((i) => i.type === 'message' && i.role === 'user') as { content: string; attachments?: { base64: string }[] } | undefined
  const a = m?.attachments?.[0]
  return { content: m?.content ?? '', attachmentSha: a ? createHash('sha256').update(Buffer.from(a.base64, 'base64')).digest('hex') : null }
}

export function captureMockStep(req: ChatRequest): MockStep | null {
  const name = req.responseFormat?.name
  if (name === 'bill_extraction') {
    const { content, attachmentSha } = userText(req)
    const text = /<<<BILL\n([\s\S]*)\nBILL>>>/.exec(content)?.[1]
    if (text != null) return { text: JSON.stringify(transcribeFixtureText(text)), usage: { inputTokens: 1400, outputTokens: 600 } }
    if (attachmentSha === FIXTURE_PHOTO_SHA256) return { text: JSON.stringify(CANNED_BHARAT_BILL), usage: { inputTokens: 1800, outputTokens: 600 } }
    return { text: JSON.stringify(empty({ documentType: 'not_a_bill', confidence: 'low' })), usage: { inputTokens: 1800, outputTokens: 80 } }
  }
  if (name === 'statement_categories') {
    const { content } = userText(req)
    let data: { lineId: number; narration: string; candidates: { id: number; name: string }[] }[] = []
    try {
      data = JSON.parse(content.slice(content.indexOf('['))) as typeof data
    } catch {
      /* none */
    }
    const words = (s: string): string[] => s.toUpperCase().split(/[^A-Z]+/).filter((w) => w.length >= 4)
    const picks = data.map((l) => {
      const said = new Set(words(l.narration))
      const hit = l.candidates.find((c) => words(c.name).some((w) => said.has(w)))
      return { lineId: l.lineId, ledgerId: hit?.id ?? null, reason: hit ? `the narration mentions ${hit.name}` : 'no candidate fits' }
    })
    return { text: JSON.stringify({ picks }), usage: { inputTokens: 900, outputTokens: 120 } }
  }
  return null
}
