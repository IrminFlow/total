import {
  THEME_LABEL,
  THEME_ORDER,
  TEXT_SIZE_LABEL,
  TEXT_SIZE_SCALE,
  useA11y,
  useTheme,
  type MotionPref,
  type TextSize,
  type Theme
} from '../../state/stores'
import { Panel, SectionTitle } from '../../components/ui'

/**
 * Settings → Appearance.
 *
 * The three preferences that describe the person at the desk rather than the books on it: how
 * much contrast they need, how big the type has to be, and whether movement makes them ill.
 * They are stored per machine, not per company, and applied to <html> before the first paint
 * (see main.tsx) so nothing flashes at the wrong size on launch.
 *
 * A radio group rather than a dropdown for each: three or four options that are compared against
 * one another are exactly what radios are for, and every option is then one Tab and one arrow
 * away instead of hidden behind a popup.
 */
export function AppearanceSection(): React.JSX.Element {
  const { theme, set: setTheme } = useTheme()
  const { textSize, motion, setTextSize, setMotion } = useA11y()

  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <p className="mb-4 text-body-sm text-muted">
        Stored on this machine, for every company you open here.
      </p>

      <Panel className="divide-y divide-line">
        <Choice<Theme>
          label="Theme"
          hint="High contrast trades the paper-and-ink palette for black on white, hard hairlines and AAA-contrast figures."
          name="theme"
          value={theme}
          options={THEME_ORDER.map((t) => ({ value: t, label: THEME_LABEL[t] }))}
          onChange={setTheme}
        />
        <Choice<TextSize>
          label="Text size"
          // Said out loud because it is the question anyone changing this is actually asking:
          // the tables stay dense, the letters get bigger. Row heights follow the text; the
          // gutters, gaps and column widths do not.
          hint="Scales every size in the app together. Column spacing is unchanged, so tables stay as dense as they are now."
          name="text-size"
          value={textSize}
          options={(Object.keys(TEXT_SIZE_SCALE) as TextSize[]).map((s) => ({
            value: s,
            label: TEXT_SIZE_LABEL[s]
          }))}
          onChange={setTextSize}
        />
        <Choice<MotionPref>
          label="Motion"
          hint="Follow the system setting, or reduce motion here regardless of what macOS is set to. Spinners keep a slow fade either way, so “still working” is never silent."
          name="motion"
          value={motion}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'reduced', label: 'Reduce motion' }
          ]}
          onChange={setMotion}
        />
      </Panel>
    </div>
  )
}

function Choice<T extends string>({
  label,
  hint,
  name,
  value,
  options,
  onChange
}: {
  label: string
  hint: string
  name: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <fieldset className="px-5 py-3.5">
      <legend className="text-body font-medium">{label}</legend>
      <p className="mt-0.5 mb-2 text-small text-muted">{hint}</p>
      <div className="flex flex-wrap gap-4">
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-body">
            <input
              type="radio"
              name={name}
              data-testid={`opt-${name}-${o.value}`}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
