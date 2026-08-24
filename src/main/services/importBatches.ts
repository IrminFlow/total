import { createHash } from 'crypto'
import type { DB } from '../db/connection'

export interface ImportBatchRecord {
  id: number
  kind: string
  sourceHash: string
  appliedAt: string
  sourceRows: number
  acceptedRows: number
  rejectedRows: number
}

export function importSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function findImportBatch(db: DB, kind: string, source: string): ImportBatchRecord | null {
  const hash = importSourceHash(source)
  return (db.prepare(
    `SELECT id, kind, source_hash AS sourceHash, applied_at AS appliedAt,
            source_rows AS sourceRows, accepted_rows AS acceptedRows, rejected_rows AS rejectedRows
     FROM import_batches WHERE kind = ? AND source_hash = ?`
  ).get(kind, hash) as ImportBatchRecord | undefined) ?? null
}

export function assertImportNotApplied(db: DB, kind: string, source: string): void {
  const existing = findImportBatch(db, kind, source)
  if (existing) throw new Error(`This exact ${kind} file was already imported on ${existing.appliedAt} (batch #${existing.id})`)
}

export function recordImportBatch(
  db: DB,
  kind: string,
  source: string,
  outcome: { sourceRows: number; acceptedRows: number; rejectedRows: number; summary: unknown }
): ImportBatchRecord {
  const sourceHash = importSourceHash(source)
  const result = db.prepare(
    `INSERT INTO import_batches (
       kind, source_hash, source_bytes, source_rows, accepted_rows, rejected_rows, summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    kind,
    sourceHash,
    Buffer.byteLength(source, 'utf8'),
    outcome.sourceRows,
    outcome.acceptedRows,
    outcome.rejectedRows,
    JSON.stringify(outcome.summary)
  )
  return db.prepare(
    `SELECT id, kind, source_hash AS sourceHash, applied_at AS appliedAt,
            source_rows AS sourceRows, accepted_rows AS acceptedRows, rejected_rows AS rejectedRows
     FROM import_batches WHERE id = ?`
  ).get(result.lastInsertRowid) as ImportBatchRecord
}
