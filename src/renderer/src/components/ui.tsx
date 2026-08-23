import { forwardRef, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatPaise, parseRupees } from '@shared/money'
import { isExpression, parseAmountExpression } from '@shared/amountExpr'
import { parseSmartDate, toDisplayDate } from '@shared/dates'
import { useToasts } from '../state/stores'
import { isBlocked, isTypingTarget, topLayer, useKeyLayer } from '../lib/keyboard'
import { splitAccel } from '../lib/accel'

// ---------- text + labels ----------

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-md border border-line bg-panel2 px-1.5 py-0.5 font-mono text-label text-muted">
      {children}
    </kbd>
  )
}

/**
 * A label with its accelerator letter highlighted, e.g. Ba<span class=accel>l</span>ance sheet.
 *
 * The accessible name is unchanged because the text stays one contiguous run — screen readers
 * and Playwright's text matching both still see "Balance sheet".
 *
 * `muted` renders the letter grey instead of red: used when the current screen has claimed that
 * letter for itself, so the sidebar shows at a glance which shortcuts are temporarily shadowed
 * rather than leaving the user to discover it by pressing one.
 */
export function Accel({
  label,
  accel,
  at,
  muted = false
}: {
  label: string
  accel?: string
  at?: number
  muted?: boolean
}): React.JSX.Element {
  const { before, hit, after } = splitAccel(label, accel, at)
  if (!hit) {
    // The accelerator isn't a letter of the label (only TDS today) — show it as a trailing key.
    return (
      <span>
        {label}
        {accel ? <span className={`ml-1.5 ${muted ? 'accel-muted' : 'accel'}`}>{accel}</span> : null}
      </span>
    )
  }
  return (
    <span>
      {before}
      <span className={muted ? 'accel-muted' : 'accel'}>{hit}</span>
      {after}
    </span>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="font-serif text-heading font-semibold tracking-tight whitespace-nowrap">{children}</h2>
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
  'w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-body text-ink placeholder:text-muted/60 focus:border-amber/60'

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-hint text-cr">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-hint text-muted/80">{hint}</span>
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
  disabledTitle,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  /** Tooltip shown while the button is disabled — rendered on a wrapping span, since a
   *  pointer-events-none disabled button can't surface `title` itself. */
  disabledTitle?: string
}): React.JSX.Element {
  const styles = {
    default: 'border border-line bg-panel hover:border-amber/60 text-ink panel-shadow',
    primary: 'border border-amberbar bg-amberbar/90 text-onamber hover:bg-amberbar font-semibold',
    danger: 'border border-cr/50 bg-cr/10 text-cr hover:bg-cr/20',
    ghost: 'border border-transparent text-muted hover:text-ink hover:border-line'
  }[variant]
  const button = (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-detail transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${props.className ?? ''}`}
    />
  )
  if (props.disabled && disabledTitle) {
    return (
      <span title={disabledTitle} className="inline-block cursor-not-allowed">
        {button}
      </span>
    )
  }
  return button
}

/** Rupee amount input that thinks in integer paise. Shows an inline error while the text
 *  doesn't parse as an amount. */
export function AmountInput({
  paise,
  onPaise,
  onEnter,
  autoFocus,
  placeholder,
  className,
  testId = 'input-amount'
}: {
  paise: number | null
  onPaise: (paise: number | null) => void
  onEnter?: () => void
  autoFocus?: boolean
  placeholder?: string
  className?: string
  /** data-testid for the input (lib/testids.ts — `input-<what>`). */
  testId?: string
}): React.JSX.Element {
  const [text, setText] = useState(paise != null && paise !== 0 ? formatPaise(paise) : '')
  useEffect(() => {
    // Reflect external resets (e.g. clearing a form).
    if (paise == null || paise === 0) setText((t) => (parseAmountExpression(t) ? t : ''))
  }, [paise])

  const parsed = text.trim() === '' ? null : parseAmountExpression(text)
  const invalid = text.trim() !== '' && parsed == null
  // Only worth previewing when the user typed something a plain number parser would reject —
  // otherwise the preview just repeats what is already in the box.
  const preview = parsed != null && isExpression(text) ? formatPaise(parsed) : null

  return (
    <span className={`block min-w-0 ${className ?? ''}`}>
      <input
        className={`${inputCls} num text-right ${invalid ? 'border-cr/70' : ''}`}
        data-testid={testId}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder ?? '0.00'}
        inputMode="decimal"
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value)
          onPaise(parseAmountExpression(e.target.value))
        }}
        onBlur={() => {
          // Resolve the expression in place on blur, so what is stored and what is shown agree.
          if (parsed != null) setText(formatPaise(parsed))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter()
        }}
      />
      {invalid && <span className="mt-0.5 block text-hint text-cr">Not an amount</span>}
      {preview && (
        <span className="mt-0.5 block text-right text-hint text-muted" data-testid={`${testId}-preview`}>
          = {preview}
        </span>
      )}
    </span>
  )
}

/** Date input with Tally shorthand: "7", "7/4", "y", "t". Shows DD-MMM-YY when valid;
 *  an unparseable entry shows an inline error that clears as soon as you type again. */
export function DateInput({
  value,
  context,
  onChange,
  className,
  testId = 'input-date'
}: {
  value: string
  context: string
  onChange: (iso: string) => void
  className?: string
  /** data-testid for the input (lib/testids.ts — `input-<what>`). */
  testId?: string
}): React.JSX.Element {
  const [text, setText] = useState(toDisplayDate(value))
  const [bad, setBad] = useState(false)
  useEffect(() => setText(toDisplayDate(value)), [value])
  return (
    <span className={`block min-w-0 ${className ?? ''}`}>
      <input
        className={`${inputCls} num ${bad ? 'border-cr/70' : ''}`}
        data-testid={testId}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value)
          if (bad) setBad(false)
        }}
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
      {bad && <span className="mt-0.5 block text-hint text-cr">Try 7, 7/4, t, y or 15-08-2026</span>}
    </span>
  )
}

// ---------- panels + modal ----------

export const Panel = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode
    className?: string
    /** Cap the panel's content height — anything longer scrolls inside the panel instead of
     *  growing the page (Gateway top-lists, Settings backups, …). */
    scroll?: { maxH: string }
    /** Entry forms attach the Enter-chaining handler to the panel that wraps their fields. */
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  }
>(function Panel({ children, className = '', scroll, onKeyDown }, ref): React.JSX.Element {
  return (
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      className={`rounded-lg border border-line bg-panel panel-shadow overflow-hidden ${className}`}
    >
      {scroll ? (
        <div className="overflow-y-auto" style={{ maxHeight: scroll.maxH }}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
})

/** Bare capped-height scroll container for lists that already live inside a Panel (or none). */
export function ScrollList({
  maxH,
  children,
  className = ''
}: {
  maxH: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`overflow-y-auto ${className}`} style={{ maxHeight: maxH }}>
      {children}
    </div>
  )
}

/** ScrollList that only clips once `active` — for tables whose rows contain absolutely-
 *  positioned TypeAhead dropdowns, which any overflow container would clip while the table
 *  is short enough not to need scrolling (voucher entry line grids). */
export function LineTableScroller({
  active,
  children,
  className = '',
  maxH = '340px'
}: {
  active: boolean
  children: ReactNode
  className?: string
  maxH?: string
}): React.JSX.Element {
  return active ? (
    <ScrollList maxH={maxH} className={className}>
      {children}
    </ScrollList>
  ) : (
    <div className={className}>{children}</div>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * True while a dialog or the command palette owns the keyboard — screens use it to suppress
 * their own shortcuts so keys aimed at a dialog never leak to the screen underneath.
 *
 * Modal stacking (a ConfirmModal over a form modal) and "only the topmost list takes the
 * arrows" are both handled by the shared layer registry in lib/keyboard.ts now; this is kept
 * as the familiar name for the predicate.
 */
export const isAnyModalOpen = isBlocked

export function Modal({
  title,
  onClose,
  children,
  wide,
  dirty = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** When true, dismissing (Esc / overlay / ✕) first asks to discard unsaved changes. */
  dirty?: boolean
}): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const overlayMouseDown = useRef(false)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const confirmRef = useRef(confirmDiscard)
  confirmRef.current = confirmDiscard
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const requestClose = useCallback((): void => {
    if (confirmRef.current) return // discard prompt is already up — answer it instead
    if (dirtyRef.current) {
      setConfirmDiscard(true)
      return
    }
    onCloseRef.current()
  }, [])

  // Focus trap: move focus in on mount (unless a child autoFocus already took it), restore on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialog).focus()
    }
    return () => {
      previous?.focus?.()
    }
  }, [])

  // Escape goes through the layer registry as an OPAQUE layer: it closes this dialog and, by
  // being opaque, stops the key reaching the screen's own shortcuts or nav's Esc-to-go-back.
  const modalLayer = useKeyLayer(
    'modal',
    (e) => {
      if (e.key !== 'Escape') return false
      if (confirmRef.current) {
        setConfirmDiscard(false) // Esc on the discard prompt = keep editing
        return true
      }
      requestClose()
      return true
    },
    { opaque: true }
  )

  useEffect(() => {
    // Tab stays a capture-phase element listener: the focus trap has to beat the browser's own
    // default focus move, which the bubble-phase dispatcher runs too late to do.
    const isTop = (): boolean => topLayer('modal')?.id === modalLayer.current
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop()) return
      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        )
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        const inside = dialog.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [modalLayer])

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]"
      onMouseDown={(e) => {
        overlayMouseDown.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        // Dismiss only on a clean click that both starts AND ends on the overlay — a drag that
        // starts in a field and drifts outside must not nuke the modal.
        const outside = overlayMouseDown.current && e.target === e.currentTarget
        overlayMouseDown.current = false
        if (outside) requestClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal={title}
        tabIndex={-1}
        className={`max-h-[75vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto rounded-lg border border-line bg-panel shadow-2xl outline-none`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 id={titleId} className="font-serif text-title font-semibold">
            {title}
          </h3>
          <div className="flex items-center gap-2">
            <Kbd>Esc</Kbd>
            <button
              type="button"
              aria-label="Close"
              data-testid="modal-close"
              onClick={requestClose}
              className="rounded-md border border-transparent px-1.5 py-0.5 text-lead leading-none text-muted transition-colors hover:border-line hover:text-ink"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="p-5">{children}</div>
        {confirmDiscard && (
          <div className="flex items-center justify-between gap-3 border-t border-amber/60 bg-amber/10 px-5 py-3">
            <p className="text-detail text-ink">Discard unsaved changes?</p>
            <div className="flex shrink-0 gap-2">
              <Button data-testid="modal-keep-editing" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="danger" data-testid="modal-discard" onClick={() => onCloseRef.current()}>
                Discard
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function Toasts(): React.JSX.Element {
  const { toasts, dismiss, pause, resume } = useToasts()
  const tones = {
    info: 'border-blue/50 text-blue',
    success: 'border-dr/50 text-dr',
    error: 'border-cr/60 text-cr',
    warning: 'border-amber/60 text-amber'
  }
  return (
    // Pause/resume live on the container, not the toast: React still fires the container's
    // mouseEnter/Leave when the pointer moves over a child, and a hovered toast that gets
    // removed (click-dismiss, dedupe) can no longer strand the stack in the paused state.
    <div
      aria-live="polite"
      role="status"
      onMouseEnter={pause}
      onMouseLeave={resume}
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-lg border bg-panel px-4 py-2.5 text-left text-detail shadow-xl ${tones[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}

// ---------- loading primitives ----------

export function Spinner({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-amber ${className}`}
    />
  )
}

export function Skeleton({ className = '' }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={`block animate-pulse rounded-md bg-panel2 ${className}`} />
}

/** Placeholder rows while a list/report query is in flight — drop inside a Panel. */
export function SkeletonRows({ rows = 8, className = '' }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div aria-hidden="true" data-testid="skeleton-rows" className={`flex flex-col gap-2.5 p-4 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i % 3 === 0 ? 'w-2/3' : i % 3 === 1 ? 'w-full' : 'w-5/6'}`} />
      ))}
    </div>
  )
}

// ---------- keyboard list navigation (the amber bar) ----------

/** What `useKeyNav` binds, as data — ShortcutHelp renders this rather than restating it. */
export const LIST_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['↑', '↓'], label: 'Move the selection' },
  { keys: ['↵'], label: 'Open the selected row' },
  { keys: ['Home', 'End'], label: 'Jump to the first or last row' },
  { keys: ['PgUp', 'PgDn'], label: 'Move ten rows at a time' }
]

/** Rows moved by PageUp/PageDown. Reports routinely run to hundreds of rows, so one screenful
 *  of arrow-key presses is not a realistic way to reach the bottom. */
const PAGE_JUMP = 10

export function useKeyNav(count: number, onEnter: (index: number) => void, enabled = true): {
  active: number
  setActive: (i: number) => void
} {
  const [active, setActive] = useState(0)
  const countRef = useRef(count)
  countRef.current = count
  const activeRef = useRef(active)
  activeRef.current = active
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1)
  }, [count, active])

  // A 'list' layer. Being below any modal in the stack is what keeps a screen's list from
  // reacting to keys aimed at a dialog on top of it — the old explicit modalStack check.
  const listLayer = useKeyLayer(
    'list',
    (e) => {
      if (isTypingTarget(e)) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(countRef.current - 1, a + 1))
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
        return true
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setActive(0)
        return true
      }
      if (e.key === 'End') {
        e.preventDefault()
        setActive(Math.max(0, countRef.current - 1))
        return true
      }
      if (e.key === 'PageDown') {
        e.preventDefault()
        setActive((a) => Math.min(countRef.current - 1, a + PAGE_JUMP))
        return true
      }
      if (e.key === 'PageUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - PAGE_JUMP))
        return true
      }
      if (e.key === 'Enter') {
        // Side-effect outside the state updater — updaters can run twice under StrictMode.
        if (countRef.current > 0) onEnterRef.current(activeRef.current)
        return true
      }
      return false
    },
    { enabled, topOfKind: true }
  )
  // Keep the active row visible as the selection moves. Rows follow the `.kbar-row` +
  // `data-active` convention; the last match wins because overlays render after the screen.
  useEffect(() => {
    if (enabled && topLayer('list')?.id !== listLayer.current) return
    const rows = document.querySelectorAll<HTMLElement>('.kbar-row[data-active="true"]')
    rows[rows.length - 1]?.scrollIntoView({ block: 'nearest' })
  }, [active, enabled, listLayer])
  return { active, setActive }
}

/**
 * List navigation for a `.ledger-table` — `useKeyNav` plus the row markup it depends on.
 *
 * Rows are plain hand-written `<tr>`s all over this app (screens do their own colSpan maths,
 * expandable sub-rows, per-report column visibility), so a `<DataTable>` would mean rewriting
 * thousands of lines of screen code against a 13-scenario E2E suite. Instead `rowProps` emits
 * the three things the amber bar and the E2E harness rely on — `.kbar-row`, `data-active` and
 * `data-row-id` — so they cannot be typed correctly on one screen and wrongly on the next.
 *
 * Screens with several tables pass `enabled` for the visible one; the topmost enabled list is
 * the only one that reacts, so the tables never fight over the arrow keys.
 */
export function useTableNav<T>(
  rows: T[],
  opts: {
    onEnter?: (row: T, index: number) => void
    rowId?: (row: T, index: number) => string | number
    enabled?: boolean
  } = {}
): {
  active: number
  setActive: (i: number) => void
  rowProps: (index: number, row: T) => {
    'data-active': boolean
    'data-row-id'?: string | number
    className: string
    onMouseEnter: () => void
    onClick?: () => void
  }
} {
  const { onEnter, rowId, enabled = true } = opts
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const { active, setActive } = useKeyNav(
    rows.length,
    (index) => {
      const row = rowsRef.current[index]
      if (row !== undefined) onEnterRef.current?.(row, index)
    },
    enabled
  )

  return {
    active,
    setActive,
    rowProps: (index, row) => ({
      'data-active': index === active,
      'data-row-id': rowId ? rowId(row, index) : undefined,
      className: `kbar-row${onEnter ? ' cursor-pointer' : ''}`,
      onMouseEnter: () => setActive(index),
      onClick: onEnter ? () => onEnter(row, index) : undefined
    })
  }
}

export function EmptyState({
  title,
  hint,
  action,
  icon
}: {
  title: string
  hint?: string
  action?: ReactNode
  icon?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="mb-3 text-muted/50">{icon}</div>}
      <p className="text-lead text-muted">{title}</p>
      {hint && <p className="mt-1 text-body-sm text-muted/70">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
