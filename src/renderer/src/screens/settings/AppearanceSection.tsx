import { Checkbox, Panel, SectionTitle } from '../../components/ui'
import { Segmented } from '../../components/kit/Segmented'
import { useAppearance, useTheme, type Density, type ThemePref } from '../../state/stores'
import { LANGUAGES } from '@shared/i18n'
import { useLanguageChoice } from '../../lib/mode'
import { ModeSetting } from '../../simple/ModeSetting'
import { useT } from '../../lib/i18n'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' }
]

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' }
]

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

/** Settings → "How Total looks" (WP 8.1; was Appearance): the company's mode (owner only —
 *  simple/ModeSetting.tsx), theme, density and motion — app-wide display preferences (this Mac) —
 *  and the language (per user: kept per company + user when someone is signed in; lib/i18n.ts).
 *  The owner's language choice is also written to meta `ui.language`, the company language
 *  `companyT` uses for what main prints. */
export function AppearanceSection(): React.JSX.Element {
  const { pref, setPref } = useTheme()
  const { density, setDensity, reduceMotion, setReduceMotion } = useAppearance()
  const { language, setLanguage, setsCompany: canSetCompany } = useLanguageChoice()
  const t = useT()
  const languages = LANGUAGES.map((value) => ({ value, label: t(`settings.language.${value}` as const) }))
  return (
    <div>
      <SectionTitle>How Total looks</SectionTitle>
      <Panel>
        <ModeSetting />
        <Row title="Theme" hint="Warm light, deep navy dark, or follow macOS.">
          <Segmented label="Theme" options={THEMES} value={pref} onChange={setPref} testId="btn-theme-pref" />
        </Row>
        <Row title="Density" hint="Row height, control size and spacing. Tables follow it unless a saved view picks its own.">
          <Segmented label="Density" options={DENSITIES} value={density} onChange={setDensity} testId="btn-density" />
        </Row>
        <Row title="Motion" hint="Turn off animations even when macOS allows them.">
          <Checkbox label="Reduce motion" checked={reduceMotion} onChange={setReduceMotion} testId="input-reduce-motion" />
        </Row>
        <Row title={t('settings.language.title')} hint={canSetCompany ? `${t('settings.language.hint')} ${t('settings.language.companyNote')}` : t('settings.language.hint')}>
          <Segmented label={t('settings.language.title')} options={languages} value={language} onChange={setLanguage} testId="btn-language" />
        </Row>
      </Panel>
      <p className="mt-2 text-hint text-muted">The mode is kept with this company (changing it never touches the books). Theme, density and motion apply to every company on this Mac. Language is kept for each person — per company and user when someone signs in.</p>
    </div>
  )
}
