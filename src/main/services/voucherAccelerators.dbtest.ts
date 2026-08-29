import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCompanyDb } from '../db/connection'
import { createDemoCompany } from './demo'
import { addAttachment, creditExposure, listAttachments, smartLedgerDefaults } from './voucherAccelerators'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'total-voucher-accelerators-')); process.env.TOTAL_DATA_DIR = dataDir })
afterEach(() => { delete process.env.TOTAL_DATA_DIR; rmSync(dataDir, { recursive: true, force: true }) })

describe('voucher accelerators', () => {
  it('derives explicit party defaults without changing a voucher', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const party = db.prepare("SELECT id FROM ledgers WHERE name='Umbrella Retail'").get() as { id: number }
    const defaults = smartLedgerDefaults(db, party.id, 'sales')
    expect(defaults?.sourceVoucherId).toBeGreaterThan(0)
    expect(defaults?.narration).toBeTruthy()
    db.prepare('UPDATE ledgers SET credit_limit=1 WHERE id=?').run(party.id)
    expect(creditExposure(db, party.id, 100)).toMatchObject({ exceeded: true, ledgerName: 'Umbrella Retail', creditLimit: 1 })
    db.close()
  })

  it('associates multiple evidence records with a posted voucher', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const voucher = db.prepare('SELECT id FROM vouchers ORDER BY id LIMIT 1').get() as { id: number }
    addAttachment(db, { voucherId: voucher.id, originalName: 'invoice.pdf', storedPath: join(dataDir, 'invoice.pdf'), kind: 'invoice', sizeBytes: 1200, actor: 'Tester' })
    expect(listAttachments(db, voucher.id)).toMatchObject([{ originalName: 'invoice.pdf', kind: 'invoice', addedBy: 'Tester' }])
    db.close()
  })
})
