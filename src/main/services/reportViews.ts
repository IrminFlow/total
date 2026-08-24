/**
 * Saved report views.
 *
 * A view is the state of a report screen with a name on it: the period, the visible columns, the
 * flags. Nothing about what the report computes, only about how it is asked for — so restoring
 * one can never change a number, only which numbers you are looking at.
 *
 * The state blob is opaque here on purpose. Validating its shape in the main process would mean
 * revising a Zod schema every time a screen gains a filter, and a stale schema would refuse to
 * save a view that is perfectly good. It is checked for being JSON and for a size limit, and the
 * screen that wrote it is the only thing that reads it.
 */

import type { DB } from '../db/connection'
import { writeAudit } from './audit'

/** Big enough for any column/filter set, small enough that nobody stores a report in here. */
const MAX_STATE_BYTES = 16_000

export interface ReportView {
  id: number
  screen: string
  name: string
  state: unknown
  createdAt: string
}

interface ViewRow {
  id: number
  screen: string
  name: string
  state_json: string
  created_at: string
}

function mapRow(r: ViewRow): ReportView {
  let state: unknown = null
  try {
    state = JSON.parse(r.state_json)
  } catch {
    // A row whose blob no longer parses is still worth listing — the user can delete it. Silently
    // dropping it would make a view that exists in the database invisible in the UI.
    state = null
  }
  return { id: r.id, screen: r.screen, name: r.name, state, createdAt: r.created_at }
}

export function listReportViews(db: DB, screen?: string): ReportView[] {
  const rows = screen
    ? (db.prepare('SELECT * FROM report_views WHERE screen = ? ORDER BY name').all(screen) as ViewRow[])
    : (db.prepare('SELECT * FROM report_views ORDER BY screen, name').all() as ViewRow[])
  return rows.map(mapRow)
}

/**
 * Save (or replace) a view. Saving over an existing name is an update rather than an error: the
 * gesture people actually make is "save the March view again with the new column", and forcing
 * a delete first would only produce two views one character apart.
 */
export function saveReportView(db: DB, screen: string, name: string, state: unknown): ReportView {
  const json = JSON.stringify(state ?? null)
  if (json.length > MAX_STATE_BYTES) throw new Error('That view carries too much state to save')

  const existing = db.prepare('SELECT * FROM report_views WHERE screen = ? AND name = ?').get(screen, name) as
    | ViewRow
    | undefined

  if (existing) {
    db.prepare('UPDATE report_views SET state_json = ? WHERE id = ?').run(json, existing.id)
    const updated = mapRow(db.prepare('SELECT * FROM report_views WHERE id = ?').get(existing.id) as ViewRow)
    writeAudit(db, 'report_view', existing.id, 'update', mapRow(existing), updated)
    return updated
  }

  const res = db
    .prepare('INSERT INTO report_views (screen, name, state_json) VALUES (?, ?, ?)')
    .run(screen, name, json)
  const created = mapRow(db.prepare('SELECT * FROM report_views WHERE id = ?').get(res.lastInsertRowid) as ViewRow)
  writeAudit(db, 'report_view', created.id, 'create', null, created)
  return created
}

export function deleteReportView(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM report_views WHERE id = ?').get(id) as ViewRow | undefined
  if (!existing) throw new Error('Saved view not found')
  db.prepare('DELETE FROM report_views WHERE id = ?').run(id)
  writeAudit(db, 'report_view', id, 'delete', mapRow(existing), null)
}
