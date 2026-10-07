import { createContext, forwardRef, useContext, useId, type ReactNode } from 'react'

/**
 * Input chrome. Height follows the density setting (min-h-control: 32px comfortable, 28px
 * compact); an invalid control gets a danger border. Use it for anything input-like that isn't a
 * TextInput/Select/Textarea (AmountInput, DateInput, TypeAhead pickers).
 */
export const inputCls =
  'w-full min-h-control rounded-md border border-line bg-panel2 px-control-x py-1 text-body text-ink placeholder:text-muted focus:border-amber/60 aria-[invalid=true]:border-danger/70'

/** inputCls without its `w-full` when the caller sizes the control itself (`w-40`, `!w-56`) —
 *  two width utilities would otherwise fight by stylesheet order, not by intent. */
export function controlCls(className?: string): string {
  const sized = !!className && /(^|\s)!?w-/.test(className)
  return `${sized ? inputCls.replace('w-full ', '') : inputCls} ${className ?? ''}`
}

/** Smaller control for toolbars (the table's quick filter, group-by select). */

export const inputSmCls = `${inputCls} !min-h-control-sm !py-0.5 !text-detail`

/** What a Field tells the control inside it: the ids of its hint/error text and whether it's in error. */
const FieldContext = createContext<{ describedBy?: string; invalid: boolean; inField?: boolean }>({
  invalid: false
})

/** True inside a Field — its label names the control, so a fallback aria-label must not override it. */
export function useInField(): boolean {
  return !!useContext(FieldContext).inField
}

/** aria props for a custom control inside a Field (TextInput/Select/Textarea apply them already). */
export function useFieldAria(): {
  'aria-describedby'?: string
  'aria-invalid'?: true
} {
  const f = useContext(FieldContext)
  return {
    'aria-describedby': f.describedBy,
    'aria-invalid': f.invalid || undefined
  }
}

/**
 * A labelled control: uppercase caption above, help text or an error below. The label wraps the
 * control (so clicking it focuses the control and the caption alone is its accessible name); the
 * help/error sits outside the label and is wired via aria-describedby.
 */
export function Field({
  label,
  children,
  hint,
  error,
  required,
  className = ''
}: {
  label: string
  children: ReactNode
  /** Help text under the control (hidden while an error shows). */
  hint?: ReactNode
  error?: string | null
  required?: boolean
  className?: string
}): React.JSX.Element {
  const id = useId()
  const msgId = error || hint ? `${id}-msg` : undefined
  return (
    <FieldContext.Provider value={{ describedBy: msgId, invalid: !!error, inField: true }}>

      <div className={className}>
        <label className="block">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">
            {label}
            {required && (
              <span className="ml-0.5 text-danger" aria-hidden="true">
                *
              </span>
            )}
          </span>
          {children}
        </label>
        {error ? (
          <span id={msgId} role="alert" className="mt-1 block text-hint text-danger">
            {error}
          </span>
        ) : hint ? (
          <span id={msgId} className="mt-1 block text-hint text-muted">
            {hint}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

type InvalidProp = {
  /** Marks the control invalid (danger border, aria-invalid) outside a Field. */ invalid?: boolean
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & InvalidProp>(function TextInput(
  { invalid, ...props },
  ref
) {
  const aria = useFieldAria()
  return (
    <input
      ref={ref}
      aria-describedby={aria['aria-describedby']}
      {...props}
      aria-invalid={invalid || aria['aria-invalid'] || props['aria-invalid'] || undefined}
      className={controlCls(props.className)}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & InvalidProp>(function Select(
  { invalid, ...props },
  ref
) {
  const aria = useFieldAria()
  return (
    <select
      ref={ref}
      aria-describedby={aria['aria-describedby']}
      {...props}
      aria-invalid={invalid || aria['aria-invalid'] || props['aria-invalid'] || undefined}
      className={controlCls(props.className)}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProp>(function Textarea(
  { invalid, ...props },
  ref
) {
  const aria = useFieldAria()
  return (
    <textarea
      ref={ref}
      aria-describedby={aria['aria-describedby']}
      {...props}
      aria-invalid={invalid || aria['aria-invalid'] || props['aria-invalid'] || undefined}
      className={controlCls(props.className)}
    />
  )
})

/** A labelled checkbox / switch row: box on the left, label and optional help text. */
export function Checkbox({
  label,
  checked,
  onChange,
  hint,
  disabled,
  testId
}: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: ReactNode
  disabled?: boolean
  testId?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <label className={`flex items-start gap-2 text-detail ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--t-focus)]"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-ink">{label}</span>
        {hint && (
          <span id={`${id}-hint`} className="block text-hint text-muted">
            {hint}
          </span>
        )}
      </span>
    </label>
  )
}
