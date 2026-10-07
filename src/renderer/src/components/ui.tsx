import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatPaise, parseRupees } from '@shared/money'
import { parseSmartDate, toDisplayDate } from '@shared/dates'
import { useToasts } from '../state/stores'
import { Button, IconButton } from './kit/Button'
import { Kbd } from './kit/Text'
import { inputCls, useFieldAria } from './kit/Field'
import { isAnyModalOpen, layerCount, topModalElement, useDialogLayer } from './kit/layers'

// The design-system kit lives in components/kit (see kit/README.md). Everything is re-exported
// here so existing `from '../components/ui'` imports keep working.
export { Button, IconButton, buttonClass } from './kit/Button'
export type { ButtonProps, ButtonVariant, ButtonSize } from './kit/Button'
export { Kbd, SectionTitle, Money } from './kit/Text'
export { Field, TextInput, Select, Textarea, Checkbox, inputCls, inputSmCls, useFieldAria } from './kit/Field'
export { Spinner, Skeleton, SkeletonRows, SkeletonTiles, EmptyState, Banner } from './kit/Feedback'
export type { Tone } from './kit/Feedback'
export { Badge, Chip } from './kit/Badge'
export { StatTile, StatGrid } from './kit/StatTile'
export { Toolbar, ToolbarSpacer } from './kit/Toolbar'
export { TabBar, Tabs } from './kit/Tabs'
export type { TabItem } from './kit/Tabs'
export { Drawer, DrawerSection } from './kit/Drawer'
export { Page, PageHeader } from './kit/PageHeader'
export type { PageOptions, PageWidth } from './kit/PageHeader'
export { Segmented } from './kit/Segmented'
export { Checklist } from './kit/Checklist'
export { isAnyModalOpen, topModalElement, registerEscapeLayer } from './kit/layers'

// ---------- controls ----------

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
    if (paise == null || paise === 0) setText((t) => (parseRupees(t) ? t : ''))
  }, [paise])
  const invalid = text.trim() !== '' && parseRupees(text) == null
  const fieldAria = useFieldAria()
  return (
    <span className={`block min-w-0 ${className ?? ''}`}>
      <input
        className={`${inputCls} num text-right ${invalid ? 'border-danger/70' : ''}`}
        data-testid={testId}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder ?? '0.00'}
        inputMode="decimal"
        aria-describedby={fieldAria['aria-describedby']}
        aria-invalid={invalid || fieldAria['aria-invalid'] || undefined}
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
      {invalid && <span className="mt-0.5 block text-hint text-danger">Not an amount</span>}
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
  const fieldAria = useFieldAria()
  return (
    <span className={`block min-w-0 ${className ?? ''}`}>
      <input
        className={`${inputCls} num ${bad ? 'border-danger/70' : ''}`}
        data-testid={testId}
        value={text}
        aria-describedby={fieldAria['aria-describedby']}
        aria-invalid={bad || fieldAria['aria-invalid'] || undefined}
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
      {bad && <span className="mt-0.5 block text-hint text-danger">Try 7, 7/4, t, y or 15-08-2026</span>}
    </span>
  )
}

// ---------- panels + modal ----------

export function Panel({
  children,
  className = '',
  scroll
}: {
  children: ReactNode
  className?: string
  /** Cap the panel's content height — anything longer scrolls inside the panel instead of
   *  growing the page (Gateway top-lists, Settings backups, …). */
  scroll?: { maxH: string }
}): React.JSX.Element {
  return (
    <div className={`rounded-lg border border-line bg-panel panel-shadow overflow-hidden ${className}`}>
      {scroll ? (
        <div className="overflow-y-auto" style={{ maxHeight: scroll.maxH }}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

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

  // Dialog layer (kit/layers.ts): focus in on mount / restore on close, Tab trap, and Esc for the
  // topmost layer only. Esc on the discard prompt = keep editing.
  useDialogLayer(dialogRef, () => {
    if (confirmRef.current) setConfirmDiscard(false)
    else requestClose()
  })

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-scrim pt-[10vh]"
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
        className={`max-h-[75vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto rounded-xl border border-line bg-raised shadow-elev-3 outline-none`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 id={titleId} className="font-serif text-title font-semibold">
            {title}
          </h3>
          <div className="flex items-center gap-2">
            <Kbd>Esc</Kbd>
            <IconButton label="Close" size="sm" data-testid="modal-close" onClick={requestClose}>
              ✕
            </IconButton>
          </div>
        </div>
        <div className="p-5">{children}</div>
        {confirmDiscard && (
          <div className="flex items-center justify-between gap-3 border-t border-warning/50 bg-warning-soft px-5 py-3">
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
    info: 'border-info/50 text-info',
    success: 'border-success/50 text-success',
    error: 'border-danger/60 text-danger',
    warning: 'border-warning/60 text-warning'
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
          className={`pointer-events-auto rounded-lg border bg-raised px-4 py-2.5 text-left text-detail shadow-elev-2 ${tones[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}

// ---------- keyboard list navigation (the amber bar) ----------

/** Stack of mounted keyboard lists — only the topmost enabled list responds to ↑↓↵, so an
 *  overlay's list doesn't fight the screen's list underneath it. */
let keyNavSeq = 0
const keyNavStack: number[] = []
/** Each enabled list's container (its `claim` option), by stack id. */
const keyNavContainers = new Map<number, () => HTMLElement | null>()

/**
 * The list that owns ↑↓↵ right now. With no modal open: the top of the stack. With a modal
 * open: the topmost list whose container sits inside the topmost modal — lists behind the modal
 * (and lists without a `claim` container, which can't say where they live) are suspended.
 */
function keyboardOwner(): number | undefined {
  if (!isAnyModalOpen()) return keyNavStack[keyNavStack.length - 1]
  const modal = topModalElement()
  if (!modal) return undefined
  for (let i = keyNavStack.length - 1; i >= 0; i--) {
    const id = keyNavStack[i]!
    const el = keyNavContainers.get(id)?.()
    if (el && modal.contains(el)) return id
  }
  return undefined
}

/** Opt-in extras for useKeyNav (used by the DataTable platform; plain lists don't need them). */
export interface KeyNavOptions {
  /** Rows per PageUp (-1) / PageDown (+1). Setting it also enables PageUp/PageDown/Home/End. */
  pageSize?: (direction: 1 | -1) => number
  /** Replaces the default DOM scroll-into-view — for virtualised lists, whose active row may not
   *  be rendered at all (so there is no `.kbar-row[data-active]` element to scroll to). */
  scrollTo?: (index: number) => void
  /** The list's container. A pointerdown or focus landing inside it makes this list the keyboard
   *  target (moves it to the top of the stack) — for screens with several lists. It also says
   *  where the list lives: while a Modal is open only a list whose container is inside the
   *  topmost modal responds (lists without `claim` stay suspended under any modal). */
  claim?: () => HTMLElement | null
  /** Extra keys (e.g. ←/→ to collapse/expand). Runs under the same topmost/modal/input rules;
   *  return true when the key was handled (its default is then prevented). */
  onKey?: (e: KeyboardEvent, active: number) => boolean
}

export function useKeyNav(
  count: number,
  onEnter: (index: number) => void,
  enabled = true,
  options?: KeyNavOptions
): {
  active: number
  setActive: (i: number) => void
} {
  const [active, setActive] = useState(0)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const countRef = useRef(count)
  countRef.current = count
  const activeRef = useRef(active)
  activeRef.current = active
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  const idRef = useRef(0)
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1)
  }, [count, active])
  useEffect(() => {
    if (!enabled) return
    const id = ++keyNavSeq
    idRef.current = id
    keyNavStack.push(id)
    keyNavContainers.set(id, () => optionsRef.current?.claim?.() ?? null)
    const isTop = (): boolean => keyNavStack[keyNavStack.length - 1] === id
    const onKey = (e: KeyboardEvent): void => {
      // While a Modal is up it owns the keyboard — a screen's list behind it must not move its
      // selection (or fire Enter) from keys aimed at the dialog. A list INSIDE the topmost modal
      // (its `claim` container is within the dialog) keeps working.
      if (keyboardOwner() !== id) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      // In a dialog, focus usually sits on one of its buttons: Enter belongs to that button.
      if (e.key === 'Enter' && layerCount() > 0 && (e.target as Element).closest?.('button, a[href], [role="button"]')) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(countRef.current - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        // Side-effect outside the state updater — updaters can run twice under StrictMode.
        if (countRef.current > 0) onEnterRef.current(activeRef.current)
      } else if (optionsRef.current?.onKey && optionsRef.current.onKey(e, activeRef.current)) {
        e.preventDefault()
      } else if (optionsRef.current?.pageSize && ['PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        const last = Math.max(0, countRef.current - 1)
        const page = (dir: 1 | -1): number => Math.max(1, optionsRef.current?.pageSize?.(dir) ?? 1)
        if (e.key === 'PageDown') setActive((a) => Math.min(last, a + page(1)))
        else if (e.key === 'PageUp') setActive((a) => Math.max(0, a - page(-1)))
        else if (e.key === 'Home') setActive(0)
        else setActive(last)
      }
    }
    // Interaction claims the keyboard: move this list to the top of the stack.
    const onClaim = (e: Event): void => {
      const el = optionsRef.current?.claim?.()
      if (!el || !(e.target instanceof Node) || !el.contains(e.target) || isTop()) return
      const i = keyNavStack.indexOf(id)
      if (i >= 0) keyNavStack.splice(i, 1)
      keyNavStack.push(id)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onClaim, true)
    window.addEventListener('focusin', onClaim, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onClaim, true)
      window.removeEventListener('focusin', onClaim, true)
      const i = keyNavStack.indexOf(id)
      if (i >= 0) keyNavStack.splice(i, 1)
      keyNavContainers.delete(id)
    }
  }, [enabled])
  // Keep the active row visible as the selection moves. Rows follow the `.kbar-row` +
  // `data-active` convention; the last match wins because overlays render after the screen.
  useEffect(() => {
    if (enabled && keyboardOwner() !== idRef.current && keyNavStack[keyNavStack.length - 1] !== idRef.current) return
    const scrollTo = optionsRef.current?.scrollTo
    if (scrollTo) {
      scrollTo(active)
      return
    }
    const rows = document.querySelectorAll<HTMLElement>('.kbar-row[data-active="true"]')
    rows[rows.length - 1]?.scrollIntoView({ block: 'nearest' })
  }, [active, enabled])
  return { active, setActive }
}
