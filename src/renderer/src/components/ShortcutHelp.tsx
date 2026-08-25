import { useMemo, useState } from 'react'
import { Kbd, Modal, TextInput } from './ui'
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
 * Only these are hand-written, because they are the only shortcuts bound directly in App.tsx's
 * `nav` layer rather than declared as data. Every row here has a binding a few lines away from
 * the one that renders it — that adjacency is what keeps this list honest.
 */
const GLOBAL_ROWS: ShortcutRow[] = [
  { keys: ['⌘K'], label: 'Open the command palette' },
  { keys: ['Esc'], label: 'Leave a field, close a dialog, or go back a screen' },
  { keys: ['⌘['], label: 'Back a screen' },
  { keys: ['⌘]'], label: 'Forward again, after going back' },
  { keys: ['⌘`'], label: 'Switch to the last screen — hold ⌘ to pick from the last eight' },
  { keys: ['⌘1', '…', '⌘9'], label: 'Jump to the first nine sidebar entries' },
  { keys: ['⌘F'], label: 'Focus the filter box, on screens that have one' },
  { keys: ['⌘D'], label: 'On a list: start a new voucher shaped like the selected one' },
  { keys: ['⌘⇧F'], label: 'Search, scoped to this screen' },
  { keys: ['⌘⇧L'], label: 'Lock the books immediately' },
  { keys: ['⌘⇧P'], label: 'Change the working period — presets, arrows, ↵ to apply' },
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

  // Everything the screen publishes, including the actions the footer bar has no room for —
  // this overlay is the reference, and a binding documented nowhere is a binding nobody finds.
  const thisScreen: ShortcutGroup[] = screenActions.length
    ? [
        {
          title: 'This screen',
          rows: screenActions
            .map((a) => ({
              keys: a.display ?? [
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

/**
 * Filter the whole reference by what the user is looking for.
 *
 * The overlay outgrew one screen a while ago — thirty-odd navigation letters, plus whatever the
 * current screen publishes, plus the list keys. Searching matches the LABEL and the KEYS, because
 * both are things people arrive knowing: "what does ⌘D do" is as common a question as "how do I
 * get to the day book", and a reference that only answers one of them is half a reference.
 *
 * Groups that end up empty disappear rather than showing an empty heading.
 */
function filterGroups(groups: ShortcutGroup[], query: string): ShortcutGroup[] {
  const q = query.trim().toLowerCase()
  if (q === '') return groups
  return groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.keys.some((k) => k.toLowerCase().includes(q)) ||
          // The group title counts too: typing "gst" should bring back the whole GST block.
          g.title.toLowerCase().includes(q)
      )
    }))
    .filter((g) => g.rows.length > 0)
}

export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const groups = useShortcutGroups()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterGroups(groups, query), [groups, query])
  const total = shown.reduce((n, g) => n + g.rows.length, 0)
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <p className="mb-3 text-body-sm text-muted">
        Every menu item has one letter highlighted in red — press it to go there, from any screen.
        A letter the current screen has taken over shows grey in the sidebar.
      </p>
      <TextInput
        autoFocus
        data-testid="input-shortcut-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search shortcuts — a key, a word, a screen…"
        className="mb-4"
      />
      {total === 0 && (
        <p className="py-6 text-center text-body text-muted">Nothing bound to “{query.trim()}”.</p>
      )}
      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        {shown.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{group.title}</p>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div
                  key={`${group.title}-${row.label}`}
                  data-testid="shortcut-row"
                  className={`flex items-center justify-between gap-4 ${row.dimmed ? 'opacity-45' : ''}`}
                >
                  <span className="text-detail text-ink">{row.label}</span>
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
