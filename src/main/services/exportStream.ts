/**
 * Exports that never hold the whole report.
 *
 * The other export path builds a report in the renderer, joins every row into one string, and
 * sends that string across IPC for main to write. For a trial balance that is fine. For three
 * years of a Day Book it is a ~6 MB payload built as a ~6 MB string out of 30,000 arrays, cloned
 * across a process boundary, and then written — three copies of the same data alive at once, on
 * the thread that also answers every other query.
 *
 * This path instead pulls the report a page at a time straight from the database, formats each
 * page, and appends it to the file. Peak memory is one page and one write buffer, whatever the
 * period. Nothing crosses IPC but the request and the resulting path.
 *
 * Pages are fetched with the keyset cursor rather than an offset, so page five hundred costs what
 * page one costs (see @shared/keyset). The row FORMATTING is deliberately identical to the
 * screen's export — same columns, same display strings — and `exportStream.dbtest.ts` asserts the
 * streamed file is byte-for-byte what the in-memory path produces, because two export paths that
 * disagree is worse than one slow one.
 */
import { closeSync, openSync, writeSync } from 'node:fs'
import type { DB } from '../db/connection'
import { quoteCsvField } from '@shared/csv'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import * as reports from './reports'

/** Rows fetched per page, and roughly the number buffered before a write. Big enough that the
 *  per-page overhead disappears, small enough that peak memory does not depend on the period. */
const PAGE = 1000

/** CSV rows are joined with CRLF and the file starts with a BOM, matching `rowsToCsv` exactly —
 *  Excel needs the BOM to read a rupee sign, and a second export format would be a second bug. */
const BOM = '﻿'

export interface StreamResult {
  path: string
  rows: number
  bytes: number
  /** Pages fetched. Reported so a test can prove the export really was chunked and did not
   *  quietly fall back to fetching everything. */
  pages: number
}

/** Which columns a streamed Day Book carries. Mirrors the screen's column toggles so the export
 *  matches what was on screen when it was asked for. */
export interface DayBookColumns {
  type: boolean
  number: boolean
  account: boolean
  debit: boolean
  credit: boolean
}

export type StreamRequest =
  | { kind: 'dayBook'; from: string; to: string; includeOutOfBooks: boolean; columns: DayBookColumns }
  | { kind: 'ledgerStatement'; ledgerId: number; from: string; to: string }

/**
 * A file written in chunks.
 *
 * `writeSync` on a raw descriptor rather than a WriteStream: this runs inside a synchronous IPC
 * handler, and a stream's back-pressure would need the handler to become async for no benefit at
 * these sizes. The buffering is the part that matters — one string per chunk, not one per file.
 */
class ChunkWriter {
  private fd: number
  private buffer: string[] = []
  private buffered = 0
  bytes = 0
  /** Flush at roughly 256 KB: large enough that the syscall count is irrelevant, small enough
   *  that peak memory is a constant rather than a function of the book. */
  private static readonly FLUSH_BYTES = 256 * 1024

  constructor(path: string) {
    this.fd = openSync(path, 'w')
  }

  write(text: string): void {
    this.buffer.push(text)
    this.buffered += text.length
    if (this.buffered >= ChunkWriter.FLUSH_BYTES) this.flush()
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const chunk = this.buffer.join('')
    this.buffer = []
    this.buffered = 0
    this.bytes += Buffer.byteLength(chunk, 'utf8')
    writeSync(this.fd, chunk, null, 'utf8')
  }

  close(): void {
    this.flush()
    closeSync(this.fd)
  }
}

const csvLine = (cells: string[]): string => `${cells.map(quoteCsvField).join(',')}\r\n`

/** One display row of a report, as the PDF template wants it. */
export interface StreamedPdfRow {
  cells: string[]
  bold?: boolean
}

/**
 * The same report, collected in main for printing.
 *
 * The PDF path refuses more than 5,000 rows, and the refusal is in the right place for the
 * channel it guards: `report:pdf` takes the finished rows over IPC, and 30,000 of them is a
 * multi-megabyte structured clone built in the renderer. It is the wrong answer for "print my
 * year", though, so this collects the rows on the same side of the boundary as the database,
 * paged, and hands them straight to the template.
 *
 * Still capped, at a number that means something: past ~50,000 rows the PDF is a thousand pages
 * Chromium takes minutes to lay out, and the honest answer is the CSV.
 */
export const STREAMED_PDF_ROW_CAP = 50_000

export function collectReportRows(
  db: DB,
  request: StreamRequest
): { columns: { label: string; align: 'l' | 'r' }[]; rows: StreamedPdfRow[]; title: string } {
  if (request.kind === 'dayBook') {
    const c = request.columns
    const columns: { label: string; align: 'l' | 'r' }[] = [
      { label: 'Date', align: 'l' },
      ...(c.type ? [{ label: 'Type', align: 'l' as const }] : []),
      ...(c.number ? [{ label: 'No.', align: 'l' as const }] : []),
      ...(c.account ? [{ label: 'Account', align: 'l' as const }] : []),
      { label: 'Narration', align: 'l' as const },
      ...(c.debit ? [{ label: 'Debit', align: 'r' as const }] : []),
      ...(c.credit ? [{ label: 'Credit', align: 'r' as const }] : [])
    ]
    const rows: StreamedPdfRow[] = []
    let totalDebit = 0
    let totalCredit = 0
    let cursor: string | null = null
    for (;;) {
      const page = reports.dayBook(db, request.from, request.to, {
        includeOutOfBooks: request.includeOutOfBooks,
        limit: PAGE,
        after: cursor
      })
      if (page.length === 0) break
      for (const r of page) {
        const badge = r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : ''
        if (!r.isOptional && !r.postDated) {
          totalDebit += r.debit
          totalCredit += r.credit
        }
        rows.push({
          cells: [
            toDisplayDate(r.date),
            ...(c.type ? [r.voucherType] : []),
            ...(c.number ? [r.number] : []),
            ...(c.account ? [r.account] : []),
            (r.narration ?? '') + badge,
            ...(c.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
            ...(c.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
          ]
        })
        if (rows.length > STREAMED_PDF_ROW_CAP) {
          throw new Error(
            `That period is over ${STREAMED_PDF_ROW_CAP.toLocaleString('en-IN')} rows — export it as CSV, or narrow the dates.`
          )
        }
      }
      cursor = reports.dayBookCursor(page[page.length - 1]!)
      if (page.length < PAGE) break
    }
    rows.push({
      cells: [
        'Total',
        ...(c.type ? [''] : []),
        ...(c.number ? [''] : []),
        ...(c.account ? [''] : []),
        '',
        ...(c.debit ? [formatPaise(totalDebit, { zeroDash: true })] : []),
        ...(c.credit ? [formatPaise(totalCredit, { zeroDash: true })] : [])
      ],
      bold: true
    })
    return { columns, rows, title: 'Day book' }
  }

  const columns: { label: string; align: 'l' | 'r' }[] = [
    { label: 'Date', align: 'l' },
    { label: 'Particulars', align: 'l' },
    { label: 'Type · No.', align: 'l' },
    { label: 'Debit', align: 'r' },
    { label: 'Credit', align: 'r' },
    { label: 'Balance', align: 'r' }
  ]
  const rows: StreamedPdfRow[] = []
  let statement = reports.ledgerStatement(db, request.ledgerId, request.from, request.to, undefined, { limit: PAGE })
  for (;;) {
    for (const r of statement.rows) {
      rows.push({
        cells: [
          toDisplayDate(r.date),
          r.particulars,
          `${r.voucherType} ${r.number}`,
          formatPaise(r.debit, { zeroDash: true }),
          formatPaise(r.credit, { zeroDash: true }),
          formatPaise(r.running, { zeroDash: true })
        ]
      })
      if (rows.length > STREAMED_PDF_ROW_CAP) {
        throw new Error(
          `That ledger has over ${STREAMED_PDF_ROW_CAP.toLocaleString('en-IN')} rows in this period — export it as CSV, or narrow the dates.`
        )
      }
    }
    const next = statement.nextCursor ?? null
    if (!next) break
    statement = reports.ledgerStatement(db, request.ledgerId, request.from, request.to, undefined, {
      limit: PAGE,
      after: next
    })
  }
  rows.push({
    cells: [
      'Closing balance',
      '',
      '',
      formatPaise(statement.totalDebit, { zeroDash: true }),
      formatPaise(statement.totalCredit, { zeroDash: true }),
      formatPaise(statement.closing, { zeroDash: true })
    ],
    bold: true
  })
  return { columns, rows, title: statement.ledgerName }
}

/** Writes `request` to `path` as CSV, a page at a time. Returns what it wrote. */
export function streamReportCsv(db: DB, request: StreamRequest, path: string): StreamResult {
  const out = new ChunkWriter(path)
  let rows = 0
  let pages = 0
  try {
    if (request.kind === 'dayBook') {
      const c = request.columns
      out.write(BOM)
      out.write(
        csvLine([
          'Date',
          ...(c.type ? ['Type'] : []),
          ...(c.number ? ['No.'] : []),
          ...(c.account ? ['Account'] : []),
          'Narration',
          ...(c.debit ? ['Debit'] : []),
          ...(c.credit ? ['Credit'] : [])
        ])
      )
      let totalDebit = 0
      let totalCredit = 0
      let cursor: string | null = null
      for (;;) {
        const page = reports.dayBook(db, request.from, request.to, {
          includeOutOfBooks: request.includeOutOfBooks,
          limit: PAGE,
          after: cursor
        })
        if (page.length === 0) break
        pages++
        for (const r of page) {
          // The same badge the screen's export writes: an optional or post-dated voucher must not
          // read as an ordinary one in a file someone reconciles against.
          const badge = r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : ''
          // Totals count only what is in the books, whatever the export shows — same rule as the
          // screen's total row.
          if (!r.isOptional && !r.postDated) {
            totalDebit += r.debit
            totalCredit += r.credit
          }
          out.write(
            csvLine([
              toDisplayDate(r.date),
              ...(c.type ? [r.voucherType] : []),
              ...(c.number ? [r.number] : []),
              ...(c.account ? [r.account] : []),
              (r.narration ?? '') + badge,
              ...(c.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
              ...(c.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
            ])
          )
          rows++
        }
        cursor = reports.dayBookCursor(page[page.length - 1]!)
        if (page.length < PAGE) break
      }
      out.write(
        csvLine([
          'Total',
          ...(c.type ? [''] : []),
          ...(c.number ? [''] : []),
          ...(c.account ? [''] : []),
          '',
          ...(c.debit ? [formatPaise(totalDebit, { zeroDash: true })] : []),
          ...(c.credit ? [formatPaise(totalCredit, { zeroDash: true })] : [])
        ])
      )
    } else {
      out.write(BOM)
      out.write(csvLine(['Date', 'Particulars', 'Type · No.', 'Debit', 'Credit', 'Balance']))
      let cursor: string | null = null
      let statement = reports.ledgerStatement(db, request.ledgerId, request.from, request.to, undefined, {
        limit: PAGE
      })
      for (;;) {
        pages++
        for (const r of statement.rows) {
          out.write(
            csvLine([
              toDisplayDate(r.date),
              r.particulars,
              `${r.voucherType} ${r.number}`,
              formatPaise(r.debit, { zeroDash: true }),
              formatPaise(r.credit, { zeroDash: true }),
              formatPaise(r.running, { zeroDash: true })
            ])
          )
          rows++
        }
        cursor = statement.nextCursor ?? null
        if (!cursor) break
        statement = reports.ledgerStatement(db, request.ledgerId, request.from, request.to, undefined, {
          limit: PAGE,
          after: cursor
        })
      }
      // The closing line comes from the period's totals, which every page carries — so it is the
      // whole period's, not the last page's.
      out.write(
        csvLine([
          'Closing balance',
          '',
          '',
          formatPaise(statement.totalDebit, { zeroDash: true }),
          formatPaise(statement.totalCredit, { zeroDash: true }),
          formatPaise(statement.closing, { zeroDash: true })
        ])
      )
    }
  } finally {
    out.close()
  }
  return { path, rows, bytes: out.bytes, pages }
}
