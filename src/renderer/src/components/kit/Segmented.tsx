import { useRef } from 'react'

/**
 * A small one-of-N choice rendered as joined buttons (role="radiogroup" / "radio"): Light · Dark ·
 * System, Comfortable · Compact. ←/→ move and select (radio semantics), click selects.
 * Testids: `<testId>-<value>`.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
  size = 'md'
}: {
  /** Accessible name of the group. */
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  testId?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pick = (i: number): void => {
    const n = options.length
    const next = options[(i + n) % n]!
    onChange(next.value)
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(i + n) % n]?.focus()
  }
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md border border-line bg-panel2 p-0.5">
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-testid={testId && `${testId}-${o.value}`}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick(i + 1)
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick(i - 1)
              else return
              e.preventDefault()
              e.stopPropagation()
            }}
            className={`rounded px-3 whitespace-nowrap transition-colors ${size === 'sm' ? 'py-0.5 text-small' : 'py-1 text-detail'} ${
              on ? 'bg-panel font-medium text-ink shadow-elev-1 ring-1 ring-line' : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
