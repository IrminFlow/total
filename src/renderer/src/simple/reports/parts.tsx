import type { ReactNode } from 'react'
import { formatPaise } from '@shared/money'
import { useT } from '../../lib/i18n'
import { useNav } from '../../state/stores'
import type { Screen } from '../../state/stores'
import { Button, Why } from '../../components/kit'

export const money = (paise: number): string => formatPaise(paise, { symbol: true })
export const cardCls = 'rounded-lg border border-line bg-panel p-panel shadow-elev-1'

/** A report's title, one plain line under it and its Accountant view (the full report). */
export function ReportHeader({ title, subtitle, accountant, testId }: { title: string; subtitle: string; accountant?: { screen: Screen; hint: string }; testId: string }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-detail text-muted" data-testid={`${testId}-subtitle`}>
          {subtitle}
        </p>
      </div>
      {accountant && (
        <Button variant="ghost" data-testid={`${testId}-accountant-view`} title={accountant.hint} onClick={() => nav.go(accountant.screen)}>
          {t('common.accountantView')}
        </Button>
      )}
    </div>
  )
}

/** One figure with its "Why?" sentence (shared/simple/explain.ts) and the link to the figure. */
export function WhyLink({
  what,
  sentence,
  link,
  testId,
  extra
}: {
  what: string
  sentence: string
  link?: { label: string; screen: Screen }
  testId: string
  /** WP 10.2: a second, quieter line under the sentence (a comparison, what is left over). */
  extra?: string | null
}): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  return (
    <Why
      label={t('common.why')}
      ariaLabel={t('simple.reports.whyLabel', { what })}
      sentence={sentence}
      link={link ? { label: link.label, onOpen: () => nav.go(link.screen) } : undefined}
      testId={testId}
    >
      {extra && (
        <p className="text-small text-muted" data-testid={`${testId}-extra`}>
          {extra}
        </p>
      )}
    </Why>
  )
}

/** A figure tile: title, amount, an optional line under it, "Why?". */
export function FigureTile({
  id,
  title,
  paise,
  value,
  sub,
  why,
  whyExtra,
  link,
  emphasis,
  children
}: {
  id: string
  title: string
  paise: number
  /** Shown instead of the amount ("₹7,200.00 by 20 Oct"). */
  value?: string
  sub?: string | null
  why: string
  whyExtra?: string | null
  link?: { label: string; screen: Screen }
  emphasis?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <li className={`${cardCls} ${emphasis ? 'border-amber/60' : ''}`} data-testid={`tile-${id}`} data-paise={paise}>
      <h2 className="text-small font-medium text-muted">{title}</h2>
      <p className={`num mt-2 font-semibold ${paise < 0 ? 'text-cr' : 'text-ink'} ${emphasis ? 'text-heading' : 'text-title'}`} data-testid={`tile-${id}-value`}>
        {value ?? money(paise)}
      </p>
      {sub && (
        <p className="mt-1 text-small text-muted" data-testid={`tile-${id}-sub`}>
          {sub}
        </p>
      )}
      {children}
      <div className="mt-2">
        <WhyLink what={title} sentence={why} extra={whyExtra} link={link} testId={`why-${id}`} />
      </div>
    </li>
  )
}

/** A radio-button row (periods, sides). */
export function Choice<V extends string>({ label, value, options, onChange, testId }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; testId: string }): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md border border-line bg-panel2 p-0.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-testid={`${testId}-${o.value}`}
          className={`rounded px-3 py-1 text-detail ${value === o.value ? 'bg-panel font-medium text-ink shadow-elev-1 ring-1 ring-line' : 'text-muted hover:text-ink'}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function LoadError({ onRetry, testId, text }: { onRetry: () => void; testId: string; text: string }): React.JSX.Element {
  const t = useT()
  return (
    <section className={cardCls} data-testid={`${testId}-error`}>
      <p className="text-detail text-ink">{text}</p>
      <Button className="mt-3" variant="secondary" size="sm" onClick={onRetry}>
        {t('common.tryAgain')}
      </Button>
    </section>
  )
}
