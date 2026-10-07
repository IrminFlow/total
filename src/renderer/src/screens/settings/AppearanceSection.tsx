import { Checkbox, Panel, SectionTitle } from '../../components/ui'
import { Segmented } from '../../components/kit/Segmented'
import { useAppearance, useTheme, type Density, type ThemePref } from '../../state/stores'

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

/** Settings → Appearance: theme, density and motion — app-wide display preferences (this Mac). */
export function AppearanceSection(): React.JSX.Element {
  const { pref, setPref } = useTheme()
  const { density, setDensity, reduceMotion, setReduceMotion } = useAppearance()
  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <Panel>
        <Row title="Theme" hint="Warm light, deep navy dark, or follow macOS.">
          <Segmented label="Theme" options={THEMES} value={pref} onChange={setPref} testId="btn-theme-pref" />
        </Row>
        <Row title="Density" hint="Row height, control size and spacing. Tables follow it unless a saved view picks its own.">
          <Segmented label="Density" options={DENSITIES} value={density} onChange={setDensity} testId="btn-density" />
        </Row>
        <Row title="Motion" hint="Turn off animations even when macOS allows them.">
          <Checkbox label="Reduce motion" checked={reduceMotion} onChange={setReduceMotion} testId="input-reduce-motion" />
        </Row>
      </Panel>
      <p className="mt-2 text-hint text-muted">These apply to every company on this Mac and are never stored in the books.</p>
    </div>
  )
}
