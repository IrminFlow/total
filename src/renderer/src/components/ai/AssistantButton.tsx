import { Kbd } from '../ui'
import { useAssistantPanel } from './AssistantPanel'

/**
 * The header's "Assistant ⌘J" button (WP 5.2) — one component for both shells; the accountant
 * header passes its English wording, the simple header t() strings (WP 8.1).
 */
export function AssistantButton({
  label,
  title,
  openLabel,
  closeLabel,
  shortcut,
  className
}: {
  label: string
  title: string
  openLabel: string
  closeLabel: string
  shortcut: string
  className: string
}): React.JSX.Element {
  const toggle = useAssistantPanel((s) => s.toggle)
  const open = useAssistantPanel((s) => s.open)
  return (
    <button type="button" data-testid="btn-assistant" className={className} onClick={toggle} title={title} aria-label={open ? closeLabel : openLabel} aria-pressed={open}>
      <span className="flex items-center gap-2">
        {label} <Kbd>{shortcut}</Kbd>
      </span>
    </button>
  )
}
