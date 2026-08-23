import { Kbd, Modal } from './ui'
import { NAV_SECTIONS, SCREENS } from '../lib/screens'
import { useAccelStore } from '../lib/screenAccels'
import { LIST_SHORTCUTS } from './ui'

interface ShortcutRow {
  keys: string[]
  label: string
  /** Bound, but shadowed or unavailable right now. */
  dimmed?: boolean
}

interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

/**
 * Only these three are hand-written, because they are the only shortcuts bound directly in
 * App.tsx's `nav` layer rather than declared as data.
 */
const GLOBAL_ROWS: ShortcutRow[] = [
  { keys: ['⌘K'], label: 'Open the command palette' },
  { keys: ['Esc'], label: 'Leave a field, close a dialog, or go back a screen' },
  { keys: ['?'], label: 'Show this shortcut reference' }
]

/**
 * Everything else is generated: the navigation groups from the screen registry, and "This
 * screen" from the accelerators the visible screen actually published. The old version restated
 * VoucherEntry's F-keys by hand and bound nothing, so it could describe shortcuts that no longer
 * existed; now the same declaration drives the binding, the hint bar and this overlay.
 */
function useShortcutGroups(): ShortcutGroup[] {
  const screenActions = useAccelStore((s) => s.actions)

  const navGroups = NAV_SECTIONS.map((section) => ({
    title: section.title ?? 'Go to',
    rows: SCREENS.filter((s) => s.navSection === section.id && s.accel).map((s) => ({
      keys: [s.accel!],
      label: s.navLabel ?? s.title
    }))
  })).filter((g) => g.rows.length > 0)

  const thisScreen: ShortcutGroup[] = screenActions.some((a) => !a.hidden)
    ? [
        {
          title: 'This screen',
          rows: screenActions
            .filter((a) => !a.hidden)
            .map((a) => ({
              keys: [
                ...(a.ctrlOrAlt ? ['Ctrl/Alt'] : []),
                ...(a.fkey ? [a.fkey] : []),
                ...(a.key ? [a.key.toUpperCase()] : [])
              ],
              label: a.label,
              dimmed: !a.enabled
            }))
        }
      ]
    : []

  return [
    { title: 'Global', rows: GLOBAL_ROWS },
    ...thisScreen,
    ...navGroups,
    { title: 'Lists', rows: LIST_SHORTCUTS }
  ]
}

export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const groups = useShortcutGroups()
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <p className="mb-4 text-[12.5px] text-muted">
        Every menu item has one letter highlighted in red — press it to go there, from any screen.
        A letter the current screen has taken over shows grey in the sidebar.
      </p>
      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{group.title}</p>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div
                  key={`${group.title}-${row.label}`}
                  className={`flex items-center justify-between gap-4 ${row.dimmed ? 'opacity-45' : ''}`}
                >
                  <span className="text-[13px] text-ink">{row.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.keys.map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
