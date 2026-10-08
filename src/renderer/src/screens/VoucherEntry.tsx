import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { STOCK_NOTE_KINDS, type VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { modeForKind, planVoucherEdit, taxLedgerIdsFrom, type EditPlan } from '@shared/voucherEdit'
import { api } from '../lib/client'
import { aiApi } from '../lib/aiClient'
import { aiDraftByLabel } from '@shared/mcp'
import { useSession, type VoucherDraft } from '../state/stores'
import { AttachmentsButton } from '../components/attachments/Attachments'
import { Banner, DrawerSection, isAnyModalOpen, Kbd, Page, PageHeader, Panel, SkeletonRows } from '../components/ui'
import { OptionToggle, useScreenOptions } from '../components/ScreenOptions'
import { useFeatures } from '../lib/useFeatures'
import { isManufactureKey, kindForVoucherKey } from '../lib/voucherKeys'
import { LINKABLE_VOUCHER_KINDS, LinkedDocsButton } from '../components/LinkedDocs'
import { InvoiceEntry } from './voucher/InvoiceEntry'
import { PricingOptions } from './voucher/PricingOptions'
import { AccountingEntry } from './voucher/AccountingEntry'
import { ManufactureForm } from './Manufacture'
import { PhysicalStockEntry } from './voucher/PhysicalStockEntry'
import { StockLinesEntry } from './voucher/StockLinesEntry'
import { StockNoteEntry } from './voucher/StockNoteEntry'
import { LineDetailOption } from './voucher/LineStockDetail'
import { StockJournalEntry, TransferEntry } from './StockJournal'


/** Voucher types in list order, except that challan / GRN types (migration 024 gave them the
 *  lowest ids) sit right after the last debit-note type. */
function tabOrder<T extends { kind: VoucherKind }>(types: readonly T[]): T[] {
  const notes = types.filter((t) => STOCK_NOTE_KINDS.includes(t.kind))
  const rest = types.filter((t) => !STOCK_NOTE_KINDS.includes(t.kind))
  const at = rest.map((t) => t.kind).lastIndexOf('debit_note')
  return at < 0 ? [...rest, ...notes] : [...rest.slice(0, at + 1), ...notes, ...rest.slice(at + 1)]
}

export function VoucherEntry({
  voucherId,
  kindHint,
  draft: draftProp,
  aiDraftId
}: {
  voucherId?: number
  kindHint?: VoucherKind
  draft?: VoucherDraft
  /** WP 5.1: pre-fill from this AI draft (ai_drafts.id); saving marks it consumed. */
  aiDraftId?: number
}): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })
  const features = useFeatures()
  // An AI draft becomes an ordinary VoucherDraft prefill — the entry modes don't know where it
  // came from; only the save carries aiDraftId back so main can mark the draft consumed.
  const { data: aiDraft, error: aiDraftError } = useQuery({
    queryKey: ['aiDraft', aiDraftId],
    queryFn: () => aiApi.draft(aiDraftId!),
    enabled: !!aiDraftId && !voucherId
  })
  const aiDraftOpen = aiDraft?.status === 'open'
  const draft: VoucherDraft | undefined =
    aiDraft && aiDraftOpen
      ? {
          date: aiDraft.payload.date,
          partyLedgerId: aiDraft.payload.partyLedgerId ?? undefined,
          narration: aiDraft.payload.narration ?? undefined,
          reference: aiDraft.payload.reference ?? undefined,
          lines: aiDraft.payload.lines,
          aiDraftId: aiDraft.id
        }
      : draftProp
  const waitingForAiDraft = !!aiDraftId && !voucherId && !aiDraft && !aiDraftError
  const [typeId, setTypeId] = useState<number | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)
  const [sjMode, setSjMode] = useState<'transfer' | 'manufacture'>('transfer')
  // Delivery challans / GRNs (WP 2.5b) — behind Orders & challans (F11), which needs inventory.
  const stockNotesOn = features.inventory && features.orders

  // Same queryKey Gateway uses for report:dashboard — a brand-new company (no vouchers yet) gets a
  // first-time hint here; react-query dedupes the request rather than firing a second round-trip.
  const { from, info } = useSession()
  const today = todayISO()
  const { data: dash } = useQuery({ queryKey: ['dashboard', today, from], queryFn: () => api.reports.dashboard(today, from) })
  const showFirstVoucherHint = !voucherId && !hintDismissed && dash?.voucherCount === 0
  const opts = useScreenOptions('voucher-entry', { showShortcuts: true })


  // ---------- alteration: which mode can show this voucher faithfully ----------
  // Masters for the decision come from the same query keys the entry modes' pickers use, so the
  // modes mount with them already cached. The plan is computed ONCE per opened voucher — the
  // post-save refetch must not flip the screen into another mode underneath the user.
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list, enabled: !!voucherId })
  const { data: items } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list, enabled: !!voucherId })
  const existingKind = existing && types?.find((t) => t.id === existing.voucherTypeId)?.kind
  // A stock journal opens in the Manufacture form only when it has a manufacture_details row
  // (WP 2.2); one without (pre-0.6.0) opens as plain stock lines.
  const isStockJournal = existingKind === 'stock_journal'
  const { data: mfg } = useQuery({
    queryKey: ['voucher', voucherId, 'manufacture'],
    queryFn: () => api.manufacture.get(voucherId!),
    enabled: !!voucherId && isStockJournal
  })
  // WP 2.4: a job-work send / return challan opens in the Send-to-job-worker form.
  const { data: jobWorkChallan } = useQuery({
    queryKey: ['voucher', voucherId, 'jobWork'],
    queryFn: () => api.jobWork.get(voucherId!),
    enabled: !!voucherId && isStockJournal
  })
  const [plan, setPlan] = useState<EditPlan | null>(null)
  const ledgerDraftLatch = useRef<number | null>(null)

  useEffect(() => {
    if (!voucherId || plan || !existing || !existingKind || !ledgers || !items || !info) return
    if (isStockJournal && (mfg === undefined || jobWorkChallan === undefined)) return
    setPlan(
      planVoucherEdit(existing, existingKind, {
        invoice: {
          companyStateCode: info.stateCode,
          items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
          ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
        },
        taxLedgers: taxLedgerIdsFrom(ledgers),
        manufacture: mfg?.details ?? null,
        jobWork: jobWorkChallan ?? null,
        itemName: (id) => items.find((i) => i.id === id)?.name ?? ''
      })
    )
  }, [voucherId, plan, existing, existingKind, ledgers, items, info, isStockJournal, mfg, jobWorkChallan])

  useEffect(() => {
    if (!types || typeId != null) return
    if (voucherId) return
    if (aiDraftId && !aiDraftError) {
      // Wait for the draft, then open its own voucher type.
      if (!aiDraft) return
      if (aiDraftOpen && types.some((t) => t.id === aiDraft.payload.voucherTypeId)) return setTypeId(aiDraft.payload.voucherTypeId)
    }
    const wanted = kindHint ?? 'journal'
    const t = types.find((t) => t.kind === wanted) ?? types.find((t) => !STOCK_NOTE_KINDS.includes(t.kind)) ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId, aiDraftId, aiDraft, aiDraftOpen, aiDraftError])

  useEffect(() => {
    if (existing) setTypeId(existing.voucherTypeId)
  }, [existing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const manufactureKey = isManufactureKey(e)
      const target = manufactureKey ? 'stock_journal' : kindForVoucherKey(e, { stockNotes: stockNotesOn })
      if (!target || voucherId || !types) return
      if (target === 'stock_journal' && !features.inventory) return
      // Never switch voucher type underneath an open dialog (quick-create ledger, confirm…).
      if (isAnyModalOpen()) return
      const t = types.find((t) => t.kind === target)
      if (t) {
        e.preventDefault()
        setTypeId(t.id)
        // WP 2.3: the Stock Journal tab opens on transfers; Alt+F7 asks for Manufacture.
        if (target === 'stock_journal') setSjMode(manufactureKey ? 'manufacture' : 'transfer')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [types, voucherId, features.inventory, stockNotesOn])

  if (!types || (voucherId && (!existing || !plan)) || waitingForAiDraft || (aiDraftOpen && typeId == null)) {
    return (
      <Page>
        <PageHeader title={voucherId ? 'Alter voucher' : 'Voucher entry'} />
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      </Page>
    )
  }
  const currentType = (voucherId ? types.find((t) => t.id === existing!.voucherTypeId) : types.find((t) => t.id === typeId)) ?? types.find((t) => !STOCK_NOTE_KINDS.includes(t.kind)) ?? types[0]!
  const closingEntry = !!existing?.isYearEndClose
  // WP 5.5: an assistant draft of a purchase / debit note carries ledger lines (the 2B assistant's
  // "record the purchase"), not item rows — it opens in accounting mode, like a saved voucher
  // without stock lines does, so no line is lost.
  // Latched: once the draft opened in accounting mode it stays there — its save consumes the draft
  // and the refetched (no longer open) draft must not swap the form out before it leaves.
  if (!voucherId && !!draft?.aiDraftId && !!draft.lines?.length && modeForKind(currentType.kind) === 'invoice') ledgerDraftLatch.current = currentType.id
  const ledgerDraft = !voucherId && ledgerDraftLatch.current === currentType.id
  const activeMode = voucherId ? plan!.mode : ledgerDraft ? 'accounting' : modeForKind(currentType.kind)

  const typeTabs = !voucherId ? (
    <div role="tablist" aria-label="Voucher type" className="flex flex-wrap items-center gap-1">
      {tabOrder(types)
        .filter((t) => features.inventory || (t.kind !== 'stock_journal' && t.kind !== 'physical_stock'))
        // Delivery challans / GRNs (WP 2.5b): shown with Orders & challans on.
        .filter((t) => stockNotesOn || !STOCK_NOTE_KINDS.includes(t.kind))
        .map((t) => {
          const selected = t.id === currentType.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`tab-voucher-entry-${t.kind}`}
              onClick={() => setTypeId(t.id)}
              className={`rounded-md px-2.5 py-1 text-small whitespace-nowrap transition-colors ${
                selected ? 'bg-amberbar/20 font-medium text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.name}
            </button>
          )
        })}
    </div>
  ) : undefined

  return (
    <Page width={activeMode === 'manufacture' ? 'wide' : 'standard'}>
      <PageHeader
        title={voucherId ? `Alter voucher ${existing?.number}` : 'Voucher entry'}
        tabs={typeTabs}
        secondary={
          voucherId ? (
            <span className="flex items-center gap-2">
              {features.orders && LINKABLE_VOUCHER_KINDS.has(currentType.kind) && <LinkedDocsButton target={{ voucherId }} />}
              {/* WP 6.4: the voucher's attached files (bills, scans) — not while it sits in the bin. */}
              {!existing?.deletedAt && <AttachmentsButton target={{ entity: 'voucher', entityId: voucherId }} title={`Files — ${currentType.name} ${existing?.number ?? ''}`} />}
            </span>
          ) : undefined
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <DrawerSection title="Display">
                <OptionToggle
                  label="Show the shortcut line under the form"
                  checked={opts.options.showShortcuts}
                  onChange={(v) => opts.set('showShortcuts', v)}
                  testId="input-voucher-entry-shortcuts"
                />
              </DrawerSection>
              {features.inventory && (
                <DrawerSection title="Stock lines">
                  <LineDetailOption />
                </DrawerSection>
              )}
              {features.inventory && <PricingOptions />}
              <DrawerSection title="Keyboard">
                <ul className="flex flex-col gap-1 text-detail text-ink">
                  <li>
                    <Kbd>F4</Kbd>–<Kbd>F9</Kbd> Contra, Payment, Receipt, Journal, Sales, Purchase
                  </li>
                  <li>
                    <Kbd>Alt</Kbd>+<Kbd>F7</Kbd> Manufacture
                  </li>
                  {stockNotesOn && (
                    <li>
                      <Kbd>Ctrl</Kbd>+<Kbd>F8</Kbd>/<Kbd>F9</Kbd> credit / debit note · <Kbd>Alt</Kbd>+<Kbd>F8</Kbd>/<Kbd>F9</Kbd> delivery challan / GRN
                    </li>
                  )}
                  <li>
                    <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back
                  </li>
                  <li>
                    Dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">t</span>,{' '}
                    <span className="num">y</span>
                  </li>
                </ul>
              </DrawerSection>
            </>
          )
        }}
      />
      {showFirstVoucherHint && (
        <Banner tone="info" className="mb-section" onDismiss={() => setHintDismissed(true)} testId="voucher-first-hint">
          First voucher? Pick a type above (or <Kbd>F8</Kbd> for Sales), fill in the lines, then <Kbd>⌘↵</Kbd> to save.
        </Banner>
      )}
      {aiDraftId && aiDraft && (
        <Banner tone={aiDraftOpen ? 'info' : 'warning'} className="mb-section" testId="ai-draft-banner">
          {aiDraftOpen
            ? <>{aiDraftByLabel(aiDraft)}: {aiDraft.summary}{aiDraft.payload.reference ? ` (reference ${aiDraft.payload.reference})` : ''}. Check every line — nothing is in the books until you save.</>
            : <>This assistant draft is already {aiDraft.status}{aiDraft.voucherId ? ' (saved as a voucher)' : ''}; it is not pre-filled again.</>}
        </Banner>
      )}
      {aiDraftId && aiDraftError && (
        <Banner tone="warning" className="mb-section" testId="ai-draft-banner">
          The assistant draft could not be opened: {(aiDraftError as Error).message}
        </Banner>
      )}
      {closingEntry && (
        <Banner tone="info" className="mb-section" testId="year-end-close-banner">
          Year-end closing entry — read-only. Move it to the bin to reopen the year, then close again.
        </Banner>
      )}
      {/* A disabled fieldset disables every input and button inside (Save included) for a
          year-end closing entry; the server refuses the edit regardless. */}
      <fieldset disabled={closingEntry} className="m-0 min-w-0 border-0 p-0">
      <div data-testid="voucher-entry-mode" data-mode={activeMode}>
        {voucherId && existing && plan ? (
          plan.mode === 'invoice' ? (
            <InvoiceEntry typeId={currentType.id} kind={currentType.kind} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'manufacture' ? (
            <ManufactureForm typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'physical' ? (
            <PhysicalStockEntry typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'transfer' ? (
            <TransferEntry typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state} />
          ) : plan.mode === 'jobWorkSend' ? (
            <TransferEntry typeId={currentType.id} voucherId={voucherId} voucher={existing} initial={plan.state.transfer} jobWork={plan.state.challan} />
          ) : plan.mode === 'stockNote' ? (
            <StockNoteEntry
              typeId={currentType.id}
              kind={currentType.kind as 'delivery_note' | 'receipt_note'}
              voucherId={voucherId}
              voucher={existing}
              initial={plan.state}
            />
          ) : plan.mode === 'stockLines' ? (
            <StockLinesEntry
              typeId={currentType.id}
              voucherId={voucherId}
              voucher={existing}
              initial={plan.state}
              fallbackReason={plan.fallbackReason}
              legacy={!!plan.legacy}
              formName={currentType.kind === 'physical_stock' ? 'physical-count' : currentType.kind === 'delivery_note' ? 'delivery challan' : currentType.kind === 'receipt_note' ? 'goods receipt' : 'manufacture'}
            />
          ) : (
            <AccountingEntry
              key={voucherId}
              typeId={currentType.id}
              kind={currentType.kind}
              voucherId={voucherId}
              voucher={existing}
              initial={plan.state}
              fallbackReason={plan.fallbackReason}
            />
          )
        ) : ledgerDraft ? (
          <AccountingEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
        ) : modeForKind(currentType.kind) === 'invoice' ? (
          <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
        ) : modeForKind(currentType.kind) === 'manufacture' ? (
          // WP 2.3: a new stock journal opens the transfer / adjustment form; the BOM manufacture
          // form stays one click away (WP 2.2 gives Manufacture its own screen).
          <StockJournalEntry
            key={`${currentType.id}-${sjMode}`}
            typeId={currentType.id}
            initialMode={sjMode}
            extraModes={[
              { value: 'manufacture', label: 'Manufacture (BOM)', render: () => <ManufactureForm key={currentType.id} typeId={currentType.id} /> }
            ]}
          />
        ) : modeForKind(currentType.kind) === 'physical' ? (
          <PhysicalStockEntry key={currentType.id} typeId={currentType.id} />
        ) : modeForKind(currentType.kind) === 'stockNote' ? (
          <StockNoteEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind as 'delivery_note' | 'receipt_note'} draft={draft} />
        ) : (
          <AccountingEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
        )}
      </div>
      </fieldset>
      {opts.options.showShortcuts && (
        <p className="mt-3 text-hint text-muted">
          <Kbd>F4</Kbd>–<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>,{' '}
          <span className="num">7/4</span>, <span className="num">y</span> · <Kbd>F12</Kbd> options
        </p>
      )}
    </Page>
  )
}

// Re-export for renderer unit tests that target the pre-split path (lane T's voucherNumberField.test).
export { useVoucherNumberField } from './voucher/hooks'
