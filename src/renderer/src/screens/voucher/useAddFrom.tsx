// "Add from…" for an entry form (WP 2.5c): the party's open source lines for the kind being
// entered (rules.ts decides which kinds), the drawer's rows net of what the form already holds,
// the per-row quantity caps / locks and "from SO-4 · line 2" chips, Alt+A, and the one-shot
// "Convert to …" pre-fill from an order. Used by the challan / GRN form; InvoiceEntry still
// carries its own copy of the same logic (WP 2.5b) — fold it in once WP 3.3's TCS work there lands.
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { OpenSourceLine } from '@shared/tradeCycle/types'
import type { TradeSideKind } from '@shared/tradeCycle/rules'
import { addFromFor, rowsFromSourcePicks, sourceLocksGoods, type SourcePick } from '@shared/voucherEdit'
import type { LinkType } from '@shared/domain'
import { api } from '../../lib/client'
import { isAnyModalOpen } from '../../components/ui'
import { DocLink } from '../../components/links'
import { nextLineKey } from './hooks'
import { blankItemRow, type ItemRow } from './ItemLineGrid'

export interface AddFromState {
  /** The button's label / link type; null = no "Add from…" for this kind (or flag off). */
  addFrom: ReturnType<typeof addFromFor>
  open: boolean
  setOpen: (open: boolean) => void
  drawerLines: OpenSourceLine[]
  loading: boolean
  insert: (picks: SourcePick[]) => void
  lockedBySource: (r: ItemRow) => { label: string; maxQtyMilli: number; lockDetail: boolean } | null
  rowNote: (r: ItemRow) => React.ReactNode
  removeRow: (i: number) => void
}

export function useAddFrom(opts: {
  kind: TradeSideKind
  enabled: boolean
  partyId: number | null
  voucherId?: number
  /** The order being altered (its own links don't count against what is pending). */
  tradeDocId?: number
  rows: ItemRow[]
  setRows: Dispatch<SetStateAction<ItemRow[]>>
  /** Draw every pending line of this order once its lines load ("Convert to …"). */
  convertFromTradeDocId?: number | null
  /** WP 2.5d: a second picker on the same form (a stock note's rejection, `rejectionFor`) —
   *  replaces addFromFor(kind); its rows are the ones with this link type. */
  spec?: ReturnType<typeof addFromFor>
  /** ⌥A opens this picker (default true; the second picker of a form passes false). */
  hotkey?: boolean
}): AddFromState {
  const { kind, partyId, voucherId, tradeDocId, rows, setRows } = opts
  const addFrom = opts.enabled ? (opts.spec !== undefined ? opts.spec : addFromFor(kind)) : null
  const own = (r: ItemRow): boolean => !!r.source && (opts.spec === undefined || r.source.linkType === opts.spec?.linkType)
  const sourced = rows.some(own)
  const linkType: LinkType = addFrom?.linkType ?? rows.find(own)?.source?.linkType ?? 'fulfil'
  const [open, setOpen] = useState(false)
  const { data: openLines, isLoading } = useQuery({
    queryKey: ['openSourceLines', partyId, kind, linkType, voucherId ?? null, tradeDocId ?? null],
    queryFn: () =>
      api.links.openSourceLines({
        partyLedgerId: partyId!, targetKind: kind, linkType,
        ...(voucherId ? { excludeVoucherId: voucherId } : {}), ...(tradeDocId ? { excludeTradeDocId: tradeDocId } : {})
      }),
    enabled: partyId != null && (!!addFrom || sourced)
  })
  const byUid = useMemo(() => new Map((openLines ?? []).map((l) => [l.lineUid, l])), [openLines])
  const qtyInForm = (uid: string, exceptKey?: number): number =>
    rows
      .filter((r) => r.source?.lineUid === uid && r.key !== exceptKey)
      .reduce((s, r) => s + (Math.round(parseFloat(r.qtyText || '0') * 1000) || 0), 0)
  const drawerLines = (openLines ?? [])
    .map((l) => {
      const pending = l.pendingMilli - qtyInForm(l.lineUid)
      return { ...l, doneMilli: l.qtyMilli - pending, pendingMilli: pending }
    })
    .filter((l) => l.pendingMilli > 0)

  const lockedBySource = (r: ItemRow): { label: string; maxQtyMilli: number; lockDetail: boolean } | null => {
    if (!r.source) return null
    const l = byUid.get(r.source.lineUid)
    const own = Math.round(parseFloat(r.qtyText || '0') * 1000) || 0
    if (!l) return { label: 'the linked line', maxQtyMilli: own, lockDetail: false }
    return {
      label: l.label,
      maxQtyMilli: Math.max(0, l.pendingMilli - qtyInForm(l.lineUid, r.key)),
      lockDetail: sourceLocksGoods(l.kind, kind, r.source.linkType)
    }
  }
  const rowNote = (r: ItemRow): React.ReactNode => {
    if (!r.source) return null
    const l = byUid.get(r.source.lineUid)
    return (
      <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-panel2 px-1.5 text-hint text-muted" data-testid="chip-line-source">
        {r.source.linkType === 'return' ? 'against' : 'from'}{' '}
        {l ? <DocLink voucherId={l.voucherId} tradeDocId={l.tradeDocId} kind={l.kind} label={l.label.replace(/ line (\d+)$/, ' · line $1')} /> : 'a linked line'}
      </span>
    )
  }
  const insert = (picks: SourcePick[]): void => {
    const added = rowsFromSourcePicks(picks, { linkType }).map((r) => ({ ...r, key: nextLineKey() }))
    setRows((rs) => [...rs.filter((r) => r.itemId != null || r.source), ...added, blankItemRow()])
    setOpen(false)
  }
  const removeRow = (i: number): void =>
    setRows((rs) => {
      const next = rs.filter((_r, j) => j !== i)
      return next.length > 0 && next[next.length - 1]!.itemId == null ? next : [...next, blankItemRow()]
    })

  // Lines drawn from another party's order can't stay (same party, I2).
  const lastParty = useRef(partyId)
  useEffect(() => {
    if (lastParty.current === partyId) return
    lastParty.current = partyId
    setRows((rs) => {
      if (!rs.some((r) => r.source)) return rs
      const kept = rs.filter((r) => !r.source)
      return kept.length > 0 && kept[kept.length - 1]!.itemId == null ? kept : [...kept, blankItemRow()]
    })
  }, [partyId, setRows])

  const convertFrom = useRef(opts.convertFromTradeDocId ?? null)
  useEffect(() => {
    if (convertFrom.current == null || !openLines) return
    const docId = convertFrom.current
    convertFrom.current = null
    const picks = openLines.filter((l) => l.tradeDocId === docId).map((line) => ({ line, qtyMilli: line.pendingMilli }))
    if (picks.length > 0) insert(picks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLines])

  const hotkey = opts.hotkey ?? true
  useEffect(() => {
    if (!addFrom || partyId == null || !hotkey) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyA') {
        if (isAnyModalOpen()) return
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addFrom, partyId, hotkey])

  return { addFrom, open, setOpen, drawerLines, loading: isLoading, insert, lockedBySource, rowNote, removeRow }
}
