// Shared bits of the TDS screen's tabs (WP 3.2) — and, with kind 'tcs', of the TCS screen
// (WP 3.3): every tab takes a `kind` and reads its words, test ids and API namespace from here,
// so the two screens are one set of components.
import { createContext, useCallback, useContext, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { fyFromStartYear } from '@shared/dates'
import { tdsQuarterBounds } from '@shared/tds'
import type { WithholdingKind } from '@shared/tdsTypes'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'

export type { WithholdingKind }
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

/** The words each kind's screen uses. */
export interface KindWords {
  kind: WithholdingKind
  /** "TDS" / "TCS" — also the test-id / view-id prefix in lower case. */
  name: string
  /** "Deductee" / "Collectee". */
  party: string
  /** "Deducted" / "Collected" (the tab). */
  done: string
  /** "deduction" / "collection". */
  noun: string
  /** "deduct" / "collect". */
  verb: string
  /** Default "Not applicable" reason. */
  naReason: string
  /** "Expense ledger" / "Sales ledger / goods". */
  ledgerHeader: string
  /** Voucher kinds the Eligible list carries. */
  kindLabels: Record<string, string>
  /** "Supplier" / "Buyer" on line-rule hints. */
  counterparty: string
  /** The payable deposit: "Dr TDS Payable / Cr Bank". */
  depositHint: string
  /** Lower-rate certificate section: "s.197" / "s.206C(9)". */
  certificateSection: string
}

export const KIND_WORDS: Record<WithholdingKind, KindWords> = {
  tds: {
    kind: 'tds', name: 'TDS', party: 'Deductee', done: 'Deducted', noun: 'deduction', verb: 'deduct', naReason: 'Not a sum liable to TDS',
    ledgerHeader: 'Expense ledger', kindLabels: { purchase: 'Purchase', journal: 'Journal', payment: 'Payment' }, counterparty: 'supplier',
    depositHint: 'Dr TDS Payable / Cr Bank', certificateSection: 's.197'
  },
  tcs: {
    kind: 'tcs', name: 'TCS', party: 'Collectee', done: 'Collected', noun: 'collection', verb: 'collect',
    naReason: 'Form 27C declaration (s.206C(1A)) — goods for manufacture', ledgerHeader: 'Sales ledger / goods',
    kindLabels: { sales: 'Sales', receipt: 'Receipt' }, counterparty: 'buyer', depositHint: 'Dr TCS Payable / Cr Bank',
    certificateSection: 's.206C(9)'
  }
}

/** The kind deep components (modals, editors) of a tab read, without prop-drilling. */
export const KindContext = createContext<WithholdingKind>('tds')
export const useKind = (): WithholdingKind => useContext(KindContext)

/** The API namespace for a kind, with the return / certificate calls under one name. */
export function withholdingApi(kind: WithholdingKind) {
  if (kind === 'tcs') {
    const t = api.tcs
    return {
      ...t,
      returnData: t.form27eq, exportReturn: t.export27eq, certificateData: t.form27d, certificatePdf: t.form27dPdf
    }
  }
  const t = api.tds
  return {
    ...t,
    returnData: t.form26q, exportReturn: t.export26q, certificateData: t.form16a, certificatePdf: t.form16aPdf
  }
}

/** Run a TDS / TCS write, toast the outcome and refresh everything (vouchers changed: every report). */
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
