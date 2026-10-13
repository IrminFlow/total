import { useT } from '../lib/i18n'
import { useLanguageChoice } from '../lib/mode'
import { useAppearance, useTheme, type Density, type ThemePref } from '../state/stores'
import { Page } from '../components/ui'
import { Segmented } from '../components/kit/Segmented'
import { LANGUAGES } from '@shared/i18n'
import { ModeSetting } from './ModeSetting'

const THEMES: readonly ThemePref[] = ['light', 'dark', 'system'] // i18n-technical
const DENSITIES: readonly Density[] = ['comfortable', 'compact'] // i18n-technical

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

/**
 * WP 8.1: Settings → "How Total looks" in the simple shell — the company's mode (owner only), light
 * or dark, spacing and the language. Same state as the full app's Settings → How Total looks
 * (the theme / density stores, `useLanguageChoice`); nothing is duplicated.
 */
export function SimpleLooks(): React.JSX.Element {
  const t = useT()
  const { pref, setPref } = useTheme()
  const { density, setDensity } = useAppearance()
  const { language, setLanguage, setsCompany } = useLanguageChoice()
  const themeLabel = (v: ThemePref): string =>
    v === 'light' ? t('simple.looks.theme.light') : v === 'dark' ? t('simple.looks.theme.dark') : t('simple.looks.theme.system')
  const languageLabel = (v: (typeof LANGUAGES)[number]): string =>
    v === 'en' ? t('simple.looks.lang.en') : v === 'hi' ? t('simple.looks.lang.hi') : t('simple.looks.lang.hinglish')

  return (
    <Page width="narrow" data-testid="simple-looks">
      <h1 className="mb-5 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.settings.looks')}</h1>
      <div className="rounded-lg border border-line bg-panel shadow-elev-1">
        <ModeSetting />
        <Row title={t('simple.looks.theme')} hint={t('simple.looks.themeHint')}>
          <Segmented
            label={t('simple.looks.theme')}
            options={THEMES.map((value) => ({ value, label: themeLabel(value) }))}
            value={pref}
            onChange={setPref}
            testId="btn-theme-pref"
          />
        </Row>
        <Row title={t('simple.looks.density')} hint={t('simple.looks.densityHint')}>
          <Segmented
            label={t('simple.looks.density')}
            options={DENSITIES.map((value) => ({ value, label: value === 'compact' ? t('simple.looks.density.compact') : t('simple.looks.density.comfortable') }))}
            value={density}
            onChange={setDensity}
            testId="btn-density"
          />
        </Row>
        <Row title={t('simple.looks.language')} hint={setsCompany ? `${t('simple.looks.languageHint')} ${t('simple.looks.languageCompany')}` : t('simple.looks.languageHint')}>
          <Segmented
            label={t('simple.looks.language')}
            options={LANGUAGES.map((value) => ({ value, label: languageLabel(value) }))}
            value={language}
            onChange={setLanguage}
            testId="btn-language"
          />
        </Row>
      </div>
      <p className="mt-2 text-hint text-muted">{t('simple.looks.note')}</p>
    </Page>
  )
}
