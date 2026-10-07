// Drill-down links (WP 1.8). Every name of a ledger, stock item or voucher on a report renders
// through one of these, so a click on the NAME always means the same thing:
//   LedgerLink → the ledger's edit window (its statement for read-only users)
//   ItemLink   → the stock item editor
//   VoucherLink → the voucher in voucher entry
// A link swallows its own click and Enter/Space, so the row underneath (whose click opens the
// ledger statement, the voucher, an expansion…) never fires as well.
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { TradeDocKind } from '@shared/domain'
import { isRealId, openItemEdit, openLedgerEdit, openVoucher, useCanEditMasters } from '../lib/drill'
import { useNav } from '../state/stores'
import { useLedgers } from './pickers'

const LINK_CLS =
  'drill-link max-w-full cursor-pointer truncate text-left align-baseline decoration-muted/70 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none'

function stop(e: MouseEvent | KeyboardEvent): void {
  e.stopPropagation()
}

interface LinkButtonProps {
  label: ReactNode
  title: string
  onOpen: () => void
  className?: string
  attrs: Record<string, string | number>
}

function LinkButton({ label, title, onOpen, className, attrs }: LinkButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      className={`${LINK_CLS} ${className ?? ''}`}
      {...attrs}
      onClick={(e) => {
        stop(e)
        onOpen()
      }}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        // Lists listen for Enter on window (useKeyNav) — keep this key from also activating the row.
        e.preventDefault()
        stop(e)
        onOpen()
      }}
    >
      {label}
    </button>
  )
}

/** A ledger's name. Click / Enter / Space → edit window (read-only users: the statement).
 *  Synthetic ledgers (id <= 0) render as plain text. `children` overrides the shown label
 *  (e.g. search highlighting); `name` stays the accessible text and tooltip subject. */
export function LedgerLink({
  ledgerId,
  name,
  children,
  className
}: {
  ledgerId: number | null | undefined
  name: string
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  const canEdit = useCanEditMasters()
  if (!isRealId(ledgerId)) return <>{children ?? name}</>
  return (
    <LinkButton
      label={children ?? name}
      title={canEdit ? `Edit ledger ${name}` : `Open ${name} statement`}
      className={className}
      attrs={{ 'data-ledger-link': ledgerId, 'data-testid': 'ledger-link', 'aria-label': canEdit ? `Edit ledger ${name}` : `Open ${name} statement` }}
      onOpen={() => openLedgerEdit(ledgerId)}
    />
  )
}

/** A summary like "Purchase A/c,CGST Input,SGST Input" whose FIRST name is `ledgerId`: only that
 *  name links; the rest stays plain text. Falls back to linking the whole text when the summary
 *  doesn't start with the ledger's current name (e.g. the ledger list hasn't loaded yet). */
export function FirstLedgerLink({ ledgerId, text }: { ledgerId: number | null | undefined; text: string }): React.JSX.Element {
  const ledgers = useLedgers()
  const first = isRealId(ledgerId) ? ledgers.find((l) => l.id === ledgerId)?.name : undefined
  if (first && text !== first && text.startsWith(first + ',')) {
    return (
      <>
        <LedgerLink ledgerId={ledgerId} name={first} />
        <span className="text-muted">{text.slice(first.length)}</span>
      </>
    )
  }
  return <LedgerLink ledgerId={ledgerId} name={text} />
}

/** A stock item's name → its editor. Read-only users see plain text (there is no item view). */
export function ItemLink({
  itemId,
  name,
  children,
  className
}: {
  itemId: number | null | undefined
  name: string
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  const canEdit = useCanEditMasters()
  if (!isRealId(itemId) || !canEdit) return <>{children ?? name}</>
  return (
    <LinkButton
      label={children ?? name}
      title={`Edit item ${name}`}
      className={className}
      attrs={{ 'data-item-link': itemId, 'data-testid': 'item-link', 'aria-label': `Edit item ${name}` }}
      onOpen={() => openItemEdit(itemId)}
    />
  )
}

/** A voucher's number/label → voucher entry (the same place a voucher row opens). */
export function VoucherLink({
  voucherId,
  label,
  className
}: {
  voucherId: number | null | undefined
  label: ReactNode
  className?: string
}): React.JSX.Element {
  if (!isRealId(voucherId)) return <>{label}</>
  return (
    <LinkButton
      label={label}
      title="Open voucher"
      className={className}
      attrs={{ 'data-voucher-link': voucherId, 'data-testid': 'voucher-link' }}
      onOpen={() => openVoucher(voucherId)}
    />
  )
}

/** A quotation / order's number → its entry form (WP 2.5c). `kind` picks the form's title. */
export function TradeDocLink({
  tradeDocId,
  kind,
  label,
  className
}: {
  tradeDocId: number | null | undefined
  kind: TradeDocKind
  label: ReactNode
  className?: string
}): React.JSX.Element {
  if (!isRealId(tradeDocId)) return <>{label}</>
  return (
    <LinkButton
      label={label}
      title="Open document"
      className={className}
      attrs={{ 'data-trade-doc-link': tradeDocId, 'data-testid': 'trade-doc-link' }}
      onOpen={() => useNav.getState().go({ name: 'trade-doc', kind, id: tradeDocId })}
    />
  )
}

/** A source / linked document of either class: a voucher or a trade doc. */
export function DocLink({
  voucherId,
  tradeDocId,
  kind,
  label
}: {
  voucherId: number | null
  tradeDocId: number | null
  kind: string
  label: ReactNode
}): React.JSX.Element {
  if (tradeDocId != null && (kind === 'quotation' || kind === 'sales_order' || kind === 'purchase_order')) {
    return <TradeDocLink tradeDocId={tradeDocId} kind={kind} label={label} />
  }
  return <VoucherLink voucherId={voucherId} label={label} />
}

/** Props that turn a plain (non-DataTable) list row into a drill row: click or Enter opens the
 *  ledger statement, and ⌘E finds the ledger through `data-drill-ledger`. Put a LedgerLink on the
 *  name inside it. Not a <button> — a button can't contain the link button. */
export function drillRowProps(onActivate: () => void, ledgerId?: number): {
  role: 'button'
  tabIndex: 0
  onClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
  'data-drill-row': ''
  'data-drill-ledger'?: number
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
    'data-drill-row': '',
    ...(isRealId(ledgerId) ? { 'data-drill-ledger': ledgerId } : {})
  }
}
