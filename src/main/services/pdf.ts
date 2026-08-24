import { BrowserWindow } from "electron";
import { writeFileSync } from "fs";
import { join } from "path";
import { companyExportsDir } from "../paths";

export interface HtmlToPdfOptions {
  /** A named page size, or a custom size. Custom sizes are consumed as-is by Electron's
   *  printToPDF, which (unlike webContents.print's pageSize, which takes microns) takes an
   *  object of height/width in INCHES — see PrintToPDFOptions.pageSize's doc in
   *  node_modules/electron/electron.d.ts. Callers with an mm-precision layout (e.g. cheque
   *  printing) must convert mm → inches themselves (see @shared/cheque's mmToInches) before
   *  passing a custom size here; the plain 'A4' etc. named sizes cover everything else. */
  pageSize?:
    Electron.PrintToPDFOptions["pageSize"] | { width: number; height: number };
  /** 'none' drops all page margins — for layouts (e.g. a cheque) that are absolutely
   *  positioned against the physical page edge and must not be inset by a default margin. */
  margins?: "none";
  /** Landscape orientation — for wide reports (columnar, many-column registers). */
  landscape?: boolean;
  /** "Page N of M" centered in the footer of every page. Chromium ignores CSS @page margin-box
   *  counters, so page numbers ride on printToPDF's native footerTemplate instead. */
  pageNumbers?: boolean;
}

/** One hidden render window shared by every PDF job (task Q2 #98). Recreated lazily after any
 *  failure/timeout — a wedged renderer must not poison every subsequent print. */
let sharedWin: BrowserWindow | null = null;

/** Tail of the job queue: PDF jobs are strictly serialized so two callers never race the shared
 *  window's loadURL/printToPDF pair. */
let queueTail: Promise<unknown> = Promise.resolve();

const JOB_TIMEOUT_MS = 30_000;

function obtainWindow(): BrowserWindow {
  if (!sharedWin || sharedWin.isDestroyed()) {
    sharedWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true },
    });
  }
  return sharedWin;
}

function discardWindow(): void {
  try {
    if (sharedWin && !sharedWin.isDestroyed()) sharedWin.destroy();
  } catch {
    // Already gone — nothing to clean up.
  }
  sharedWin = null;
}

async function renderPdf(
  html: string,
  opts: HtmlToPdfOptions,
): Promise<Buffer> {
  const win = obtainWindow();
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const printOpts: Electron.PrintToPDFOptions = {
    printBackground: true,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  };
  if (opts.pageSize)
    printOpts.pageSize =
      opts.pageSize as Electron.PrintToPDFOptions["pageSize"];
  // Electron 43 removed Chromium's legacy marginType field. Explicit zero-inch edges preserve
  // the same borderless output while using the stable PrintToPDFMargins shape.
  if (opts.margins === "none")
    printOpts.margins = { top: 0, right: 0, bottom: 0, left: 0 };
  if (opts.landscape) printOpts.landscape = true;
  if (opts.pageNumbers) {
    printOpts.displayHeaderFooter = true;
    printOpts.headerTemplate = "<span></span>";
    printOpts.footerTemplate =
      '<div style="width:100%;text-align:center;font-size:9px;font-family:Helvetica,Arial,sans-serif;color:#555">' +
      'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>';
  }
  return await win.webContents.printToPDF(printOpts);
}

/**
 * Render HTML to a PDF buffer via a hidden, sandboxed BrowserWindow. Jobs are queued and run one
 * at a time against a single reused window, each with a 30s timeout; on any failure (including
 * timeout) the window is destroyed and recreated for the next job.
 */
export async function htmlToPdf(
  html: string,
  opts: HtmlToPdfOptions = {},
): Promise<Buffer> {
  const job = queueTail.then(async (): Promise<Buffer> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `PDF rendering timed out after ${JOB_TIMEOUT_MS / 1000}s`,
              ),
            ),
          JOB_TIMEOUT_MS,
        );
      });
      return await Promise.race([renderPdf(html, opts), timeout]);
    } catch (err) {
      discardWindow();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
  // The tail must survive rejections, or one failed job would reject every later one.
  queueTail = job.catch(() => undefined);
  return job;
}

/** htmlToPdf + write into the company's exports folder. Returns the file path. */
export async function writeExportPdf(
  slug: string,
  filename: string,
  html: string,
  opts?: HtmlToPdfOptions,
): Promise<string> {
  const pdf = await htmlToPdf(html, opts);
  const path = join(companyExportsDir(slug), filename);
  writeFileSync(path, pdf);
  return path;
}
