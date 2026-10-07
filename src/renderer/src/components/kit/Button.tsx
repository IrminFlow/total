import { forwardRef, type ReactNode } from 'react'
import { Spinner } from './Feedback'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  secondary: 'border border-line bg-panel text-ink shadow-elev-1 hover:border-amber/60',
  primary: 'border border-amberbar bg-amberbar/90 font-semibold text-on-amber hover:bg-amberbar',
  danger: 'border border-danger/50 bg-danger-soft text-danger hover:border-danger',
  ghost: 'border border-transparent text-muted hover:border-line hover:text-ink'
}

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-control px-3 py-1 text-detail',
  sm: 'min-h-control-sm px-2 py-0.5 text-small'
}

/** Class string for something that should LOOK like a Button (a label wrapping a file input…). */
export function buttonClass(variant: ButtonVariant | 'default' = 'secondary', size: ButtonSize = 'md'): string {
  const v = variant === 'default' ? 'secondary' : variant
  return `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40 ${SIZES[size]} ${VARIANTS[v]}`
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `default` is the historical name of `secondary` — both render the same outlined button. */
  variant?: ButtonVariant | 'default'
  size?: ButtonSize
  /** Shows a spinner, disables the button and sets aria-busy; the label stays for width. */
  loading?: boolean
  /** Leading icon (decorative — give icon-only buttons an aria-label, or use IconButton). */
  icon?: ReactNode
  /** Tooltip shown while the button is disabled — rendered on a wrapping span, since a
   *  pointer-events-none disabled button can't surface `title` itself. */
  disabledTitle?: string
}

/**
 * The one button. Variants: primary (amber, one per view), secondary (default outline), ghost
 * (toolbar/inline), danger. Sizes md (control height, follows density) and sm (toolbars).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, disabledTitle, children, className, disabled, ...props },
  ref
) {
  const isDisabled = disabled || loading
  const button = (
    <button
      ref={ref}
      type="button"
      {...props}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`${buttonClass(variant, size)} ${className ?? ''}`}
    >
      {loading ? <Spinner className="!h-3.5 !w-3.5" label={null} /> : icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  )
  if (isDisabled && disabledTitle) {
    return (
      <span title={disabledTitle} className="inline-block cursor-not-allowed">
        {button}
      </span>
    )
  }
  return button
})

/** Square icon-only button; `label` becomes its accessible name and tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label: string; children: ReactNode; size?: ButtonSize }
>(function IconButton({ label, children, size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={props.title ?? label}
      {...props}
      className={`inline-flex items-center justify-center rounded-md border border-transparent leading-none text-muted transition-colors hover:border-line hover:text-ink disabled:pointer-events-none disabled:opacity-40 ${
        size === 'sm' ? 'h-control-sm w-control-sm text-small' : 'h-control w-control text-subtitle'
      } ${className ?? ''}`}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  )
})
