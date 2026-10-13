import { useT } from '../lib/i18n'

/** Stand-in for the simple-mode screens (Phase 8–9). Every visible word comes from `t()`. */
export function SimplePlaceholder(): React.JSX.Element {
  const t = useT()
  return (
    <section className="mx-auto max-w-xl px-panel py-8" data-testid="simple-placeholder" aria-live="polite">
      <h2 className="text-title font-semibold text-ink">{t('simple.placeholder.title')}</h2>
      <p className="mt-2 text-detail text-muted">{t('simple.placeholder.body')}</p>
    </section>
  )
}
