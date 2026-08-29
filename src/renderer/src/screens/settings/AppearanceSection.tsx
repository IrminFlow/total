import {
  THEME_LABEL,
  THEME_ORDER,
  TEXT_SIZE_LABEL,
  TEXT_SIZE_SCALE,
  useA11y,
  useKeyPrefs,
  useTheme,
  type MotionPref,
  type TextSize,
  type Theme
} from '../../state/stores'
import { Kbd, Panel, SectionTitle } from '../../components/ui'
import { SCREENS } from '../../lib/screens'
import { SCREEN_KEY_CLAIMS, shortcutConflicts } from '../../lib/shortcutConflicts'

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
  const { keyboardOnly, vimKeys, setKeyboardOnly, setVimKeys } = useKeyPrefs()

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
        <Choice<'off' | 'on'>
          label="Keyboard only"
          // Said as a consequence rather than a feature: the user is choosing what the screen
          // will look like, and "row actions stop appearing under the pointer" is the change.
          hint="Row actions stop appearing on hover. They show for the accent selection bar and for Tab instead, so everything visible is something the keyboard can reach."
          name="keyboard-only"
          value={keyboardOnly ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Show on hover' },
            { value: 'on', label: 'Keyboard only' }
          ]}
          onChange={(v) => setKeyboardOnly(v === 'on')}
        />
        <Choice<'off' | 'on'>
          label="Vim keys on lists"
          // The cost is stated because it is not obvious and it is not small: G is Gateway.
          hint="Adds gg and G to jump to the first and last row of a list. While a list is on screen this takes over G, which is otherwise the Gateway — ⌘1 still goes home."
          name="vim-keys"
          value={vimKeys ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'gg / G' }
          ]}
          onChange={(v) => setVimKeys(v === 'on')}
        />
      </Panel>
      <ShortcutConflicts />
    </div>
  )
}

/**
 * Settings → Appearance → "Shortcuts that change meaning" (#21).
 *
 * The layer stack already does the right thing: a screen's own letters sit above the navigation
 * ones, so `C` starts a contra on voucher entry rather than jumping to Cost centres. The problem
 * was never the behaviour, it was that the behaviour was undiscoverable — the sidebar greys the
 * shadowed letter out only while the screen that took it is open, which explains it at exactly
 * the moment nobody is looking at the sidebar.
 *
 * Read-only on purpose. Remapping was declined (#22) and the reason holds: every surface in the
 * app renders the shortcut it binds from the binding, and `V` meaning voucher entry on every
 * machine in the office is the thing a Tally user relies on. Naming the collisions is the part of
 * that complaint worth fixing.
 */
function ShortcutConflicts(): React.JSX.Element {
  const conflicts = shortcutConflicts(SCREENS, SCREEN_KEY_CLAIMS)

  return (
    <div>
      <SectionTitle>Shortcuts that change meaning</SectionTitle>
      <Panel>
        <div className="px-5 py-3.5">
          <p className="text-small text-muted">
            A screen&rsquo;s own keys win while it is open, so a few navigation letters do something
            different there. The sidebar greys them out at the time; this is the whole list.
          </p>
          {conflicts.length === 0 ? (
            <p className="mt-3 text-body">No screen currently takes over a navigation letter.</p>
          ) : (
            <table className="ledger-table mt-3" data-testid="shortcut-conflicts">
              <thead>
                <tr>
                  <th scope="col" className="w-16">Key</th>
                  <th scope="col">On</th>
                  <th scope="col">Does</th>
                  <th scope="col">Instead of going to</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={`${c.screen}-${c.key}`}>
                    <td><Kbd>{c.key}</Kbd></td>
                    <td>{c.screenTitle}</td>
                    <td>{c.action}</td>
                    <td className="text-muted">{c.shadows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
