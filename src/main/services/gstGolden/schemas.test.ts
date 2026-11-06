// The vendored official GST JSON schemas (no network): the files are the ones published (SHA-256
// as recorded in schemas/sources.json), the repaired schemas compile, and each portal's own sample
// payload passes its schema — so a failure on the app's JSON (gstGolden.dbtest.ts, which validates
// every golden fixture's GSTR-1 / GSTR-3B / e-invoice output) is the app's, not the repair's.
import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { repairedEinvoiceSchema, validateEinvoiceJson, validateGstr1Json, validateGstr3bJson, vendored } from './schemas'

const sources = vendored('sources.json') as { files: Record<string, { sha256: string; url: string; fetched: string }> }

const dir = join(__dirname, 'schemas')
const read = (f: string): string => readFileSync(join(dir, f), 'utf8')

describe('vendored GST schemas', () => {
  it('are byte-for-byte the files recorded in sources.json, each with its URL and fetch date', () => {
    for (const [file, meta] of Object.entries(sources.files)) {
      const sha = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')
      expect({ file, sha }).toEqual({ file, sha: meta.sha256 })
      expect(meta.url).toMatch(/^https:\/\/(developer|einvoice)\.gst\.gov\.in\//)
      expect(meta.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  // The published samples lag their schemas by a field or two: the GSTR-1 v5.0 sample still sends
  // `etin` on B2CL / B2CS rows (e-commerce supplies moved to Table 14, `supeco`), the v4.1 sample
  // `diff_percent` (dropped from the schema), and the e-invoice sample `null` for absent optional
  // fields the schema types as string / number. Exactly those are dropped; everything else in each
  // sample must pass.
  it('the portals\' own sample payloads pass their schemas (bar the fields the schemas dropped)', () => {
    const sample = (f: string, drop: (k: string, v: unknown, holder: Record<string, unknown>) => boolean): unknown =>
      JSON.parse(read(f), function (this: Record<string, unknown>, k, v) { return drop(k, v, this) ? undefined : v })
    expect(validateGstr1Json(JSON.parse(read('gstr1-save-v5.0.sample.json')), 'v5.0').every((e) => /etin|flag|anyOf/.test(e))).toBe(true)
    expect(validateGstr1Json(sample('gstr1-save-v5.0.sample.json', (k, _v, row) => k === 'etin' && ('inum' in row || 'sply_ty' in row)), 'v5.0')).toEqual([])
    expect(validateGstr1Json(sample('gstr1-save-v4.1.sample.json', (k) => k === 'diff_percent'), 'v4.1')).toEqual([])
    expect(validateGstr3bJson(JSON.parse(read('gstr3b-save-v7.1.sample.json')))).toEqual([])
    expect(validateEinvoiceJson(sample('einvoice-1.1.sample.json', (_k, v) => v === null))).toEqual([])
  })

  it('the e-invoice repair moves every published field under properties and makes ItemList an array', () => {
    const s = repairedEinvoiceSchema() as { properties: Record<string, { type?: string; items?: unknown }>; required: string[] }
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['Version', 'TranDtls', 'DocDtls', 'SellerDtls', 'BuyerDtls', 'ItemList', 'ValDtls', 'AddlDocDtls']))
    expect(s.properties.ItemList).toMatchObject({ type: 'array' })
    expect(s.required).toEqual(['Version', 'TranDtls', 'DocDtls', 'SellerDtls', 'BuyerDtls', 'ItemList', 'ValDtls'])
  })

  it('reject what they should (the checks are live, not vacuous)', () => {
    expect(validateGstr1Json({ gstin: '27AAPFU0939F1ZV', fp: '132025' })).not.toEqual([])
    expect(validateGstr3bJson({ gstin: '27AAPFU0939F1ZV', ret_period: '052025', sup_details: { osup_det: { txval: 1.234 } } })).not.toEqual([])
    const sample = JSON.parse(read('einvoice-1.1.sample.json'))
    expect(validateEinvoiceJson({ ...sample, ItemList: [{ ...sample.ItemList[0], HsnCd: '12' }] })).not.toEqual([])
    expect(validateEinvoiceJson({ ...sample, DocDtls: { ...sample.DocDtls, Dt: '2025-05-05' } })).not.toEqual([])
  })
})
