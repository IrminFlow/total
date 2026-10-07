import type { ReactNode } from 'react'
import { inputCls } from '../../../components/ui'

/** Small form atoms shared by the template editor sections — token utilities only. */

export function Check({
  label,
  checked,
  onChange,
  disabled,
  testId,
  hint
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  testId?: string
  hint?: string
}): React.JSX.Element {
  return (
    <label className="flex items-start gap-2 text-body-sm">
      <input
        type="checkbox"
        className="mt-[3px]"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-hint text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  label,
  testId,
  allowEmpty = false,
  className = ''
}: {
  value: number | null
  onChange: (v: number | null) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  /** Accessible name. */
  label: string
  testId?: string
  /** Empty input → null (e.g. auto column width). */
  allowEmpty?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <input
      type="number"
      aria-label={label}
      data-testid={testId}
      className={`${inputCls} num ${className}`}
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={allowEmpty ? 'auto' : undefined}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return onChange(allowEmpty ? null : min)
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  disabled,
  label,
  testId
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  disabled?: boolean
  label: string
  testId?: string
}): React.JSX.Element {
  return (
    <textarea
      aria-label={label}
      data-testid={testId}
      value={value}
      rows={rows}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} disabled:opacity-60`}
    />
  )
}

/** A titled group inside a section. */
export function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }): React.JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <legend className="float-left mb-1 w-full text-caption font-semibold tracking-[0.08em] text-muted uppercase">{title}</legend>
      {hint && <p className="clear-left -mt-1 text-hint text-muted">{hint}</p>}
      <div className="clear-left flex flex-col gap-2.5">{children}</div>
    </fieldset>
  )
}

export function Row({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-2.5">{children}</div>
}
