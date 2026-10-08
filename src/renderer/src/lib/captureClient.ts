// Typed client for document capture (WP 5.4) — the channels in src/main/ai/capture/ipc.ts.
// Files go to main as bytes (dropped) or are picked in main (native dialog); the renderer never
// sends a path and never talks to the provider.
import { call } from './client'
import type {
  CaptureEstimate, CaptureItemDto, CaptureMapping, CaptureQueueView, CategoriseAcceptResult, StatementCategorisation
} from '@shared/capture/types'

export type * from '@shared/capture/types'

export const captureApi = {
  list: () => call<CaptureQueueView>('capture:list'),
  get: (id: number) => call<CaptureItemDto>('capture:get', { id }),
  pick: () => call<{ added: number[]; refused: string[] }>('capture:pick'),
  addFiles: (files: { name: string; base64: string }[]) => call<{ added: number[]; refused: string[] }>('capture:addFiles', { files }),
  estimate: (ids?: number[]) => call<CaptureEstimate>('capture:estimate', { ids }),
  process: (ids?: number[]) => call<{ approved: number }>('capture:process', { ids }),
  stop: () => call<{ stopped: number }>('capture:stop'),
  cancel: (id: number) => call<CaptureItemDto>('capture:cancel', { id }),
  retry: (id: number) => call<CaptureItemDto>('capture:retry', { id }),
  resolve: (id: number, mapping: CaptureMapping) => call<CaptureItemDto>('capture:resolve', { id, mapping }),
  remove: (id: number) => call<null>('capture:remove', { id }),
  revealInbox: () => call<string>('capture:revealInbox'),
  categorise: (bankLedgerId: number, useAi = true) => call<StatementCategorisation>('bankImport:categorise', { bankLedgerId, useAi }),
  acceptCategories: (bankLedgerId: number, items: { lineId: number; ledgerId: number; kind?: 'payment' | 'receipt' | 'contra'; oldestBillsFirst?: boolean; memoryId?: number }[]) =>
    call<CategoriseAcceptResult>('bankImport:categoriseAccept', { bankLedgerId, items })
}

/** A dropped File → base64 (FileReader; no path leaves the renderer). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.onload = () => {
      const s = String(r.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(file)
  })
}

/** micro-USD → "$0.0123" (estimates only — the price table is the user's). */
export function usd(micro: number | null): string {
  if (micro == null) return '—'
  const d = micro / 1_000_000
  return `$${d < 1 ? d.toFixed(4) : d.toFixed(2)}`
}
