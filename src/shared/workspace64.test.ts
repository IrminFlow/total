// WP 6.4 pure pieces: the bulk-edit change functions, the attachment rules and store layout, and
// the party-task due buckets.
import { describe, expect, it } from 'vitest'
import { applyItemChange, applyLedgerChange, applyVoucherChange, typeChangeAllowed, type VoucherChangeContext } from './bulkEdit'
import type { VoucherPayload } from './voucherEdit/payload'
import {
  DEFAULT_ATTACHMENT_CONFIG, attachmentRefusal, cleanFileName, extensionOf, isSafeStoredPath, storedPathFor
} from './attachments'
import { summariseTasks, taskBucket } from './partyNotes'

const base: VoucherPayload = {
  voucherTypeId: 1, date: '2026-04-01', number: '7', partyLedgerId: 10, narration: 'Sale', reference: null, instrumentNo: null,
  instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null,
  exchangeRate: null, postDated: false, isOptional: false,
  lines: [
    { ledgerId: 10, drCr: 'dr', amount: 1000, costAllocations: [] },
    { ledgerId: 20, drCr: 'cr', amount: 1000, costAllocations: [{ costCentreId: 1, amount: 600 }, { costCentreId: 2, amount: 400 }] }
  ],
  inventory: [], billRefs: [], tds: null, tcs: null
}
const ctx: VoucherChangeContext = { kind: 'sales', name: (w, id) => `${w}#${id}` }

describe('bulk edit — voucher changes', () => {
  it('narration: replace / append / prepend; unchanged when it already reads so', () => {
    expect(applyVoucherChange(base, { field: 'narration', mode: 'append', text: 'ok' }, ctx)).toMatchObject({ kind: 'changed', payload: { narration: 'Sale ok' } })
    expect(applyVoucherChange(base, { field: 'narration', mode: 'prepend', text: 'ok' }, ctx)).toMatchObject({ payload: { narration: 'ok Sale' } })
    expect(applyVoucherChange(base, { field: 'narration', mode: 'replace', text: '' }, ctx)).toMatchObject({ payload: { narration: null } })
    expect(applyVoucherChange(base, { field: 'narration', mode: 'replace', text: 'Sale' }, ctx).kind).toBe('unchanged')
    expect(applyVoucherChange(base, { field: 'narration', mode: 'append', text: '  ' }, ctx).kind).toBe('unchanged')
  })

  it('party moves the party lines with it; refuses a voucher without a party or a clash', () => {
    const r = applyVoucherChange(base, { field: 'party', from: null, to: 11 }, ctx)
    expect(r).toMatchObject({ kind: 'changed', payload: { partyLedgerId: 11 } })
    if (r.kind === 'changed') expect(r.payload.lines.map((l) => l.ledgerId)).toEqual([11, 20])
    expect(applyVoucherChange({ ...base, partyLedgerId: null }, { field: 'party', from: null, to: 11 }, ctx).kind).toBe('refused')
    expect(applyVoucherChange(base, { field: 'party', from: null, to: 20 }, ctx)).toMatchObject({ kind: 'refused', reason: 'ledger#20 already has a line on this voucher' })
    expect(applyVoucherChange(base, { field: 'party', from: 99, to: 11 }, ctx).kind).toBe('unchanged')
  })

  it('cost centre re-points and merges allocations; godown needs stock lines', () => {
    const r = applyVoucherChange(base, { field: 'costCentre', from: 2, to: 1 }, ctx)
    if (r.kind !== 'changed') throw new Error('expected a change')
    expect(r.payload.lines[1]!.costAllocations).toEqual([{ costCentreId: 1, amount: 1000 }])
    expect(applyVoucherChange(base, { field: 'costCentre', from: 9, to: 1 }, ctx).kind).toBe('unchanged')
    expect(applyVoucherChange(base, { field: 'godown', from: null, to: 3 }, ctx)).toMatchObject({ kind: 'refused', reason: 'This voucher has no stock lines' })
  })

  it('voucher type: same kind, or within the accounting family without stock', () => {
    expect(typeChangeAllowed('sales', 'sales', true)).toBeNull()
    expect(typeChangeAllowed('payment', 'journal', false)).toBeNull()
    expect(typeChangeAllowed('payment', 'journal', true)).not.toBeNull()
    expect(typeChangeAllowed('sales', 'purchase', false)).toMatch(/posting rules differ/)
    const r = applyVoucherChange(base, { field: 'voucherType', voucherTypeId: 5 }, { ...ctx, targetKind: 'sales', targetNumbering: 'auto' })
    expect(r).toMatchObject({ kind: 'changed', payload: { voucherTypeId: 5, number: undefined } })
  })
})

describe('bulk edit — master changes', () => {
  const name = { name: (w: string, id: number | null) => (id === null ? 'none' : `${w}#${id}`) }
  it('ledger group (never a system ledger), credit days, price level', () => {
    const l = { name: 'A', groupId: 1, creditDays: null, priceLevelId: null }
    expect(applyLedgerChange(l, { field: 'group', groupId: 2 }, name)).toMatchObject({ kind: 'changed', before: 'group#1', after: 'group#2' })
    expect(applyLedgerChange(l, { field: 'group', groupId: 2 }, { ...name, isSystem: true }).kind).toBe('refused')
    expect(applyLedgerChange(l, { field: 'creditDays', creditDays: 30 }, name)).toMatchObject({ before: 'none', after: '30 days' })
    expect(applyLedgerChange(l, { field: 'priceLevel', priceLevelId: null }, name).kind).toBe('unchanged')
  })
  it('item GST rate and HSN (validated)', () => {
    const i = { name: 'W', groupId: null, unitId: 1, hsn: '8471', gstRate: 12, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null }
    expect(applyItemChange(i, { field: 'gstRate', gstRate: 18 }, name)).toMatchObject({ before: '12%', after: '18%' })
    expect(applyItemChange(i, { field: 'hsn', hsn: '847' }, name)).toMatchObject({ kind: 'refused', reason: 'HSN must be 4, 6 or 8 digits' })
    expect(applyItemChange(i, { field: 'hsn', hsn: ' ' }, name)).toMatchObject({ kind: 'changed', after: 'none' })
  })
})

describe('attachments — rules and layout', () => {
  it('cleans names to a base name and checks type and size', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('C:\\bills\\inv\u0007.pdf')).toBe('inv.pdf')
    expect(extensionOf('scan.PDF')).toBe('pdf')
    expect(extensionOf('.bashrc')).toBe('')
    expect(attachmentRefusal('a.pdf', 10, DEFAULT_ATTACHMENT_CONFIG)).toBeNull()
    expect(attachmentRefusal('a.exe', 10, DEFAULT_ATTACHMENT_CONFIG)).toMatch(/\.exe can't be attached/)
    expect(attachmentRefusal('README', 10, DEFAULT_ATTACHMENT_CONFIG)).toMatch(/without an extension/)
    expect(attachmentRefusal('big.pdf', 26 * 1024 * 1024, DEFAULT_ATTACHMENT_CONFIG)).toMatch(/limit is 25 MB/)
    expect(attachmentRefusal('a.csv', 10, { ...DEFAULT_ATTACHMENT_CONFIG, allowedExtensions: ['pdf'] })).toMatch(/allowed: pdf/)
  })
  it('stores by hash and accepts only the exact content-addressed path', () => {
    const sha = 'ab'.padEnd(64, '0')
    expect(storedPathFor(sha)).toBe(`ab/${sha}`)
    expect(isSafeStoredPath(`ab/${sha}`, sha)).toBe(true)
    expect(isSafeStoredPath(`../${sha}`, sha)).toBe(false)
    expect(isSafeStoredPath(`/tmp/${sha}`, sha)).toBe(false)
    expect(() => storedPathFor('../../x')).toThrow()
  })
})

describe('party tasks — due buckets', () => {
  it('overdue / today / this week / later; notes and done tasks never count', () => {
    const t = (dueDate: string | null, doneAt: string | null = null) => ({ kind: 'task' as const, dueDate, doneAt })
    expect(taskBucket(t('2026-10-01'), '2026-10-08')).toBe('overdue')
    expect(taskBucket(t('2026-10-08'), '2026-10-08')).toBe('today')
    expect(taskBucket(t('2026-10-15'), '2026-10-08')).toBe('week')
    expect(taskBucket(t('2026-10-16'), '2026-10-08')).toBe('later')
    expect(taskBucket(t('2026-10-01', 'x'), '2026-10-08')).toBe('done')
    expect(taskBucket({ kind: 'note', dueDate: null, doneAt: null }, '2026-10-08')).toBe('none')
    expect(summariseTasks([t('2026-10-01'), t('2026-10-08'), t('2026-10-09'), t(null), t('2026-10-01', 'x')], '2026-10-08')).toEqual({ overdue: 1, today: 1, week: 1 })
  })
})
