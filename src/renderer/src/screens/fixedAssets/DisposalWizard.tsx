// Disposal wizard (WP 3.6): sale or scrap of one asset — or a part of it (a quantity of units, or
// a share of the cost) — → preview the journal (proceeds, accumulated depreciation written back,
// cost out, catch-up depreciation, profit / loss) → post.
import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import type { DisposalKind, FixedAssetRow, JournalPreviewLine } from '@shared/fixedAssets'
import { faApi } from '../../lib/fixedAssetsClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Banner, Button, Checkbox, DateInput, Field, Modal, Money, Segmented, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerPicker } from '../../components/pickers'
import { LedgerLink } from '../../components/links'
import { useRefreshFixedAssets } from './common'

export const JOURNAL_COLUMNS = defineColumns<JournalPreviewLine & { key: number }>([
  {
    id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, hideable: false, groupable: false, minWidth: 200,
    cell: (r) => (
      <>
        <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} />
        {r.ledgerId == null && <span className="ml-2 text-hint text-muted">(created on posting)</span>}
      </>
    )
  },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => (r.drCr === 'dr' ? r.amount : null), width: 150, aggregate: 'sum' },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => (r.drCr === 'cr' ? r.amount : null), width: 150, aggregate: 'sum' }
])

export function DisposalWizard({ asset, onClose }: { asset: FixedAssetRow; onClose: () => void }): React.JSX.Element {
  const { workingDate } = useSession()
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const [step, setStep] = useState<1 | 2>(1)
  const [date, setDate] = useState(workingDate)
  const [kind, setKind] = useState<DisposalKind>('sale')
  const [proceeds, setProceeds] = useState<number | null>(null)
  const [consideration, setConsideration] = useState<number | null>(null)
  const [catchUp, setCatchUp] = useState(true)
  const [posting, setPosting] = useState(false)
  const [scope, setScope] = useState<'whole' | 'part'>('whole')
  const [qtyText, setQtyText] = useState('')
  const [ofText, setOfText] = useState('')
  const part = scope === 'part' ? partOf(qtyText, ofText) : null
  const input = {
    assetId: asset.id, date, kind, proceedsPaise: kind === 'scrap' && !proceeds ? 0 : proceeds ?? 0,
    considerationLedgerId: consideration, chargeCatchUp: catchUp, part
  }
  const { data: preview } = useQuery({
    queryKey: ['faDisposal', input],
    queryFn: () => faApi.disposalPreview(input),
    placeholderData: keepPreviousData,
    enabled: scope === 'whole' || part != null
  })
  const partInvalid = scope === 'part' && part == null

  const post = async (): Promise<void> => {
    setPosting(true)
    try {
      await faApi.dispose(input)
      await refresh()
      toast.push('success', part ? `Part (${part.quantity} of ${part.of}) of ${asset.name} disposed — the rest stays on the register` : `${asset.name} disposed — the journal is in the Day book`)
      onClose()
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setPosting(false)
    }
  }

  const rows = (preview?.journal ?? []).map((l, i) => ({ ...l, key: i }))
  return (
    <Modal title={`Dispose of ${asset.name}`} onClose={onClose} wide dirty={step === 2 || proceeds != null}>
      <div className="flex flex-col gap-4" data-testid="fixed-assets-disposal">
        <ol className="flex items-center gap-2 text-small font-medium text-muted" aria-label="Steps">
          <li className={step === 1 ? 'text-ink' : ''}>1 · Details</li>
          <li aria-hidden="true">—</li>
          <li className={step === 2 ? 'text-ink' : ''}>2 · Review journal</li>
        </ol>
        {step === 1 && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="What goes">
              <Segmented label="What goes" testId="btn-fixed-assets-disposal-scope" value={scope} onChange={(v) => setScope(v as 'whole' | 'part')} options={[{ value: 'whole', label: 'The whole asset' }, { value: 'part', label: 'A part of it' }]} />
            </Field>
            {scope === 'part' ? (
              <Field label="Part disposed of" hint="Units sold of units held (or the part's cost of the whole cost) — that share of cost and depreciation leaves the register">
                <div className="flex items-center gap-2">
                  <TextInput data-testid="input-fixed-assets-part-qty" aria-label="Part" className="num w-24" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
                  <span className="text-muted">of</span>
                  <TextInput data-testid="input-fixed-assets-part-of" aria-label="Whole" className="num w-24" value={ofText} onChange={(e) => setOfText(e.target.value)} />
                </div>
              </Field>
            ) : <div />}
            <Field label="Disposal">
              <Segmented label="Disposal" testId="btn-fixed-assets-disposal-kind" value={kind} onChange={(v) => setKind(v as DisposalKind)} options={[{ value: 'sale', label: 'Sale' }, { value: 'scrap', label: 'Scrap / discard' }]} />
            </Field>
            <Field label="Date" hint="Depreciation stops the day before">
              <DateInput testId="input-fixed-assets-disposal-date" value={date} context={workingDate} onChange={setDate} />
            </Field>
            <Field label={kind === 'sale' ? 'Sale proceeds' : 'Scrap value (if any)'}>
              <AmountInput testId="input-fixed-assets-proceeds" paise={proceeds} onPaise={setProceeds} />
            </Field>
            <Field label="Proceeds received in" hint="Cash, bank or the buyer's ledger">
              <LedgerPicker testId="picker-fixed-assets-consideration" value={consideration} onPick={setConsideration} placeholder="Cash / bank / party" />
            </Field>
            <div className="col-span-2">
              <Checkbox
                testId="input-fixed-assets-catch-up"
                label="Charge depreciation up to the disposal date in this journal"
                hint="From the day after the last run to the day before disposal"
                checked={catchUp}
                onChange={setCatchUp}
              />
            </div>
          </div>
        )}

        {preview && (
          <div className="grid grid-cols-5 gap-2 rounded-lg border border-line bg-panel2 p-3 text-body-sm" data-testid="fixed-assets-disposal-figures">
            <Figure label={preview.part ? "Cost of the part" : "Cost"} paise={preview.gross} />
            <Figure label="Depreciation booked" paise={preview.accumulatedBooked} />
            <Figure label={preview.catchUpFrom ? `Catch-up from ${toDisplayDate(preview.catchUpFrom)}` : 'Catch-up'} paise={preview.catchUp} />
            <Figure label="Carrying amount" paise={preview.carrying} />
            <div>
              <p className="text-hint text-muted">{preview.profit >= 0 ? 'Profit on sale' : 'Loss on sale'}</p>
              <Money paise={Math.abs(preview.profit)} className={`font-semibold ${preview.profit < 0 ? 'text-cr' : 'text-dr'}`} />
            </div>
          </div>
        )}
        {preview?.part && preview.remainingCost != null && (
          <p className="text-body-sm text-muted" data-testid="fixed-assets-disposal-remaining">
            The part is split off as its own record and disposed of; <Money paise={preview.remainingCost} /> of cost stays on {asset.name}.
          </p>
        )}
        {partInvalid && <Banner tone="info" testId="fixed-assets-disposal-part-hint">Give the part as two whole numbers, the part less than the whole (e.g. 3 of 10).</Banner>}
        {preview?.blocked && <Banner tone="warning" testId="fixed-assets-disposal-blocked">{preview.blocked}</Banner>}

        {step === 2 && (
          <div className="overflow-hidden rounded-md border border-line">
            <DataTable
              viewId="fixed-assets-disposal-journal"
              testId="fixed-assets-disposal-journal"
              ariaLabel="Disposal journal"
              columns={JOURNAL_COLUMNS}
              rows={rows}
              rowKey={(r) => r.key}
              maxHeight="none"
              toolbar={false}
              totalsLabel="Total"
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          {step === 2 && <Button onClick={() => setStep(1)}>Back</Button>}
          {step === 1 ? (
            <Button variant="primary" data-testid="btn-fixed-assets-disposal-next" disabled={!preview || !!preview.blocked || partInvalid} onClick={() => setStep(2)}>
              Next: review journal
            </Button>
          ) : (
            <Button variant="primary" data-testid="btn-fixed-assets-dispose" loading={posting} disabled={!!preview?.blocked || partInvalid} onClick={() => void post()}>
              Post disposal
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** "3" of "10" → { quantity: 3, of: 10 }; null unless both are whole numbers with 0 < part < whole. */
export function partOf(qtyText: string, ofText: string): { quantity: number; of: number } | null {
  const q = /^\s*\d+\s*$/.test(qtyText) ? Number(qtyText) : NaN
  const o = /^\s*\d+\s*$/.test(ofText) ? Number(ofText) : NaN
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(o) || q < 1 || o < 2 || q >= o) return null
  return { quantity: q, of: o }
}

function Figure({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div>
      <p className="text-hint text-muted">{label}</p>
      <Money paise={paise} />
    </div>
  )
}
