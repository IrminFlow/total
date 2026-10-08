import { describe, expect, it } from 'vitest'
import { bpOf, findAnomalies, isqrt, normaliseBillNo, rateText, rupeeText, sigmaText, zScoreMilli, type AnomalyInput, type AnomalyVoucher, type LedgerRole } from './anomalies'

const L = new Map<number, { name: string; role: LedgerRole }>([
  [1, { name: 'Cash', role: 'cashBank' }],
  [2, { name: 'Bank', role: 'cashBank' }],
  [3, { name: 'Acme', role: 'party' }],
  [4, { name: 'Rent', role: 'other' }],
  [5, { name: 'Purchases', role: 'other' }],
  [6, { name: 'IGST', role: 'tax' }],
  [7, { name: 'Repairs', role: 'other' }],
  [8, { name: 'Sales', role: 'other' }]
])

let seq = 0
function v(p: Partial<AnomalyVoucher> & { date: string; amount: number; lines?: AnomalyVoucher['lines'] }): AnomalyVoucher {
  seq++
  return {
    voucherId: p.voucherId ?? seq,
    kind: p.kind ?? 'payment',
    typeName: p.typeName ?? 'Payment',
    number: p.number ?? String(seq),
    partyLedgerId: p.partyLedgerId ?? null,
    partyName: p.partyName ?? null,
    narration: p.narration ?? null,
    reference: p.reference ?? null,
    createdOn: p.createdOn ?? p.date,
    lines: p.lines ?? [
      { ledgerId: 4, drCr: 'dr', amount: p.amount },
      { ledgerId: 1, drCr: 'cr', amount: p.amount }
    ],
    ...p
  }
}

const input = (vouchers: AnomalyVoucher[], extra: Partial<AnomalyInput> = {}): AnomalyInput => ({ from: '2026-05-01', to: '2026-05-31', vouchers, ledgers: L, ...extra })
const kinds = (a: { kind: string }[]): string[] => a.map((x) => x.kind)

describe('integer helpers', () => {
  it('isqrt is the exact floor square root on BigInt', () => {
    expect(isqrt(0n)).toBe(0n)
    expect(isqrt(15n)).toBe(3n)
    expect(isqrt(16n)).toBe(4n)
    const big = 10n ** 30n + 12345n
    const r = isqrt(big)
    expect(r * r <= big && (r + 1n) * (r + 1n) > big).toBe(true)
  })

  it('zScoreMilli: exact, no float overflow on large paise amounts', () => {
    // history 100, 100, 100, 200 → mean 125, sd = sqrt(1875) ≈ 43.30; x = 300 → z ≈ 4.04
    expect(zScoreMilli(300, [100, 100, 100, 200])).toBe(4041)
    expect(zScoreMilli(5, [5, 5, 5])).toBeNull() // no spread
    expect(zScoreMilli(5, [5])).toBeNull()
    // ₹1,000 crore amounts: squares are ~1e26, far past 2^53 — still exact.
    const crore = 1_000_00_00_000_00
    expect(zScoreMilli(crore * 3, [crore, crore, crore, crore * 2])).toBe(4041)
  })

  it('formats rates, sigmas and rupees without floats', () => {
    expect(bpOf(1800, 10000)).toBe(1800)
    expect(bpOf(1, 3)).toBe(3333)
    expect(rateText(1800)).toBe('18%')
    expect(rateText(25)).toBe('0.25%')
    expect(rateText(250)).toBe('2.5%')
    expect(sigmaText(4041)).toBe('4.0σ')
    expect(rupeeText(123456789)).toBe('₹12,34,567.89')
    expect(rupeeText(5)).toBe('₹0.05')
    expect(normaliseBillNo('inv-007')).toBe(normaliseBillNo('INV7'))
  })
})

describe('findAnomalies', () => {
  it('flags the same party + amount within the window on the later voucher only', () => {
    const a = v({ date: '2026-05-02', amount: 50000_00, partyLedgerId: 3, partyName: 'Acme', kind: 'payment' })
    const b = v({ date: '2026-05-04', amount: 50000_00, partyLedgerId: 3, partyName: 'Acme', kind: 'payment' })
    const c = v({ date: '2026-05-20', amount: 50000_00, partyLedgerId: 3, partyName: 'Acme', kind: 'payment' }) // 16 days later: no
    const out = findAnomalies(input([a, b, c]))
    const dup = out.filter((x) => x.kind === 'duplicate_party_amount')
    expect(dup).toHaveLength(1)
    expect(dup[0]).toMatchObject({ voucherId: b.voucherId, relatedVoucherIds: [a.voucherId], severity: 'high', key: `duplicate_party_amount:${a.voucherId}:${b.voucherId}` })
  })

  it('flags a bill number entered twice for the same supplier (normalised)', () => {
    const a = v({ date: '2026-04-10', amount: 1000_00, partyLedgerId: 3, kind: 'purchase', typeName: 'Purchase', reference: 'INV-007' })
    const b = v({ date: '2026-05-10', amount: 1200_00, partyLedgerId: 3, kind: 'purchase', typeName: 'Purchase', reference: 'inv 7' })
    const out = findAnomalies(input([a, b]))
    expect(out.find((x) => x.kind === 'duplicate_bill_number')).toMatchObject({ voucherId: b.voucherId, relatedVoucherIds: [a.voucherId] })
  })

  it('flags same narration + amount within the window (not when the amount differs)', () => {
    const a = v({ date: '2026-05-05', amount: 777_00, narration: 'Office party snacks' })
    const b = v({ date: '2026-05-06', amount: 777_00, narration: 'office party   snacks!' })
    const c = v({ date: '2026-05-06', amount: 778_00, narration: 'Office party snacks' })
    const out = findAnomalies(input([a, b, c]))
    expect(out.filter((x) => x.kind === 'duplicate_narration').map((x) => x.voucherId)).toEqual([b.voucherId])
  })

  it('flags large round journal / payment amounts, not small or receipts', () => {
    const big = v({ date: '2026-05-12', amount: 5_00_000_00, kind: 'journal', typeName: 'Journal' })
    const small = v({ date: '2026-05-12', amount: 50_000_00, kind: 'journal', typeName: 'Journal' })
    const receipt = v({ date: '2026-05-12', amount: 5_00_000_00, kind: 'receipt', typeName: 'Receipt' })
    const odd = v({ date: '2026-05-12', amount: 5_00_001_00, kind: 'journal', typeName: 'Journal' })
    const out = findAnomalies(input([big, small, receipt, odd])).filter((x) => x.kind === 'round_amount')
    expect(out.map((x) => x.voucherId)).toEqual([big.voucherId])
  })

  it('amount outlier per party from history (a voucher is never its own baseline)', () => {
    const hist = [1000, 1100, 900, 1050, 950, 1000].map((r, i) =>
      v({ date: `2026-0${(i % 3) + 1}-1${i}`, amount: r * 100, partyLedgerId: 3, partyName: 'Acme', kind: 'sales', typeName: 'Sales', lines: [{ ledgerId: 3, drCr: 'dr', amount: r * 100 }, { ledgerId: 8, drCr: 'cr', amount: r * 100 }] })
    )
    const spike = v({ date: '2026-05-15', amount: 9000_00, partyLedgerId: 3, partyName: 'Acme', kind: 'sales', typeName: 'Sales', lines: [{ ledgerId: 3, drCr: 'dr', amount: 9000_00 }, { ledgerId: 8, drCr: 'cr', amount: 9000_00 }] })
    const normal = v({ date: '2026-05-16', amount: 1000_00, partyLedgerId: 3, partyName: 'Acme', kind: 'sales', typeName: 'Sales', lines: [{ ledgerId: 3, drCr: 'dr', amount: 1000_00 }, { ledgerId: 8, drCr: 'cr', amount: 1000_00 }] })
    const out = findAnomalies(input([...hist, spike, normal])).filter((x) => x.kind === 'amount_outlier')
    expect(out.map((x) => x.voucherId)).toEqual([spike.voucherId])
    expect(out[0]!.metric).toBeGreaterThan(3000)
    expect(out[0]!.detail).toMatch(/σ above Acme/)
  })

  it('amount outlier on an expense ledger without a party', () => {
    const hist = [500, 520, 480, 510, 490, 505].map((r, i) => v({ date: `2026-04-0${i + 1}`, amount: r * 100, lines: [{ ledgerId: 7, drCr: 'dr', amount: r * 100 }, { ledgerId: 1, drCr: 'cr', amount: r * 100 }] }))
    const spike = v({ date: '2026-05-20', amount: 4000_00, lines: [{ ledgerId: 7, drCr: 'dr', amount: 4000_00 }, { ledgerId: 1, drCr: 'cr', amount: 4000_00 }] })
    const out = findAnomalies(input([...hist, spike])).filter((x) => x.kind === 'amount_outlier')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ voucherId: spike.voucherId, ledgerId: 7 })
  })

  it('unusual pairing only between established ledgers', () => {
    const hist: AnomalyVoucher[] = []
    for (let i = 0; i < 6; i++) {
      hist.push(v({ date: `2026-04-0${i + 1}`, amount: 100_00, lines: [{ ledgerId: 4, drCr: 'dr', amount: 100_00 }, { ledgerId: 1, drCr: 'cr', amount: 100_00 }] }))
      hist.push(v({ date: `2026-04-1${i}`, amount: 100_00, lines: [{ ledgerId: 7, drCr: 'dr', amount: 100_00 }, { ledgerId: 2, drCr: 'cr', amount: 100_00 }] }))
    }
    const odd = v({ date: '2026-05-03', amount: 300_00, lines: [{ ledgerId: 4, drCr: 'dr', amount: 300_00 }, { ledgerId: 2, drCr: 'cr', amount: 300_00 }] }) // Rent paid from Bank: never before
    const fresh = v({ date: '2026-05-04', amount: 300_00, lines: [{ ledgerId: 5, drCr: 'dr', amount: 300_00 }, { ledgerId: 2, drCr: 'cr', amount: 300_00 }] }) // Purchases: new ledger, not flagged
    const out = findAnomalies(input([...hist, odd, fresh])).filter((x) => x.kind === 'unusual_pairing')
    expect(out.map((x) => x.voucherId)).toEqual([odd.voucherId])
  })

  it('weekend, holiday, back-dated (after a closed month → high)', () => {
    const sunday = v({ date: '2026-05-03', amount: 10_00 }) // 3 May 2026 is a Sunday
    const holiday = v({ date: '2026-05-01', amount: 10_00 })
    const late = v({ date: '2026-05-05', amount: 10_00, createdOn: '2026-06-20' })
    const closed = v({ date: '2026-05-06', amount: 10_00, createdOn: '2026-06-02' })
    const out = findAnomalies(input([sunday, holiday, late, closed]), { holidays: ['2026-05-01'], closedPeriods: [{ period: '2026-05', closedOn: '2026-06-01' }], backdatedDays: 30 })
    expect(out.find((x) => x.voucherId === sunday.voucherId)?.kind).toBe('weekend_posting')
    expect(kinds(out.filter((x) => x.voucherId === holiday.voucherId))).toEqual(['holiday_posting'])
    const b = out.filter((x) => x.kind === 'backdated')
    expect(b.find((x) => x.voucherId === closed.voucherId)?.severity).toBe('high')
    expect(b.find((x) => x.voucherId === late.voucherId)?.severity).toBe('high') // also after the close
    const lateOnly = findAnomalies(input([v({ date: '2026-05-05', amount: 10_00, createdOn: '2026-06-20' })]))
    expect(lateOnly.find((x) => x.kind === 'backdated')).toMatchObject({ severity: 'medium', metric: 46 })
  })

  it('GST charged unlike the item rates; HSN with two rates', () => {
    const ok = v({ date: '2026-05-07', amount: 1180_00, kind: 'sales', typeName: 'Sales', taxPaise: 180_00, stockLines: [{ itemId: 1, itemName: 'Widget', hsn: '8471', amount: 1000_00, rateBp: 1800 }] })
    const off = v({ date: '2026-05-08', amount: 1120_00, kind: 'sales', typeName: 'Sales', taxPaise: 120_00, stockLines: [{ itemId: 1, itemName: 'Widget', hsn: '8471', amount: 1000_00, rateBp: 1800 }] })
    const items = [
      { itemId: 1, name: 'Widget', hsn: '8471', rateBp: 1800 },
      { itemId: 2, name: 'Gadget', hsn: '8471', rateBp: 1800 },
      { itemId: 3, name: 'Gizmo', hsn: '8471', rateBp: 1200 }
    ]
    const out = findAnomalies(input([ok, off], { items }))
    expect(out.filter((x) => x.kind === 'gst_rate_deviation').map((x) => x.voucherId)).toEqual([off.voucherId])
    expect(out.find((x) => x.kind === 'gst_rate_deviation')!.detail).toMatch(/12% .*give 18%/)
    expect(out.filter((x) => x.kind === 'hsn_rate_mismatch').map((x) => x.itemId)).toEqual([3])
  })

  it('reports only the period, severity first; keys are stable across runs', () => {
    const before = v({ date: '2026-04-28', amount: 5_00_000_00, kind: 'journal' })
    const inside = v({ date: '2026-05-28', amount: 5_00_000_00, kind: 'journal' })
    const a = findAnomalies(input([before, inside]))
    expect(a.every((x) => !x.date || (x.date >= '2026-05-01' && x.date <= '2026-05-31'))).toBe(true)
    expect(findAnomalies(input([before, inside])).map((x) => x.key)).toEqual(a.map((x) => x.key))
  })
})
