// Error → form placement (WP 8.5). Both shells use it: a simple screen shows only the plain
// `t()` message of each issue; the accountant shell keeps the wording the service always had
// (the fallback text) — at the field when the issue has one, as a message for the form when not.

import type { MessageKey, Translate } from '../i18n'
import { ERROR_MAP, isErrorCode, type ErrorMapEntry } from './codes'
import type { ErrorIssue, ErrorParams, StructuredError } from './appError'

/** Anything a screen catches: an Error, optionally carrying the structured fields from IPC. */
export type CaughtError = { message: string } & Partial<StructuredError>

export interface MappedErrors {
  /** Field path → message, for the fields the form shows. */
  fields: Record<string, string>
  /** What has no field on this form (null when every issue found its field). */
  general: string | null
  /** The technical wording, for "Details" (simple mode). */
  details: string
}

export interface MapOptions {
  /** Simple shell: plain t() messages only. Accountant: the service's own wording. */
  simple: boolean
  t: Translate
  /** Fields the form renders. An issue whose field isn't here moves up its path ('lines.2.amount'
   *  → 'lines'), else to `general`. Omitted = every field is accepted. */
  fields?: readonly string[]
}

/** Zod issues arrive as 'zod.<issue code>' with the payload path as the field. */
function zodEntry(code: string, field: string | undefined): ErrorMapEntry {
  const last = field?.split('.').pop() ?? ''
  if (/gstin$/i.test(last)) return { key: 'errors.gstinInvalid' }
  if (/^pan$/i.test(last)) return { key: 'errors.panInvalid' }
  if (/date$/i.test(last)) return { key: 'errors.badDate' }
  if (last === 'name' && (code === 'zod.too_small' || code === 'zod.invalid_type')) return { key: 'errors.nameNeeded' }
  if (/amount$/i.test(last)) return { key: 'errors.enterAmount' }
  if (code === 'zod.too_small' || code === 'zod.invalid_type') return { key: 'errors.fieldNeeded' }
  return { key: 'errors.fieldInvalid' }
}

/** The registry entry for a code (zod issues by rule; unknown codes → null). */
export function errorEntry(code: string, field?: string): ErrorMapEntry | null {
  if (code.startsWith('zod.')) return zodEntry(code, field)
  return isErrorCode(code) ? ERROR_MAP[code] : null
}

function fieldOf(entry: ErrorMapEntry | null, issue: ErrorIssue): string | undefined {
  if (issue.field) return issue.field
  const tpl = entry?.field
  if (!tpl) return undefined
  if (tpl.includes('{line}')) return issue.line == null ? tpl.replace(/\.\{line\}.*$/, '') : tpl.replace('{line}', String(issue.line))
  return tpl
}

function plainText(entry: ErrorMapEntry, params: ErrorParams | undefined, t: Translate): string {
  const has = (entry.vars ?? []).every((v) => params?.[v] != null && params[v] !== '')
  const key: MessageKey = has ? entry.key : (entry.plainKey ?? entry.key)
  return t(key, params)
}

/** The issues of an error: its own list, or the error itself as one issue. */
export function issuesOf(err: CaughtError): ErrorIssue[] {
  if (err.issues?.length) return err.issues
  if (!err.code) return []
  return [{ code: err.code, ...(err.field ? { field: err.field } : {}), ...(err.params ? { params: err.params } : {}), message: err.message }]
}

/** Resolve `field` against the fields the form shows, walking up its path. */
function placeField(field: string | undefined, known: readonly string[] | undefined): string | null {
  if (!field) return null
  if (!known) return field
  const parts = field.split('.')
  while (parts.length) {
    const f = parts.join('.')
    if (known.includes(f)) return f
    parts.pop()
  }
  return null
}

export function mapError(err: CaughtError, opts: MapOptions): MappedErrors {
  const fields: Record<string, string> = {}
  const general: string[] = []
  const issues = issuesOf(err)
  const add = (bucket: string[], text: string): void => {
    if (!bucket.includes(text)) bucket.push(text)
  }
  for (const issue of issues) {
    const entry = errorEntry(issue.code, issue.field)
    const field = placeField(fieldOf(entry, issue), opts.fields)
    // Accountant wording: the issue's own message (posting rules carry one per issue), else the
    // error's — never rewritten.
    const own = issue.message ?? err.message
    const text = opts.simple ? (entry ? plainText(entry, issue.params ?? err.params, opts.t) : opts.t('errors.generic')) : own
    if (field) {
      fields[field] = fields[field] && fields[field] !== text ? `${fields[field]} ${text}` : text
    } else add(general, text)
  }
  if (issues.length === 0) add(general, opts.simple ? opts.t('errors.generic') : err.message)
  // Accountant shell, several issues but some unplaced: the joined service message reads as it
  // always did only when nothing was placed.
  const generalText = general.length === 0 ? null : !opts.simple && Object.keys(fields).length === 0 ? err.message : general.join(' ')
  return { fields, general: generalText, details: err.message }
}
