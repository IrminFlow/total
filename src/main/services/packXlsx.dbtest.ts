// WP 6.3 × 6.1: scheduled report packs write XLSX through the shared workbook writer — amounts are
// numbers (Dr +), labels text.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { postSimpleVoucher, seededDb, TEST_INFO } from '../db/testdb'
import { runPack, savePack } from './reportPacks'
import { readXlsxFile } from './xlsxFile'

describe('report packs → XLSX', () => {
  it('writes a typed workbook per report', async () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2026-04-10', amount: 123450, kind: 'receipt' })
    const out = mkdtempSync(join(tmpdir(), 'total-pack-xlsx-'))
    try {
      const pack = savePack(db, { name: 'Excel', reports: [{ kind: 'builtin', key: 'trialBalance' }], periodRule: 'fyToDate', frequency: 'monthly', formats: ['xlsx'], outputDir: out })
      const run = await runPack(db, 'test-co', TEST_INFO, pack.id, { trigger: 'manual', now: new Date('2026-05-15T10:00:00'), renderPdf: async () => Buffer.from('') })
      expect(run.status).toBe('ok')
      expect(run.files).toHaveLength(1)
      expect(run.files[0]).toMatch(/\.xlsx$/)
      const wb = readXlsxFile(run.files[0]!)
      const rows = wb.sheets[0]!.rows
      const header = rows.find((r) => r.cells.includes('Ledger') || r.cells.some((c) => typeof c === 'string' && /ledger|particulars/i.test(c)))!
      expect(header).toBeTruthy()
      // The cash line's debit is a number in rupees, not the display string.
      const cash = rows.find((r) => r.cells[0] === 'Cash')!
      expect(cash.cells.some((c) => c === 1234.5)).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
