import { BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { companyExportsDir } from '../paths'

export interface HtmlToPdfOptions {
  /** A named page size, or a custom size. Custom sizes are consumed as-is by Electron's
   *  printToPDF, which (unlike webContents.print's pageSize, which takes microns) takes an
   *  object of height/width in INCHES — see PrintToPDFOptions.pageSize's doc in
   *  node_modules/electron/electron.d.ts. Callers with an mm-precision layout (e.g. cheque
   *  printing) must convert mm → inches themselves (see @shared/cheque's mmToInches) before
   *  passing a custom size here; the plain 'A4' etc. named sizes cover everything else. */
  pageSize?: Electron.PrintToPDFOptions['pageSize'] | { width: number; height: number }
  /** 'none' drops all page margins — for layouts (e.g. a cheque) that are absolutely
   *  positioned against the physical page edge and must not be inset by a default margin. */
  margins?: 'none'
  /** Landscape orientation — for wide reports (columnar, many-column registers). */
  landscape?: boolean
  /** "Page N of M" centered in the footer of every page. Chromium ignores CSS @page margin-box
   *  counters, so page numbers ride on printToPDF's native footerTemplate instead. */
  pageNumbers?: boolean
  /**
   * A running head and foot repeated on every page.
   *
   * The in-document header block only appears on page one, so page four of a printed ledger used
   * to identify neither the company nor the period it covered — and page four is exactly the
   * page that ends up photocopied, emailed, or handed to an auditor on its own. Chromium's
   * header/footer templates are the only way to repeat content per page.
   */
  runningHead?: { company: string; gstin: string | null; title: string; periodLabel: string }
}

/** Chromium's header/footer templates render in an isolated document with no access to the page's
 *  CSS, so every style has to be inline. Escaped here because a company name is user input. */
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One hidden render window shared by every PDF job (task Q2 #98). Recreated lazily after any
 *  failure/timeout — a wedged renderer must not poison every subsequent print. */
let sharedWin: BrowserWindow | null = null

/** Tail of the job queue: PDF jobs are strictly serialized so two callers never race the shared
 *  window's loadURL/printToPDF pair. */
let queueTail: Promise<unknown> = Promise.resolve()

const JOB_TIMEOUT_MS = 30_000

function obtainWindow(): BrowserWindow {
  if (!sharedWin || sharedWin.isDestroyed()) {
    sharedWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  }
  return sharedWin
}

function discardWindow(): void {
  try {
    if (sharedWin && !sharedWin.isDestroyed()) sharedWin.destroy()
  } catch {
    // Already gone — nothing to clean up.
  }
  sharedWin = null
}

async function renderPdf(html: string, opts: HtmlToPdfOptions): Promise<Buffer> {
  const win = obtainWindow()
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const printOpts: Electron.PrintToPDFOptions = { printBackground: true }
  if (opts.pageSize) printOpts.pageSize = opts.pageSize as Electron.PrintToPDFOptions['pageSize']
  if (opts.margins === 'none') printOpts.margins = { marginType: 'none' }
  if (opts.landscape) printOpts.landscape = true
  if (opts.pageNumbers || opts.runningHead) {
    printOpts.displayHeaderFooter = true
    const head = opts.runningHead
    const font = 'font-size:8.5px;font-family:Helvetica,Arial,sans-serif;color:#555'
    printOpts.headerTemplate = head
      ? `<div style="width:100%;padding:0 12mm;display:flex;justify-content:space-between;${font}">` +
        `<span>${escHtml(head.company)}${head.gstin ? ' · ' + escHtml(head.gstin) : ''}</span>` +
        `<span>${escHtml(head.title)}</span>` +
        '</div>'
      : '<span></span>'
    // The period goes in the footer rather than the header so a page cannot be read as covering
    // a range it does not — it sits right under the last row on the page.
    const periodPart = head ? `<span>${escHtml(head.periodLabel)}</span>` : '<span></span>'
    const pagePart = opts.pageNumbers
      ? '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>'
      : '<span></span>'
    printOpts.footerTemplate =
      `<div style="width:100%;padding:0 12mm;display:flex;justify-content:space-between;${font}">` +
      periodPart +
      pagePart +
      '</div>'
  }
  return await win.webContents.printToPDF(printOpts)
}

/**
 * Render HTML to a PDF buffer via a hidden, sandboxed BrowserWindow. Jobs are queued and run one
 * at a time against a single reused window, each with a 30s timeout; on any failure (including
 * timeout) the window is destroyed and recreated for the next job.
 */
export async function htmlToPdf(html: string, opts: HtmlToPdfOptions = {}): Promise<Buffer> {
  const job = queueTail.then(async (): Promise<Buffer> => {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PDF rendering timed out after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)
      })
      return await Promise.race([renderPdf(html, opts), timeout])
    } catch (err) {
      discardWindow()
      throw err
    } finally {
      clearTimeout(timer)
    }
  })
  // The tail must survive rejections, or one failed job would reject every later one.
  queueTail = job.catch(() => undefined)
  return job
}

/** htmlToPdf + write into the company's exports folder. Returns the file path. */
export async function writeExportPdf(
  slug: string,
  filename: string,
  html: string,
  opts?: HtmlToPdfOptions
): Promise<string> {
  const pdf = await htmlToPdf(html, opts)
  const path = join(companyExportsDir(slug), filename)
  writeFileSync(path, pdf)
  return path
}
