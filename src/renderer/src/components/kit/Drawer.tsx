import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogLayer } from './layers'
import { Kbd } from './Text'
import { IconButton } from './Button'

/**
 * Right-side panel over the screen: screen options, a record's details, filters. A dialog layer
 * like Modal — focus moves in and is trapped, Esc closes the topmost layer only (so a Modal opened
 * from a Drawer closes first), focus returns to the opener, keyboard lists behind it pause.
 * Clicking the scrim closes it.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 380,
  testId
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  /** Sticky actions at the bottom (Reset / Done …). */
  footer?: ReactNode
  width?: number
  testId?: string
}): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useDialogLayer(panelRef, () => onCloseRef.current())

  // z-30: under Modal (z-40) and popovers (z-50), so a dialog opened from the drawer (Change
  // period…, Cheque setup…) paints above it — the layer stack already gives it the keyboard.
  return createPortal(
    <div className="fixed inset-0 z-30 flex justify-end" data-drawer-root="">

      <div aria-hidden="true" className="absolute inset-0 bg-scrim" onMouseDown={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-drawer={title}
        data-testid={testId}
        style={{ width, maxWidth: '92vw' }}
        className="t-drawer-in relative flex h-full flex-col border-l border-line bg-raised shadow-elev-3 outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="font-serif text-title font-semibold">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-hint text-muted">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Kbd>Esc</Kbd>
            <IconButton label="Close" size="sm" data-testid="drawer-close" onClick={() => onCloseRef.current()}>
              ✕
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/** A titled group inside a Drawer (or any settings column). */
export function DrawerSection({
  title,
  children,
  testId
}: {
  title: string
  children: ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <section className="mb-5 last:mb-0" data-testid={testId} aria-label={title}>
      <h3 className="mb-2 text-label font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

/**
 * A docked right panel (WP 5.2, the assistant): sits BESIDE the screen in the layout (the screen
 * narrows) instead of over it on a scrim — not a dialog layer, so the screen stays usable (click a
 * figure, keep typing in a table) while it is open. Esc inside the panel calls `onClose`; keys
 * typed in it never reach the screen's shortcuts (⌘/Ctrl chords still do: ⌘K, ⌘J). The left edge
 * is a resize handle (drag, or ←/→ when focused), reported through `onResize` for the caller to
 * remember.
 */
export function DockedDrawer({
  title,
  subtitle,
  onClose,
  children,
  header,
  footer,
  width,
  minWidth = 340,
  maxWidth = 760,
  onResize,
  testId
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  /** A strip under the title (toolbar, context). */
  header?: ReactNode
  footer?: ReactNode
  width: number
  minWidth?: number
  maxWidth?: number
  onResize?: (width: number) => void
  testId?: string
}): React.JSX.Element {
  const titleId = useId()
  const clamp = (w: number): number => Math.round(Math.min(maxWidth, Math.max(minWidth, w)))
  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onResize) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    const move = (ev: PointerEvent): void => onResize(clamp(w0 + (x0 - ev.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.metaKey || e.ctrlKey) return // ⌘K / ⌘J and friends stay global
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
    e.stopPropagation()
  }
  return (
    <aside
      aria-labelledby={titleId}
      data-drawer={title}
      data-docked=""
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={{ width }}
      className="t-drawer-in relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-raised"
    >
      {onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel"
          aria-valuenow={width}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          tabIndex={0}
          data-testid={testId ? `${testId}-resize` : undefined}
          onPointerDown={startDrag}
          onDoubleClick={() => onResize(clamp(480))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault()
              onResize(clamp(width + (e.key === 'ArrowLeft' ? 24 : -24)))
            }
          }}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none hover:bg-amber/30 focus-visible:bg-amber/40"
        />
      )}
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h2 id={titleId} className="font-serif text-title font-semibold">
            {title}
          </h2>
          {subtitle && <div className="mt-0.5 truncate text-hint text-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Kbd>Esc</Kbd>
          <IconButton label="Close" size="sm" data-testid="drawer-close" onClick={onClose}>
            ✕
          </IconButton>
        </div>
      </div>
      {header && <div className="border-b border-line px-4 py-2">{header}</div>}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">{children}</div>
      {footer && <div className="border-t border-line px-4 py-3">{footer}</div>}
    </aside>
  )
}
