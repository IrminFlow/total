// WP 9.9: `simple:taxes` reads the GST returns' own figures and changes nothing.
//   - the three figures equal gst:gstr3b (and the Home tile) on the Demo Traders seed, monthly and
//     as a quarterly filer (the quarter); "awaiting confirmation" equals the 2B matcher's
//     missing-in-portal tax once a GSTR-2B is stored, "not checked" before;
//   - the GSTR-1 / GSTR-3B exports are byte-identical before and after the screen is read and a
//     filing is noted;
//   - unregistered → nothing to file; composition → CMP-08 / GSTR-4 dates (rule 62);
//   - "I've filed" round-trips through meta gstFiled with one audit row (none when unchanged),
//     refuses a bad ARN / date on their fields; a viewer reads but can't note a filing.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { gstPeriodOf, todayISO } from '@shared/dates'
import { addDays } from '@shared/dashboard'
import { cmp08DueDate, gstr1DueDate, gstr3bDueDate, gstr4DueDate } from '@shared/gst/filing'
import { nextCompositionDue, type SimpleTaxes } from '@shared/simple/taxes'
import type { SimpleHomeData } from '@shared/simple/home'
import { seededDb, TEST_INFO } from './db/testdb'
import { createLedger } from './services/masters'
import { saveVoucher } from './services/vouchers'
import { getFeatures, setFeatures } from './services/config'
import { ensureTdsPayableLedger } from './services/tds'
import { simpleTaxes } from './services/simpleTaxes'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string; field?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-taxes-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string; field?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

const TODAY = todayISO()
type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
type T4 = { igst: number; cgst: number; sgst: number; cess: number }
const sum4 = (a: T4): number => a.igst + a.cgst + a.sgst + a.cess
interface View3b { outward: T4; zeroRated: { igst: number; cess: number }; rcm: T4; itc: T4; netPayable: T4; rcmPayable: T4 }
const view3b = (from: string, to: string, period: string): Promise<View3b> => ok('gst:gstr3b', { from, to, period: gstPeriodOf(`${period}-01`) })
const company = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null, ...extra
})

beforeAll(async () => {
  const ipc = await import('./ipc')
  ipc.registerIpc()
})

describe('simple:taxes — regular (WP 9.9)', () => {
  let slug = ''

  it('the three figures are gstr3b()’s (and the Home tile’s); due dates by the cited rules; 2B "not checked" then "awaiting"', async () => {
    slug = (await ok<{ slug: string }>('company:createDemo', { mode: 'simple' })).slug
    await ok('company:open', { slug })
    const ro = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const audit = (): number => (ro.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    const before = audit()

    const x = await ok<Regular>('simple:taxes', { today: TODAY })
    expect(x.kind).toBe('regular')
    expect(x.filing).toBe('monthly')
    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const row = home.gst?.kind === 'regular' ? home.gst.row : null
    expect(x.period.period).toBe(row!.period)
    expect([x.period.from, x.period.to]).toEqual([row!.from, row!.to])
    expect(x.figures.collected).toBe(row!.outwardTax)
    expect(x.figures.reverseCharge).toBe(row!.rcmTax)
    expect(x.figures.onPurchases).toBe(row!.itc)
    expect(x.figures.toPay).toBe(row!.payable)
    expect(x.due.gstr3b).toBe(row!.gstr3bDue)
    const v = await view3b(x.period.from, x.period.to, x.period.period)
    expect(x.figures.collected).toBe(sum4(v.outward) + v.zeroRated.igst + v.zeroRated.cess)
    expect(x.figures.onPurchases).toBe(sum4(v.itc))
    expect(x.figures.toPay).toBe(sum4(v.netPayable) + sum4(v.rcmPayable))
    expect(x.figures.collected).toBeGreaterThan(0)
    expect(x.due).toMatchObject({ gstr1: gstr1DueDate(x.period.period, 'monthly'), gstr3b: gstr3bDueDate(x.period.period, 'monthly', '27').date, gstr3bUnverified: false, pmt06: [] })
    expect(x.figures.checked).toBe('none')
    expect(x.supplierBills.every((m) => !m.imported)).toBe(true)
    expect(x.prepared).toEqual({ gstr1: null, gstr3b: null })
    expect(x.filed).toEqual({})
    expect(audit()).toBe(before)

    // A period picked by month: the figures of that month's 3B.
    const prev = x.periods.find((p) => p.period < x.period.period)!
    const y = await ok<Regular>('simple:taxes', { period: prev.period, today: TODAY })
    const vp = await view3b(y.period.from, y.period.to, y.period.period)
    expect(y.figures.collected).toBe(sum4(vp.outward) + vp.zeroRated.igst + vp.zeroRated.cess)
    expect(y.figures.toPay).toBe(sum4(vp.netPayable) + sum4(vp.rcmPayable))
    expect(await call('simple:taxes', { period: '2999-01', today: TODAY })).toMatchObject({ ok: false, code: 'simple_taxes_period', field: 'period' })

    // An (empty) GSTR-2B for the month: every purchase bill of the month awaits confirmation —
    // the WP 5.5 mismatch list's "in your books, not on the portal" tax, and Home's figure.
    await ok('assist:gst2b:store', { jsonText: JSON.stringify({ data: { rtnprd: gstPeriodOf(`${x.period.period}-01`), docdata: {} } }), period: x.period.period })
    const z = await ok<Regular>('simple:taxes', { today: TODAY })
    expect(z.figures.checked).toBe('all')
    const step2 = z.supplierBills.find((m) => m.month === x.period.period)!
    expect(step2.imported).toBe(true)
    const missing2b = step2.categories.find((c) => c.category === 'missing_in_2b')
    expect(z.figures.awaiting).toBe(missing2b?.tax ?? 0)
    const home2 = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(z.figures.awaiting).toBe(home2.gst?.kind === 'regular' ? home2.gst.credit.awaiting : -1)
    ro.close()
  })

  it('the exports are byte-identical before and after the screen is read and a filing is noted; the mark round-trips', async () => {
    await ok('company:open', { slug })
    const x = await ok<Regular>('simple:taxes', { today: TODAY })
    const prev = x.periods.find((p) => !p.soFar && p.period < TODAY.slice(0, 7))!
    const args = { from: prev.from, to: prev.to, period: gstPeriodOf(`${prev.period}-01`) }
    const r1 = await call('gst:exportGstr1', args)
    const r3 = await call('gst:exportGstr3b', args)
    const readJson = (r: { ok: boolean; data?: unknown }): string | null => (r.ok ? readFileSync((r.data as { jsonPath: string }).jsonPath, 'utf8') : null)
    expect(r1.ok && r3.ok).toBe(true)
    const before1 = readJson(r1)
    const before3 = readJson(r3)

    const ro = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const audit = (): number => (ro.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'company'").get() as { n: number }).n
    const a0 = audit()
    const filedOn = addDays(prev.to, 5) <= TODAY ? addDays(prev.to, 5) : TODAY
    const mark = await ok<Record<string, unknown>>('simple:taxes:filed', { period: prev.period, form: 'gstr3b', arn: 'aa27 0926 123456x', date: filedOn })
    expect(mark.gstr3b).toMatchObject({ arn: 'AA270926123456X', date: filedOn })
    expect(audit()).toBe(a0 + 1)
    const last = ro.prepare("SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity = 'company' ORDER BY id DESC LIMIT 1").get() as { b: string; a: string }
    expect(JSON.parse(last.b)).toEqual({ gstFiled: { [prev.period]: { gstr3b: null } } })
    expect(JSON.parse(last.a).gstFiled[prev.period].gstr3b.arn).toBe('AA270926123456X')
    // The same again writes nothing.
    await ok('simple:taxes:filed', { period: prev.period, form: 'gstr3b', arn: 'AA270926123456X', date: filedOn })
    expect(audit()).toBe(a0 + 1)
    const read = await ok<Regular>('simple:taxes', { period: prev.period, today: TODAY })
    expect(read.filed.gstr3b?.arn).toBe('AA270926123456X')
    expect(read.filed.gstr1).toBeUndefined()
    if (r1.ok) expect(read.prepared.gstr1).not.toBeNull()

    // Refusals on their fields.
    expect(await call('simple:taxes:filed', { period: prev.period, form: 'gstr1', arn: '123', date: filedOn })).toMatchObject({ ok: false, code: 'gst_filed_arn', field: 'arn' })
    expect(await call('simple:taxes:filed', { period: prev.period, form: 'gstr1', arn: 'AA270926123456X', date: prev.to })).toMatchObject({ ok: false, code: 'gst_filed_date', field: 'date' })
    expect(await call('simple:taxes:filed', { period: prev.period, form: 'gstr1', arn: 'AA270926123456X', date: '2999-01-01' })).toMatchObject({ ok: false, code: 'gst_filed_date', field: 'date' })
    expect(await call('simple:taxes:filed', { period: TODAY.slice(0, 7), form: 'gstr1', arn: 'AA270926123456X', date: TODAY })).toMatchObject({ ok: false, code: 'gst_filed_too_early', field: 'date' })
    expect(audit()).toBe(a0 + 1)

    // The exports again: byte-identical.
    expect(readJson(await call('gst:exportGstr1', args))).toBe(before1)
    expect(readJson(await call('gst:exportGstr3b', args))).toBe(before3)

    // Clearing the mark.
    await ok('simple:taxes:filed', { period: prev.period, form: 'gstr3b', arn: null })
    expect((await ok<Regular>('simple:taxes', { period: prev.period, today: TODAY })).filed).toEqual({})
    expect(audit()).toBe(a0 + 2)
    ro.close()
  })

  it('quarterly filer: the quarter (the Home tile’s), GSTR-1 the 13th, GSTR-3B the 22nd for Maharashtra, PMT-06 dates', async () => {
    await ok('company:open', { slug })
    await ok('gstProfile:set', { filing: 'quarterly' })
    const x = await ok<Regular>('simple:taxes', { today: TODAY })
    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const row = home.gst?.kind === 'regular' ? home.gst.row : null
    expect(x.period.quarterly).toBe(true)
    expect([x.period.from, x.period.to]).toEqual([row!.from, row!.to])
    expect(x.figures.collected).toBe(row!.outwardTax)
    expect(x.figures.onPurchases).toBe(row!.itc)
    expect(x.figures.toPay).toBe(row!.payable)
    expect(Number(x.period.period.slice(5, 7)) % 3).toBe(0)
    expect(x.due.gstr1).toBe(gstr1DueDate(x.period.period, 'quarterly'))
    expect(x.due.gstr3b).toBe(`${gstr1DueDate(x.period.period, 'quarterly').slice(0, 8)}22`)
    expect(x.due.pmt06).toHaveLength(2)
    expect(x.filesMonthly).toBe(true)
    const v = await view3b(x.period.from, x.period.to, x.period.period)
    expect(x.figures.collected).toBe(sum4(v.outward) + v.zeroRated.igst + v.zeroRated.cess)
    await ok('gstProfile:set', { filing: 'monthly' })
  })
})

describe('simple:taxes — not regular, roles (WP 9.9)', () => {
  it('unregistered: nothing to file; composition: CMP-08 / GSTR-4 dates; filing refused', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Kirana Unreg', { gstRegistrationType: 'unregistered' }))
    await ok('company:open', { slug })
    expect(await ok<SimpleTaxes>('simple:taxes', { today: TODAY })).toEqual({ kind: 'unregistered', today: TODAY, withholding: [] })
    expect(await call('simple:taxes:filed', { period: '2026-01', form: 'gstr1', arn: 'AA270926123456X', date: '2026-02-10' })).toMatchObject({ ok: false, code: 'gst_filed_not_regular' })

    const comp = await ok<{ slug: string }>('company:create', company('Composition Co', { gstRegistrationType: 'composition', gstin: '27AAPFU0939F1ZV' }))
    await ok('company:open', { slug: comp.slug })
    const c = await ok<SimpleTaxes>('simple:taxes', { today: TODAY })
    expect(c).toEqual({ kind: 'composition', today: TODAY, composition: nextCompositionDue(TODAY, cmp08DueDate, gstr4DueDate), withholding: [] })
  })

  it('TDS (feature on, a payable account): this month’s deduction, its date, and what is unpaid — FIFO, March due 30 April', () => {
    const db = seededDb()
    setFeatures(db, { ...getFeatures(db), tds: true })
    const section = (db.prepare("SELECT id FROM tds_sections WHERE code LIKE '194C%' ORDER BY id LIMIT 1").get() as { id: number }).id
    const payable = ensureTdsPayableLedger(db, section)
    const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const ledger = (name: string, g: string): number =>
      createLedger(db, { name, groupId: group(g), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }).id
    const work = ledger('Contract work', 'Indirect Expenses')
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const post = (kind: 'journal' | 'payment', date: string, lines: [number, 'dr' | 'cr', number][]): void => {
      saveVoucher(db, {
        voucherTypeId: vt(kind), date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })), inventory: [], billRefs: [], tds: null
      })
    }
    // March: 1,000 deducted (due 30 April); April: 300 deducted, 400 paid → March has 600 left.
    post('journal', '2026-03-20', [[work, 'dr', 1_000_00], [payable, 'cr', 1_000_00]])
    post('journal', '2026-04-10', [[work, 'dr', 300_00], [payable, 'cr', 300_00]])
    post('payment', '2026-04-12', [[payable, 'dr', 400_00], [cash, 'cr', 400_00]])
    const r = simpleTaxes(db, { ...TEST_INFO, gstRegistrationType: 'unregistered' }, {}, '2026-04-20')
    expect(r.kind).toBe('unregistered')
    expect(r.withholding).toEqual([
      {
        kind: 'tds', thisMonth: 300_00, thisMonthDue: '2026-05-07', totalUnpaid: 900_00,
        unpaid: [{ month: '2026-03', amount: 600_00, dueDate: '2026-04-30', late: false }, { month: '2026-04', amount: 300_00, dueDate: '2026-05-07', late: false }]
      }
    ])
    // TDS off → no answer.
    setFeatures(db, { ...getFeatures(db), tds: false })
    expect(simpleTaxes(db, { ...TEST_INFO, gstRegistrationType: 'unregistered' }, {}, '2026-04-20').withholding).toEqual([])
  })

  it('a viewer reads Taxes but can’t note a filing', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Viewer Tax Co', { gstin: '27AAPFU0939F1ZV' }))
    await ok('company:open', { slug })
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const x = await ok<Regular>('simple:taxes', { today: TODAY })
    expect(x.kind).toBe('regular')
    const prev = x.periods.find((p) => !p.soFar)!
    expect(await call('simple:taxes:filed', { period: prev.period, form: 'gstr1', arn: 'AA270926123456X', date: TODAY })).toMatchObject({ ok: false, code: 'not_permitted' })
    expect((await ok<Regular>('simple:taxes', { period: prev.period, today: TODAY })).filed).toEqual({})
    await ok('auth:logout')
  })
})
