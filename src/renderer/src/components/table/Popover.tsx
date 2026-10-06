import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * Small anchored panel for the table's menus (filters, columns, views). Portalled to <body> with
 * fixed positioning so the table's own scroll container can't clip it. Closes on Esc (captured,
 * so the screen's Esc-to-go-back never sees it), on a mousedown outside, and on window resize.
 */
export function Popover({
  anchor,
  onClose,
  children,
  label,
  align = 'left',
  width = 260,
  testId
}: {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  /** Accessible name of the dialog. */
  label: string
  align?: 'left' | 'right'
  width?: number
  testId?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const id = useId()

  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const vw = window.innerWidth || 1024
      let left = align === 'right' ? r.right - width : r.left
      left = Math.max(8, Math.min(left, vw - width - 8))
      setPos({ top: r.bottom + 4, left })
    }
    place()
  }, [anchor, align, width])

  useEffect(() => {
    // Focus the first control so the popover is keyboard-usable straight away.
    const node = ref.current
    const el = node?.querySelector<HTMLElement>('input, select, button, [tabindex]:not([tabindex="-1"])')
    el?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        anchor.current?.focus() // Esc returns focus to the trigger
        onCloseRef.current()
      }
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onCloseRef.current()
    }
    const onResize = (): void => onCloseRef.current()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      id={id}
      data-testid={testId}
      data-table-popover=""
      style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
      className="z-50 rounded-lg border border-line bg-panel p-3 text-detail text-ink shadow-2xl"
    >
      {children}
    </div>,
    document.body
  )
}

/** Button that toggles a Popover anchored to itself. */
export function PopoverButton({
  label,
  children,
  popoverLabel,
  render,
  open,
  setOpen,
  active = false,
  align,
  width,
  testId,
  title,
  className = ''
}: {
  label: string
  children: ReactNode
  popoverLabel: string
  render: (close: () => void) => ReactNode
  open: boolean
  setOpen: (open: boolean) => void
  active?: boolean
  align?: 'left' | 'right'
  width?: number
  testId?: string
  title?: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={title ?? label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen(!open)}
        className={`rounded-md border px-2 py-1 text-small transition-colors ${
          active || open ? 'border-amber/60 text-ink' : 'border-line text-muted hover:border-amber/60 hover:text-ink'
        } bg-panel2 ${className}`}
      >
        {children}
      </button>
      {open && (
        <Popover anchor={ref} onClose={() => setOpen(false)} label={popoverLabel} align={align} width={width} testId={testId && `${testId}-popover`}>
          {render(() => {
            ref.current?.focus() // closing from inside (Apply, a menu pick) returns focus to the trigger
            setOpen(false)
          })}
        </Popover>
      )}
    </>
  )
}
