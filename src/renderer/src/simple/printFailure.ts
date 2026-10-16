import { useCallback } from 'react'
import type { Translate } from '@shared/i18n'
import { mapError, type CaughtError } from '@shared/errors'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useToasts } from '../state/stores'

/**
 * A print / PDF that failed, in plain words: the screen's own sentence (`lead`, already
 * translated) plus what the 8.5 mapping says about the error when it has a plain message of its
 * own (a bill that went to the bin …) — never the service's English, never the generic
 * "nothing was saved" line (printing saves nothing).
 */
export function printFailureText(err: unknown, t: Translate, lead: string): string {
  const m = mapError(err as CaughtError, { simple: true, t })
  const generic = t('errors.generic')
  const extra = [m.general, ...Object.values(m.fields)].filter((x): x is string => !!x && x !== generic)
  return [lead, ...extra].join(' ')
}

/** Print a saved bill (invoice:pdf); a refusal becomes an error toast instead of nothing. */
export function usePrintBill(): (voucherId: number) => Promise<void> {
  const t = useT()
  const push = useToasts((s) => s.push)
  return useCallback(
    async (voucherId: number) => {
      try {
        await api.invoice.pdf(voucherId)
      } catch (err) {
        push('error', printFailureText(err, t, t('simple.bill.printFailed')))
      }
    },
    [t, push]
  )
}
