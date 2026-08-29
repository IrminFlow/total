import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { applyImport, importItems, importLedgers, importOpenings, previewImport, previewLedgers } from './importers'

describe('importLedgers', () => {
  it('creates new ledgers, updates existing ones (case-insensitive), and errors unknown groups row-wise', () => {
    const db = seededDb()

    // Pre-existing ledger that the import should update, not duplicate.
    const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    createLedger(db, {
      name: 'Acme Traders',
      groupId: debtors.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })

    const csv = [
      'Name,Group,Opening Balance',
      'acme traders,Sundry Debtors,"1,000.00 Dr"', // case-insensitive match -> update
      'Beta Supplies,Sundry Creditors,"500.00 Cr"', // new group match -> create
      'Ghost Ledger,No Such Group,100' // unknown group -> row error
    ].join('\n')

    const result = importLedgers(db, csv)

    expect(result.created).toBe(1)
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([{ line: 4, message: 'Unknown group "No Such Group"' }])

    const acme = db.prepare("SELECT opening_balance FROM ledgers WHERE name = 'Acme Traders'").get() as {
      opening_balance: number
    }
    expect(acme.opening_balance).toBe(100000)

    const beta = db.prepare("SELECT opening_balance, group_id FROM ledgers WHERE name = 'Beta Supplies'").get() as {
      opening_balance: number
      group_id: number
    }
    expect(beta.opening_balance).toBe(-50000)

    const ghost = db.prepare("SELECT id FROM ledgers WHERE name = 'Ghost Ledger'").get()
    expect(ghost).toBeUndefined()
  })

  it('previewLedgers reports counts without writing anything', () => {
    const db = seededDb()
    const csv = 'Name,Group,Opening\nNew Ledger,Sundry Debtors,1000'
    const preview = previewLedgers(db, csv)
    expect(preview).toMatchObject({ total: 1, willCreate: 1, willUpdate: 0, errors: [] })
    const row = db.prepare("SELECT id FROM ledgers WHERE name = 'New Ledger'").get()
    expect(row).toBeUndefined()
  })

  it('persists PAN and credit days from the CSV, and preserves other fields already on an existing ledger', () => {
    const db = seededDb()
    const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    createLedger(db, {
      name: 'Gamma Traders',
      groupId: debtors.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: 'Old address',
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })

    const csv = [
      'Name,Group,Opening,GSTIN,State,PAN,Credit Days',
      'New Ledger,Sundry Debtors,0,,,AAAAA0000A,45',
      'Gamma Traders,Sundry Debtors,0,,,BBBBB1111B,60'
    ].join('\n')
    const result = importLedgers(db, csv)
    expect(result.errors).toEqual([])

    const created = db.prepare("SELECT pan, credit_days FROM ledgers WHERE name = 'New Ledger'").get() as {
      pan: string
      credit_days: number
    }
    expect(created).toEqual({ pan: 'AAAAA0000A', credit_days: 45 })

    const updated = db.prepare("SELECT pan, credit_days, address FROM ledgers WHERE name = 'Gamma Traders'").get() as {
      pan: string
      credit_days: number
      address: string
    }
    expect(updated.pan).toBe('BBBBB1111B')
    expect(updated.credit_days).toBe(60)
    // Field not present in the ledgers CSV is preserved, not clobbered.
    expect(updated.address).toBe('Old address')
  })
})

describe('importOpenings', () => {
  it('updates opening balances of existing ledgers and errors unknown ledger names', () => {
    const db = seededDb()
    const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    const ledger = createLedger(db, {
      name: 'Acme Traders',
      groupId: debtors.id,
      openingBalance: 0,
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      address: 'Some address',
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })

    const csv = ['Ledger,Opening', 'Acme Traders,"2,500.00 Cr"', 'Nonexistent Ledger,100'].join('\n')
    const result = importOpenings(db, csv)

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([{ line: 3, message: 'Unknown ledger "Nonexistent Ledger"' }])

    const row = db.prepare('SELECT opening_balance, gstin, address FROM ledgers WHERE id = ?').get(ledger.id) as {
      opening_balance: number
      gstin: string
      address: string
    }
    expect(row.opening_balance).toBe(-250000)
    // Other fields are preserved, not clobbered.
    expect(row.gstin).toBe('27AAPFU0939F1ZV')
    expect(row.address).toBe('Some address')
  })
})

describe('importItems', () => {
  it('errors rows with an unknown unit while good rows still import', () => {
    const db = seededDb()
    const csv = [
      'Name,Unit,Opening Qty,Opening Value',
      'Widget A,Numbers,10,2500', // seeded unit -> creates
      'Widget B,Furlongs,5,1000' // unknown unit -> row error
    ].join('\n')

    const result = importItems(db, csv)

    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual([{ line: 3, message: 'Unknown unit "Furlongs"' }])

    const widgetA = db.prepare("SELECT opening_qty_milli, opening_value FROM stock_items WHERE name = 'Widget A'").get() as {
      opening_qty_milli: number
      opening_value: number
    }
    expect(widgetA).toEqual({ opening_qty_milli: 10000, opening_value: 250000 })

    const widgetB = db.prepare("SELECT id FROM stock_items WHERE name = 'Widget B'").get()
    expect(widgetB).toBeUndefined()
  })

  it('updates an existing item (case-insensitive name match)', () => {
    const db = seededDb()
    const numbers = db.prepare("SELECT id FROM units WHERE name = 'Numbers'").get() as { id: number }
    db.prepare(
      `INSERT INTO stock_items (name, group_id, unit_id, opening_qty_milli, opening_value) VALUES (?, NULL, ?, 0, 0)`
    ).run('widget c', numbers.id)

    const csv = 'Name,Unit,Opening Qty,Opening Value\nWidget C,Numbers,20,5000'
    const result = importItems(db, csv)

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([])

    const row = db.prepare("SELECT opening_qty_milli FROM stock_items WHERE name = 'widget c'").get() as {
      opening_qty_milli: number
    }
    expect(row.opening_qty_milli).toBe(20000)
  })
})

describe('reviewed import batches', () => {
  it('reconciles accepted and rejected rows and values to the source', () => {
    const db = seededDb()
    const csv = [
      'Name,Unit,Opening Qty,Opening Value',
      'Widget A,Numbers,10,2500',
      'Widget B,Furlongs,5,1000'
    ].join('\n')

    const preview = previewImport(db, 'items', csv)
    expect(preview.reconciliation).toEqual({
      sourceRows: 2,
      parsedRows: 2,
      acceptedRows: 1,
      rejectedRows: 1,
      sourceAmount: 350000,
      acceptedAmount: 250000,
      rejectedAmount: 100000,
      rowsAccountedFor: true,
      amountsAccountedFor: true
    })
  })

  it('records the source fingerprint and refuses the exact file a second time', () => {
    const db = seededDb()
    const csv = 'Name,Unit,Opening Qty,Opening Value\nUnique Widget,Numbers,1,99'

    const first = applyImport(db, 'items', csv)
    expect(first.batchId).toBeGreaterThan(0)
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(previewImport(db, 'items', csv).alreadyImported).toMatchObject({ id: first.batchId })
    expect(() => applyImport(db, 'items', csv)).toThrow(/already imported/i)
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_items WHERE name = 'Unique Widget'").get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toMatchObject({ n: 1 })
  })

  it('rolls back every accepted row, batch record, and audit row on a hard failure', () => {
    const db = seededDb()
    db.exec(`CREATE TRIGGER explode_import BEFORE INSERT ON stock_items
      WHEN NEW.name = 'Explode' BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;`)
    const csv = [
      'Name,Unit,Opening Qty,Opening Value',
      'Good Before Failure,Numbers,1,100',
      'Explode,Numbers,1,100'
    ].join('\n')

    expect(() => applyImport(db, 'items', csv)).toThrow(/forced import failure/)
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_items WHERE name IN ('Good Before Failure', 'Explode')").get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toMatchObject({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'import_batch'").get()).toMatchObject({ n: 0 })
  })

  it('counts multi-line quoted CSV fields as one logical source row', () => {
    const db = seededDb()
    const csv = 'Name,Group,Opening Balance\n"Multi\nLine",Sundry Debtors,100'
    expect(previewImport(db, 'ledgers', csv).reconciliation.sourceRows).toBe(1)
  })
})
