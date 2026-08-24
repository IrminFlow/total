import { safeStorage } from 'electron'
import type { DB } from '../db/connection'
import { rowsToCsv } from '@shared/csv'
import { importStatement } from './banking'
import { writeAudit } from './audit'

const TOKEN_PREFIX = 'bank.feed.token.'

export interface BankFeedConnection {
  id: number; bankLedgerId: number; bankLedgerName: string; provider: 'custom_open_banking'
  displayName: string; endpoint: string; consentScope: 'statements.read'; consentExpiresAt: string
  status: 'connected' | 'paused' | 'revoked'; lastSyncAt: string | null; lastError: string | null
  hasCredential: boolean; createdBy: string; createdAt: string; updatedAt: string
}

function tokenKey(id: number): string { return `${TOKEN_PREFIX}${id}` }

function validateEndpoint(value: string): string {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('Feed URL must not contain credentials')
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Feed URL must use HTTPS (HTTP is allowed only for localhost)')
  return url.toString()
}

function hasToken(db: DB, id: number): boolean {
  return !!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(tokenKey(id))
}

function map(row: Record<string, unknown>, db: DB): BankFeedConnection {
  const id = Number(row.id)
  return {
    id, bankLedgerId: Number(row.bankLedgerId), bankLedgerName: String(row.bankLedgerName),
    provider: 'custom_open_banking', displayName: String(row.displayName), endpoint: String(row.endpoint),
    consentScope: 'statements.read', consentExpiresAt: String(row.consentExpiresAt),
    status: row.status as BankFeedConnection['status'], lastSyncAt: row.lastSyncAt == null ? null : String(row.lastSyncAt),
    lastError: row.lastError == null ? null : String(row.lastError), hasCredential: hasToken(db, id),
    createdBy: String(row.createdBy), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
  }
}

export function listConnections(db: DB): BankFeedConnection[] {
  return (db.prepare(
    `SELECT bf.id, bf.bank_ledger_id AS bankLedgerId, l.name AS bankLedgerName, bf.provider,
            bf.display_name AS displayName, bf.endpoint, bf.consent_scope AS consentScope,
            bf.consent_expires_at AS consentExpiresAt, bf.status, bf.last_sync_at AS lastSyncAt,
            bf.last_error AS lastError, bf.created_by AS createdBy, bf.created_at AS createdAt, bf.updated_at AS updatedAt
     FROM bank_feed_connections bf JOIN ledgers l ON l.id = bf.bank_ledger_id ORDER BY bf.id DESC`
  ).all() as Record<string, unknown>[]).map((row) => map(row, db))
}

function storeToken(db: DB, id: number, token: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer')
  const encrypted = safeStorage.encryptString(token).toString('base64')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(tokenKey(id), JSON.stringify({ version: 1, encrypted }))
}

function readToken(db: DB, id: number): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(tokenKey(id)) as { value: string } | undefined
  if (!row) throw new Error('Feed access token is missing; reconnect this provider')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
  const envelope = JSON.parse(row.value) as { encrypted: string }
  return safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64'))
}

export function saveConnection(
  db: DB,
  input: { bankLedgerId: number; displayName: string; endpoint: string; consentExpiresAt: string; accessToken?: string },
  actor: string,
  id?: number
): BankFeedConnection {
  const endpoint = validateEndpoint(input.endpoint)
  const ledger = db.prepare('SELECT id FROM ledgers WHERE id = ?').get(input.bankLedgerId)
  if (!ledger) throw new Error('Bank ledger not found')
  if (id != null) {
    const before = listConnections(db).find((row) => row.id === id)
    if (!before) throw new Error('Bank feed connection not found')
    db.prepare(
      `UPDATE bank_feed_connections SET bank_ledger_id = ?, display_name = ?, endpoint = ?,
       consent_expires_at = ?, status = 'connected', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(input.bankLedgerId, input.displayName, endpoint, input.consentExpiresAt, id)
    if (input.accessToken) storeToken(db, id, input.accessToken)
    const after = listConnections(db).find((row) => row.id === id)!
    writeAudit(db, 'bank_feed', id, 'update', before, { ...after, hasCredential: after.hasCredential })
    return after
  }
  if (!input.accessToken) throw new Error('An access token is required for a new feed')
  const result = db.prepare(
    `INSERT INTO bank_feed_connections
     (bank_ledger_id, provider, display_name, endpoint, consent_expires_at, created_by)
     VALUES (?, 'custom_open_banking', ?, ?, ?, ?)`
  ).run(input.bankLedgerId, input.displayName, endpoint, input.consentExpiresAt, actor)
  id = Number(result.lastInsertRowid)
  try { storeToken(db, id, input.accessToken) } catch (error) { db.prepare('DELETE FROM bank_feed_connections WHERE id = ?').run(id); throw error }
  const created = listConnections(db).find((row) => row.id === id)!
  writeAudit(db, 'bank_feed', id, 'create', null, { ...created, hasCredential: true })
  return created
}

export function setConnectionStatus(db: DB, id: number, status: 'connected' | 'paused' | 'revoked'): BankFeedConnection {
  const before = listConnections(db).find((row) => row.id === id)
  if (!before) throw new Error('Bank feed connection not found')
  db.prepare("UPDATE bank_feed_connections SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
  if (status === 'revoked') db.prepare('DELETE FROM meta WHERE key = ?').run(tokenKey(id))
  const after = listConnections(db).find((row) => row.id === id)!
  writeAudit(db, 'bank_feed', id, 'update', before, after)
  return after
}

export async function syncConnection(db: DB, id: number, actor: string): Promise<{ importId: number | null; statementRows: number; matched: number; unmatched: number }> {
  const connection = listConnections(db).find((row) => row.id === id)
  if (!connection) throw new Error('Bank feed connection not found')
  if (connection.status !== 'connected') throw new Error('Bank feed is not connected')
  if (Date.parse(connection.consentExpiresAt) < Date.now()) throw new Error('Bank feed consent has expired; reconnect to continue')
  const token = readToken(db, id)
  try {
    const response = await fetch(connection.endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`)
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > 10 * 1024 * 1024) throw new Error('Provider response exceeds the 10 MB safety limit')
    const payload = await response.json() as { transactions?: unknown[] }
    if (!Array.isArray(payload.transactions) || payload.transactions.length > 50_000) throw new Error('Provider response must contain at most 50,000 transactions')
    const rows = payload.transactions.map((raw, index) => {
      const value = raw as Record<string, unknown>
      const date = String(value.date ?? '')
      const amount = Number(value.amount)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount === 0) throw new Error(`Invalid provider transaction at row ${index + 1}`)
      return [date, String(value.description ?? ''), String(value.reference ?? ''), amount < 0 ? (-amount).toFixed(2) : '', amount > 0 ? amount.toFixed(2) : '', value.balance == null ? '' : Number(value.balance).toFixed(2)]
    })
    const csv = rowsToCsv(['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'], rows)
    const imported = importStatement(db, connection.bankLedgerId, csv, { apply: true, actor, fileName: `${connection.displayName}-feed.json`, format: 'csv' })
    db.prepare("UPDATE bank_feed_connections SET last_sync_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(id)
    writeAudit(db, 'bank_feed', id, 'import', null, { statementRows: imported.statementRows, matched: imported.matched, unmatched: imported.unmatched.length })
    return { importId: imported.importId, statementRows: imported.statementRows, matched: imported.matched, unmatched: imported.unmatched.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.prepare("UPDATE bank_feed_connections SET last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message.slice(0, 500), id)
    throw error
  }
}
