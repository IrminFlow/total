import { forwardRef, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatPaise, parseRupees } from '@shared/money'
import { isExpression, parseAmountExpression } from '@shared/amountExpr'
import { parseSmartDate, toDisplayDate } from '@shared/dates'
import { useAnnouncer, useKeyPrefs, useToasts } from '../state/stores'
import { isBlocked, isPlainKey, isTypingTarget, topLayer, useKeyLayer } from '../lib/keyboard'
import { splitAccel } from '../lib/accel'

// ---------- text + labels ----------

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-md border border-line bg-panel2 px-1.5 py-0.5 font-mono text-micro text-muted">
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
    // The accelerator isn't a letter of the label — show it as a key badge.
    //
    // Drawn as a key, not as coloured text. Rendered the same way as an in-label letter, a
    // trailing "5" beside "Fixed assets" reads as a count of five things needing attention; a
    // digit next to "Disclosure" reads as six unread items. A bordered key cap cannot be
    // mistaken for a number about the data.
    return (
      <span>
        {label}
        {accel ? (
          <span
            className={`ml-1.5 rounded-md border px-1 font-mono text-micro leading-none ${
              muted ? 'border-line text-muted' : 'border-accel/40 text-accel'
            }`}
            aria-hidden="true"
          >
            {accel}
          </span>
        ) : null}
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
      <h2 className="font-serif text-section font-semibold tracking-tight whitespace-nowrap">{children}</h2>
      {right}
    </div>
  )
}

// ---------- page layout ----------

/**
 * The outer wrapper for a screen's content.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never centres. `mx-auto` was the reason the content column jumped left and right on
 *    every navigation: a narrow form centred itself in the window while the wide table beside it
 *    in the nav order started at the gutter. Left-aligned, the first column of every screen lands
 *    in the same place and the eye stops re-finding it.
 *  - It never sizes to its content. `h-full flex flex-col min-h-0` lets a table or a report fill
 *    the window and scroll inside itself, instead of ending halfway down and leaving the bottom
 *    half of the screen as empty cream. Children that should absorb the slack take `flex-1
 *    min-h-0 overflow-auto`.
 *
 * `wide` is for tables and reports, `narrow` for forms and prose — a form measured against the
 * full width of a 1600px window is unreadable and its fields end up a foot apart.
 */
export function PageFrame({
  width = 'wide',
  children,
  className = ''
}: {
  width?: 'wide' | 'narrow'
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-frame={width}
      className={`flex h-full min-h-0 w-full flex-col ${width === 'narrow' ? 'max-w-[760px]' : 'max-w-[1440px]'} ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * Title, tabs and toolbar for a screen — the one place a page speaks above a whisper.
 *
 * The title is `text-page` (24px) and `whitespace-nowrap`: hand-rolled copies of this header sized
 * the title at 19px and let it wrap, so "Voucher entry" arrived broken across two lines while the
 * toolbar beside it had room to spare.
 *
 * `children` is the toolbar slot — buttons, period pickers, export actions — and sits on the
 * title's baseline, right-aligned. `tabs` goes underneath, against the rule, so switching tabs
 * never moves the title.
 */
export function ScreenHeader({
  title,
  tabs,
  children
}: {
  title: ReactNode
  tabs?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <header className="mb-3 shrink-0">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-page font-semibold tracking-tight whitespace-nowrap">{title}</h1>
        {children ? <div className="flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
      </div>
      {tabs ? <div className="mt-2.5 border-b border-line pb-2">{tabs}</div> : null}
    </header>
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

/**
 * A caller-supplied width beats `inputCls`'s own `w-full`.
 *
 * Tailwind emits `.w-full` *after* the numeric widths in the stylesheet, and both have the same
 * specificity — so the order of the class attribute is irrelevant and `<Select className="w-36">`
 * rendered full-width anyway. Every width override on a Select or TextInput in the app was
 * silently doing nothing. Dropping the base width when the call site names one is the only merge
 * that honours what it asked for.
 *
 * Only a plain `w-*` counts: `max-w-*` and `min-w-*` are meant to be combined with `w-full`.
 */
const OWN_WIDTH = /(?:^|\s)!?w-\S+/
export function mergeInputCls(className?: string): string {
  if (!className) return inputCls
  const base = OWN_WIDTH.test(className) ? inputCls.replace('w-full ', '') : inputCls
  return `${base} ${className}`
}

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-micro font-semibold tracking-[0.08em] text-muted uppercase">{label}</span>
      {children}
      {error ? (
        // role="alert" so the message is announced when it appears. A validation error the user
        // has to act on is exactly the case a polite region is allowed to sit on indefinitely.
        <span role="alert" className="mt-1 block text-micro text-cr">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-micro text-muted/80">{hint}</span>
      ) : null}
    </label>
  )
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} {...props} className={mergeInputCls(props.className)} />
  }
)

/**
 * The app's only <select>. `appearance-none` is what stops macOS painting its own double-chevron
 * in its own blue-grey — the loudest off-brand element on any screen with a filter bar. The
 * replacement caret and the room made for it live on the element rule in app.css, so a select
 * that ever gets hand-written elsewhere still looks like this one.
 */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`appearance-none ${mergeInputCls(props.className)}`} />
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
      className={`rounded-md px-3 py-1.5 text-body transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${props.className ?? ''}`}
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
      {invalid && <span className="mt-0.5 block text-micro text-cr">Not an amount</span>}
      {preview && (
        <span className="mt-0.5 block text-right text-micro text-muted" data-testid={`${testId}-preview`}>
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
  // An OPTIONAL date field holds '' when it is unset, and toDisplayDate('') indexes into a
  // split that isn't there and throws — which took the whole screen down through the error
  // boundary the moment a modal with an empty date opened (the transport modal's document
  // date). Empty in, empty out.
  const show = (v: string): string => (v ? toDisplayDate(v) : '')
  const [text, setText] = useState(show(value))
  const [bad, setBad] = useState(false)
  useEffect(() => setText(show(value)), [value])
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
          const parsed = parseSmartDate(text, context) ?? (text.trim() === show(value) ? value : null)
          if (parsed) {
            setBad(false)
            onChange(parsed)
            setText(show(parsed))
          } else {
            // An empty box over an unset date is the field's resting state, not a typo.
            setBad(!(text.trim() === '' && value === ''))
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {bad && <span className="mt-0.5 block text-micro text-cr">Try 7, 7/4, t, y or 15-08-2026</span>}
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
    /** A panel is often the thing a test wants to assert on; without this it silently swallows
     *  the attribute and the selector never matches. */
    'data-testid'?: string
  }
>(function Panel({ children, className = '', scroll, onKeyDown, ...rest }, ref): React.JSX.Element {
  return (
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      {...rest}
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
  className = '',
  onPaste
}: {
  maxH: string
  children: ReactNode
  className?: string
  onPaste?: (e: React.ClipboardEvent) => void
}): React.JSX.Element {
  return (
    <div className={`overflow-y-auto ${className}`} style={{ maxHeight: maxH }} onPaste={onPaste}>
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
  maxH = '340px',
  onPaste
}: {
  active: boolean
  children: ReactNode
  className?: string
  maxH?: string
  /** Paste handler for the whole grid — a pasted spreadsheet table belongs to the table, not to
   *  whichever cell happened to have focus. Passed through both branches so the behaviour does
   *  not change the moment a voucher grows past eight lines and starts scrolling. */
  onPaste?: (e: React.ClipboardEvent) => void
}): React.JSX.Element {
  return active ? (
    <ScrollList maxH={maxH} className={className} onPaste={onPaste}>
      {children}
    </ScrollList>
  ) : (
    <div className={className} onPaste={onPaste}>
      {children}
    </div>
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

/**
 * The focus trap, as one implementation (#280).
 *
 * Every overlay in the app needs the same three things and they are easy to get 2-of-3 right:
 *
 *   1. focus moves INTO the overlay when it opens — otherwise the caret is still on the row
 *      behind it and the first Tab walks the page under the dimmer;
 *   2. Tab and Shift+Tab wrap at the ends — otherwise focus escapes to the sidebar and the user
 *      is operating a screen they cannot see;
 *   3. focus goes BACK to whatever opened it on close — otherwise it falls to <body> and the
 *      next Tab restarts from the top of the app.
 *
 * The Command palette had (1) only, via `autoFocus` on its input, which is exactly the 2-of-3
 * this hook exists to stop happening again.
 *
 * Tab is a capture-phase window listener rather than a key-layer entry: the trap has to beat the
 * browser's own default focus move, and the bubble-phase dispatcher runs too late for that.
 *
 * `isTop` lets a stack of overlays agree on which one owns the keyboard; the default traps
 * unconditionally, which is right for an overlay that can't be stacked on.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  opts: { isTop?: () => boolean; autoFocus?: boolean } = {}
): void {
  const { isTop, autoFocus = true } = opts
  const isTopRef = useRef(isTop)
  isTopRef.current = isTop

  // Captured during the first RENDER, not in the effect. React applies a child's `autoFocus`
  // during commit, which is before passive effects run — so an effect reading activeElement
  // finds the overlay's own input and "restores" focus to a node that is about to be unmounted.
  // That is how the Modal has been quietly failing to give focus back all along.
  const previousRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  )

  useEffect(() => {
    const previous = previousRef.current
    const container = ref.current
    if (autoFocus && container && !container.contains(document.activeElement)) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? container).focus()
    }
    return () => {
      // Guarded: the element that opened the overlay may itself have been unmounted by whatever
      // the overlay did (a row deleted, a screen navigated away from).
      if (previous?.isConnected) previous.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      if (isTopRef.current && !isTopRef.current()) return
      const container = ref.current
      if (!container) return
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const inside = container.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ref])
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

  // Focus in on mount, wrap at the ends, restore on close — and only while this dialog is the
  // top of the modal stack, so a ConfirmModal over a form modal traps against itself.
  useFocusTrap(dialogRef, { isTop: () => topLayer('modal')?.id === modalLayer.current })

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
          <h3 id={titleId} className="font-serif text-section font-semibold">
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
          <div className="flex items-center justify-between gap-3 border-t border-warnline bg-warnsoft px-5 py-3">
            <p className="text-body text-ink">Discard unsaved changes?</p>
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
    // Warnings use the ochre, not the amber: the amber is the selection bar and the primary
    // button, and a toast wearing it reads as something to click rather than something to read.
    warning: 'border-warnline text-warn'
  }
  return (
    // Pause/resume live on the container, not the toast: React still fires the container's
    // mouseEnter/Leave when the pointer moves over a child, and a hovered toast that gets
    // removed (click-dismiss, dedupe) can no longer strand the stack in the paused state.
    <div
      // Two live-region politeness levels would need two containers, and two containers would
      // stack toasts in two places on screen. One container, assertive only while it holds a
      // message the user has to act on: a polite region may be deferred indefinitely, which is
      // fine for "saved" and wrong for "could not save".
      aria-live={toasts.some((t) => t.kind === 'error' || t.kind === 'warning') ? 'assertive' : 'polite'}
      role="status"
      onMouseEnter={pause}
      onMouseLeave={resume}
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-3 rounded-lg border bg-panel px-4 py-2.5 text-left text-body shadow-xl ${tones[t.kind]}`}
        >
          {/* The message dismisses on click, as it always has. The action is a separate target
              so reaching for Undo can never dismiss the toast by missing it. */}
          <button className="flex-1 text-left" onClick={() => dismiss(t.id)}>
            {t.text}
          </button>
          {t.action && (
            <button
              data-testid="toast-action"
              className="shrink-0 rounded-md border border-current px-2 py-0.5 text-micro font-medium"
              onClick={() => {
                dismiss(t.id)
                void t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
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

/**
 * The app's single polite live region (#275) — mount once, near the toasts.
 *
 * Separate from <Toasts/> on purpose: that region flips to `assertive` while an error is up, and
 * a row-selection announcement sharing it would inherit the interruption and talk over the user
 * on every arrow press.
 */
export function LiveAnnouncer(): React.JSX.Element {
  const message = useAnnouncer((s) => s.message)
  return (
    <div data-testid="live-announcer" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}

// ---------- keyboard list navigation (the amber bar) ----------

/** How much of a row gets read out. A ledger row can carry ten columns; the first few identify
 *  it, and the rest is the reader talking for fifteen seconds before the next arrow press. */
const ANNOUNCE_MAX = 140

/**
 * What a screen reader should hear when the amber bar lands on a row.
 *
 * Cells are joined with commas rather than taken from `textContent`, because `textContent` runs
 * "12-Apr-26Sales/0007Acme Traders" together into one unreadable word. Position is read first:
 * "row 4 of 96" is the thing a sighted user gets for free from the scrollbar.
 */
function rowAnnouncement(row: HTMLElement, index: number, count: number): string {
  const cells = Array.from(row.querySelectorAll<HTMLElement>('td'))
  const text = (cells.length > 0 ? cells.map((c) => c.textContent ?? '') : [row.textContent ?? ''])
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
  const clipped = text.length > ANNOUNCE_MAX ? `${text.slice(0, ANNOUNCE_MAX)}…` : text
  return `Row ${index + 1} of ${count}${clipped ? `: ${clipped}` : ''}`
}

/** What `useKeyNav` binds, as data — ShortcutHelp renders this rather than restating it. */
export const LIST_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['↑', '↓'], label: 'Move the selection' },
  { keys: ['↵'], label: 'Open the selected row' },
  { keys: ['Home', 'End'], label: 'Jump to the first or last row' },
  { keys: ['PgUp', 'PgDn'], label: 'Move ten rows at a time' },
  { keys: ['⌘⌫'], label: 'Delete the selected row, with an undo on the toast' },
  // Advertised whether or not the preference is on: a shortcut nobody can find out about is a
  // shortcut nobody uses, and the row says where to turn it on.
  { keys: ['gg', 'G'], label: 'First / last row — vim keys, off until Settings → Appearance' }
]

/** Rows moved by PageUp/PageDown. Reports routinely run to hundreds of rows, so one screenful
 *  of arrow-key presses is not a realistic way to reach the bottom. */
const PAGE_JUMP = 10

/** How long a lone `g` waits for its partner before it stops meaning anything (vim keys). */
const G_CHORD_MS = 800

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
  // Whether the last move came from the keyboard. Only those are announced: a pointer user
  // sweeping down a table moves the selection dozens of times a second, and a live region fed
  // from that is a stuck record. Screen-reader users are on the keyboard by definition.
  const fromKeyboard = useRef(false)
  /** Timestamp of a lone `g` waiting for its partner; 0 when nothing is pending. */
  const gPending = useRef(0)
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1)
  }, [count, active])

  // A 'list' layer. Being below any modal in the stack is what keeps a screen's list from
  // reacting to keys aimed at a dialog on top of it — the old explicit modalStack check.
  const listLayer = useKeyLayer(
    'list',
    (e) => {
      if (isTypingTarget(e)) return false
      // Set for every key this layer might claim, before the branches: whichever one fires, the
      // move it causes is a keyboard move and should be spoken.
      fromKeyboard.current = true
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
      /**
       * Vim's `gg` and `G`, only when the preference is on (Settings → Appearance).
       *
       * Off by default and it has to be: `G` is the Gateway accelerator, and this layer sits
       * above the nav layer, so binding it here shadows the way home on every screen with a
       * list. Behind the preference it is a trade the user has made knowingly.
       *
       * The `gg` timeout is what stops a stray `g` from arming forever — a `g` pressed now and
       * another two minutes later is two separate keystrokes, not a jump to the top.
       */
      if (useKeyPrefs.getState().vimKeys && isPlainKey(e) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (e.key === 'G') {
          gPending.current = 0
          setActive(Math.max(0, countRef.current - 1))
          return true
        }
        if (Date.now() - gPending.current < G_CHORD_MS) {
          gPending.current = 0
          setActive(0)
        } else {
          gPending.current = Date.now()
        }
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
    const row = rows[rows.length - 1]
    row?.scrollIntoView({ block: 'nearest' })
    // Moving the amber bar changes nothing in the accessibility tree — no focus moves, no state
    // attribute a reader watches. Without this, arrowing down a 900-row day book is silence.
    if (!row || !fromKeyboard.current || countRef.current === 0) return
    useAnnouncer.getState().announce(rowAnnouncement(row, active, countRef.current))
  }, [active, enabled, listLayer])

  // The pointer path, wrapped so hover can mark itself as not-keyboard. Stable identity: screens
  // pass this straight into deps and into `rowProps`.
  const select = useCallback((i: number) => {
    fromKeyboard.current = false
    setActive(i)
  }, [])

  return { active, setActive: select }
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
    onClick?: (e: React.MouseEvent) => void
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
      // A click on a control inside the row is that control's click, not the row's. Without this
      // an action button in the last cell fires its own handler AND the row's, which on a screen
      // where both open a dialog means two dialogs stacked on top of each other.
      onClick: onEnter
        ? (e: React.MouseEvent) => {
            if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label')) return
            onEnter(row, index)
          }
        : undefined
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
      {hint && <p className="mt-1 text-body text-muted/70">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
