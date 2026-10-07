import { useEffect, useState, type ReactNode } from 'react'
import { useScreen } from '../../state/stores'
import { Drawer } from './Drawer'
import { Button } from './Button'
import { isAnyModalOpen } from './layers'

const WIDTHS = {
  /** forms and single-column flows (company details, year-end, import) */
  narrow: 'max-w-3xl',
  /** voucher entry, settings-style two-column pages */
  medium: 'max-w-4xl',
  /** reports and lists — the default */
  standard: 'max-w-5xl',
  /** wide registers (day book, GSTR-2B, e-documents) */
  wide: 'max-w-6xl'
} as const

export type PageWidth = keyof typeof WIDTHS

/** The screen container: centred, one of four widths. Every screen renders inside one. */
export function Page({
  width = 'standard',
  children,
  className = '',
  ...rest
}: {
  width?: PageWidth
  children: ReactNode
  className?: string
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div {...rest} className={`mx-auto ${WIDTHS[width]} ${className}`}>
      {children}
    </div>
  )
}

export interface PageOptions {
  /** The drawer body — DrawerSections with the screen's settings. */
  content: ReactNode
  /** Drawer subtitle (default: "Saved for this screen in this company"). */
  subtitle?: ReactNode
  /** Restores the screen's option defaults (shows a Reset button in the drawer footer). */
  onReset?: () => void
}

/**
 * The page header every screen uses:
 *
 *   [breadcrumb]
 *   Title  period/subtitle   [tabs]          [controls] [secondary] [primary] [Options]
 *
 * - `period` is the as-on / from–to label (mono, muted); `subtitle` is free text.
 * - `tabs` is a TabBar for the screen's primary views (stays visible — never in Options).
 * - `controls` holds always-visible selectors (the period/month picker, the bank account).
 * - `actions` is the primary action (one amber Button) and `secondary` any others.
 * - `options` adds the Options button (and F12) opening a right Drawer with the screen's
 *   settings — see components/ScreenOptions.tsx for the per-screen persistence hook.
 *
 * Testids: page-title, page-period, btn-<screen>-options, options-<screen> (the drawer).
 */
export function PageHeader({
  title,
  period,
  subtitle,
  breadcrumb,
  tabs,
  controls,
  secondary,
  actions,
  options,
  screen: screenProp,
  className = ''
}: {
  title: ReactNode
  period?: ReactNode
  subtitle?: ReactNode
  breadcrumb?: ReactNode
  tabs?: ReactNode
  controls?: ReactNode
  secondary?: ReactNode
  actions?: ReactNode
  options?: PageOptions
  /** Registry screen name for testids (default: the current screen). */
  screen?: string
  className?: string
}): React.JSX.Element {
  const current = useScreen()
  const screen = screenProp ?? current.name
  const [open, setOpen] = useState(false)
  const hasOptions = !!options

  // F12 — the Tally "configure" key — opens the screen's options (when no dialog is up).
  useEffect(() => {
    if (!hasOptions) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F12' || e.metaKey || e.ctrlKey || e.altKey || isAnyModalOpen()) return
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasOptions])

  const right = controls || secondary || actions || options
  return (
    <header className={`mb-section ${className}`} data-testid="page-header">
      {breadcrumb && <div className="mb-0.5 text-hint text-muted">{breadcrumb}</div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 data-testid="page-title" className="truncate font-serif text-heading font-semibold tracking-tight">
            {title}
          </h1>
          {period && (
            <span data-testid="page-period" className="num shrink-0 text-small whitespace-nowrap text-muted">
              {period}
            </span>
          )}
          {subtitle && <span className="min-w-0 truncate text-body-sm text-muted">{subtitle}</span>}
        </div>
        {tabs && <div className="flex items-center">{tabs}</div>}
        {right && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {controls}
            {secondary}
            {actions}
            {options && (
              <Button
                variant="ghost"
                data-testid={`btn-${screen}-options`}
                aria-haspopup="dialog"
                aria-expanded={open}
                title="Screen options (F12)"
                onClick={() => setOpen(true)}
                icon="⚙"
              >
                Options
              </Button>
            )}
          </div>
        )}
      </div>
      {open && options && (
        <Drawer
          title="Options"
          subtitle={options.subtitle ?? 'Saved for this screen in this company'}
          onClose={() => setOpen(false)}
          testId={`options-${screen}`}
          footer={
            <>
              {options.onReset && (
                <Button variant="ghost" data-testid={`options-${screen}-reset`} onClick={options.onReset}>
                  Reset to defaults
                </Button>
              )}
              <Button variant="primary" data-testid={`options-${screen}-done`} onClick={() => setOpen(false)}>
                Done
              </Button>
            </>
          }
        >
          {options.content}
        </Drawer>
      )}
    </header>
  )
}
