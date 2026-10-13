// Structured errors (WP 8.5, plan 2026-10-13 §1.7): a service throws an AppError whose
// `message` is exactly the wording it always had (the accountant shell and every log keep it)
// and whose `code` / `field` / `params` let a screen put a plain message under the field that
// caused it. Pure — no Electron, no DB.

import type { ErrorCode } from './codes'

/** Values a plain message interpolates (amounts already formatted by money.ts, names, dates). */
export type ErrorParams = Record<string, string | number>

/** One problem of a save — several when the posting rules find more than one. */
export interface ErrorIssue {
  code: string
  /** Form field path ('date', 'party', 'lines.2.amount', 'gstin' …) when known. */
  field?: string
  /** Index into lines[] for a line-specific posting error. */
  line?: number
  params?: ErrorParams
  /** The issue's own technical wording (the accountant fallback for that field). */
  message?: string
}

/** What crosses IPC next to `error` (the message) in a failed `{ ok: false }` result. */
export interface StructuredError {
  code: string
  field?: string
  params?: ErrorParams
  issues?: ErrorIssue[]
}

export class AppError extends Error {
  readonly code: ErrorCode
  // `declare`: no own property unless set — callers test `'issues' in err` to spot a ZodError.
  declare readonly field?: string
  declare readonly params?: ErrorParams
  declare readonly issues?: ErrorIssue[]

  constructor(code: ErrorCode, message: string, opts: { field?: string; params?: ErrorParams; issues?: ErrorIssue[] } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    const self = this as { field?: string; params?: ErrorParams; issues?: ErrorIssue[] }
    if (opts.field !== undefined) self.field = opts.field
    if (opts.params !== undefined) self.params = opts.params
    if (opts.issues !== undefined) self.issues = opts.issues
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError || (err instanceof Error && err.name === 'AppError' && typeof (err as { code?: unknown }).code === 'string')
}

/** The structured part of an AppError (undefined fields dropped), or null for a plain Error. */
export function structuredOf(err: unknown): StructuredError | null {
  if (!isAppError(err)) return null
  const out: StructuredError = { code: err.code }
  if (err.field !== undefined) out.field = err.field
  if (err.params !== undefined) out.params = err.params
  if (err.issues !== undefined) out.issues = err.issues
  return out
}
