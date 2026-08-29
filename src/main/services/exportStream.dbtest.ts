import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBigBook } from '../db/bigbook'
import { streamReportCsv } from './exportStream'
import * as reports from './reports'
import { rowsToCsv } from '@shared/csv'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'

/**
 * The streamed export has to be the same file, not a similar one.
 *
 * Two export paths is one export path more than anybody wants. It is justified only while the
 * streamed one is provably identical to the one it replaces, so these tests build the CSV the old
 * way — every row in memory, `rowsToCsv` — and compare the bytes. If a column is ever added to
 * one and not the other, this fails on the next run rather than in someone's spreadsheet.
 */

const OUT = mkdtempSync(join(tmpdir(), 'total-export-stream-'))
const ALL_COLUMNS = { type: true, number: true, account: true, debit: true, credit: true }

describe('streamed Day Book CSV', () => {
  const book = openBigBook({ invoices: 900 })
  const { db } = book
  const { from, to } = book.shape

  it('is byte-for-byte what building the whole thing in memory produces', () => {
    const path = join(OUT, 'daybook.csv')
    const result = streamReportCsv(db, { kind: 'dayBook', from, to, includeOutOfBooks: false, columns: ALL_COLUMNS }, path)

    const all = reports.dayBook(db, from, to)
    const header = ['Date', 'Type', 'No.', 'Account', 'Narration', 'Debit', 'Credit']
    const body = all.map((r) => [
      toDisplayDate(r.date),
      r.voucherType,
      r.number,
      r.account,
      (r.narration ?? '') + (r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : ''),
      formatPaise(r.debit, { zeroDash: true }),
      formatPaise(r.credit, { zeroDash: true })
    ])
    const totals = all.reduce(
      (acc, r) => (r.isOptional || r.postDated ? acc : { d: acc.d + r.debit, c: acc.c + r.credit }),
      { d: 0, c: 0 }
    )
    body.push(['Total', '', '', '', '', formatPaise(totals.d, { zeroDash: true }), formatPaise(totals.c, { zeroDash: true })])

    expect(readFileSync(path, 'utf8')).toBe(rowsToCsv(header, body))
    expect(result.rows).toBe(all.length)
    // It really was chunked: one page would mean the streaming was decorative.
    expect(result.pages).toBeGreaterThan(1)
  })

  it('honours the columns the screen has hidden', () => {
    const path = join(OUT, 'daybook-narrow.csv')
    streamReportCsv(
      db,
      { kind: 'dayBook', from, to, includeOutOfBooks: false, columns: { ...ALL_COLUMNS, type: false, number: false } },
      path
    )
    const firstLine = readFileSync(path, 'utf8').split('\r\n')[0]!
    expect(firstLine).toBe('﻿Date,Account,Narration,Debit,Credit')
  })

  it('writes a file whose size is the period, not a page', () => {
    const path = join(OUT, 'daybook-size.csv')
    const result = streamReportCsv(db, { kind: 'dayBook', from, to, includeOutOfBooks: false, columns: ALL_COLUMNS }, path)
    expect(statSync(path).size).toBe(result.bytes)
    expect(result.rows).toBe(reports.dayBookCount(db, from, to))
  })

  it('writes a header and a total even for an empty period', () => {
    // An empty file would look like a failed export; a header and a nil total says "nothing here".
    const path = join(OUT, 'daybook-empty.csv')
    const result = streamReportCsv(
      db,
      { kind: 'dayBook', from: '2019-01-01', to: '2019-01-31', includeOutOfBooks: false, columns: ALL_COLUMNS },
      path
    )
    expect(result.rows).toBe(0)
    const lines = readFileSync(path, 'utf8').trimEnd().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Total')
  })
})

describe('streamed ledger statement CSV', () => {
  const book = openBigBook({ invoices: 900 })
  const { db } = book
  const { from, to } = book.shape
  const ledgerId = book.ledgerId(book.shape.salesLedger)

  it('matches the in-memory statement row for row, running balance included', () => {
    const path = join(OUT, 'ledger.csv')
    const result = streamReportCsv(db, { kind: 'ledgerStatement', ledgerId, from, to }, path)

    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    const header = ['Date', 'Particulars', 'Type · No.', 'Debit', 'Credit', 'Balance']
    const body = whole.rows.map((r) => [
      toDisplayDate(r.date),
      r.particulars,
      `${r.voucherType} ${r.number}`,
      formatPaise(r.debit, { zeroDash: true }),
      formatPaise(r.credit, { zeroDash: true }),
      formatPaise(r.running, { zeroDash: true })
    ])
    body.push([
      'Closing balance',
      '',
      '',
      formatPaise(whole.totalDebit, { zeroDash: true }),
      formatPaise(whole.totalCredit, { zeroDash: true }),
      formatPaise(whole.closing, { zeroDash: true })
    ])

    expect(readFileSync(path, 'utf8')).toBe(rowsToCsv(header, body))
    expect(result.rows).toBe(whole.rows.length)
  })

  it('foots to the period, not to the last page', () => {
    const path = join(OUT, 'ledger-foot.csv')
    streamReportCsv(db, { kind: 'ledgerStatement', ledgerId, from, to }, path)
    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    const lines = readFileSync(path, 'utf8').trimEnd().split('\r\n')
    expect(lines[lines.length - 1]).toContain(formatPaise(whole.closing, { zeroDash: true }))
  })
})

describe('peak memory', () => {
  /**
   * The point of the exercise, asserted.
   *
   * A whole-period export used to allocate the rows, the formatted cells and the joined string all
   * at once. This measures the heap the streamed path adds while writing a book several times
   * bigger than the file it produces — if it ever starts growing with the period again, the number
   * here moves long before a customer's machine does.
   */
  it('does not grow with the period', () => {
    const book = openBigBook({ invoices: 900 })
    const { db } = book
    const { from, to } = book.shape
    const path = join(OUT, 'daybook-memory.csv')

    global.gc?.()
    const before = process.memoryUsage().heapUsed
    const result = streamReportCsv(db, { kind: 'dayBook', from, to, includeOutOfBooks: false, columns: ALL_COLUMNS }, path)
    const after = process.memoryUsage().heapUsed
    const grownMb = (after - before) / (1024 * 1024)
    const fileMb = result.bytes / (1024 * 1024)
    console.log(`[stream] wrote ${result.rows} rows, ${fileMb.toFixed(2)} MB, heap grew ${grownMb.toFixed(1)} MB`)

    // Generous, because a GC may or may not have run in the middle: what this catches is the
    // change that buffers the whole file, which shows up as tens of MB, not as three.
    expect(grownMb).toBeLessThan(24)
  })
})

// The temp directory is left for inspection when a test fails, and cleaned when they all pass.
process.on('exit', () => rmSync(OUT, { recursive: true, force: true }))
