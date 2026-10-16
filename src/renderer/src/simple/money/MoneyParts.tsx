import type { ReactNode } from 'react'
import { formatPaise } from '@shared/money'
import type { SimplePreview } from '@shared/simple/intents'
import { useT } from '../../lib/i18n'
import { Button } from '../../components/ui'
import { AccountantViewButton } from '../AccountantViewButton'
import { SaveBar } from '../SaveBar'
import { useCanSave, ViewerNote } from '../ViewerNote'

/** WP 9.4 — a Money screen's heading: its title, one plain line, and "Accountant view". */
export function MoneyHeader({ title, sub, onAccountant }: { title: string; sub: string; onAccountant: (always: boolean) => void }): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-detail text-muted">{sub}</p>
        </div>
        <AccountantViewButton testId="btn-money-accountant-view" title={t('simple.money.accountantHint')} onOpen={onAccountant} />
      </div>
      {!canSave && <ViewerNote top />}
    </>
  )
}

/** WP 9.4 — a plain question with choices (radio chips). */
export function Choices<V extends string>({
  label,
  value,
  options,
  onPick,
  testId
}: {
  label: string
  value: V | null
  options: { value: V; label: string }[]
  onPick: (v: V) => void
  testId: string
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onPick(o.value)}
          className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
            value === o.value ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A card around one question. */
export function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={title} data-testid={testId}>
      <h2 className="mb-3 text-subtitle font-semibold text-ink">{title}</h2>
      {children}
    </section>
  )
}

/**
 * WP 9.4 — what will be saved (simple:preview's plain sentences, computed by main — where the
 * party stands after the save included), the TDS hint when the existing rules fire, a problem
 * with no field of its own, and the Save bar.
 */
export function MoneyFooter({
  preview,
  previewing,
  ready,
  general,
  saving,
  canSave,
  dirty,
  onSave,
  onStartAgain
}: {
  preview: SimplePreview | null
  previewing: boolean
  ready: boolean
  general: { text: string; details: string } | null
  saving: boolean
  canSave: boolean
  dirty: boolean
  onSave: () => void
  onStartAgain: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      {!!preview?.tds?.length && (
        <section className="flex flex-col gap-2" aria-label={t('simple.money.preview')} data-testid="money-preview-box">
          {preview.tds.map((h, i) => (
            <p key={i} role="status" className="rounded-md border border-amber/60 bg-amberbar/10 px-3 py-2 text-detail text-ink" data-testid="money-tds-hint">
              {t('simple.money.tds', { name: h.partyName, section: h.sectionCode })}
              {h.tdsPaise != null && ` ${t('simple.money.tdsAmount', { amount: formatPaise(h.tdsPaise, { symbol: true }) })}`}
            </p>
          ))}
        </section>
      )}
      {general && (
        <div role="alert" className="rounded-md border border-danger/50 bg-danger-soft px-3 py-2 text-detail text-danger" data-testid="money-error">
          <p>{general.text}</p>
          <details className="mt-1 text-muted">
            <summary className="cursor-pointer">{t('common.details')}</summary>
            <p className="mt-1 font-mono text-small">{general.details}</p>
          </details>
        </div>
      )}
      <SaveBar
        preview={preview ? preview.sentences.map((s, i) => <p key={i}>{s}</p>) : ready && previewing ? <p className="text-muted">{t('simple.money.checking')}</p> : null}
        previewTestId="money-preview"
        shortcuts={t('simple.money.shortcuts')}
      >
        <Button data-testid="btn-money-start-again" disabled={saving || !dirty} onClick={onStartAgain}>
          {t('simple.money.startAgain')}
        </Button>
        <Button variant="primary" data-testid="btn-money-save" disabled={saving || !canSave} onClick={onSave}>
          {t('simple.money.save')}
        </Button>
      </SaveBar>
    </>
  )
}
