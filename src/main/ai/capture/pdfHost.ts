// WP 5.4 — reading a PDF's text layer without blocking main. In the built app the reader runs
// in a worker thread (out/main/pdfWorker.js) that is terminated after PDF_TIMEOUT_MS; where the
// worker file does not exist (dbtests run the TypeScript sources) it runs in-process, still
// bounded by the reader's own budgets (PDF_LIMITS: decoded bytes, objects, operators, time).
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { extractPdfText, PdfBudgetError, type PdfText } from '@shared/capture/pdfText'
import { pdfInflate } from './pdfInflate'

export const PDF_TIMEOUT_MS = 15_000

const workerFile = (): string | null => {
  const f = join(__dirname, 'pdfWorker.js')
  return existsSync(f) ? f : null
}

let seq = 0

export async function readPdf(bytes: Uint8Array, timeoutMs = PDF_TIMEOUT_MS): Promise<PdfText> {
  const file = workerFile()
  if (!file) return extractPdfText(bytes, pdfInflate)
  const worker = new Worker(file)
  const id = ++seq
  try {
    return await new Promise<PdfText>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PdfBudgetError('took too long')), timeoutMs)
      worker.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      worker.on('message', (m: { id: number; ok: boolean; result?: PdfText; error?: string; name?: string }) => {
        if (m.id !== id) return
        clearTimeout(timer)
        if (m.ok) resolve(m.result!)
        else reject(m.name === 'PdfBudgetError' ? Object.assign(new PdfBudgetError(''), { message: m.error! }) : new Error(m.error))
      })
      worker.postMessage({ id, bytes })
    })
  } finally {
    void worker.terminate()
  }
}
