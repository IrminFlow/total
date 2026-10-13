// WP 5.4 — the PDF text-layer reader off the main thread (a worker_threads entry, built as
// out/main/pdfWorker.js). The host (pdfHost.ts) terminates it on a timeout, so even a PDF that
// defeats the reader's own budgets can never stall the app.
import { parentPort } from 'worker_threads'
import { extractPdfText } from '@shared/capture/pdfText'
import { pdfInflate } from './pdfInflate'

parentPort?.on('message', (msg: { id: number; bytes: Uint8Array }) => {
  try {
    const result = extractPdfText(msg.bytes, pdfInflate)
    parentPort!.postMessage({ id: msg.id, ok: true, result })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : 'Error' })
  }
})
