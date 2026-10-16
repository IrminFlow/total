import { useMemo, useState } from 'react'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { BankLineView } from '@shared/simple/bank'
import { useT } from '../../lib/i18n'
import { bankingApi } from '../../lib/bankingClient'
import { confirmDialog } from '../../lib/dialogs'
import { useNav } from '../../state/stores'
import { DataTable, defineColumns } from '../../components/table'
import { useCanSave } from '../ViewerNote'

/** What a settled line shows: "Done · Ramesh" (the entry's other account) or "Left out …". */
function statusText(l: BankLineView, t: ReturnType<typeof useT>): string {
  if (l.status === 'left_out') return t('simple.bank.leftOut')
  const name = l.done[0]?.name
  return name ? t('simple.bank.doneWith', { name }) : t('simple.bank.done')
}

/**
 * WP 9.6 — the statement lines already done (matched to an entry in the books) or left out in the
 * full app, in the shared DataTable. "Open" shows the entry in the full app. "Not this" (accountant
 * and owner) takes a done line off its entry after a confirm — the full Banking's own unmatch
 * (bankImport:unmatch: the bank date goes back, the rule it taught counts a rejection, audited);
 * the entry stays in the books and the line is open again, with its suggestion.
 */
export function DoneLines({ lines, bankLedgerId, onUnmatched }: { lines: BankLineView[]; bankLedgerId: number; onUnmatched: (note: string) => void }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const mayWrite = useCanSave()
  const [busy, setBusy] = useState<number | null>(null)
  const notThis = async (r: BankLineView): Promise<void> => {
    const ok = await confirmDialog({
      title: t('simple.bank.notThisTitle'),
      message: t('simple.bank.notThisBody', { date: toPlainDate(r.date, t.lang), name: r.done[0]?.name ?? '' }),
      confirmLabel: t('simple.bank.notThisYes'),
      cancelLabel: t('simple.bank.notThisKeep')
    })
    if (!ok) return
    setBusy(r.id)
    try {
      await bankingApi.import.unmatch(bankLedgerId, r.id)
      onUnmatched(t('simple.bank.notThisDone'))
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t })
      onUnmatched(t('simple.bank.notThisProblem', { reason: m.general ?? m.details }))
    } finally {
      setBusy(null)
    }
  }
  const columns = useMemo(
    () =>
      defineColumns<BankLineView>([
        { id: 'date', header: t('simple.bank.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date, t.lang), width: 130, groupable: false }, // i18n-technical
        { id: 'description', header: t('simple.bank.col.description'), kind: 'text', value: (r) => r.description, minWidth: 220, hideable: false, groupable: false }, // i18n-technical
        { id: 'amount', header: t('simple.bank.col.amount'), kind: 'money', value: (r) => (r.side === 'withdrawal' ? -r.amount : r.amount), width: 130, explainable: false }, // i18n-technical
        {
          id: 'status', header: t('simple.bank.col.status'), kind: 'text', groupable: false, minWidth: 200, // i18n-technical
          value: (r) => statusText(r, t),
          cell: (r) => (
            <span className={r.status === 'done' ? 'text-success' : 'text-muted'} data-testid="bank-done-status" data-status={r.status}>
              {statusText(r, t)}
            </span>
          )
        }
      ]),
    [t]
  )
  return (
    <section aria-label={t('simple.bank.doneTitle')} data-testid="bank-done">
      <h2 className="mb-2 text-subtitle font-semibold text-ink">{t('simple.bank.doneTitle')}</h2>
      <div className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-bank-done"
          columns={columns}
          rows={lines}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-line-id': r.id, 'data-status': r.status })}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{ title: t('simple.bank.noDone') }}
          onRowActivate={(r) => r.done[0] && nav.go({ name: 'voucher-entry', voucherId: r.done[0].voucherId })} // i18n-technical
          trailing={(r) =>
            r.done[0] ? (
              <span className="flex items-center gap-3">
                <button type="button" className="text-small text-blue hover:underline" data-testid="btn-bank-done-open" onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.done[0]!.voucherId })} // i18n-technical
                >
                  {t('simple.bank.open')}
                </button>
                {mayWrite && r.status === 'done' && (
                  <button
                    type="button"
                    className="text-small text-blue hover:underline disabled:opacity-60"
                    data-testid={`btn-bank-not-this-${r.id}`}
                    title={t('simple.bank.notThisHint')}
                    disabled={busy != null}
                    onClick={(e) => {
                      e.stopPropagation()
                      void notThis(r)
                    }}
                  >
                    {t('simple.bank.notThis')}
                  </button>
                )}
              </span>
            ) : null
          }
          trailingWidth={mayWrite ? 150 : 70}
        />
      </div>
    </section>
  )
}
