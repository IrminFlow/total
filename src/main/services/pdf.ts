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
}

/** Render HTML to a PDF buffer via a hidden, sandboxed BrowserWindow. Extracted from
 *  invoice.ts's original invoicePdf (Task 3.6 was slated to do this extraction; it landed here
 *  first in Task 2.7 since cheque printing needed the same custom-page-size machinery). */
export async function htmlToPdf(html: string, opts: HtmlToPdfOptions = {}): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const printOpts: Electron.PrintToPDFOptions = { printBackground: true }
    if (opts.pageSize) printOpts.pageSize = opts.pageSize as Electron.PrintToPDFOptions['pageSize']
    if (opts.margins === 'none') printOpts.margins = { marginType: 'none' }
    return await win.webContents.printToPDF(printOpts)
  } finally {
    win.destroy()
  }
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
