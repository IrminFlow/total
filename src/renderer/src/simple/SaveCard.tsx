import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { mapError, type CaughtError } from '@shared/errors'
import { saveCardSentences } from '@shared/simple/saveCard'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { Button } from '../components/kit/Button'

/**
 * The save card (WP 8.5, plan §1.6): what was just saved, in one or two plain sentences — "Bill
 * ₹1,180 saved. Received ₹500 into UPI. Ramesh still owes ₹680." — with Print / PDF / Share
 * (the existing print paths), New and Undo. Every figure comes from `voucher:saveSummary` (the
 * saved vouchers and the party's outstanding, computed by main). Undo bins all of `voucherIds`
 * as one group and is offered only while they are untouched since the save; once edited the card
 * says so and offers "Edit instead". Errors stay on the card, never in a toast.
 */
export function SaveCard({
  voucherIds,
  onNew,
  onEdit,
  onUndone
}: {
  voucherIds: number[]
  onNew: () => void
  onEdit: (voucherId: number) => void
  onUndone?: () => void
}): React.JSX.Element {
  const t = useT()
  const queryClient = useQueryClient()
  const [undone, setUndone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ text: string; details: string } | null>(null)
  const summaryKey = ['saveSummary', voucherIds] // i18n-technical
  const { data } = useQuery({
    queryKey: summaryKey,
    queryFn: () => api.vouchers.saveSummary(voucherIds),
    enabled: !undone
  })
  const primary = voucherIds[0]!
  const sentences = data ? saveCardSentences(data, t) : []

  const fail = (err: unknown): void => {
    // Refused because it changed since (or went to the bin): re-read, so the card says so.
    void queryClient.invalidateQueries({ queryKey: summaryKey })
    const m = mapError(err as CaughtError, { simple: true, t })
    setProblem({ text: [m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('errors.generic'), details: m.details })
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const undo = (): Promise<void> =>
    run(async () => {
      await api.vouchers.undoSave(voucherIds)
      setUndone(true)
      await queryClient.invalidateQueries()
      onUndone?.()
    })

  const pdf = (): Promise<void> =>
    run(async () => {
      const r = await api.invoice.pdfBatch([primary])
      setNote(t('simple.saveCard.pdfSaved', { path: r.paths[0] ?? r.dir }))
    })

  const share = (): Promise<void> =>
    run(async () => {
      await api.invoice.pdfBatch([primary])
      try {
        await navigator.clipboard.writeText(sentences.join(' '))
      } catch {
        /* no clipboard (tests, denied) — the PDF is still shown in Finder */
      }
      setNote(t('simple.saveCard.shareHint'))
    })

  if (undone) {
    return (
      <section data-testid="save-card" data-state="undone" aria-live="polite" className="mb-4 rounded-lg border border-line bg-panel2 px-4 py-3">
        <p className="text-body text-ink" data-testid="save-card-undone">{t('simple.saveCard.undone')}</p>
        <p className="mt-0.5 text-detail text-muted">{t('simple.saveCard.undoneHint')}</p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" data-testid="btn-save-card-new" onClick={onNew}>
            {t('simple.saveCard.new')}
          </Button>
        </div>
      </section>
    )
  }

  const undoable = data?.undo.undoable ?? false
  // Changed since, already used by other entries, or older than a day: "Edit instead".
  const reason = data != null && !undoable ? data.undo.reason : null
  const editNote =
    reason === 'edited'
      ? t('simple.saveCard.editedSince')
      : reason === 'linked'
        ? t('simple.saveCard.linkedSince')
        : reason === 'expired'
          ? t('simple.saveCard.expired')
          : null
  const edited = editNote != null
  return (
    <section
      data-testid="save-card"
      data-state="saved"
      aria-label={t('simple.saveCard.label')}
      aria-live="polite"
      className="mb-4 rounded-lg border border-success/50 bg-success-soft px-4 py-3"
    >
      <p className="text-body text-ink" data-testid="save-card-text">
        {sentences.length ? sentences.join(' ') : t('common.saved')}
      </p>
      {edited && (
        <p className="mt-1 text-detail text-muted" data-testid="save-card-edited" data-reason={reason ?? undefined}>
          {editNote}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-testid="btn-save-card-print" disabled={busy} onClick={() => void run(async () => void (await api.invoice.pdf(primary)))}>
          {t('common.print')}
        </Button>
        <Button data-testid="btn-save-card-pdf" disabled={busy} onClick={() => void pdf()}>
          {t('common.pdf')}
        </Button>
        <Button data-testid="btn-save-card-share" disabled={busy} onClick={() => void share()}>
          {t('common.share')}
        </Button>
        <Button variant="primary" data-testid="btn-save-card-new" onClick={onNew}>
          {t('simple.saveCard.new')}
        </Button>
        {edited ? (
          <Button data-testid="btn-save-card-edit" onClick={() => onEdit(primary)}>
            {t('simple.saveCard.editInstead')}
          </Button>
        ) : (
          <Button data-testid="btn-save-card-undo" disabled={busy || !undoable} onClick={() => void undo()}>
            {busy ? t('simple.saveCard.undoing') : t('simple.saveCard.undo')}
          </Button>
        )}
      </div>
      {note && (
        <p className="mt-2 text-detail text-muted" data-testid="save-card-note">
          {note}
        </p>
      )}
      {problem && (
        <div role="alert" className="mt-2 text-detail text-danger" data-testid="save-card-error">
          <p>{problem.text}</p>
          <details className="mt-1 text-muted">
            <summary className="cursor-pointer">{t('common.details')}</summary>
            <p className="mt-1 font-mono text-small">{problem.details}</p>
          </details>
        </div>
      )}
    </section>
  )
}
