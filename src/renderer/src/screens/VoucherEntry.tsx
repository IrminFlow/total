import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { nextDraftId, useNav, useSession, useToasts, type VoucherDraft } from '../state/stores'
import { AmountInput, Button, Field, Kbd, Modal, Select, SkeletonRows } from '../components/ui'
import { isAnyModalOpen } from '../components/modalRegistry'
import { useFeatures } from '../lib/useFeatures'
import { TRADING_KINDS } from './voucher/hooks'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureEntry } from './voucher/ManufactureEntry'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'
import { MnemonicText } from '../components/MnemonicText'
import { VoucherReverseModal } from './DayBook'

const FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

const FKEY_LABELS: Partial<Record<VoucherKind, string>> = {
  contra: 'F4', payment: 'F5', receipt: 'F6', journal: 'F7', sales: 'F8', purchase: 'F9'
}

const LETTER_KEYS: Partial<Record<VoucherKind, string>> = {
  contra: 'c', payment: 'p', receipt: 'r', journal: 'j', sales: 's', purchase: 'u',
  credit_note: 'n', debit_note: 'd', stock_journal: 'k', physical_stock: 'h'
}

const PRIMARY_VOUCHER_KINDS = new Set<VoucherKind>(['contra', 'payment', 'receipt', 'journal', 'sales', 'purchase'])

/** Routes each voucher kind to its focused accounting, invoice, stock, or manufacturing editor. */
export function VoucherEntry({
  voucherId,
  kindHint,
  draft,
  workDraftId
}: {
  voucherId?: number
  kindHint?: VoucherKind
  draft?: VoucherDraft
  workDraftId?: number
}): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })
  const { data: workDraft } = useQuery({
    queryKey: ['voucher-drafts', workDraftId],
    queryFn: () => api.voucherDrafts.get(workDraftId!),
    enabled: !!workDraftId
  })
  const features = useFeatures()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [typeId, setTypeId] = useState<number | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)
  const [reverseOpen, setReverseOpen] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [compoundOpen, setCompoundOpen] = useState(false)
  const { data: comments } = useQuery({
    queryKey: ['voucher-comments', voucherId],
    queryFn: () => api.vouchers.comments(voucherId!),
    enabled: !!voucherId
  })

  // Same queryKey Gateway uses for report:dashboard — a brand-new company (no vouchers yet) gets a
  // first-time hint here; react-query dedupes the request rather than firing a second round-trip.
  const { from } = useSession()
  const today = todayISO()
  const { data: dash } = useQuery({ queryKey: ['dashboard', today, from], queryFn: ({ signal }) => api.reports.dashboard(today, from, signal) })
  const showFirstVoucherHint = !voucherId && !workDraftId && !hintDismissed && dash?.voucherCount === 0

  useEffect(() => {
    if (!types || typeId != null) return
    if (voucherId) return
    if (workDraftId && !workDraft) return
    if (workDraft) return void setTypeId(workDraft.voucherTypeId)
    const wanted = kindHint ?? 'journal'
    const t = types.find((t) => t.kind === wanted) ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId, workDraftId, workDraft])

  useEffect(() => {
    if (existing) setTypeId(existing.voucherTypeId)
  }, [existing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (voucherId || !types) return
      // Never switch voucher type underneath an open dialog (quick-create ledger, confirm…).
      if (isAnyModalOpen()) return
      const functionKind = FKEYS[e.key]
      const targetElement = e.target as HTMLElement | null
      const editable = targetElement?.matches('input, select, textarea, [contenteditable="true"]') ?? false
      // A new accounting voucher deliberately focuses its first empty ledger picker. Preserve the
      // one-letter type shortcuts at that exact starting point; once the user has typed anything
      // (or is in narration/amount fields), ordinary text entry always wins.
      const emptyFirstLedger = targetElement instanceof HTMLInputElement && targetElement.value === '' &&
        !!targetElement.closest('[data-testid="rows-voucher-lines"]')
      const letterKind = Object.entries(LETTER_KEYS).find(([, key]) => key === e.key.toLowerCase())?.[0] as VoucherKind | undefined
      if (!functionKind && (!letterKind || (editable && !emptyFirstLedger && !e.altKey) || e.metaKey || e.ctrlKey)) return
      const withNoteModifier = !!functionKind && (e.ctrlKey || e.altKey)
      const target = withNoteModifier && functionKind === 'sales'
        ? 'credit_note'
        : withNoteModifier && functionKind === 'purchase'
          ? 'debit_note'
          : (functionKind ?? letterKind)
      const t = types.find((candidate) => candidate.kind === target)
      if (t) {
        e.preventDefault()
        setTypeId(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [types, voucherId])

  if (!types || (voucherId && !existing) || (workDraftId && !workDraft)) return <p className="text-muted">Loading…</p>
  const currentType = types.find((t) => t.id === typeId) ?? types[0]!
  const invoiceMode = !voucherId && TRADING_KINDS.includes(currentType.kind)
  const manufactureMode = !voucherId && currentType.kind === 'stock_journal'
  const physicalMode = !voucherId && currentType.kind === 'physical_stock'
  const availableTypes = types.filter((type) => features.inventory || (type.kind !== 'stock_journal' && type.kind !== 'physical_stock'))
  const primaryTypes = availableTypes.filter((type) => PRIMARY_VOUCHER_KINDS.has(type.kind))
  const additionalTypes = availableTypes.filter((type) => !PRIMARY_VOUCHER_KINDS.has(type.kind))

  return (
    <div className="mx-auto max-w-4xl">
      {showFirstVoucherHint && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber/40 bg-amber/10 px-4 py-2.5">
          <p className="text-[12.5px] text-ink">
            First voucher? Choose a type or press <Kbd>F8</Kbd> for Sales, fill in the lines, then press{' '}
            <Kbd>⌘↵</Kbd> to save.
          </p>
          <button
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss"
            className="shrink-0 text-[12px] text-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[20px] font-semibold tracking-[-0.015em] whitespace-nowrap">
          {voucherId ? `Alter voucher ${existing?.number}` : workDraft ? `Resume ${workDraft.title}` : 'Voucher entry'}
        </h2>
        {voucherId && existing && <Button data-testid="btn-duplicate-voucher" className="ml-auto" disabled={!!existing.reversalOfId || !!existing.reversedById} onClick={() => {
          const partyLine = existing.lines.find((line) => line.ledgerId === existing.partyLedgerId)
          const accountLedgerId = existing.lines
            .filter((line) => line.ledgerId !== existing.partyLedgerId && (!partyLine || line.drCr !== partyLine.drCr))
            .sort((a, b) => b.amount - a.amount)[0]?.ledgerId
          nav.go({
            name: 'voucher-entry', kindHint: currentType.kind, draftId: nextDraftId(),
            draft: {
              date: todayISO(), partyLedgerId: existing.partyLedgerId, narration: existing.narration ?? '',
              lines: existing.lines.map((line) => ({ ledgerId: line.ledgerId, drCr: line.drCr, amount: line.amount, costAllocations: line.costAllocations })),
              accountLedgerId, inventory: existing.inventory.map(({ stockItemId, godownId, batchId, qtyMilli, ratePaise, discountPaise, amount, direction }) => ({ stockItemId, godownId, batchId, qtyMilli, ratePaise, discountPaise, amount, direction })),
              posOverride: existing.posOverride, currencyCode: existing.currencyCode, exchangeRate: existing.exchangeRate,
              isOptional: existing.isOptional
            }
          })
        }}>Duplicate voucher</Button>}
        {voucherId && existing && !existing.reversalOfId && !existing.reversedById && (
          <Button
            variant="danger"
            data-testid="btn-reverse-voucher"
            disabled={!!existing.tds || existing.inventory.some((line) => line.isAbsolute)}
            disabledTitle={existing.tds ? 'Use a TDS adjustment for this voucher' : 'Use a new physical stock count or stock adjustment'}
            onClick={() => setReverseOpen(true)}
          >
            Reverse…
          </Button>
        )}
        {voucherId && existing && <Button variant="ghost" onClick={() => nav.go({ name: 'task-inbox', compose: true, linkType: 'voucher', linkKey: String(voucherId) })}>Add task</Button>}
        {voucherId && existing && <Button data-testid="btn-voucher-comments" variant="ghost" onClick={() => setCommentsOpen(true)}>Comments{comments?.length ? ` ${comments.length}` : ''}</Button>}
        {voucherId && existing && <Button data-testid="btn-voucher-attachments" variant="ghost" onClick={() => setAttachmentsOpen(true)}>Evidence</Button>}
        {!voucherId && !workDraftId && <Button data-testid="btn-compound-entry" variant="ghost" onClick={() => setCompoundOpen(true)}>Guided entry…</Button>}
      </div>
      {!voucherId && (
        <div className="mb-4 flex min-w-0 items-center gap-1 overflow-visible border-y border-line bg-panel px-1 py-1" role="toolbar" aria-label="Voucher type">
          {primaryTypes.map((type) => (
            <button
              key={type.id}
              type="button"
              data-testid={`tab-voucher-entry-${type.kind}`}
              aria-current={type.id === currentType.id ? 'page' : undefined}
              aria-pressed={type.id === currentType.id}
              onClick={() => setTypeId(type.id)}
              className={`flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                type.id === currentType.id ? 'bg-amber/20 font-medium text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              <span>
                <MnemonicText label={type.name} mnemonic={LETTER_KEYS[type.kind] ?? ''} />
              </span>
              <kbd
                aria-label={`${FKEY_LABELS[type.kind]} shortcut`}
                className={`num rounded border px-1 py-px text-[9.5px] leading-none ${
                  type.id === currentType.id ? 'border-amber/40 text-amber' : 'border-line text-muted/75'
                }`}
              >
                {FKEY_LABELS[type.kind]}
              </kbd>
            </button>
          ))}
          {additionalTypes.length > 0 && (
            <details className="relative ml-auto shrink-0">
              <summary className="flex min-h-8 cursor-pointer list-none items-center rounded-md px-2.5 py-1 text-[12px] text-muted hover:bg-panel2 hover:text-ink">
                {additionalTypes.some((type) => type.id === currentType.id) ? currentType.name : 'More types'}
              </summary>
              <div className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-line bg-panel py-1 panel-shadow">
                {additionalTypes.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    data-testid={`tab-voucher-entry-${type.kind}`}
                    aria-current={type.id === currentType.id ? 'page' : undefined}
                    aria-pressed={type.id === currentType.id}
                    onClick={(event) => {
                      setTypeId(type.id)
                      event.currentTarget.closest('details')?.removeAttribute('open')
                    }}
                    className={`block min-h-8 w-full px-3 py-1.5 text-left text-[12px] ${
                      type.id === currentType.id ? 'bg-amber/20 font-medium text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
                    }`}
                  >
                    <MnemonicText label={type.name} mnemonic={LETTER_KEYS[type.kind] ?? ''} />
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {existing?.reversalOfId && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-cr/25 bg-cr/5 px-3 py-2 text-[11.5px]">
          <span>This is a linked reversal by {existing.reversalAuthor ?? 'Local user'} · {existing.reversalReason}</span>
          <Button variant="ghost" onClick={() => nav.go({ name: 'voucher-entry', voucherId: existing.reversalOfId! })}>Open original</Button>
        </div>
      )}
      {existing?.reversedById && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-line bg-panel2 px-3 py-2 text-[11.5px]">
          <span>This voucher has been reversed and is now immutable.</span>
          <Button variant="ghost" onClick={() => nav.go({ name: 'voucher-entry', voucherId: existing.reversedById! })}>Open reversal</Button>
        </div>
      )}
      {invoiceMode ? (
        <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} workDraft={workDraft ?? undefined} />
      ) : manufactureMode ? (
        <ManufactureEntry key={currentType.id} typeId={currentType.id} workDraft={workDraft ?? undefined} />
      ) : physicalMode ? (
        <PhysicalStockEntry key={currentType.id} typeId={currentType.id} workDraft={workDraft ?? undefined} />
      ) : (
        <AccountingEntry
          key={voucherId ?? currentType.id}
          typeId={currentType.id}
          kind={currentType.kind}
          voucherId={voucherId}
          draft={draft}
          workDraft={workDraft ?? undefined}
        />
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        <Kbd>F4</Kbd>-<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">y</span>
      </p>
      {reverseOpen && voucherId && (
        <VoucherReverseModal
          count={1}
          onClose={() => setReverseOpen(false)}
          onReverse={async (date, reason) => {
            try {
              const [reversal] = await api.vouchers.batchReverse([voucherId], date, reason)
              await queryClient.invalidateQueries()
              toast.push('success', 'Linked reversal created')
              setReverseOpen(false)
              if (reversal) nav.go({ name: 'voucher-entry', voucherId: reversal.id })
            } catch (err) {
              toast.push('error', err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
      {commentsOpen && voucherId && <VoucherCommentsModal voucherId={voucherId} onClose={() => setCommentsOpen(false)} />}
      {attachmentsOpen && voucherId && <VoucherAttachmentsModal voucherId={voucherId} onClose={() => setAttachmentsOpen(false)} />}
      {compoundOpen && <CompoundEntryModal onClose={() => setCompoundOpen(false)} />}
    </div>
  )
}

function VoucherAttachmentsModal({ voucherId, onClose }: { voucherId: number; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [kind, setKind] = useState<'invoice' | 'receipt' | 'email' | 'delivery' | 'other'>('invoice')
  const [adding, setAdding] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['voucher-attachments', voucherId], queryFn: () => api.vouchers.attachments(voucherId) })
  const add = async (): Promise<void> => {
    setAdding(true)
    try {
      const added = await api.vouchers.addAttachments(voucherId, kind)
      if (added.length) {
        await queryClient.invalidateQueries({ queryKey: ['voucher-attachments', voucherId] })
        toast.push('success', `${added.length} evidence file${added.length === 1 ? '' : 's'} attached`)
      }
    } catch (error) { toast.push('error', (error as Error).message) }
    finally { setAdding(false) }
  }
  return <Modal title="Voucher evidence bundle" onClose={onClose}>
    <p className="mb-3 text-[12px] leading-5 text-muted">Keep invoices, receipts, emails and delivery evidence together. Files are copied into this company’s managed attachment vault.</p>
    <div data-testid="voucher-attachment-list" className="max-h-64 overflow-y-auto rounded-md border border-line">
      {isLoading ? <div className="p-3"><SkeletonRows rows={3} /></div> : !data?.length ? <p className="px-4 py-8 text-center text-[12px] text-muted">No evidence attached</p> : data.map((item) => <button key={item.id} type="button" onClick={() => void api.vouchers.openAttachment(item.id)} className="flex w-full items-center justify-between border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-panel2"><span><span className="block text-[12.5px] text-ink">{item.originalName}</span><span className="mt-0.5 block text-[10px] capitalize text-muted">{item.kind} · {item.addedBy}</span></span><span className="num text-[10px] text-muted">{Math.max(1, Math.round(item.sizeBytes / 1024))} KB</span></button>)}
    </div>
    <div className="mt-4 flex items-end gap-2"><Field label="Evidence type"><Select data-testid="select-voucher-attachment-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="email">Email</option><option value="delivery">Delivery document</option><option value="other">Other</option></Select></Field><Button data-testid="btn-add-voucher-attachment" variant="primary" disabled={adding} onClick={() => void add()}>{adding ? 'Adding…' : 'Choose files…'}</Button></div>
  </Modal>
}

const COMPOUND_PRESETS = {
  asset_purchase: { label: 'Asset purchase', kind: 'journal' as VoucherKind, main: 'Asset ledger', extra: 'Input tax / expense', counter: 'Bank or payable' },
  loan_repayment: { label: 'Loan repayment', kind: 'payment' as VoucherKind, main: 'Loan principal', extra: 'Interest expense', counter: 'Bank ledger' },
  import_purchase: { label: 'Import purchase', kind: 'purchase' as VoucherKind, main: 'Import purchases', extra: 'Duty / landed cost', counter: 'Supplier payable' },
  advance_adjustment: { label: 'Advance adjustment', kind: 'journal' as VoucherKind, main: 'Customer advance', extra: 'Adjustment / tax', counter: 'Revenue ledger' },
}

function CompoundEntryModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const [presetKey, setPresetKey] = useState<keyof typeof COMPOUND_PRESETS>('asset_purchase')
  const [mainLedgerId, setMainLedgerId] = useState(0)
  const [extraLedgerId, setExtraLedgerId] = useState(0)
  const [counterLedgerId, setCounterLedgerId] = useState(0)
  const [mainAmount, setMainAmount] = useState<number | null>(null)
  const [extraAmount, setExtraAmount] = useState<number | null>(null)
  const preset = COMPOUND_PRESETS[presetKey]
  const build = (): void => {
    const extra = extraAmount ?? 0
    if (!mainLedgerId || !counterLedgerId || !mainAmount || (extra > 0 && !extraLedgerId)) return void toast.push('warning', 'Choose the required ledgers and enter the amounts')
    const lines = [
      { ledgerId: mainLedgerId, drCr: 'dr' as const, amount: mainAmount, costAllocations: [] },
      ...(extra > 0 ? [{ ledgerId: extraLedgerId, drCr: 'dr' as const, amount: extra, costAllocations: [] }] : []),
      { ledgerId: counterLedgerId, drCr: 'cr' as const, amount: mainAmount + extra, costAllocations: [] },
    ]
    nav.go({ name: 'voucher-entry', kindHint: preset.kind, draftId: nextDraftId(), draft: { date: todayISO(), narration: preset.label, lines } })
    onClose()
  }
  const ledgerOptions = <>{<option value={0}>Choose ledger…</option>}{ledgers?.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.name}</option>)}</>
  return <Modal title="Compound entry assistant" onClose={onClose}>
    <p className="mb-4 text-[12px] leading-5 text-muted">Build a balanced, editable starting entry. Nothing posts until the normal validation and approval flow succeeds.</p>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Workflow"><Select data-testid="select-compound-preset" value={presetKey} onChange={(event) => setPresetKey(event.target.value as keyof typeof COMPOUND_PRESETS)}>{Object.entries(COMPOUND_PRESETS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</Select></Field><div />
      <Field label={preset.main}><Select value={mainLedgerId} onChange={(event) => setMainLedgerId(Number(event.target.value))}>{ledgerOptions}</Select></Field><Field label="Principal / base amount"><AmountInput paise={mainAmount} onPaise={setMainAmount} /></Field>
      <Field label={preset.extra}><Select value={extraLedgerId} onChange={(event) => setExtraLedgerId(Number(event.target.value))}>{ledgerOptions}</Select></Field><Field label="Additional amount (optional)"><AmountInput paise={extraAmount} onPaise={setExtraAmount} /></Field>
      <Field label={preset.counter}><Select value={counterLedgerId} onChange={(event) => setCounterLedgerId(Number(event.target.value))}>{ledgerOptions}</Select></Field><div className="self-end rounded-md border border-line bg-panel2 px-3 py-2 text-[11px] text-muted">Credit total: <span className="num text-ink">₹{(((mainAmount ?? 0) + (extraAmount ?? 0)) / 100).toFixed(2)}</span></div>
    </div>
    <div className="mt-5 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button data-testid="btn-build-compound-entry" variant="primary" onClick={build}>Build editable entry</Button></div>
  </Modal>
}

function VoucherCommentsModal({ voucherId, onClose }: { voucherId: number; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['voucher-comments', voucherId], queryFn: () => api.vouchers.comments(voucherId) })

  const add = async (): Promise<void> => {
    if (!body.trim() || saving) return
    setSaving(true)
    try {
      await api.vouchers.addComment(voucherId, body)
      setBody('')
      await queryClient.invalidateQueries({ queryKey: ['voucher-comments', voucherId] })
      toast.push('success', 'Comment added')
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return <Modal title="Voucher comments" onClose={onClose}>
    <p className="mb-3 text-[12px] leading-5 text-muted">Review notes stay separate from the printed narration. Existing comments cannot be rewritten.</p>
    <div data-testid="voucher-comment-list" className="max-h-64 overflow-y-auto rounded-md border border-line">
      {isLoading ? <div className="p-3"><SkeletonRows rows={3} /></div> : !data?.length ? <p className="px-4 py-8 text-center text-[12px] text-muted">No comments yet</p> : data.map((comment) => <div key={comment.id} className="border-b border-line px-3 py-2.5 last:border-0"><p className="whitespace-pre-wrap text-[12.5px] leading-5 text-ink">{comment.body}</p><p className="num mt-1 text-[10px] text-muted">{comment.createdBy} · {new Date(`${comment.createdAt}Z`).toLocaleString()}</p></div>)}
    </div>
    <label className="mt-4 block"><span className="mb-1 block text-[11px] font-medium text-muted">Add review note</span><textarea data-testid="input-voucher-comment" value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} rows={3} placeholder="Question, evidence needed, or review context" className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-[12.5px] leading-5 text-ink placeholder:text-muted/65" /></label>
    <div className="mt-3 flex items-center justify-between"><span className="num text-[10px] text-muted">{body.length}/2,000</span><div className="flex gap-2"><Button onClick={onClose}>Close</Button><Button data-testid="btn-add-voucher-comment" variant="primary" disabled={!body.trim() || saving} onClick={() => void add()}>{saving ? 'Adding…' : 'Add comment'}</Button></div></div>
  </Modal>
}
