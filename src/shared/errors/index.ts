// Plain errors that point at the field (WP 8.5) — see codes.ts (registry), appError.ts (what
// services throw and IPC carries) and map.ts (placement on a form, both shells).
export { AppError, isAppError, structuredOf } from './appError'
export type { ErrorIssue, ErrorParams, StructuredError } from './appError'
export { ERROR_MAP, isErrorCode, WITHHOLDING_ERROR_SUFFIXES } from './codes'
export type { ErrorCode, ErrorMapEntry } from './codes'
export { errorEntry, issuesOf, mapError } from './map'
export type { CaughtError, MapOptions, MappedErrors } from './map'
