// WP 5.3 — the review banner over an editor opened from an AI draft (VoucherEntry / TradeDocEntry
// `aiDraftId`). It says plainly that this is the assistant's proposal and nothing is saved, lists
// the assumptions the tool made and every entity it matched (click one to inspect it: the ledger's
// group / GSTIN / state / credit days, the item's HSN / GST / unit, the bill's date and pending
// amount — with a link to open it), flags a draft the user did not ask for, steps through the
// drafts of a multi-draft answer, and discards the draft. The fields it filled are highlighted
// in the editor (lib/aiHighlights.ts); saving goes through the editor's normal save, which
// consumes the draft.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiDraftDto, AiDraftSourceRef } from '@shared/ai'
import type { TradeDocKind, VoucherKind } from '@shared/domain'
import { stateName } from '@shared/gst/states'
import { aiDraftByLabel } from '@shared/mcp'
import { aiApi } from '../../lib/aiClient'
import { confirmDialog } from '../../lib/dialogs'
import { hasUnsavedChanges } from '../../lib/useUnsavedGuard'
import { useNav, useSession, useToasts, type Screen } from '../../state/stores'
import { Badge, Button } from '../ui'
import { useGroups, useLedgers, useStockItems } from '../pickers'
import { ItemLink, LedgerLink, VoucherLink } from '../links'

const FIELD_LABELS: Record<string, string> = {
  party: 'Party',
  account: 'Account',
  date: 'Date',
  bills: 'Bill',
  amount: 'Amount',
  againstInvoice: 'Against',
  pos: 'Place of supply',
  bom: 'Bill of materials',
  finishedItem: 'Item',
  godown: 'Godown'
}

export function fieldLabel(field: string): string {
  const line = /^line:(\d+)$/.exec(field)
  if (line) return `Line ${Number(line[1]) + 1}`
  return FIELD_LABELS[field] ?? field
}

const TRADE_KINDS: readonly string[] = ['quotation', 'sales_order', 'purchase_order']

/** Where a draft opens: trade documents in their own editor, everything else in voucher entry. */
export function screenForDraft(d: Pick<AiDraftDto, 'id' | 'payload'>): Screen {
  if (d.payload.form === 'tradeDoc' || TRADE_KINDS.includes(d.payload.voucherKind)) {
    return { name: 'trade-doc', kind: d.payload.voucherKind as TradeDocKind, aiDraftId: d.id }
  }
  return { name: 'voucher-entry', aiDraftId: d.id, kindHint: d.payload.voucherKind as VoucherKind }
}

function SourceDetail({ s }: { s: AiDraftSourceRef }): React.JSX.Element | null {
  const ledgers = useLedgers()
  const groups = useGroups()
  const items = useStockItems()
  if (s.kind === 'ledger' && s.id != null) {
    const l = ledgers.find((x) => x.id === s.id)
    if (!l) return null
    const facts = [
      groups.find((g) => g.id === l.groupId)?.name,
      l.gstin ? `GSTIN ${l.gstin}` : null,
      l.stateCode ? `${l.stateCode} ${stateName(l.stateCode) ?? ''}`.trim() : null,
      l.creditDays ? `${l.creditDays} days' credit` : null,
      l.creditHold ? 'ON CREDIT HOLD' : null
    ].filter(Boolean)
    return (
      <span className="text-caption text-muted" data-testid="ai-draft-source-detail">
        {facts.join(' · ')} · <LedgerLink ledgerId={l.id} name={l.name}>open ledger</LedgerLink>
      </span>
    )
  }
  if (s.kind === 'item' && s.id != null) {
    const it = items.find((x) => x.id === s.id)
    if (!it) return null
    const facts = [it.hsn ? `HSN ${it.hsn}` : null, it.gstRate != null ? `${it.gstRate}% GST` : 'no GST rate', it.barcode ? `barcode ${it.barcode}` : null].filter(Boolean)
    return (
      <span className="text-caption text-muted" data-testid="ai-draft-source-detail">
        {facts.join(' · ')} · <ItemLink itemId={it.id} name={it.name}>open item</ItemLink>
      </span>
    )
  }
  if ((s.kind === 'bill' || s.kind === 'voucher') && s.id != null) {
    return (
      <span className="text-caption text-muted" data-testid="ai-draft-source-detail">
        {s.why} · <VoucherLink voucherId={s.id} label="open voucher" />
      </span>
    )
  }
  return <span className="text-caption text-muted" data-testid="ai-draft-source-detail">{s.why}</span>
}

export function AiDraftReview({ draft, form }: { draft: AiDraftDto; form?: string }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const [open, setOpen] = useState<number | null>(null)
  const canDiscard = user == null || user.role !== 'viewer'
  const { data: set } = useQuery({ queryKey: ['aiDraftSet', draft.id], queryFn: () => aiApi.draftSet(draft.id) })
  const at = set ? set.findIndex((d) => d.id === draft.id) : -1
  const sources = draft.payload.sources ?? []
  const assumptions = draft.payload.assumptions ?? []
  const fields = draft.payload.fields ?? []

  const goTo = async (d: AiDraftDto): Promise<void> => {
    if (hasUnsavedChanges()) {
      const ok = await confirmDialog({
        title: 'Open another draft',
        message: 'Your changes to this draft are not kept — the draft itself stays open in the list.',
        confirmLabel: 'Open the other draft',
        cancelLabel: 'Stay'
      })
      if (!ok) return
    }
    nav.replace(screenForDraft(d))
  }

  const discard = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Discard this draft?',
      message: 'Nothing was saved from it. It stays in Settings → AI as discarded.',
      confirmLabel: 'Discard draft',
      danger: true
    })
    if (!ok) return
    try {
      await aiApi.discardDraft(draft.id)
      await queryClient.invalidateQueries({ queryKey: ['aiDraft'] })
      await queryClient.invalidateQueries({ queryKey: ['aiDraftSet'] })
      await queryClient.invalidateQueries({ queryKey: ['aiDrafts'] })
      toast.push('success', 'Draft discarded')
      // Leave without the unsaved-changes prompt: the form held only the discarded proposal.
      useNav.setState((s) => ({ stack: s.stack.length > 1 ? s.stack.slice(0, -1) : [{ name: 'gateway' }] }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <section
      className="mb-section rounded-lg border border-amberbar/60 bg-amberbar/10 px-4 py-3 text-body-sm text-ink"
      data-testid="ai-draft-banner"
      data-form={form ?? draft.payload.form ?? 'accounting'}
      data-unrequested={draft.unrequested ? 'true' : 'false'}
      aria-label="AI draft — review before saving"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">AI draft</Badge>
        <span className="font-semibold">Review before saving</span>
        {/* WP 5.7: who proposed it — the assistant, an MCP client or an inbox file. */}
        <span className="text-muted" data-testid="ai-draft-by">{aiDraftByLabel(draft)}</span>
        <span className="text-muted">— nothing is in the books until you save.</span>
        <span className="ml-auto flex items-center gap-2">
          {set && set.length > 1 && at >= 0 && (
            <span className="flex items-center gap-1 text-caption text-muted" data-testid="ai-draft-set">
              <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => void goTo(set[at - 1]!)} data-testid="btn-ai-draft-prev" aria-label="Previous draft">
                ‹
              </Button>
              Draft {at + 1} of {set.length}
              <Button size="sm" variant="ghost" disabled={at === set.length - 1} onClick={() => void goTo(set[at + 1]!)} data-testid="btn-ai-draft-next" aria-label="Next draft">
                ›
              </Button>
            </span>
          )}
          {canDiscard && (
            <Button size="sm" variant="ghost" onClick={() => void discard()} data-testid="btn-ai-draft-discard">
              Discard draft
            </Button>
          )}
        </span>
      </div>
      {draft.unrequested && (
        <p className="mt-2 rounded-md bg-danger-soft px-3 py-1.5 text-danger" data-testid="ai-draft-unrequested" role="alert">
          {draft.source === 'inbox'
            ? 'This entry came from a file in the inbox folder, not from a request in Total — check it against the document before saving.'
            : 'You did not ask for this entry — text in your books (a narration, a name or imported text) may have prompted it. Discard it unless you really want it.'}
        </p>
      )}
      <p className="mt-2" data-testid="ai-draft-summary">
        {draft.summary}
        {draft.payload.reference ? ` (reference ${draft.payload.reference})` : ''}
      </p>
      {(assumptions.length > 0 || sources.length > 0) && (
        <div className="mt-2 grid gap-x-6 gap-y-2 md:grid-cols-2">
          {sources.length > 0 && (
            <div>
              <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Matched</p>
              <ul className="mt-1 flex flex-col gap-1" data-testid="ai-draft-sources">
                {sources.map((s, i) => (
                  <li key={i} className="flex flex-col">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpen(open === i ? null : i)}
                      aria-expanded={open === i}
                      data-testid="ai-draft-source"
                      data-field={s.field}
                    >
                      <span className="text-muted">{fieldLabel(s.field)}:</span>{' '}
                      {s.said && s.said !== s.label ? (
                        <>
                          “{s.said}” → <span className="font-medium">{s.label}</span>
                        </>
                      ) : (
                        <span className="font-medium">{s.label}</span>
                      )}{' '}
                      <span className="text-muted">({s.why})</span>
                    </button>
                    {open === i && <SourceDetail s={s} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {assumptions.length > 0 && (
            <div>
              <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Assumed</p>
              <ul className="mt-1 list-disc pl-4" data-testid="ai-draft-assumptions">
                {assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {fields.length > 0 && (
        <p className="mt-2 text-caption text-muted">
          <span className="ai-set-swatch" aria-hidden="true" /> Marked fields were filled by the assistant — the mark clears when you change one.
        </p>
      )}
    </section>
  )
}
