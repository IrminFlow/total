// Shared bits of the TDS screen's tabs (WP 3.2).
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { fyFromStartYear } from '@shared/dates'
import { tdsQuarterBounds } from '@shared/tds'
import { useToasts } from '../../state/stores'

export type QuarterChoice = 0 | 1 | 2 | 3 | 4

/** The screen's period: a quarter of the FY, or (0) the whole FY. */
export interface TdsPeriod {
  fyStartYear: number
  quarter: QuarterChoice
  from: string
  to: string
  label: string
}

export function periodOf(fyStartYear: number, quarter: QuarterChoice): TdsPeriod {
  const fy = fyFromStartYear(fyStartYear)
  if (quarter === 0) return { fyStartYear, quarter, from: fy.from, to: fy.to, label: `FY ${fy.label}` }
  const { from, to } = tdsQuarterBounds(fyStartYear, quarter)
  return { fyStartYear, quarter, from, to, label: `Q${quarter} FY${fy.label}` }
}

export const pctText = (bp: number | null): string => (bp == null ? '—' : `${bp / 100}%`)

/** Run a TDS write, toast the outcome and refresh everything (vouchers changed: every report). */
export function useTdsAction(): { busy: boolean; run: <T>(fn: () => Promise<T>, success?: string | ((r: T) => string)) => Promise<T | null> } {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | null> => {
      setBusy(true)
      try {
        const r = await fn()
        if (success) toast.push('success', typeof success === 'string' ? success : success(r))
        await queryClient.invalidateQueries()
        return r
      } catch (err) {
        toast.push('error', (err as Error).message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [toast, queryClient]
  )
  return { busy, run }
}
