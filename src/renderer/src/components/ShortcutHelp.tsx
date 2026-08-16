import { Kbd, Modal } from './ui'

interface ShortcutRow {
  keys: string[]
  label: string
}

interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

/** Static reference — mirrors the keydown handlers actually wired up in App.tsx (⌘K/Esc/?),
 *  Gateway.tsx (the single-letter card shortcuts), VoucherEntry.tsx (F4–F9 + the note variants
 *  + ⌘↵), and ui.tsx's `useKeyNav` (↑↓↵ on every list screen). Update this alongside those if the
 *  bindings ever change. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['⌘K'], label: 'Open the command palette' },
      { keys: ['Esc'], label: 'Close a dialog, or go back a screen' },
      { keys: ['?'], label: 'Show this shortcut reference' }
    ]
  },
  {
    title: 'Gateway',
    rows: [
      { keys: ['V'], label: 'Voucher entry' },
      { keys: ['D'], label: 'Day book' },
      { keys: ['M'], label: 'Masters' },
      { keys: ['T'], label: 'Trial balance' },
      { keys: ['P'], label: 'Profit & Loss' },
      { keys: ['B'], label: 'Balance sheet' },
      { keys: ['S'], label: 'Stock summary' },
      { keys: ['1'], label: 'GSTR-1' },
      { keys: ['3'], label: 'GSTR-3B' }
    ]
  },
  {
    title: 'Voucher entry',
    rows: [
      { keys: ['F4'], label: 'Contra' },
      { keys: ['F5'], label: 'Payment' },
      { keys: ['F6'], label: 'Receipt' },
      { keys: ['F7'], label: 'Journal' },
      { keys: ['F8'], label: 'Sales' },
      { keys: ['F9'], label: 'Purchase' },
      { keys: ['Ctrl/Alt', 'F8'], label: 'Credit note' },
      { keys: ['Ctrl/Alt', 'F9'], label: 'Debit note' },
      { keys: ['⌘', '↵'], label: 'Save the voucher' }
    ]
  },
  {
    title: 'Lists',
    rows: [
      { keys: ['↑', '↓'], label: 'Move the selection' },
      { keys: ['↵'], label: 'Open the selected row' }
    ]
  }
]

export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{group.title}</p>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4">
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
