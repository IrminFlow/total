import { describe, it, expect } from 'vitest'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { deleteVoucher, saveVoucher } from './vouchers'
import { recordFiling } from './filings'
import { dropGstr1Snapshot, gstr1Amendments, portalPeriodOf, snapshotGstr1 } from './amendments'

/**
 * GSTR-1 amendments, the half that needs a database.
 *
 * The rules are pure and tested in src/shared/gst/amendments.test.ts. What can only be tested
 * here is the memory: that marking a return filed freezes the documents it contained, that
 * re-marking it filed does not quietly replace that memory with today's books, and that the
 * three things which are NOT amendments — a document deleted after filing, one added after
 * filing, and a period that was never filed at all — are each reported as themselves rather
 * than as an empty table that reads "nothing changed".
 */

const INFO: CompanyInfo = { ...TEST_INFO, gstin: '27AAPFU0939F1ZV', booksFrom: 2026 }

/** July 2026 is the period that gets filed; amendments are then raised in August 2026. */
const JULY = { key: '2026-07', from: '2026-07-01', to: '2026-07-31', portal: '072026' }
const AUG_PORTAL = '082026'

function setup() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  const buyer = L({ name: 'Buyer 27', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' })
  const farBuyer = L({ name: 'Buyer 29', groupId: groupId('Sundry Debtors'), gstin: '29AABCF9012G1ZQ', stateCode: '29' })
  const sales = L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' })
  const cgstL = L({ name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
  const sgstL = L({ name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })
  const igstL = L({ name: 'IGST', groupId: groupId('Duties & Taxes'), taxType: 'igst' })

  const post = (
    kind: string,
    date: string,
    partyId: number,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    opts: { posOverride?: string | null; number?: string; existingId?: number } = {}
  ): number =>
    saveVoucher(
      db,
      {
        voucherTypeId: vtId(kind),
        date,
        partyLedgerId: partyId,
        number: opts.number,
        posOverride: opts.posOverride ?? null,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })),
        inventory: [],
        billRefs: [],
        tds: null
      },
      opts.existingId
    ).id

  /** An intra-state B2B sale: taxable + 9% CGST + 9% SGST. */
  const intraSale = (
    date: string,
    taxable: number,
    opts: { number?: string; existingId?: number; party?: number } = {}
  ): number => {
    const party = opts.party ?? buyer
    const half = Math.round(taxable * 0.09)
    return post(
      'sales',
      date,
      party,
      [
        { ledgerId: party, drCr: 'dr', amount: taxable + half * 2 },
        { ledgerId: sales, drCr: 'cr', amount: taxable },
        { ledgerId: cgstL, drCr: 'cr', amount: half },
        { ledgerId: sgstL, drCr: 'cr', amount: half }
      ],
      { number: opts.number, existingId: opts.existingId }
    )
  }

  /** An inter-state B2B sale with an explicit place of supply. */
  const interSale = (
    date: string,
    taxable: number,
    pos: string,
    opts: { number?: string; existingId?: number } = {}
  ): number => {
    const igst = Math.round(taxable * 0.18)
    return post(
      'sales',
      date,
      farBuyer,
      [
        { ledgerId: farBuyer, drCr: 'dr', amount: taxable + igst },
        { ledgerId: sales, drCr: 'cr', amount: taxable },
        { ledgerId: igstL, drCr: 'cr', amount: igst }
      ],
      { posOverride: pos, number: opts.number, existingId: opts.existingId }
    )
  }

  /** A credit note to the registered intra-state buyer. */
  const creditNote = (
    date: string,
    taxable: number,
    opts: { number?: string; existingId?: number } = {}
  ): number => {
    const half = Math.round(taxable * 0.09)
    return post(
      'credit_note',
      date,
      buyer,
      [
        { ledgerId: sales, drCr: 'dr', amount: taxable },
        { ledgerId: cgstL, drCr: 'dr', amount: half },
        { ledgerId: sgstL, drCr: 'dr', amount: half },
        { ledgerId: buyer, drCr: 'cr', amount: taxable + half * 2 }
      ],
      { number: opts.number, existingId: opts.existingId }
    )
  }

  /** Mark July's GSTR-1 filed — the act that freezes the return's documents. */
  const fileJuly = (filedAt = '2026-08-11', arn = 'AA270826000001X') =>
    recordFiling(db, INFO, {
      form: 'GSTR-1',
      period: JULY.key,
      dueDate: '2026-08-11',
      filedAt,
      arn,
      taxPaid: 0,
      notes: null
    })

  const report = (period = AUG_PORTAL) => gstr1Amendments(db, INFO, period)

  return { db, buyer, farBuyer, sales, cgstL, sgstL, igstL, post, intraSale, interSale, creditNote, fileJuly, report }
}

describe('gstr1 snapshot — the memory of what was filed', () => {
  it('is taken when the return is marked filed, and only then', () => {
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    const before = s.db.prepare('SELECT COUNT(*) AS n FROM gstr1_filed_documents').get() as { n: number }
    expect(before.n).toBe(0)

    const saved = s.fileJuly()
    expect(saved.snapshot).not.toBeNull()
    expect(saved.snapshot!.period).toBe(JULY.portal)
    expect(saved.snapshot!.docs).toBe(1)
    expect(saved.snapshot!.keptExisting).toBe(false)
  })

  it('keeps the ORIGINAL snapshot when the period is marked filed again', () => {
    // Re-entering an ARN must not overwrite the snapshot with today's books: doing so would make
    // every amendment vanish at the moment somebody corrected a typo in the ARN.
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    s.intraSale('2026-07-06', 50000, { number: 'S-2' }) // entered AFTER filing

    const again = s.fileJuly('2026-08-12', 'AA270826000002X')
    expect(again.snapshot!.keptExisting).toBe(true)
    expect(again.snapshot!.written).toBe(0)
    expect(again.snapshot!.docs).toBe(1) // still only the document that was actually filed
    expect(again.arn).toBe('AA270826000002X') // the ARN itself still updates
  })

  it('is dropped when the filing is cleared, because an unfiled return has nothing to amend', () => {
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    const cleared = recordFiling(s.db, INFO, {
      form: 'GSTR-1',
      period: JULY.key,
      dueDate: '2026-08-11',
      filedAt: null,
      arn: null,
      taxPaid: 0,
      notes: 'filed in error'
    })
    expect(cleared.snapshot).toBeNull()
    const n = s.db.prepare('SELECT COUNT(*) AS n FROM gstr1_filed_documents').get() as { n: number }
    expect(n.n).toBe(0)
    expect(s.report().noSnapshots).toBe(true)
  })

  it('keys a quarterly period by the last month of the quarter', () => {
    // A quarterly GSTR-1 is filed on the portal under the quarter's closing month, and the
    // amendment ordering has to stay comparable across a filer who switched frequency.
    expect(portalPeriodOf('2026-06-30')).toBe('062026')
    expect(portalPeriodOf('2026-07-31')).toBe('072026')
  })

  it('takes nothing new when called twice directly', () => {
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    const first = snapshotGstr1(s.db, INFO, JULY.to, JULY.from, JULY.to, '2026-08-11')
    const second = snapshotGstr1(s.db, INFO, JULY.to, JULY.from, JULY.to, '2026-08-12')
    expect(first.written).toBe(1)
    expect(second.written).toBe(0)
    expect(second.keptExisting).toBe(true)
    expect(dropGstr1Snapshot(s.db, JULY.to)).toBe(1)
  })
})

describe('gstr1 amendments — what changed since the return was filed', () => {
  it('says the period was never filed rather than showing an empty table', () => {
    // An empty amendment table reads as "nothing changed", which is a different and much more
    // reassuring claim than "there is no filed return to compare against".
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    const r = s.report()
    expect(r.noSnapshots).toBe(true)
    expect(r.filedPeriods).toEqual([])
    expect(r.rows).toEqual([])
    expect(r.json).toBeNull()
  })

  it('reports a filed period with nothing changed as unchanged, not as amended', () => {
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()

    const r = s.report()
    expect(r.noSnapshots).toBe(false)
    expect(r.filedPeriods.map((p) => p.period)).toEqual([JULY.portal])
    expect(r.filedPeriods[0]!.earlier).toBe(true)
    expect(r.rows).toEqual([])
    expect(r.counts).toEqual({ amended: 0, unchanged: 1, rejected: 1 })
    // The engine refuses a no-change pair by name, so the screen can say why there is no row.
    expect(r.tables.rejected[0]!.code).toBe('no_change')
    expect(r.json).toBeNull()
  })

  it('raises a B2BA row when the value of a filed invoice changes', () => {
    const s = setup()
    const id = s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    s.intraSale('2026-07-05', 120000, { number: 'S-1', existingId: id })

    const r = s.report()
    expect(r.rows).toHaveLength(1)
    const row = r.rows[0]!
    expect(row.table).toBe('b2ba')
    expect(row.originalPeriod).toBe(JULY.portal)
    expect(row.originalNumber).toBe('S-1')
    expect(row.invoiceValue).toBe(141600)
    const fields = row.changes.map((c) => c.field).sort()
    expect(fields).toContain('value')
    expect(fields).toContain('tax')
    // The portal's match key is the ORIGINAL document — never re-derived from the corrected one.
    const b2ba = r.tables.b2ba as { ctin: string; inv: { oinum: string; oidt: string; val: number }[] }[]
    expect(b2ba[0]!.inv[0]!.oinum).toBe('S-1')
    expect(b2ba[0]!.inv[0]!.oidt).toBe('05-07-2026')
    expect(b2ba[0]!.inv[0]!.val).toBe(1416)
    expect(r.json).not.toBeNull()
    expect(r.json!.fp).toBe(AUG_PORTAL)
  })

  it('raises a row when only the place of supply changes', () => {
    const s = setup()
    const id = s.interSale('2026-07-08', 200000, '29', { number: 'S-9' })
    s.fileJuly()
    s.interSale('2026-07-08', 200000, '30', { number: 'S-9', existingId: id })

    const r = s.report()
    expect(r.rows).toHaveLength(1)
    const changes = r.rows[0]!.changes
    expect(changes.map((c) => c.field)).toEqual(['pos'])
    expect(changes[0]!.from).toBe('29')
    expect(changes[0]!.to).toBe('30')
    // A place-of-supply correction alone leaves the tax untouched, so the row restates the same
    // rate split against a new POS.
    expect(r.rows[0]!.pos).toBe('30')
  })

  it('raises a CDNRA row when a filed credit note changes', () => {
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    const noteId = s.creditNote('2026-07-20', 20000, { number: 'CN-1' })
    s.fileJuly()
    s.creditNote('2026-07-20', 30000, { number: 'CN-1', existingId: noteId })

    const r = s.report()
    const note = r.rows.find((row) => row.table === 'cdnra')
    expect(note).toBeDefined()
    expect(note!.originalNumber).toBe('CN-1')
    const cdnra = r.tables.cdnra as { ctin: string; nt: { ont_num: string; ntty: string }[] }[]
    expect(cdnra[0]!.nt[0]!.ont_num).toBe('CN-1')
    expect(cdnra[0]!.nt[0]!.ntty).toBe('C')
    expect(r.tables.b2ba).toEqual([]) // the untouched invoice is not amended
  })

  it('reports a voucher deleted after filing instead of inventing a withdrawal row', () => {
    // No GSTR-1 table deletes a filed document. The correction is a section 34 credit note or an
    // amendment that restates it, and neither can be built from a voucher that is gone.
    const s = setup()
    const id = s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    deleteVoucher(s.db, id)

    const r = s.report()
    expect(r.rows).toEqual([])
    expect(r.deleted).toHaveLength(1)
    expect(r.deleted[0]!.number).toBe('S-1')
    expect(r.deleted[0]!.message).toMatch(/bin|no longer/)
    expect(r.deleted[0]!.message).toMatch(/section 34/)
    expect(r.json).toBeNull()
  })

  it('never turns a missed invoice into a B2BA row', () => {
    // A document the portal has never seen cannot be amended: it belongs in the ordinary tables
    // of the return being filed now. Filing it as an amendment asks the portal to match a
    // document it does not hold, and the row is rejected.
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    s.intraSale('2026-07-25', 70000, { number: 'S-LATE' })

    const r = s.report()
    expect(r.tables.b2ba).toEqual([])
    expect(r.rows.every((row) => row.number !== 'S-LATE')).toBe(true)
    expect(r.addedAfterFiling.map((d) => d.number)).toEqual(['S-LATE'])
    expect(r.addedAfterFiling[0]!.message).toMatch(/not amendable/)
  })

  it('produces no JSON at all when the amendment set is nil', () => {
    // Nothing to file must be nothing to file — an empty-tabled file uploaded to the portal
    // asserts a return was amended when it was not.
    const s = setup()
    s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()

    const r = s.report()
    expect(r.counts.amended).toBe(0)
    expect(r.json).toBeNull()
    expect(r.tables.b2ba).toEqual([])
    expect(r.tables.b2cla).toEqual([])
    expect(r.tables.cdnra).toEqual([])
    expect(r.tables.cdnura).toEqual([])
  })

  it('refuses to amend into the period the original was filed in', () => {
    const s = setup()
    const id = s.intraSale('2026-07-05', 100000, { number: 'S-1' })
    s.fileJuly()
    s.intraSale('2026-07-05', 120000, { number: 'S-1', existingId: id })

    // Asking for July's own amendments: July is not EARLIER than July, so there is nothing to
    // amend against and the panel must say so rather than emit a row the portal would bounce.
    const r = s.report(JULY.portal)
    expect(r.noSnapshots).toBe(true)
    expect(r.rows).toEqual([])
    expect(r.filedPeriods[0]!.earlier).toBe(false)
  })
})
