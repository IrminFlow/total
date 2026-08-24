import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { companyAttachmentsDir } from '../paths'
import {
  addAttachment, attachmentCounts, attachmentPath, attachmentsFootprint, listAttachments,
  removeAttachment, sweepOrphanFiles
} from './attachments'
import { purgeVoucher, deleteVoucher } from './vouchers'

// The service writes into <TOTAL_DATA_DIR>/companies/<slug>/attachments, so every test gets its
// own scratch data root — the same hermetic trick the smoke scripts use (see CLAUDE.md).
const SLUG = 'attach-co'
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-attach-'))
  process.env.TOTAL_DATA_DIR = dataDir
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
})

const bill = (text = 'INVOICE 42'): Buffer => Buffer.from(text, 'utf8')

describe('addAttachment', () => {
  it('copies the file into the company folder, so a backup of the folder carries it', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })

    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })

    expect(attached.fileName).toBe('bill.pdf')
    expect(attached.missing).toBe(false)
    expect(existsSync(attachmentPath(SLUG, attached.storedName))).toBe(true)
    expect(attachmentPath(SLUG, attached.storedName).startsWith(companyAttachmentsDir(SLUG))).toBe(true)
  })

  it('refuses a file bigger than the cap, and says the size rather than just failing', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const huge = Buffer.alloc(11 * 1024 * 1024, 1)
    expect(() => addAttachment(db, SLUG, { voucherId: v.id, bytes: huge, fileName: 'scan.jpg' })).toThrow(/11 MB/)
  })

  it('refuses a file type the OS would run', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    expect(() => addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'x.command' })).toThrow(/not one of them/)
  })

  it('recognises the same scan attached twice instead of writing a second copy', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const first = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    const second = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    expect(second.id).toBe(first.id)
    expect(listAttachments(db, SLUG, v.id)).toHaveLength(1)
    expect(readdirSync(companyAttachmentsDir(SLUG))).toHaveLength(1)
  })

  it('keeps two genuinely different bills of the same name apart', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const a = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill('one'), fileName: 'bill.pdf' })
    const b = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill('two'), fileName: 'bill.pdf' })
    expect(b.id).not.toBe(a.id)
    expect(readdirSync(companyAttachmentsDir(SLUG))).toHaveLength(2)
  })

  it('will not attach to a voucher that does not exist', () => {
    const db = seededDb()
    expect(() => addAttachment(db, SLUG, { voucherId: 9999, bytes: bill(), fileName: 'b.pdf' })).toThrow(/not found/i)
  })
})

describe('listAttachments', () => {
  it('reports an attachment whose file has been deleted rather than hiding it', () => {
    // The app losing evidence has to be visible. A row that quietly vanished from the list would
    // be the app deciding, on its own, that the bill was never there.
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })

    rmSync(attachmentPath(SLUG, attached.storedName))

    const [row] = listAttachments(db, SLUG, v.id)
    expect(row!.missing).toBe(true)
    expect(row!.fileName).toBe('bill.pdf')
  })
})

describe('removeAttachment', () => {
  it('takes the row and the copy', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    removeAttachment(db, SLUG, attached.id)
    expect(listAttachments(db, SLUG, v.id)).toEqual([])
    expect(existsSync(attachmentPath(SLUG, attached.storedName))).toBe(false)
  })

  it('survives the file having already gone', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    rmSync(attachmentPath(SLUG, attached.storedName))
    expect(() => removeAttachment(db, SLUG, attached.id)).not.toThrow()
  })
})

describe('the bin and the purge', () => {
  it('keeps the bill while the voucher is only in the bin', () => {
    // Binning is reversible, so the evidence has to be too.
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    deleteVoucher(db, v.id)
    expect(listAttachments(db, SLUG, v.id)).toHaveLength(1)
    expect(existsSync(attachmentPath(SLUG, attached.storedName))).toBe(true)
  })

  it('sweeps the copy once the voucher is really gone', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const attached = addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    deleteVoucher(db, v.id)
    purgeVoucher(db, v.id)

    expect(listAttachments(db, SLUG, v.id)).toEqual([])
    expect(existsSync(attachmentPath(SLUG, attached.storedName))).toBe(true) // row gone, file orphaned
    expect(sweepOrphanFiles(db, SLUG)).toBe(1)
    expect(existsSync(attachmentPath(SLUG, attached.storedName))).toBe(false)
  })

  it('never sweeps a file a row still points at', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    addAttachment(db, SLUG, { voucherId: v.id, bytes: bill(), fileName: 'bill.pdf' })
    expect(sweepOrphanFiles(db, SLUG)).toBe(0)
    expect(listAttachments(db, SLUG, v.id)).toHaveLength(1)
  })

  it('removes a stray file nobody put there through the app', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    mkdirSync(companyAttachmentsDir(SLUG), { recursive: true })
    writeFileSync(join(companyAttachmentsDir(SLUG), 'stray.pdf'), 'x')
    expect(sweepOrphanFiles(db, SLUG)).toBe(1)
  })
})

describe('counts and footprint', () => {
  it('counts a whole page of vouchers in one query', () => {
    const db = seededDb()
    const a = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    const b = postSimpleVoucher(db, { date: '2026-08-02', amount: 100000, kind: 'payment' })
    addAttachment(db, SLUG, { voucherId: a.id, bytes: bill('1'), fileName: 'a.pdf' })
    addAttachment(db, SLUG, { voucherId: a.id, bytes: bill('2'), fileName: 'b.pdf' })

    const counts = attachmentCounts(db, [a.id, b.id])
    expect(counts.get(a.id)).toBe(2)
    expect(counts.has(b.id)).toBe(false)
    expect(attachmentCounts(db, [])).toEqual(new Map())
  })

  it('reports what the copies are costing', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2026-08-01', amount: 100000, kind: 'payment' })
    addAttachment(db, SLUG, { voucherId: v.id, bytes: Buffer.alloc(1000), fileName: 'a.pdf' })
    expect(attachmentsFootprint(db)).toEqual({ files: 1, bytes: 1000 })
  })
})
