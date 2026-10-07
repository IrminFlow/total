// WP 4.2 — statement of account preview: the real print (the ONE renderer, via IPC) for a party
// and period, with "Save PDF" and "Email…" (PDF saved to exports/statements + a mailto: draft
// with the company's subject / body template — the app has no SMTP).
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf } from '@shared/dates'
import { CLASSIC_DEFAULT } from '@shared/printTemplates'
import { receivablesApi } from '../../lib/receivablesClient'
import { useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, Modal, Money, Spinner } from '../ui'
import { PaperPreview } from '../print/PaperPreview'

export function StatementModal({ ledgerId, name, onClose }: { ledgerId: number; name: string; onClose: () => void }): React.JSX.Element {
  const session = useSession()
  const toast = useToasts()
  const [from, setFrom] = useState(() => fyOf(session.to).from)
  const [to, setTo] = useState(session.to)
  const [busy, setBusy] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['statement', ledgerId, from, to],
    queryFn: () => receivablesApi.statement(ledgerId, from, to),
    enabled: from <= to
  })

  const save = async (email: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await receivablesApi.statementPdf(ledgerId, from, to)
      if (email) {
        window.open(r.mailto)
        toast.push('success', `Statement saved — attach ${r.path.split('/').pop()} to the email draft`)
      } else toast.push('success', `Statement saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const d = data?.data
  return (
    <Modal title={`Statement of account — ${name}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3" data-testid="statement-modal">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <DateInput value={from} context={to} onChange={setFrom} testId="input-statement-from" />
          </Field>
          <Field label="To">
            <DateInput value={to} context={to} onChange={setTo} testId="input-statement-to" />
          </Field>
          {d && (
            <dl className="ml-auto flex gap-5 text-caption">
              <div>
                <dt className="text-muted">Opening</dt>
                <dd><Money paise={d.opening} signed /></dd>
              </div>
              <div>
                <dt className="text-muted">Closing</dt>
                <dd data-testid="statement-closing"><Money paise={d.closing} signed /></dd>
              </div>
              <div>
                <dt className="text-muted">Open bills</dt>
                <dd className="num">{d.openBills.length}</dd>
              </div>
            </dl>
          )}
        </div>
        <div className="max-h-[48vh] overflow-auto rounded-lg border border-line bg-panel2 p-3" data-testid="statement-preview">
          {isLoading ? (
            <div className="flex justify-center p-10"><Spinner /></div>
          ) : error ? (
            <p className="text-small text-cr">{(error as Error).message}</p>
          ) : data ? (
            <PaperPreview html={data.html} page={CLASSIC_DEFAULT.page} zoom={0.72} title="Statement preview" />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-hint text-muted">
            {d?.party.email ? `Email goes to ${d.party.email}` : 'No email on the ledger — the draft opens without a recipient.'} Subject and body: Settings → Receivables.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button data-testid="btn-statement-pdf" disabled={busy || !data} onClick={() => void save(false)}>
              Save PDF
            </Button>
            <Button variant="primary" data-testid="btn-statement-email" disabled={busy || !data} onClick={() => void save(true)}>
              Email…
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
