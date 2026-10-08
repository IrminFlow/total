// WP 3.5 — every e-invoice shape the builder can produce validates against the published IRN
// JSON schema 1.1 + the IRP's business validations (src/shared/gst/einvoiceSchema.ts), and the
// validator itself rejects what the published schema rejects.
import { describe, expect, it } from 'vitest'
import { buildEInvoiceJson, buildEwbByIrnPayload, type EdocCompany, type EdocInvoice, type EdocItem } from './gst/edocs'
import { einvoiceIssues, einvoiceSchema, withinNicTolerance } from './gst/einvoiceSchema'
import { computeGst } from './gst/calc'

const company: EdocCompany = {
  name: 'Demo Traders Private Limited',
  gstin: '27AAPFU0939F1ZV',
  stateCode: '27',
  address: 'Plot 12, MIDC Industrial Area, Near the Old Octroi Naka, Bhosari\nPune 411026'
}

type Shape = 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP'

interface Spec {
  shape: Shape
  intra?: boolean
  docType?: 'INV' | 'CRN' | 'DBN'
  number?: string
  lines: { hsn: string; rate: number; cessRate?: number; qtyMilli: number; ratePaise: number; discountPaise?: number; service?: boolean; name?: string }[]
  tcsPaise?: number
  roundOffPaise?: number
  shipTo?: boolean
  rchrg?: boolean
}

/** A consistent EdocInvoice the way extractEdocInvoices assembles one (computeGst per line). */
function makeInvoice(spec: Spec): EdocInvoice {
  const wop = spec.shape === 'EXPWOP' || spec.shape === 'SEZWOP'
  const isExport = spec.shape === 'EXPWP' || spec.shape === 'EXPWOP'
  const intra = spec.shape === 'B2B' && !!spec.intra
  const items: EdocItem[] = spec.lines.map((l, i) => {
    const gross = Math.round((l.qtyMilli * l.ratePaise) / 1000)
    const discount = Math.min(l.discountPaise ?? 0, gross)
    const taxable = l.service ? l.ratePaise : gross - discount
    const g = computeGst(taxable, l.rate, intra ? 'intra' : 'inter', l.cessRate ?? 0)
    return {
      name: l.name ?? `Item number ${i + 1}`, hsn: l.hsn, qtyMilli: l.service ? 0 : l.qtyMilli, uqc: l.service ? 'OTH' : 'NOS',
      unitPricePaise: l.ratePaise, taxablePaise: taxable, rate: l.rate, cessRate: l.cessRate ?? 0,
      cgst: g.cgst, sgst: g.sgst, igst: wop ? 0 : g.igst, cess: wop ? 0 : g.cess, isService: !!l.service,
      discountPaise: l.service ? 0 : discount
    }
  })
  const sum = (f: (i: EdocItem) => number): number => items.reduce((s, i) => s + f(i), 0)
  const taxable = sum((i) => i.taxablePaise)
  const cgst = sum((i) => i.cgst), sgst = sum((i) => i.sgst), igst = sum((i) => i.igst), cess = sum((i) => i.cess)
  const roundOff = spec.roundOffPaise ?? 0
  const tcs = spec.tcsPaise ? { amountPaise: spec.tcsPaise, rateBp: 10, reference: '206C(1H)' } : null
  const partyState = isExport ? '96' : intra ? '27' : '29'
  return {
    number: spec.number ?? 'INV/26-27/0001',
    date: '2026-08-15',
    docType: spec.docType ?? 'INV',
    supTyp: spec.shape,
    rchrg: spec.rchrg,
    partyName: isExport ? 'Globex Corporation' : 'Umbrella Retail LLP',
    partyGstin: isExport ? null : `${partyState}AAACU1234F1Z5`,
    partyAddress: isExport ? '1 Infinite Loop\nCupertino CA' : `Shop 4, Brigade Road\nBengaluru 560001`,
    partyStateCode: partyState,
    pos: partyState,
    items,
    taxable, cgst, sgst, igst, cess,
    roundOff,
    total: taxable + cgst + sgst + igst + cess + roundOff + (tcs?.amountPaise ?? 0),
    ...(tcs ? { tcs } : {}),
    transporterId: null,
    vehicleNo: 'MH12AB1234',
    distanceKm: 120,
    transport: isExport ? { mode: '4', docNo: 'SB1234567', docDate: '2026-08-16', transporterName: null, vehicleType: null } : null,
    shipTo: spec.shipTo
      ? { name: 'Umbrella Warehouse', gstin: null, addr1: 'Godown 7', addr2: 'Peenya Phase 2', place: 'Bengaluru', pincode: '560058', state: '29' }
      : null,
    precedingDoc: spec.docType === 'CRN' || spec.docType === 'DBN' ? { invNo: 'INV/26-27/0001', invDate: '2026-08-01' } : null
  }
}

const doc = (spec: Spec): Record<string, unknown> => buildEInvoiceJson([makeInvoice(spec)], company)[0]!
const goods = (over: Partial<Spec['lines'][number]> = {}): Spec['lines'][number] =>
  ({ hsn: '84713010', rate: 18, qtyMilli: 2000, ratePaise: 4_500_000, ...over })

describe('every invoice shape the app produces validates against the IRN schema 1.1', () => {
  const cases: [string, Spec][] = [
    ['B2B intra-state', { shape: 'B2B', intra: true, lines: [goods()] }],
    ['B2B inter-state', { shape: 'B2B', lines: [goods()] }],
    ['B2B with cess', { shape: 'B2B', intra: true, lines: [goods({ hsn: '87032291', rate: 28, cessRate: 15 })] }],
    ['B2B with line discount', { shape: 'B2B', intra: true, lines: [goods({ discountPaise: 123_456 })] }],
    ['B2B with TCS in OthChrg', { shape: 'B2B', lines: [goods()], tcsPaise: 10_620 }],
    ['B2B with round-off', { shape: 'B2B', intra: true, lines: [goods({ ratePaise: 4_499_955 })], roundOffPaise: 18 }],
    ['B2B with negative round-off', { shape: 'B2B', lines: [goods({ ratePaise: 4_500_045 })], roundOffPaise: -21 }],
    ['B2B multiple HSN', { shape: 'B2B', intra: true, lines: [goods(), goods({ hsn: '8523', rate: 12 }), goods({ hsn: '392690', rate: 5, qtyMilli: 1500 })] }],
    ['B2B service invoice', { shape: 'B2B', lines: [{ hsn: '998314', rate: 18, qtyMilli: 0, ratePaise: 2_500_000, service: true }] }],
    ['B2B 16-char document number', { shape: 'B2B', number: 'INV/2026-27/0001', lines: [goods()] }],
    ['B2B reverse charge', { shape: 'B2B', rchrg: true, lines: [goods()] }],
    ['B2B ship-to', { shape: 'B2B', shipTo: true, lines: [goods()] }],
    ['B2B two-letter item name + inch mark', { shape: 'B2B', lines: [goods({ name: 'TV' }), goods({ name: 'Monitor 27" \\ stand' })] }],
    ['credit note', { shape: 'B2B', docType: 'CRN', number: 'CN/26-27/12', lines: [goods()] }],
    ['debit note', { shape: 'B2B', docType: 'DBN', number: 'DN-7', lines: [goods()] }],
    ['SEZ with payment', { shape: 'SEZWP', lines: [goods()] }],
    ['SEZ without payment', { shape: 'SEZWOP', lines: [goods()] }],
    ['export with payment', { shape: 'EXPWP', lines: [goods()] }],
    ['export without payment', { shape: 'EXPWOP', lines: [goods(), goods({ hsn: '6109', rate: 5 })] }]
  ]
  for (const [name, spec] of cases) {
    it(name, () => {
      expect(einvoiceIssues(doc(spec))).toEqual([])
    })
  }

  it('the discount line carries the gross in TotAmt and AssAmt = TotAmt − Discount', () => {
    const d = doc({ shape: 'B2B', intra: true, lines: [goods({ discountPaise: 123_456 })] }) as any
    expect(d.ItemList[0]).toMatchObject({ TotAmt: 90000, Discount: 1234.56, AssAmt: 88765.44 })
  })

  it('exports carry URP / 96 / PIN 999999 and no null ExpDtls members', () => {
    const d = doc({ shape: 'EXPWOP', lines: [goods()] }) as any
    expect(d.BuyerDtls).toMatchObject({ Gstin: 'URP', Pos: '96', Stcd: '96', Pin: 999999 })
    expect(d.ExpDtls).toEqual({ ShipBNo: 'SB1234567', ShipBDt: '16/08/2026' })
    expect(Object.values(d.ExpDtls)).not.toContain(null)
  })
})

describe('the validator rejects what the published schema rejects', () => {
  const base = (): any => doc({ shape: 'B2B', intra: true, lines: [goods()] })
  const reject = (mutate: (d: any) => void, needle: string): void => {
    const d = base()
    mutate(d)
    expect(einvoiceIssues(d).join('\n')).toContain(needle)
  }
  it('document number: 17 chars, leading 0 / slash, spaces', () => {
    reject((d) => { d.DocDtls.No = 'INV/2026-27/00001' }, 'DocDtls.No')
    reject((d) => { d.DocDtls.No = '0012' }, 'DocDtls.No')
    reject((d) => { d.DocDtls.No = '/12' }, 'DocDtls.No')
    reject((d) => { d.DocDtls.No = 'INV 12' }, 'DocDtls.No')
  })
  it('PIN 0, HSN of 5 digits, Loc over 50, quote in a name, bad GSTIN, null optional', () => {
    reject((d) => { d.SellerDtls.Pin = 0 }, 'SellerDtls.Pin')
    reject((d) => { d.ItemList[0].HsnCd = '84713' }, 'HsnCd')
    reject((d) => { d.BuyerDtls.Loc = 'x'.repeat(51) }, 'BuyerDtls.Loc')
    reject((d) => { d.ItemList[0].PrdDesc = 'Laptop 14"' }, 'PrdDesc')
    reject((d) => { d.BuyerDtls.Gstin = '27AAACU1234F1Z' }, 'BuyerDtls.Gstin')
    reject((d) => { d.ExpDtls = { Port: null } }, 'ExpDtls.Port')
  })
  it('round-off outside ±99.99, total that does not add up, IGST on an intra-state line', () => {
    reject((d) => { d.ValDtls.RndOffAmt = 100 }, 'RndOffAmt')
    reject((d) => { d.ValDtls.TotInvVal += 5 }, '2189')
    reject((d) => { d.ItemList[0].IgstAmt = 16200; d.ItemList[0].CgstAmt = 0; d.ItemList[0].SgstAmt = 0 }, '2172')
  })
  it('an export must be URP / 96 / 999999', () => {
    const d: any = doc({ shape: 'EXPWP', lines: [goods()] })
    d.BuyerDtls.Pin = 400001
    expect(einvoiceIssues(d).join()).toContain('Export')
  })
  it('the tolerance window is the published one (2345.04 → 2344.00 … 2347.00)', () => {
    expect(withinNicTolerance(2344, 2345.04)).toBe(true)
    expect(withinNicTolerance(2347, 2345.04)).toBe(true)
    expect(withinNicTolerance(2343.99, 2345.04)).toBe(false)
    expect(withinNicTolerance(2347.01, 2345.04)).toBe(false)
  })
  it('the schema keeps the published required list (Version … ValDtls)', () => {
    for (const key of ['Version', 'TranDtls', 'DocDtls', 'SellerDtls', 'BuyerDtls', 'ItemList', 'ValDtls']) {
      const d = base()
      delete d[key]
      expect(einvoiceSchema.safeParse(d).success, key).toBe(false)
    }
  })
})

// ---- property-based: random invoices over the whole shape space ----

/** mulberry32 — small seeded PRNG so a failure is reproducible from the printed seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RATES = [0, 3, 5, 12, 18, 28] // a 0.25 % rate exists but needs a matching HSN; kept out
const HSNS = ['8471', '847130', '84713010', '8523', '392690', '6109', '1006', '73181500']
const SHAPES: Shape[] = ['B2B', 'B2B', 'B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP']

function randomSpec(r: () => number): Spec {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const shape = pick(SHAPES)
  const n = 1 + Math.floor(r() * 12)
  const lines: Spec['lines'] = Array.from({ length: n }, () => {
    const service = shape === 'B2B' && r() < 0.15
    const qtyMilli = 1 + Math.floor(r() * 50_000)
    const ratePaise = 1 + Math.floor(r() * 10_000_000)
    const gross = Math.round((qtyMilli * ratePaise) / 1000)
    return {
      hsn: service ? pick(['998314', '9983', '99831400']) : pick(HSNS),
      rate: pick(RATES),
      cessRate: r() < 0.2 ? pick([1, 12, 15, 22]) : 0,
      qtyMilli,
      ratePaise: service ? 1 + Math.floor(r() * 50_000_000) : ratePaise,
      discountPaise: r() < 0.3 ? Math.floor(r() * gross) : 0,
      service,
      name: r() < 0.1 ? 'Panel 55" with \\ bracket' : `Item ${Math.floor(r() * 1000)}`
    }
  })
  const docType = pick(['INV', 'INV', 'INV', 'CRN', 'DBN'] as const)
  const alnum = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
  const len = 1 + Math.floor(r() * 16)
  let number = pick(['I', 'S', '1', '9'])
  while (number.length < len) number += r() < 0.15 ? pick(['/', '-']) : alnum[Math.floor(r() * alnum.length)]
  return {
    shape,
    intra: shape === 'B2B' && r() < 0.5,
    docType,
    number,
    lines,
    tcsPaise: r() < 0.25 ? Math.floor(r() * 500_000) : 0,
    roundOffPaise: r() < 0.5 ? Math.floor(r() * 199) - 99 : 0,
    shipTo: r() < 0.3,
    rchrg: shape !== 'EXPWP' && shape !== 'EXPWOP' && r() < 0.1
  }
}

describe('property: generated invoices always validate', () => {
  it('500 random invoices across B2B / SEZ / export, cess, discount, TCS, round-off, HSN mixes, numbers', () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 500; seed++) {
      const spec = randomSpec(rng(seed))
      const issues = einvoiceIssues(doc(spec))
      if (issues.length) failures.push(`seed ${seed}: ${issues.join('; ')}`)
    }
    expect(failures).toEqual([])
  })
})

describe('Generate e-Way Bill by IRN payload', () => {
  const inv = (over: Partial<EdocInvoice>): EdocInvoice => ({ ...makeInvoice({ shape: 'B2B', lines: [goods()] }), ...over })
  const IRN = 'a'.repeat(64)
  it('road: vehicle number + type, no transport doc required', () => {
    expect(buildEwbByIrnPayload(IRN, inv({ vehicleNo: 'mh-12 ab 1234', transport: null }))).toEqual({
      Irn: IRN, Distance: 120, TransMode: '1', VehNo: 'MH12AB1234', VehType: 'R'
    })
  })
  it('rail/air: transport document number and date, no vehicle', () => {
    const p = buildEwbByIrnPayload(IRN, inv({ vehicleNo: null, transport: { mode: '2', docNo: 'RR998877', docDate: '2026-08-15', transporterName: 'Indian Railways', vehicleType: null } }))
    expect(p).toEqual({ Irn: IRN, Distance: 120, TransMode: '2', TransName: 'Indian Railways', TransDocNo: 'RR998877', TransDocDt: '15/08/2026' })
  })
  it('transporter id only → Part-A: no mode, no transport doc', () => {
    expect(buildEwbByIrnPayload(IRN, inv({ vehicleNo: null, transporterId: '29AAACT1234F1Z1', transport: null }))).toEqual({
      Irn: IRN, Distance: 120, TransId: '29AAACT1234F1Z1'
    })
  })
  it('distance is clamped to the published 0–4000 range', () => {
    expect(buildEwbByIrnPayload(IRN, inv({ distanceKm: 5000 })).Distance).toBe(4000)
    expect(buildEwbByIrnPayload(IRN, inv({ distanceKm: null })).Distance).toBe(0)
  })
})
