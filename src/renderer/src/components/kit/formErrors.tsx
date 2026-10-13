import { useCallback, useEffect, useRef, useState } from 'react'
import { mapError, type CaughtError, type MappedErrors } from '@shared/errors'
import type { Translate } from '@shared/i18n'

/**
 * Field errors for a form (WP 8.5, plan §1.7). `form` names the form's fields and their current
 * values — `useFormErrors({ party: partyId, date, lines: rows })`. An error set on a field stays
 * until that field's value changes (so it is gone once the field is fixed), and `apply(err)`
 * places a caught save error with the shared mapping (shared/errors): every issue with a field
 * the form shows lands under it; what is left comes back as `general` for the caller to show
 * (a toast in the accountant shell). Accountant screens keep the service's own wording
 * (`simple: false`); simple screens show only the plain t() message.
 */
export interface FormErrors<F extends string> {
  /** The current message of `field` (pass to `<Field error>`), or null. */
  get: (field: F) => string | null
  /** Any field in error. */
  any: boolean
  set: (field: F, message: string) => void
  /** Clear one field, or every field. */
  clear: (field?: F) => void
  /** Place a caught error; returns the mapping (its `general` is what found no field). */
  apply: (err: unknown) => MappedErrors
}

export interface ErrorShell {
  simple: boolean
  t: Translate
}

export function useFormErrors<F extends string>(form: Record<F, unknown>, shell: ErrorShell): FormErrors<F> {
  const [errors, setErrors] = useState<Partial<Record<F, string>>>({})
  // The value each field had when its error was set — a different value clears it.
  const snap = useRef<Partial<Record<F, unknown>>>({})
  const formRef = useRef(form)
  formRef.current = form
  const shellRef = useRef(shell)
  shellRef.current = shell

  useEffect(() => {
    const stale = (Object.keys(errors) as F[]).filter((f) => !Object.is(form[f], snap.current[f]))
    if (stale.length === 0) return
    setErrors((cur) => {
      const next = { ...cur }
      for (const f of stale) {
        delete next[f]
        delete snap.current[f]
      }
      return next
    })
  })

  const set = useCallback((field: F, message: string) => {
    snap.current[field] = formRef.current[field]
    setErrors((cur) => ({ ...cur, [field]: message }))
  }, [])

  const clear = useCallback((field?: F) => {
    if (field === undefined) {
      snap.current = {}
      setErrors({})
      return
    }
    delete snap.current[field]
    setErrors((cur) => {
      if (!(field in cur)) return cur
      const next = { ...cur }
      delete next[field]
      return next
    })
  }, [])

  const apply = useCallback((err: unknown): MappedErrors => {
    const caught: CaughtError = err instanceof Error ? (err as CaughtError) : { message: String(err) }
    const fields = Object.keys(formRef.current) as F[]
    const mapped = mapError(caught, { ...shellRef.current, fields })
    const placed = Object.entries(mapped.fields) as [F, string][]
    if (placed.length) {
      for (const [f] of placed) snap.current[f] = formRef.current[f]
      setErrors(Object.fromEntries(placed) as Partial<Record<F, string>>)
    }
    return mapped
  }, [])

  const get = useCallback((field: F): string | null => errors[field] ?? null, [errors])

  return { get, any: Object.keys(errors).length > 0, set, clear, apply }
}

/** An error for something that isn't a single control (a line grid, the item table) — the same
 *  look and wiring as Field's error slot. */
export function FieldError({ name, error, className = '' }: { name: string; error: string | null | undefined; className?: string }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p role="alert" data-field-error={name} data-testid={`field-error-${name}`} className={`mt-1 text-hint text-danger ${className}`}>
      {error}
    </p>
  )
}
