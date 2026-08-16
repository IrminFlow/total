import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatPaise, parseRupees } from '@shared/money'
import { parseSmartDate, toDisplayDate } from '@shared/dates'
import { useToasts } from '../state/stores'

// ---------- text + labels ----------

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
      {children}
    </kbd>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="font-serif text-[19px] font-semibold tracking-tight whitespace-nowrap">{children}</h2>
      {right}
    </div>
  )
}

/** Signed paise rendered ledger-style: Dr green / Cr red, mono, dash for zero. */
export function Money({ paise, signed = false, className = '' }: { paise: number; signed?: boolean; className?: string }): React.JSX.Element {
  const tone = signed ? (paise > 0 ? 'text-dr' : paise < 0 ? 'text-cr' : 'text-muted') : ''
  return <span className={`num ${tone} ${className}`}>{formatPaise(signed ? Math.abs(paise) : paise, { zeroDash: true })}{signed && paise !== 0 ? (paise > 0 ? ' Dr' : ' Cr') : ''}</span>
}

// ---------- controls ----------

export const inputCls =
  'w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[13.5px] text-ink placeholder:text-muted/60 focus:border-amber/60'

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11.5px] text-cr">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] text-muted/80">{hint}</span>
      ) : null}
    </label>
  )
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} {...props} className={`${inputCls} ${props.className ?? ''}`} />
  }
)

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function Button({
  variant = 'default',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }): React.JSX.Element {
  const styles = {
    default: 'border border-line bg-panel hover:border-amber/60 text-ink panel-shadow',
    primary: 'border border-amberbar bg-amberbar/90 text-[#2b2000] hover:bg-amberbar font-semibold',
    danger: 'border border-cr/50 bg-cr/10 text-cr hover:bg-cr/20',
    ghost: 'border border-transparent text-muted hover:text-ink hover:border-line'
  }[variant]
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${props.className ?? ''}`}
    />
  )
}

/** Rupee amount input that thinks in integer paise. */
export function AmountInput({
  paise,
  onPaise,
  onEnter,
  autoFocus,
  placeholder,
  className
}: {
  paise: number | null
  onPaise: (paise: number | null) => void
  onEnter?: () => void
  autoFocus?: boolean
  placeholder?: string
  className?: string
}): React.JSX.Element {
  const [text, setText] = useState(paise != null && paise !== 0 ? formatPaise(paise) : '')
  useEffect(() => {
    // Reflect external resets (e.g. clearing a form).
    if (paise == null || paise === 0) setText((t) => (parseRupees(t) ? t : ''))
  }, [paise])
  return (
    <input
      className={`${inputCls} num text-right ${className ?? ''}`}
      value={text}
      autoFocus={autoFocus}
      placeholder={placeholder ?? '0.00'}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value)
        onPaise(parseRupees(e.target.value))
      }}
      onBlur={() => {
        const parsed = parseRupees(text)
        if (parsed != null) setText(formatPaise(parsed))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter()
      }}
    />
  )
}

/** Date input with Tally shorthand: "7", "7/4", "y", "t". Shows DD-MMM-YY when valid. */
export function DateInput({
  value,
  context,
  onChange,
  className
}: {
  value: string
  context: string
  onChange: (iso: string) => void
  className?: string
}): React.JSX.Element {
  const [text, setText] = useState(toDisplayDate(value))
  const [bad, setBad] = useState(false)
  useEffect(() => setText(toDisplayDate(value)), [value])
  return (
    <input
      className={`${inputCls} num ${bad ? 'border-cr/70' : ''} ${className ?? ''}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        const parsed = parseSmartDate(text, context) ?? (text.trim() === toDisplayDate(value) ? value : null)
        if (parsed) {
          setBad(false)
          onChange(parsed)
          setText(toDisplayDate(parsed))
        } else {
          setBad(true)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

// ---------- panels + modal ----------

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`rounded-lg border border-line bg-panel panel-shadow overflow-hidden ${className}`}>{children}</div>
}

export function Modal({
  title,
  onClose,
  children,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]" onMouseDown={onClose}>
      <div
        className={`max-h-[75vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto rounded-xl border border-line bg-panel shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="font-serif text-[16px] font-semibold">{title}</h3>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            Esc
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Toasts(): React.JSX.Element {
  const { toasts, dismiss } = useToasts()
  const tones = {
    info: 'border-blue/50 text-blue',
    success: 'border-dr/50 text-dr',
    error: 'border-cr/60 text-cr',
    warning: 'border-amber/60 text-amber'
  }
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-lg border bg-panel px-4 py-2.5 text-left text-[13px] shadow-xl ${tones[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}

// ---------- keyboard list navigation (the amber bar) ----------

export function useKeyNav(count: number, onEnter: (index: number) => void, enabled = true): {
  active: number
  setActive: (i: number) => void
} {
  const [active, setActive] = useState(0)
  const countRef = useRef(count)
  countRef.current = count
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1)
  }, [count, active])
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(countRef.current - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        setActive((a) => {
          if (countRef.current > 0) onEnter(a)
          return a
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onEnter])
  return { active, setActive }
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string
  hint?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-[14px] text-muted">{title}</p>
      {hint && <p className="mt-1 text-[12.5px] text-muted/70">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
