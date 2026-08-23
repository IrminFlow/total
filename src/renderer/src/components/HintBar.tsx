import { useAccelStore } from '../lib/screenAccels'
import { Kbd } from './ui'

/**
 * A one-line strip under the content showing what the current screen's keys do.
 *
 * It reads the same declaration that binds the keys (`useScreenAccels`), so it cannot describe a
 * shortcut that does not exist — which is exactly how the old hand-written footer in
 * VoucherEntry drifted. Screens that declare nothing render nothing, so this costs no space on
 * the screens that do not need it.
 */
export function HintBar(): React.JSX.Element | null {
  const actions = useAccelStore((s) => s.actions).filter((a) => !a.hidden)
  if (actions.length === 0) return null

  return (
    <div
      data-testid="hint-bar"
      className="flex shrink-0 items-center gap-3 overflow-hidden border-t border-line px-5 py-1.5 text-hint whitespace-nowrap text-muted"
    >
      {actions.map((a) => (
        <span
          key={a.label}
          className={`flex items-center gap-1 ${a.enabled ? '' : 'opacity-40'}`}
          title={a.enabled ? undefined : 'Not available right now'}
        >
          {a.ctrlOrAlt && <Kbd>Ctrl/Alt</Kbd>}
          {a.fkey && <Kbd>{a.fkey}</Kbd>}
          {a.key && <Kbd>{a.key.toUpperCase()}</Kbd>}
          <span>{a.label}</span>
        </span>
      ))}
    </div>
  )
}
