import { useT } from '../lib/i18n'
import { useAiAffordances } from '../lib/explain'
import { screenDef, simpleEntriesOf, simpleEntryVisible, SIMPLE_SECTIONS, type ResolvedSimpleEntry } from '../lib/screens'
import { useFeatures } from '../lib/useFeatures'
import { useNav, useSession } from '../state/stores'
import { Page } from '../components/ui'
import type { SimpleSectionId } from '@shared/simple/uiMode'

/** Entries a section shows for this company: features on, the GST returns (GSTR-1 / 3B / 2B) only
 *  for a REGULAR registration (never while the company details are still loading), "Snap a bill"
 *  only while the AI assistant is ready. */
export function useVisibleEntries(section: SimpleSectionId): ResolvedSimpleEntry[] {
  const features = useFeatures()
  const aiReady = useAiAffordances()
  const regular = useSession((s) => s.info?.gstRegistrationType === 'regular')
  return simpleEntriesOf(section).filter((e) => simpleEntryVisible(e, { features, regular, aiReady }))
}

/**
 * WP 8.1: a simple section's page (Sell, Buy, Money …): its plain-named entries, each opening the
 * mapped EXISTING screen (plan §2.3) — inside the simple shell with the "Accountant view"
 * toggle, or in the full app for accountant-only screens (tagged "Full app"). The simple-native
 * flows replace these in Phase 9.
 */
export function SimpleSection({ section }: { section: SimpleSectionId }): React.JSX.Element {
  const t = useT()
  const entries = useVisibleEntries(section)
  const gstType = useSession((s) => s.info?.gstRegistrationType ?? null)
  const nav = useNav()
  const meta = SIMPLE_SECTIONS.find((s) => s.id === section)
  const title = meta ? t(meta.label) : '' // i18n-technical: registry key (simple.nav.*)
  const main = entries.filter((e) => e.group === null)
  const ca = entries.filter((e) => e.group === 'forYourCa')

  return (
    <Page data-testid={`simple-section-${section}`}>
      <h1 className="mb-5 font-serif text-heading font-semibold tracking-tight text-ink">{title}</h1>
      {section === 'taxes' && gstType === 'unregistered' && (
        <p className="mb-4 text-detail text-muted" data-testid="simple-taxes-unregistered">
          {t('simple.taxes.gst.unregistered')}
        </p>
      )}
      {section === 'taxes' && gstType === 'composition' && (
        <section className="mb-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="simple-taxes-composition">
          <h2 className="text-lead font-semibold text-ink">{t('simple.taxes.gst.compositionTitle')}</h2>
          <p className="mt-1 text-detail text-muted">{t('simple.taxes.gst.composition')}</p>
          {/* WP 9.9: the Taxes screen has the cited CMP-08 / GSTR-4 dates; its entries are for a
              regular registration only, so the composition card is the way in. */}
          <button
            type="button"
            data-testid="simple-taxes-composition-open"
            onClick={() => nav.go(taxesScreen)}
            className="mt-3 rounded-md border border-line px-3 py-1.5 text-detail font-medium text-ink hover:border-amber/60 hover:bg-panel2 focus-visible:border-amber"
          >
            {t('simple.taxes.composition.open')}
          </button>
        </section>
      )}
      {entries.length === 0 && <p className="text-detail text-muted">{t('simple.section.empty')}</p>}
      <EntryGrid entries={main} />
      {ca.length > 0 && (
        <>
          <h2 className="mt-7 mb-3 text-subtitle font-semibold text-ink">{t('simple.reports.forYourCa')}</h2>
          <EntryGrid entries={ca} />
        </>
      )}
    </Page>
  )
}

const taxesScreen = { name: 'simple-taxes' } as const // i18n-technical

/** The entry opens a screen that only has an accountant view (it shows in the full app). */
const accountantOnly = (e: ResolvedSimpleEntry): boolean => !screenDef(e.screenName)?.modes.includes('simple')

function EntryGrid({ entries }: { entries: ResolvedSimpleEntry[] }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  if (entries.length === 0) return null
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {entries.map((e) => {
        const label = t(e.label) // i18n-technical: registry key (simple.* / common.*), checked in simpleRegistry.test
        const fullApp = accountantOnly(e)
        return (
          <li key={e.id}>
            <button
              type="button"
              data-testid={`simple-entry-${e.id}`}
              onClick={() => nav.go(e.screen)}
              className="flex h-full w-full items-center justify-between gap-3 rounded-lg border border-line bg-panel px-panel py-4 text-left shadow-elev-1 transition-colors hover:border-amber/60 hover:bg-panel2 focus-visible:border-amber"
            >
              <span className="text-lead font-medium text-ink">{label}</span>
              <span className="flex shrink-0 items-center gap-2">
                {fullApp && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-caption text-muted" title={t('simple.shell.fullAppHint')}>
                    {t('simple.shell.fullApp')}
                  </span>
                )}
                <span aria-hidden="true" className="text-muted">
                  →
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
