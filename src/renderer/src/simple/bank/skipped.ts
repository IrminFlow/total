import { useCallback, useEffect, useState } from 'react'
import type { BankLineView } from '@shared/simple/bank'

/**
 * "Skip for now" on the simple Bank screen, remembered on this computer. It saves nothing in the
 * books (a skipped line is still an open statement line — the sentence and the full Banking count
 * it as before), so it lives in the renderer's localStorage:
 *
 *   `total-bank-skipped:<company slug>:<bank ledger id>` = JSON array of line keys
 *
 * A line key is the line's per-account identity (`BankLineView.key` = bank_statement_lines
 * .import_hash: date, signed amount, narration, same-day occurrence — the same after an import is
 * undone and the file added again), or `id:<line id>` when the view carries none.
 */
export const SKIPPED_PREFIX = 'total-bank-skipped' // i18n-technical: localStorage key prefix

export const skippedStorageKey = (slug: string | null, bankLedgerId: number): string => `${SKIPPED_PREFIX}:${slug ?? '-'}:${bankLedgerId}`

export const lineKey = (l: Pick<BankLineView, 'id' | 'key'>): string => l.key ?? `id:${l.id}` // i18n-technical

function read(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function write(storageKey: string, keys: Set<string>): void {
  try {
    if (keys.size) localStorage.setItem(storageKey, JSON.stringify([...keys]))
    else localStorage.removeItem(storageKey)
  } catch {
    // Storage full / unavailable: the skip still holds for this session.
  }
}

/** The skipped line keys of one bank account, with skip / bring back (each written at once). */
export function useSkippedLines(slug: string | null, bankLedgerId: number | null): {
  skipped: Set<string>
  skip: (key: string) => void
  bringBack: (key: string) => void
} {
  const storageKey = bankLedgerId == null ? null : skippedStorageKey(slug, bankLedgerId)
  const [skipped, setSkipped] = useState<Set<string>>(() => (storageKey ? read(storageKey) : new Set()))
  useEffect(() => setSkipped(storageKey ? read(storageKey) : new Set()), [storageKey])
  const change = useCallback(
    (key: string, on: boolean) => {
      if (!storageKey) return
      setSkipped((prev) => {
        const next = new Set(prev)
        if (on) next.add(key)
        else next.delete(key)
        write(storageKey, next)
        return next
      })
    },
    [storageKey]
  )
  return { skipped, skip: useCallback((k: string) => change(k, true), [change]), bringBack: useCallback((k: string) => change(k, false), [change]) }
}
