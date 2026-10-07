// "Linked documents" (WP 2.5d, design §5.2): the whole chain of documents around one voucher or
// quotation / order — quotation → sales order → challans → invoices → credit notes, purchase order
// → GRNs → bills → debit notes, rejection notes — as columns left to right, each document a card
// (number link, date, party, status, quantities drawn / returned per line), then every link in a
// table. Hosted once (LinkedDocsHost in App) and opened through `openLinkedDocs` from the entry
// screens, the Day book, search results and the order lists; ⌥L on an entry screen.
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import type { ChainEdge, ChainNode, ChainNodeStatus } from '@shared/tradeCycle/types'
import type { TradeSideKind } from '@shared/tradeCycle/rules'
import { isTradeDocKind } from '@shared/tradeCycle/rules'
import { tradeStatusLabel } from '@shared/tradeCycle/edit'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { Badge, Banner, Button, Drawer, Kbd, Spinner } from './ui'
import type { BadgeTone } from './kit/Badge'
import { isAnyModalOpen } from './kit/layers'
import { DocLink, LedgerLink } from './links'
import { DataTable, defineColumns } from './table'

export type LinkedDocsTarget = { voucherId: number } | { tradeDocId: number }

interface LinkedDocsState {
  target: LinkedDocsTarget | null
  open: (t: LinkedDocsTarget) => void
  close: () => void
}

export const useLinkedDocs = create<LinkedDocsState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}))

export const openLinkedDocs = (t: LinkedDocsTarget): void => useLinkedDocs.getState().open(t)

/** Voucher kinds that can carry line links (anything else has no chain). */
export const LINKABLE_VOUCHER_KINDS: ReadonlySet<string> = new Set<VoucherKind>([
  'sales', 'purchase', 'credit_note', 'debit_note', 'delivery_note', 'receipt_note'
])

const NOTE_WORDS: Partial<Record<TradeSideKind, { done: string; part: string; none: string }>> = {
  delivery_note: { done: 'Invoiced', part: 'Partly invoiced', none: 'Not invoiced' },
  receipt_note: { done: 'Billed', part: 'Partly billed', none: 'Not billed' }
}

export function chainStatusLabel(kind: TradeSideKind, status: ChainNodeStatus): string {
  if (status === 'binned') return 'In the bin'
  if (status === 'optional') return 'Optional'
  if (status === 'posted') return 'Posted'
  if (status === 'partly_returned') return 'Partly returned'
  if (status === 'returned') return 'Returned'
  if (isTradeDocKind(kind)) return tradeStatusLabel(kind, status)
  const w = NOTE_WORDS[kind]
  if (w) return status === 'fulfilled' ? w.done : status === 'partly_fulfilled' ? w.part : status === 'closed' ? 'Short-closed' : w.none
  return status
}

const TONE: Record<ChainNodeStatus, BadgeTone> = {
  open: 'info', expired: 'warning', partly_fulfilled: 'amber', fulfilled: 'success', closed: 'neutral', cancelled: 'danger',
  posted: 'success', partly_returned: 'amber', returned: 'warning', binned: 'neutral', optional: 'neutral'
}

const KIND_PLURAL: Record<TradeSideKind, string> = {
  quotation: 'Quotations', sales_order: 'Sales orders', purchase_order: 'Purchase orders', delivery_note: 'Delivery challans',
  receipt_note: 'Goods receipts', sales: 'Sales invoices', purchase: 'Purchase bills', credit_note: 'Credit notes', debit_note: 'Debit notes',
  contra: 'Contra', payment: 'Payments', receipt: 'Receipts', journal: 'Journals', stock_journal: 'Stock journals', physical_stock: 'Physical stock'
}

/** "Delivered / invoiced / returned" wording for a link, by its target. */
function edgeVerb(e: ChainEdge, to: ChainNode | undefined): string {
  if (e.linkType === 'return') return 'returned'
  switch (to?.kind) {
    case 'sales_order': return 'ordered'
    case 'delivery_note': return 'delivered'
    case 'receipt_note': return 'received'
    case 'sales': return 'invoiced'
    case 'purchase': return 'billed'
    default: return 'drawn'
  }
}

function NodeCard({ n, onNavigate }: { n: ChainNode; onNavigate: () => void }): React.JSX.Element {
  return (
    <div
      className={`rounded-md border bg-panel px-2.5 py-2 text-detail ${n.isRoot ? 'border-amberbar shadow-[inset_3px_0_0_var(--t-amber-bar)]' : 'border-line'} ${n.live ? '' : 'opacity-70'}`}
      data-testid="chain-node"
      data-key={n.key}
      data-kind={n.kind}
      data-status={n.status}
      data-root={n.isRoot ? 'true' : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium" onClickCapture={onNavigate}>
          <DocLink voucherId={n.voucherId} tradeDocId={n.tradeDocId} kind={n.kind} label={n.label} />
        </span>
        <span className="num shrink-0 text-hint text-muted">{toDisplayDate(n.date)}</span>
      </div>
      {n.partyName && (
        <div className="truncate text-hint text-muted" onClickCapture={onNavigate}>
          {n.partyLedgerId ? <LedgerLink ledgerId={n.partyLedgerId} name={n.partyName} /> : n.partyName}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        <Badge tone={TONE[n.status]} testId="chain-node-status">{chainStatusLabel(n.kind, n.status)}</Badge>
        <span className="num text-hint text-muted">{formatPaise(n.value, { symbol: true })}</span>
      </div>
      {n.closeReason && <div className="mt-1 truncate text-hint text-muted" title={n.closeReason}>“{n.closeReason}”</div>}
      <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5">
        {n.lines.map((l) => (
          <li key={l.lineUid} className="flex items-baseline justify-between gap-2 text-hint" data-testid="chain-line">
            <span className="min-w-0 truncate">{l.itemName}</span>
            <span className="num shrink-0 text-muted">
              {formatQtyMilli(l.qtyMilli)}
              {l.fulfilledMilli > 0 && <> · <span className="text-ink">{formatQtyMilli(l.fulfilledMilli)} on</span></>}
              {l.returnedMilli > 0 && <> · <span className="text-cr">{formatQtyMilli(l.returnedMilli)} back</span></>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface EdgeRow extends ChainEdge {
  fromLabel: string
  toLabel: string
  fromNode: ChainNode | undefined
  toNode: ChainNode | undefined
  verb: string
}

export function LinkedDocsDrawer({ target, onClose }: { target: LinkedDocsTarget; onClose: () => void }): React.JSX.Element {
  const key = 'voucherId' in target ? `v${target.voucherId}` : `d${target.tradeDocId}`
  const { data, isLoading, error } = useQuery({ queryKey: ['tradeChain', key], queryFn: () => api.trade.chain(target) })
  const nodes = useMemo(() => data?.nodes ?? [], [data])
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes])
  const levels = useMemo(() => {
    const m = new Map<number, ChainNode[]>()
    for (const n of nodes) m.set(n.level, [...(m.get(n.level) ?? []), n])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [nodes])
  const edges: EdgeRow[] = useMemo(
    () =>
      (data?.edges ?? []).map((e) => {
        const fromNode = byKey.get(e.from)
        const toNode = byKey.get(e.to)
        return { ...e, fromNode, toNode, fromLabel: fromNode?.label ?? e.from, toLabel: toNode?.label ?? e.to, verb: edgeVerb(e, toNode) }
      }),
    [data, byKey]
  )
  const columns = useMemo(
    () =>
      defineColumns<EdgeRow>([
        {
          id: 'from', header: 'From', kind: 'text', value: (r) => r.fromLabel, minWidth: 150,
          cell: (r) => (r.fromNode ? <span onClickCapture={onClose}><DocLink voucherId={r.fromNode.voucherId} tradeDocId={r.fromNode.tradeDocId} kind={r.fromNode.kind} label={r.fromLabel} /></span> : r.fromLabel)
        },
        {
          id: 'to', header: 'To', kind: 'text', value: (r) => r.toLabel, minWidth: 150,
          cell: (r) => (r.toNode ? <span onClickCapture={onClose}><DocLink voucherId={r.toNode.voucherId} tradeDocId={r.toNode.tradeDocId} kind={r.toNode.kind} label={r.toLabel} /></span> : r.toLabel)
        },
        { id: 'verb', header: 'Link', kind: 'text', value: (r) => r.verb, width: 96 },
        { id: 'qty', header: 'Quantity', kind: 'quantity', value: (r) => r.qtyMilli, width: 96 },
        { id: 'lines', header: 'Lines', kind: 'number', value: (r) => r.lines, width: 64, defaultHidden: true },
        {
          id: 'live', header: 'Counts', kind: 'text', value: (r) => (r.live ? 'Yes' : 'No'), width: 80,
          cell: (r) => (r.live ? <span className="text-muted">Yes</span> : <Badge tone="neutral">Dormant</Badge>)
        }
      ]),
    [onClose]
  )
  const root = nodes.find((n) => n.isRoot)
  return (
    <Drawer
      title="Linked documents"
      subtitle={root ? `${root.label} · ${nodes.length} document${nodes.length === 1 ? '' : 's'} in the chain` : undefined}
      onClose={onClose}
      width={Math.min(1180, Math.max(560, levels.length * 236 + 64))}
      testId="drawer-linked-docs"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {isLoading && <Spinner />}
      {error && <Banner tone="danger">{(error as Error).message}</Banner>}
      {data && nodes.length <= 1 && (
        <p className="text-detail text-muted" data-testid="linked-docs-none">
          Nothing is linked to {root?.label ?? 'this document'} yet. Lines drawn with “Add from…” (<Kbd>⌥A</Kbd>) — an order into a challan or
          invoice, an invoice into a credit note — show here.
        </p>
      )}
      {data?.truncated && (
        <Banner tone="warning" className="mb-3">Only the first {nodes.length} documents of a very large chain are shown.</Banner>
      )}
      {nodes.length > 1 && (
        <>
          <div className="flex items-start gap-2 overflow-x-auto pb-2" data-testid="chain-levels">
            {levels.map(([lv, ns], i) => (
              <div key={lv} className="flex items-start gap-2">
                {i > 0 && <span aria-hidden="true" className="pt-7 text-muted">→</span>}
                <section className="flex w-[212px] shrink-0 flex-col gap-2" data-testid="chain-level" aria-label={[...new Set(ns.map((n) => KIND_PLURAL[n.kind]))].join(', ')}>
                  <h3 className="truncate text-label font-semibold tracking-[0.08em] text-muted uppercase">
                    {[...new Set(ns.map((n) => KIND_PLURAL[n.kind]))].join(' · ')}
                  </h3>
                  {ns.map((n) => <NodeCard key={n.key} n={n} onNavigate={onClose} />)}
                </section>
              </div>
            ))}
          </div>
          <h3 className="mt-4 mb-2 text-label font-semibold tracking-[0.08em] text-muted uppercase">Links</h3>
          <DataTable
            testId="chain-edges"
            ariaLabel="Links between the documents"
            columns={columns}
            rows={edges}
            rowKey={(r) => `${r.from}>${r.to}:${r.linkType}`}
            rowAttrs={(r) => ({ 'data-link-type': r.linkType })}
            toolbar={false}
            maxHeight="40vh"
          />
          <p className="mt-2 text-hint text-muted">
            “on” = drawn on by the next document · “back” = returned. Dormant links belong to a binned, cancelled or optional document and
            don&apos;t count against what is pending.
          </p>
        </>
      )}
    </Drawer>
  )
}

/** Mounted once in App. */
export function LinkedDocsHost(): React.JSX.Element | null {
  const { target, close } = useLinkedDocs()
  return target ? <LinkedDocsDrawer target={target} onClose={close} /> : null
}

/** The header button on an entry screen (an alteration of a linkable voucher, a saved order);
 *  ⌥L opens it too. */
export function LinkedDocsButton({ target }: { target: LinkedDocsTarget }): React.JSX.Element {
  const id = 'voucherId' in target ? target.voucherId : target.tradeDocId
  const isVoucher = 'voucherId' in target
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyL') {
        if (isAnyModalOpen()) return
        e.preventDefault()
        openLinkedDocs(isVoucher ? { voucherId: id } : { tradeDocId: id })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, isVoucher])
  return (
    <Button data-testid="btn-linked-docs" title="Linked documents (⌥L)" onClick={() => openLinkedDocs(target)}>
      Linked documents <Kbd>⌥L</Kbd>
    </Button>
  )
}
