/**
 * GSTR-1A, the amendment return (roadmap #353).
 *
 * The diff is pure and lives in src/shared/gst/gstr1a.ts, with the statutory position. What this
 * file adds is the half the books have to supply: a copy of WHAT WAS FILED.
 *
 * Without that copy there is nothing to amend against, and the alternative — diffing the books
 * against themselves — would report every period as clean, which is the most dangerous possible
 * answer for a screen whose whole job is to find the thing that changed after filing. So the
 * snapshot is taken deliberately, on the filing register's own record, and a period with no
 * snapshot says so rather than pretending.
 */

import type { DB } from '../db/connection'
import type { GstScope } from './registrations'
import { primaryRegistrationId } from './registrationId'
import type { GstDoc } from '@shared/gst/returns'
import { amendmentWindow, diffGstr1, type AmendmentWindow, type Gstr1aResult } from '@shared/gst/gstr1a'
import { extractOutwardDocs } from './gst'
import { filingPeriodBounds } from './filings'
import { writeAudit } from './audit'

/**
 * Freeze the outward documents of a filed period.
 *
 * Stored on the GSTR-1 filing row, because that is the row that says the return was filed and the
 * two facts belong together: a snapshot without a filing date is a copy of nothing in particular.
 * Overwriting an existing snapshot is allowed and is what a REVISED filing record does.
 */
export function snapshotGstr1(db: DB, company: GstScope, period: string): { period: string; docs: number } {
  const registrationId = company.registrationId ?? primaryRegistrationId(db)
  const row = db
    .prepare("SELECT id FROM gst_filings WHERE form = 'GSTR-1' AND period = ? AND registration_id IS ?")
    .get(period, registrationId) as { id: number } | undefined
  if (!row) {
    throw new Error(`No GSTR-1 filing recorded for ${period}. Record the filing first — the snapshot is a copy of what was filed.`)
  }
  const { from, to } = filingPeriodBounds(period)
  const docs = extractOutwardDocs(db, company, from, to)
  db.prepare("UPDATE gst_filings SET docs_json = ? WHERE form = 'GSTR-1' AND period = ? AND registration_id IS ?")
    .run(JSON.stringify(docs), period, registrationId)
  writeAudit(db, 'gst_filing', row.id, 'update', null, { snapshot: { period, docs: docs.length } })
  return { period, docs: docs.length }
}

export interface Gstr1aState {
  period: string
  from: string
  to: string
  /** Null until a snapshot has been taken. The screen's whole first question. */
  result: Gstr1aResult | null
  window: AmendmentWindow
  /** ISO date GSTR-1 was recorded as filed, or null. */
  gstr1FiledAt: string | null
  gstr3bFiledAt: string | null
  snapshotDocs: number | null
  /** What to do next, when there is nothing to diff. */
  message: string | null
}

/**
 * The amendment position for a period.
 *
 * Answers in three states rather than one, because they need three different things from the
 * user: no filing recorded (record it), filed but never snapshotted (nothing can be said, and
 * saying "clean" would be a lie), and snapshotted (here is the difference).
 */
export function gstr1aFor(db: DB, company: GstScope, period: string): Gstr1aState {
  const { from, to } = filingPeriodBounds(period)
  const registrationId = company.registrationId ?? primaryRegistrationId(db)
  const filings = db
    .prepare(
      `SELECT form, filed_at AS filedAt, docs_json AS docsJson FROM gst_filings
       WHERE period = ? AND form IN ('GSTR-1','GSTR-3B') AND registration_id IS ?`
    )
    .all(period, registrationId) as { form: string; filedAt: string | null; docsJson: string | null }[]

  const g1 = filings.find((f) => f.form === 'GSTR-1') ?? null
  const g3b = filings.find((f) => f.form === 'GSTR-3B') ?? null
  const window = amendmentWindow({ gstr1FiledAt: g1?.filedAt ?? null, gstr3bFiledAt: g3b?.filedAt ?? null })

  const base: Gstr1aState = {
    period,
    from,
    to,
    result: null,
    window,
    gstr1FiledAt: g1?.filedAt ?? null,
    gstr3bFiledAt: g3b?.filedAt ?? null,
    snapshotDocs: null,
    message: null
  }

  if (!g1 || !g1.filedAt) {
    return { ...base, message: 'GSTR-1 for this period is not recorded as filed. Record the filing, then take a snapshot of it.' }
  }
  if (!g1.docsJson) {
    return {
      ...base,
      message:
        'No snapshot of the filed return exists for this period, so there is nothing to compare the books against. ' +
        'Take one now — it will freeze what the books hold today, which is only right if nothing has changed since ' +
        'the return went in.'
    }
  }

  let filed: GstDoc[]
  try {
    filed = JSON.parse(g1.docsJson) as GstDoc[]
  } catch {
    return { ...base, message: 'The stored snapshot for this period could not be read. Take a fresh one.' }
  }

  const books = extractOutwardDocs(db, company, from, to)
  return { ...base, result: diffGstr1(filed, books, period), snapshotDocs: filed.length }
}
