// Payment-run preview → post → summary (WP 4.3). The preview is the main process's own dry run
// (payables:previewRun): per supplier the amount settled, TDS on payment (WP 3.2's rule), the
// net bank payment, the bills, and anything that would stop the run. Posting is all-or-nothing.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import type { PaymentRunInput } from '@shared/payables/schemas'
import type { PaymentRun, PaymentRunLine } from '@shared/payables/types'
import { Banner, Button, Modal, Money } from '../../components/ui'
import { VoucherLink } from '../../components/links'
import { api } from '../../lib/client'
import { payablesApi } from '../../lib/payablesClient'
import { useToasts } from '../../state/stores'

function LinesTable({ lines, posted }: { lines: PaymentRunLine[]; posted: boolean }): React.JSX.Element {
  return (
    <table className="ledger-table" data-testid={posted ? 'rows-payables-run-summary' : 'rows-payables-run-preview'}>
      <thead>
        <tr>
          {posted && <th scope="col" className="w-20">Voucher</th>}
          <th scope="col">Supplier</th>
          <th scope="col">Bills</th>
          <th scope="col" className="w-36">Pay from</th>
          <th scope="col" className="r w-28">Settled</th>
          <th scope="col" className="r w-24">TDS</th>
          <th scope="col" className="r w-28">Bank pays</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} data-testid="payables-run-line" className={l.errors.length > 0 ? 'text-cr' : ''}>
            {posted && (
              <td>
                <VoucherLink voucherId={l.voucherId} label={<span className="num">{l.voucherNumber}</span>} />
              </td>
            )}
            <td className="whitespace-nowrap">
              {l.partyName}
              {l.errors.map((e, j) => (
                <span key={j} className="block text-hint text-cr" data-testid="payables-run-error">
                  {e}
                </span>
              ))}
            </td>
            <td className="text-hint whitespace-nowrap text-muted">
              {l.bills.length > 0 ? l.bills.map((b) => b.name).join(', ') : 'Oldest first'}
              {l.onAccount > 0 && <span className="block">+ {formatPaise(l.onAccount)} on account</span>}
            </td>
            <td className="text-hint">{l.bankName}{l.instrumentNo ? ` · ${l.instrumentNo}` : ''}</td>
            <td className="r"><Money paise={l.amount} /></td>
            <td className="r" title={l.tds ? `u/s ${l.tds.code} on ${formatPaise(l.tds.base)}` : undefined}>
              {l.tds ? <><Money paise={l.tds.amount} /> <span className="text-hint text-muted">{l.tds.code}</span></> : '—'}
            </td>
            <td className="r font-medium"><Money paise={l.bankAmount} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The posted run: vouchers, cheque printing (WP 4.1's cheque layouts), CSV for the bank. */
export function RunSummary({ run }: { run: PaymentRun }): React.JSX.Element {
  const toast = useToasts()
  const [printing, setPrinting] = useState(false)
  const printCheques = async (): Promise<void> => {
    // HOOK (WP 4.1): bulk cheque printing — one cheque PDF per payment through the existing
    // cheque layout (cheque:pdf); WP 4.1 may replace this with a multi-cheque sheet.
    setPrinting(true)
    try {
      let n = 0
      for (const l of run.lines) {
        if (!l.voucherId || !l.bankLedgerId) continue
        await api.cheque.pdf(l.voucherId, l.bankLedgerId)
        n++
      }
      toast.push('success', `${n} cheque${n === 1 ? '' : 's'} saved — check the alignment before printing`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }
  const exportCsv = async (): Promise<void> => {
    try {
      const r = await payablesApi.runExportCsv(run.id)
      toast.push('success', `Saved ${r.path.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="payables-run-summary">
      <p className="text-body-sm">
        Run <span className="num font-semibold" data-testid="payables-run-no">{run.runNo}</span> · {toDisplayDate(run.date)} · {run.vouchers} payment
        {run.vouchers === 1 ? '' : 's'} · <Money paise={run.amount} /> settled
      </p>
      <LinesTable lines={run.lines} posted />
      <div className="flex flex-wrap justify-end gap-2">
        <Button data-testid="btn-payables-run-cheques" disabled={printing} onClick={() => void printCheques()}>
          Print cheques
        </Button>
        <Button data-testid="btn-payables-run-csv" onClick={() => void exportCsv()}>
          Bank payment file (CSV)
        </Button>
      </div>
      <p className="text-hint text-muted">The CSV is a generic one; bank-specific bulk upload formats come with the banking update.</p>
    </div>
  )
}

export function RunPreviewModal({
  input,
  onClose,
  onPosted
}: {
  input: PaymentRunInput
  onClose: () => void
  onPosted?: (run: PaymentRun) => void
}): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [applyTds, setApplyTds] = useState(input.applyTds ?? true)
  const [posting, setPosting] = useState(false)
  const [run, setRun] = useState<PaymentRun | null>(null)
  // Idempotency key for this run: a double submit (or a retry after a slow reply) posts once.
  const [clientRunId] = useState(() => crypto.randomUUID())
  const payload = { ...input, applyTds }
  const { data: preview, isLoading, error } = useQuery({
    queryKey: ['payablesRunPreview', JSON.stringify(payload)],
    queryFn: () => payablesApi.previewRun(payload),
    enabled: !run
  })

  const post = async (): Promise<void> => {
    setPosting(true)
    try {
      const r = await payablesApi.createRun({ ...payload, clientRunId })
      setRun(r)
      onPosted?.(r)
      await qc.invalidateQueries()
      toast.push('success', `Posted ${r.vouchers} payment${r.vouchers === 1 ? '' : 's'} — run ${r.runNo}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <Modal title={run ? `Payment run ${run.runNo}` : 'Create payments'} onClose={onClose} wide>
      {run ? (
        <RunSummary run={run} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="payables-run-preview">
          {error && <Banner tone="danger">{(error as Error).message}</Banner>}
          {isLoading && <p className="text-body-sm text-muted">Working out TDS and bills…</p>}
          {preview && (
            <>
              <p className="text-body-sm">
                {preview.totals.vouchers} payment voucher{preview.totals.vouchers === 1 ? '' : 's'} dated {toDisplayDate(input.date)} · settles{' '}
                <Money paise={preview.totals.amount} />
                {preview.totals.tds > 0 && <> · TDS <Money paise={preview.totals.tds} /></>} · bank pays{' '}
                <span className="font-semibold" data-testid="payables-preview-bank-total"><Money paise={preview.totals.bank} /></span>
              </p>
              <LinesTable lines={preview.lines} posted={false} />
              {preview.banks.map((b) => (
                <p key={b.ledgerId} className={`text-hint ${b.after < 0 ? 'text-cr' : 'text-muted'}`}>
                  {b.name}: <Money paise={b.before} /> → <Money paise={b.after} />
                  {b.after < 0 && ' — the bank goes overdrawn'}
                </p>
              ))}
              {!preview.ok && <Banner tone="danger" testId="payables-preview-blocked">Fix the lines in red before posting.</Banner>}
            </>
          )}
          <label className="flex items-center gap-2 text-detail">
            <input type="checkbox" data-testid="input-payables-apply-tds" checked={applyTds} onChange={(e) => setApplyTds(e.target.checked)} />
            Deduct TDS on payment where it is due (bills not deducted when booked, advances — threshold crossed)
          </label>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-payables-post-run" disabled={!preview?.ok || posting} onClick={() => void post()}>
              Post {preview?.totals.vouchers ?? ''} payment{preview?.totals.vouchers === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
