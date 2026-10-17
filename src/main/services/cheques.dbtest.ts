// Cheque register backfill (to-do §4, WP 4.4 upgrade check): payments saved BEFORE a cheque book
// was configured carry their number on the voucher but never reached the register. The owner-run
// backfill records them as Print cheque would have — and nothing else: vouchers and figures stay
// as they are, a leaf held by another entry is a conflict (skipped, never overwritten), and a
// second run finds nothing. The role gates are driven through the IPC handlers (electron mocked).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { getVoucher, saveVoucher, deleteVoucher, maturePdcNow } from './vouchers'
import { bouncePdc } from './pdc'
import { listAudit, setAuditContext } from './audit'
import { trialBalance } from './reports'
import { backfillChequeRegister, chequeBackfillPreview, chequeRegister, issueCheque, nextChequeNumber, saveChequeBook, setChequeStatus } from './cheques'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-cheques-backfill-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

// WP 7.3: the ipc module graph is imported at collection, never inside a hook.
const ipc = await import('../ipc')

type Db = ReturnType<typeof seededDb>

function ledger(db: Db, name: string, groupName: string): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}
const vtId = (db: Db, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1').get(kind) as { id: number }).id

function pay(db: Db, o: { bank: number; to: number; amount: number; date: string; party?: number | null; instrumentNo?: string | null; reference?: string | null; narration?: string | null; postDated?: boolean }) {
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'payment'), date: o.date, partyLedgerId: o.party ?? null, narration: o.narration ?? null, reference: o.reference ?? null,
    instrumentNo: o.instrumentNo ?? null, postDated: o.postDated,
    lines: [
      { ledgerId: o.to, drCr: 'dr', amount: o.amount, costAllocations: [] },
      { ledgerId: o.bank, drCr: 'cr', amount: o.amount, costAllocations: [] }
    ]
  })
}
function receive(db: Db, o: { bank: number; from: number; amount: number; date: string; instrumentNo: string }) {
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'receipt'), date: o.date, partyLedgerId: o.from, instrumentNo: o.instrumentNo,
    lines: [
      { ledgerId: o.bank, drCr: 'dr', amount: o.amount, costAllocations: [] },
      { ledgerId: o.from, drCr: 'cr', amount: o.amount, costAllocations: [] }
    ]
  })
}

interface Co { db: Db; hdfc: number; sbi: number; rent: number; acme: number }
function company(): Co {
  const db = seededDb()
  return { db, hdfc: ledger(db, 'HDFC Bank', 'Bank Accounts'), sbi: ledger(db, 'SBI', 'Bank Accounts'), rent: ledger(db, 'Office Rent', 'Indirect Expenses'), acme: ledger(db, 'Acme Traders', 'Sundry Creditors') }
}
const BOOK = { name: 'Book 1', fromNo: 457, toNo: 466, width: 6, receivedOn: null, active: true }

/** The entries an upgraded company has: saved before any book existed. */
function seedEntries(c: Co) {
  return {
    a: pay(c.db, { bank: c.hdfc, to: c.acme, party: c.acme, amount: 1_000_00, date: '2026-05-02', instrumentNo: '000457' }),
    b: pay(c.db, { bank: c.hdfc, to: c.rent, amount: 25_000_00, date: '2026-05-03', instrumentNo: '458' }), // typed without the zeros
    c: pay(c.db, { bank: c.hdfc, to: c.acme, party: c.acme, amount: 700_00, date: '2026-05-04', reference: '000459' }),
    d: pay(c.db, { bank: c.hdfc, to: c.rent, amount: 300_00, date: '2026-05-05', narration: 'Rent paid by chq no. 000460' }),
    pdc: pay(c.db, { bank: c.hdfc, to: c.acme, party: c.acme, amount: 400_00, date: '2026-05-06', instrumentNo: '000461', postDated: true }),
    outside: pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-07', instrumentNo: '900123' }),
    neft: pay(c.db, { bank: c.hdfc, to: c.rent, amount: 50_00, date: '2026-05-08', instrumentNo: 'UTR998877' }),
    receipt: receive(c.db, { bank: c.hdfc, from: c.acme, amount: 60_00, date: '2026-05-09', instrumentNo: '000462' }), // the payer's leaf, never ours
    otherBank: pay(c.db, { bank: c.sbi, to: c.rent, amount: 80_00, date: '2026-05-10', instrumentNo: '000463' }) // SBI has no book
  }
}

const comparable = (rows: ReturnType<typeof chequeRegister>) => rows.map(({ chequeId: _id, key: _key, ...r }) => r)
const vouchersSnapshot = (db: Db) => db.prepare('SELECT * FROM vouchers ORDER BY id').all()
const linesSnapshot = (db: Db) => db.prepare('SELECT * FROM voucher_lines ORDER BY id').all()

beforeEach(() => setAuditContext({ appVersion: '0.12.0-test', getUserName: () => 'Tester' }))

describe('cheque register backfill', () => {
  it('lists the payments saved before the book existed; apply fills the register = what Print cheque would have recorded', () => {
    const c = company()
    const e = seedEntries(c)
    expect(chequeRegister(c.db, c.hdfc)).toEqual([]) // the upgrade symptom
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })

    const preview = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc })
    expect(preview.rows.map((r) => [r.voucherId, r.number, r.source, r.found])).toEqual([
      [e.a.id, '000457', 'instrument', '000457'],
      [e.b.id, '000458', 'instrument', '458'],
      [e.c.id, '000459', 'reference', '000459'],
      [e.d.id, '000460', 'narration', '000460'],
      [e.pdc.id, '000461', 'instrument', '000461']
    ])
    expect(preview.conflicts).toEqual([])
    expect(preview.outsideBooks).toBe(1)
    expect(preview.rows[0]).toMatchObject({ payee: 'Acme Traders', amount: 1_000_00, bookName: 'Book 1', bankLedgerName: 'HDFC Bank' })

    const vBefore = vouchersSnapshot(c.db)
    const lBefore = linesSnapshot(c.db)
    const tbBefore = trialBalance(c.db, '2027-03-31')
    const res = backfillChequeRegister(c.db, { bankLedgerId: c.hdfc })
    expect(res.filled).toBe(5)
    // never changes vouchers or figures ('458' stays '458' on the voucher)
    expect(vouchersSnapshot(c.db)).toEqual(vBefore)
    expect(linesSnapshot(c.db)).toEqual(lBefore)
    expect(trialBalance(c.db, '2027-03-31')).toEqual(tbBefore)
    expect(getVoucher(c.db, e.b.id)!.instrumentNo).toBe('458')

    // The twin: the book configured FIRST, the same entries saved, each printed (issueCheque).
    const t = company()
    saveChequeBook(t.db, { bankLedgerId: t.hdfc, ...BOOK })
    const te = seedEntries(t)
    for (const v of [te.a, te.b, te.c, te.d, te.pdc]) {
      // Print cheque reads the instrument number only; the reference / narration entries are printed with that leaf typed in.
      const n = getVoucher(t.db, v.id)!.instrumentNo ?? (v === te.c ? '000459' : '000460')
      issueCheque(t.db, v.id, t.hdfc, n)
    }
    expect(comparable(chequeRegister(c.db, c.hdfc))).toEqual(comparable(chequeRegister(t.db, t.hdfc)))
    expect(nextChequeNumber(c.db, c.hdfc)?.label).toBe('000462')

    // Audit: one cheque create per leaf + one summary row.
    const audit = listAudit(c.db, { entity: 'cheque' }).rows
    expect(audit.filter((r) => r.action === 'create')).toHaveLength(5)
    expect(audit.filter((r) => r.action === 'import')).toHaveLength(1)

    // Second run: nothing to do, nothing written.
    const auditCount = listAudit(c.db, {}).rows.length
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).rows).toEqual([])
    expect(backfillChequeRegister(c.db, { bankLedgerId: c.hdfc })).toMatchObject({ filled: 0 })
    expect(listAudit(c.db, {}).rows.length).toBe(auditCount)
  })

  it('a leaf already used by another entry (or a blank cancelled leaf) is a conflict: listed, skipped, never overwritten', () => {
    const c = company()
    const first = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-01', instrumentNo: '000457' })
    const dup = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 200_00, date: '2026-05-02', instrumentNo: '000457' })
    const spoilt = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 300_00, date: '2026-05-03', instrumentNo: '000458' })
    const printed = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 400_00, date: '2026-05-04', instrumentNo: '000459' })
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
    setChequeStatus(c.db, { bankLedgerId: c.hdfc, number: '000458', status: 'cancelled', note: 'spoilt' })
    const later = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 500_00, date: '2026-05-05' })
    issueCheque(c.db, later.id, c.hdfc, '000459') // printed after the book came — holds 459
    const already = issueCheque(c.db, printed.id, c.hdfc, '000460')! // printed with another leaf: already in the register

    const preview = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc })
    expect(preview.rows.map((r) => r.voucherId)).toEqual([first.id])
    expect(preview.conflicts.map((r) => [r.voucherId, r.number, r.conflict])).toEqual([
      [dup.id, '000457', { reason: 'same_number', status: null, otherVoucherId: first.id, otherVoucherNumber: first.number }],
      [spoilt.id, '000458', { reason: 'in_register', status: 'cancelled', otherVoucherId: null, otherVoucherNumber: null }]
    ])
    const before = comparable(chequeRegister(c.db, c.hdfc, false))
    expect(backfillChequeRegister(c.db, { bankLedgerId: c.hdfc })).toMatchObject({ filled: 1, conflicts: 2 })
    const after = chequeRegister(c.db, c.hdfc, false)
    expect(after.find((r) => r.number === '000458')).toMatchObject({ status: 'cancelled', voucherId: null })
    expect(after.find((r) => r.number === '000459')).toMatchObject({ voucherId: later.id })
    expect(after.find((r) => r.chequeId === already.chequeId)).toMatchObject({ voucherId: printed.id })
    expect(comparable(after).filter((r) => r.number !== '000457')).toEqual(before)
    // the conflicts stay conflicts on the next run, nothing else is found
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc })).toMatchObject({ rows: [], conflicts: [{ voucherId: dup.id }, { voucherId: spoilt.id }] })
  })

  it('numbers outside every book only with includeOutside, and then only 6-digit ones; binned entries never; voucherIds narrows the run', () => {
    const c = company()
    const six = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-01', instrumentNo: '900123' })
    pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-02', instrumentNo: '12345' })
    const binned = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-03', instrumentNo: '000457' })
    const kept = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-04', instrumentNo: '000458' })
    const notTicked = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-05', instrumentNo: '000459' })
    deleteVoucher(c.db, binned.id)
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).rows.map((r) => r.voucherId)).toEqual([kept.id, notTicked.id])
    const wide = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc, includeOutside: true })
    expect(wide.rows.map((r) => [r.voucherId, r.number, r.bookId])).toEqual([[six.id, '900123', null], [kept.id, '000458', expect.any(Number)], [notTicked.id, '000459', expect.any(Number)]])
    expect(backfillChequeRegister(c.db, { bankLedgerId: c.hdfc, includeOutside: true, voucherIds: [six.id, kept.id] })).toMatchObject({ filled: 2 })
    expect(chequeRegister(c.db, c.hdfc, false).map((r) => [r.number, r.bookId == null, r.status])).toEqual([['000458', false, 'issued'], ['900123', true, 'issued']])
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).rows.map((r) => r.voucherId)).toEqual([notTicked.id])
  })
})

describe('cheque register backfill = Print cheque, review cases', () => {
  /** Multi-line payments: two suppliers without a party, a party payment with bank charges. */
  function seedMulti(c: Co & { bea: number; charges: number }) {
    const twoSuppliers = saveVoucher(c.db, {
      voucherTypeId: vtId(c.db, 'payment'), date: '2026-05-02', partyLedgerId: null, narration: null, reference: null, instrumentNo: '000457',
      lines: [
        { ledgerId: c.acme, drCr: 'dr', amount: 600_00, costAllocations: [] },
        { ledgerId: c.bea, drCr: 'dr', amount: 900_00, costAllocations: [] },
        { ledgerId: c.hdfc, drCr: 'cr', amount: 1_500_00, costAllocations: [] }
      ]
    })
    const withCharges = saveVoucher(c.db, {
      voucherTypeId: vtId(c.db, 'payment'), date: '2026-05-03', partyLedgerId: c.acme, narration: null, reference: null, instrumentNo: '000458',
      lines: [
        { ledgerId: c.acme, drCr: 'dr', amount: 2_000_00, costAllocations: [] },
        { ledgerId: c.charges, drCr: 'dr', amount: 25_00, costAllocations: [] },
        { ledgerId: c.hdfc, drCr: 'cr', amount: 2_025_00, costAllocations: [] }
      ]
    })
    return { twoSuppliers, withCharges }
  }
  const multiCo = () => {
    const c = company()
    return { ...c, bea: ledger(c.db, 'Bea Supplies', 'Sundry Creditors'), charges: ledger(c.db, 'Bank Charges', 'Indirect Expenses') }
  }

  it('multi-line payments get the payee / amount Print cheque gives them (twin printed after the book existed)', () => {
    const c = multiCo()
    seedMulti(c)
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
    expect(backfillChequeRegister(c.db, { bankLedgerId: c.hdfc }).filled).toBe(2)
    const t = multiCo()
    saveChequeBook(t.db, { bankLedgerId: t.hdfc, ...BOOK })
    const te = seedMulti(t)
    issueCheque(t.db, te.twoSuppliers.id, t.hdfc)
    issueCheque(t.db, te.withCharges.id, t.hdfc)
    const reg = comparable(chequeRegister(c.db, c.hdfc, false))
    expect(reg).toEqual(comparable(chequeRegister(t.db, t.hdfc, false)))
    expect(reg.map((r) => [r.number, r.payee, r.amount])).toEqual([['000457', 'Bea Supplies', 1_500_00], ['000458', 'Acme Traders', 2_025_00]])
  })

  it('a post-dated cheque later matured and bounced reads exactly as print-then-bounce', () => {
    const run = (printFirst: boolean) => {
      const c = multiCo()
      if (printFirst) saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
      const p = pay(c.db, { bank: c.hdfc, to: c.acme, party: c.acme, amount: 400_00, date: '2026-05-06', instrumentNo: '000461', postDated: true })
      if (printFirst) issueCheque(c.db, p.id, c.hdfc)
      maturePdcNow(c.db, p.id)
      bouncePdc(c.db, { voucherId: p.id, date: '2026-05-08', charges: 50_00, chargesLedgerId: c.charges, recoverChargesFromParty: false, reason: 'Funds insufficient' })
      if (!printFirst) {
        saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
        const preview = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc })
        // the bounced cheque is recorded; the charges entry (reference = the original's number,
        // narration "cheque 000461") never takes a leaf of its own
        expect(preview.rows.map((r) => r.voucherId)).toEqual([p.id])
        backfillChequeRegister(c.db, { bankLedgerId: c.hdfc })
      }
      return comparable(chequeRegister(c.db, c.hdfc, false))
    }
    const backfilled = run(false)
    expect(backfilled).toEqual(run(true))
    expect(backfilled.map((r) => [r.number, r.status])).toEqual([['000461', 'issued']])
  })

  it('a bounced cheque\'s charges entry (reference = the original voucher\'s number) never takes a leaf, even when that number is inside a book', () => {
    const c = multiCo()
    const p = pay(c.db, { bank: c.hdfc, to: c.acme, party: c.acme, amount: 400_00, date: '2026-05-06', instrumentNo: '000002', postDated: true })
    maturePdcNow(c.db, p.id)
    const res = bouncePdc(c.db, { voucherId: p.id, date: '2026-05-08', charges: 50_00, chargesLedgerId: c.charges, recoverChargesFromParty: false, reason: '' })
    const chargesRef = getVoucher(c.db, res.chargesVoucherId!)!.reference!
    expect(chargesRef).toBe(getVoucher(c.db, p.id)!.number)
    // a book whose range covers both the cheque and that voucher number
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, name: 'Low book', fromNo: 1, toNo: 500, width: 6, receivedOn: null, active: true })
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).rows.map((r) => r.voucherId)).toEqual([p.id])
  })

  it('an entry printed between the preview and the apply is skipped, not recorded twice', () => {
    const c = company()
    const a = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-01', instrumentNo: '000457' })
    const b = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 200_00, date: '2026-05-02', instrumentNo: '000458' })
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
    const ticked = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).rows.map((r) => r.voucherId)
    expect(ticked).toEqual([a.id, b.id])
    issueCheque(c.db, a.id, c.hdfc) // someone printed it meanwhile
    const res = backfillChequeRegister(c.db, { bankLedgerId: c.hdfc, voucherIds: ticked })
    expect(res.rows.map((r) => r.voucherId)).toEqual([b.id])
    expect(chequeRegister(c.db, c.hdfc, false).map((r) => [r.number, r.voucherId])).toEqual([['000457', a.id], ['000458', b.id]])
    // the summary row carries counts + numbers, never the vouchers' contents
    const summary = listAudit(c.db, { entity: 'cheque' }).rows.find((r) => r.action === 'import')!
    expect(JSON.parse(summary.afterJson as string)).toEqual({
      kind: 'register_backfill', bankLedgerId: c.hdfc, includeOutside: false, filled: 1,
      numbers: [{ bankLedgerId: c.hdfc, number: '000458', voucherId: b.id }], conflicts: []
    })
  })

  it('a backfilled leaf whose payment is binned reads as a printed one whose payment is binned', () => {
    const run = (printFirst: boolean) => {
      const c = company()
      if (printFirst) saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
      const p = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-01', instrumentNo: '000457' })
      if (printFirst) issueCheque(c.db, p.id, c.hdfc)
      else {
        saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
        backfillChequeRegister(c.db, { bankLedgerId: c.hdfc })
      }
      deleteVoucher(c.db, p.id)
      return { reg: comparable(chequeRegister(c.db, c.hdfc, false)), next: nextChequeNumber(c.db, c.hdfc)?.label }
    }
    const backfilled = run(false)
    expect(backfilled).toEqual(run(true))
    expect(backfilled.next).toBe('000458')
  })

  it('with "outside any book" on, a bare digits-only reference is never recorded (UTR / bill numbers)', () => {
    const c = company()
    pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-01', reference: '900124' })
    const narr = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-02', narration: 'Paid by chq 900125' })
    const instr = pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-03', instrumentNo: '900126' })
    pay(c.db, { bank: c.hdfc, to: c.rent, amount: 100_00, date: '2026-05-04', reference: '123456789012' })
    saveChequeBook(c.db, { bankLedgerId: c.hdfc, ...BOOK })
    const wide = chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc, includeOutside: true })
    expect(wide.rows.map((r) => [r.voucherId, r.source])).toEqual([[narr.id, 'narration'], [instr.id, 'instrument']])
    expect(wide.outsideBooks).toBe(2)
    expect(chequeBackfillPreview(c.db, { bankLedgerId: c.hdfc }).outsideBooks).toBe(4)
  })
})

describe('cheque register backfill through IPC: preview accountant+, apply owner only', () => {
  const call = async (channel: string, payload?: unknown): Promise<Result> => handlers.get(channel)!({}, payload)
  const ok = async <T,>(channel: string, payload?: unknown): Promise<T> => {
    const r = await call(channel, payload)
    if (!r.ok) throw new Error(`${channel}: ${r.error} (${r.code ?? ''})`)
    return r.data as T
  }
  beforeAll(() => ipc.registerIpc())
  afterAll(() => {
    ipc.closeCurrentCompany()
    rmSync(DATA_DIR, { recursive: true, force: true })
  })

  it('a viewer is refused both, an accountant may preview but not apply, the owner applies', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', {
      name: 'Cheque Backfill Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
    })
    await ok('company:open', { slug })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const gid = (n: string): number => groups.find((g) => g.name === n)!.id
    const bank = (await ok<{ id: number }>('master:ledgers:create', { name: 'HDFC Bank', groupId: gid('Bank Accounts') })).id
    const rent = (await ok<{ id: number }>('master:ledgers:create', { name: 'Office Rent', groupId: gid('Indirect Expenses') })).id
    const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
    await ok('voucher:save', {
      data: {
        voucherTypeId: types.find((t) => t.kind === 'payment')!.id, date: '2026-05-10', partyLedgerId: null, narration: null, reference: null, instrumentNo: '000457',
        instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [{ ledgerId: rent, drCr: 'dr', amount: 500000, costAllocations: [] }, { ledgerId: bank, drCr: 'cr', amount: 500000, costAllocations: [] }],
        inventory: [], billRefs: [], tds: null
      }
    })
    await ok('cheques:saveBook', { data: { bankLedgerId: bank, ...BOOK } })

    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: '5150' } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: '6160' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '7170' } })

    await ok('auth:login', { userId: viewer.id, pin: '7170' })
    expect((await call('cheques:backfillPreview', { bankLedgerId: bank })).ok).toBe(false)
    expect((await call('cheques:backfill', { bankLedgerId: bank })).ok).toBe(false)

    await ok('auth:login', { userId: acct.id, pin: '6160' })
    expect((await ok<{ rows: unknown[] }>('cheques:backfillPreview', { bankLedgerId: bank })).rows).toHaveLength(1)
    expect((await call('cheques:backfill', { bankLedgerId: bank })).ok).toBe(false)
    expect(await ok<unknown[]>('cheques:register', { bankLedgerId: bank, includeAvailable: false })).toEqual([])

    await ok('auth:login', { userId: owner.id, pin: '5150' })
    expect(await ok<{ filled: number }>('cheques:backfill', { bankLedgerId: bank })).toMatchObject({ filled: 1 })
    expect(await ok<{ filled: number }>('cheques:backfill', { bankLedgerId: bank })).toMatchObject({ filled: 0 })
    expect((await ok<{ number: string }[]>('cheques:register', { bankLedgerId: bank, includeAvailable: false })).map((r) => r.number)).toEqual(['000457'])
    expect((await call('cheques:backfill', { bankLedgerId: bank, extra: 1 })).ok).toBe(false) // strict payload
  })
})
