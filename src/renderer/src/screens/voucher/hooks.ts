import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Group, Ledger, VoucherKind } from '@shared/domain'
import { api } from '../../lib/client'

export const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']

// ---------- stable line keys ----------

let lineKeySeq = 0
/** Monotonic id for voucher line rows — React keys must survive row insertion/removal, which
 *  array indexes don't (an index key re-binds input state to whatever row slides into that
 *  slot, e.g. after applyTds splices a line in). */
export function nextLineKey(): number {
  return ++lineKeySeq
}

// ---------- shared ledger-group helpers (party detection, cash/bank detection) ----------

export function groupChain(groupId: number, groupMap: Map<number, Group>): Group[] {
  const chain: Group[] = []
  let g = groupMap.get(groupId)
  while (g) {
    chain.push(g)
    g = g.parentId ? groupMap.get(g.parentId) : undefined
  }
  return chain
}

export function isPartyLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors')
}

export function isCashOrBankLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name))
}

/** Bank only (excludes Cash-in-Hand) — a cheque can only be drawn against a bank ledger. */
export function isBankLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => ['Bank Accounts', 'Bank OD A/c'].includes(g.name))
}

/** Local UTC date-add — mirrors @shared/outstanding's private helper (that one isn't exported). */
export function addDaysLocal(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// ---------- voucher number field ----------

export function useVoucherNumber(typeId: number, date: string, excludeId?: number): string {
  const { data } = useQuery({
    queryKey: ['nextNumber', typeId, date, excludeId],
    queryFn: () => api.vouchers.nextNumber(typeId, date, excludeId)
  })
  return data?.number ?? NUMBER_LOADING
}

/** Loading placeholder for the suggested next number, before voucher:nextNumber resolves. Never
 *  sent as input.number — see numberField.value below. */
export const NUMBER_LOADING = '…'

/** The voucher No. field: a plain TextInput pre-filled from voucher:nextNumber, but editable —
 *  once the user types into it ("touched"), further nextNumber results stop overwriting it. A
 *  type or date change is a new numbering context, so it resets `touched` and re-syncs to the
 *  freshly suggested number. `reset()` clears touched after a successful save so the field goes
 *  back to tracking the (now-advanced) suggestion for the next voucher. */
export function useVoucherNumberField(typeId: number, date: string, excludeId?: number): {
  value: string
  onChange: (v: string) => void
  reset: () => void
  /** For posting: '' when untouched-and-still-loading (never send the '…' placeholder), else the
   *  trimmed value the user is looking at (empty string included — that means "auto-assign"). */
  forPayload: string
} {
  const fetched = useVoucherNumber(typeId, date, excludeId)
  const [value, setValue] = useState(fetched)
  const [touched, setTouched] = useState(false)
  const keyRef = useRef(`${typeId}|${date}`)

  useEffect(() => {
    const key = `${typeId}|${date}`
    if (keyRef.current !== key) {
      keyRef.current = key
      setTouched(false)
    }
  }, [typeId, date])

  useEffect(() => {
    if (!touched) setValue(fetched)
  }, [fetched, touched])

  const onChange = useCallback((v: string): void => {
    setTouched(true)
    setValue(v)
  }, [])
  const reset = useCallback((): void => setTouched(false), [])

  return { value, onChange, reset, forPayload: value === NUMBER_LOADING ? '' : value.trim() }
}
