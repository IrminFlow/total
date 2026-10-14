import { useT } from '../lib/i18n'
import { useNav } from '../state/stores'
import { Page } from '../components/ui'
import { Button } from '../components/kit'
import { useHelpPanel } from '../help/store'
import { useTour } from '../help/tour'

const HOME = { name: 'gateway' } as const // i18n-technical

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line/70 px-panel py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-detail font-medium text-ink">{title}</p>
        <p className="text-hint text-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** WP 10.3: Settings → Help & tour — run the tour of Home again, open the help panel. */
export function HelpSettings(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  return (
    <Page width="narrow" data-testid="simple-help">
      <h1 className="mb-5 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.settings.helpTour')}</h1>
      <div className="rounded-lg border border-line bg-panel shadow-elev-1">
        <Row title={t('simple.helpSettings.tour')} hint={t('simple.helpSettings.tourHint')}>
          <Button
            variant="primary"
            data-testid="btn-help-show-tour"
            onClick={() => {
              nav.go(HOME)
              useTour.getState().start()
            }}
          >
            {t('simple.helpSettings.tourButton')}
          </Button>
        </Row>
        <Row title={t('simple.helpSettings.help')} hint={t('simple.helpSettings.helpHint')}>
          <Button data-testid="btn-help-open" onClick={() => useHelpPanel.getState().openList()}>
            {t('simple.helpSettings.helpButton')}
          </Button>
        </Row>
      </div>
    </Page>
  )
}
