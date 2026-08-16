import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportGstr1Csv } from './gst'
import { companyExportsDir, ensureCompanyTree } from '../paths'
import type { Gstr1Result } from '@shared/gst/returns'

describe('gst service — exportGstr1Csv', () => {
  it('writes plain (integer-math) rupee decimals — no float division artifacts, zero pads to "0.00"', () => {
    // dataRoot() reads TOTAL_DATA_DIR verbatim when set — the hermetic override that avoids
    // touching Electron's app.getPath('documents'), which isn't available under electron-as-node.
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-gst-test-'))
    const slug = 'gst-export-test'
    ensureCompanyTree(slug)

    const result: Gstr1Result = {
      period: '072026',
      gstin: '27AAAAA0000A1Z5',
      json: {},
      summary: [
        // 3333 paise / 3 lines-worth is a classic float-division trap (33.33 repeating) — pure
        // integer math must still land on an exact 2-decimal string.
        { section: 'B2B', label: 'B2B Invoices', docs: 3, taxable: 3333, igst: 0, cgst: 300, sgst: 300, cess: 0 },
        // A row with every tax column at exactly zero used to print bare "0" (a JS number
        // stringified), not the "0.00" a portal CSV column expects.
        { section: 'NIL', label: 'Nil rated', docs: 1, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
      ]
    }

    const path = exportGstr1Csv(slug, result)
    expect(path).toBe(`${companyExportsDir(slug)}/gstr1-072026-summary.csv`)
    const csv = readFileSync(path, 'utf8')
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Section,Documents,Taxable Value,IGST,CGST,SGST,Cess')
    expect(lines[1]).toBe('B2B Invoices,3,33.33,0.00,3.00,3.00,0.00')
    expect(lines[2]).toBe('Nil rated,1,0.00,0.00,0.00,0.00,0.00')
  })
})
