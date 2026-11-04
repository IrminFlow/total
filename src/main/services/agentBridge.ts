/**
 * Agent access layer (lane A): read-only CSV/JSON mirrors of the books under `<company>/agent/`
 * (Settings → Agent access, `total-cli export`). Reads are recomputed from voucher_lines at export
 * time, never denormalised. (The MCP server and the `<company>/inbox/` drop folder that used to
 * live beside it were removed; drafts they made stay in ai_drafts and still open as before.)
 *
 * Concurrency: the app and the CLI may have the same company.db open at once — WAL journal mode
 * + busy_timeout (set in db/connection.ts) make that safe; nothing here takes exclusive locks.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { companyDir } from '../paths'
import { rowsToCsv } from '@shared/csv'
import { fyOf, todayISO } from '@shared/dates'
import type { Voucher } from '@shared/domain'
import * as masters from './masters'
import { trialBalanceFor } from './reports'
import { outstandings } from './analysis'
import { getVoucher, NOT_DELETED } from './vouchers'
import { log } from '../log'

/** Bumped whenever the mirror file shapes change incompatibly; stamped into meta.json. */
export const MIRROR_SCHEMA_VERSION = 1

export type MirrorWhat = 'masters' | 'vouchers' | 'reports' | 'all'
export type MirrorFormat = 'csv' | 'json' | 'all'

export interface MirrorOptions {
  what?: MirrorWhat
  format?: MirrorFormat
  /** Optional voucher date bounds (inclusive); reports use `to` (default today) as their as-on. */
  from?: string
  to?: string
  /** WP 7.2 (PR #127): false = the caller may not see profit — the trial balance mirror is
   *  redacted like the screen's (shared/profitRedaction.ts). Absent = whole. */
  canSeeProfit?: boolean
}

export interface MirrorResult {
  dir: string
  files: string[]
}

export function agentDir(slug: string): string {
  return join(companyDir(slug), 'agent')
}

/** FY label for a voucher date, e.g. '2025-26' for anything in FY 2025-04-01..2026-03-31. */
function fyLabel(date: string): string {
  const startYear = Number(fyOf(date).from.slice(0, 4))
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

export interface MirrorFile {
  name: string
  mimeType: 'text/csv' | 'application/json'
  content: string
}

/**
 * Build the read mirror in memory:
 *   ledgers.csv, ledgers.json, items.csv, vouchers-<FY>.json, trial-balance.json,
 *   outstandings.json, meta.json (schema version + generated-at + voucher types).
 * Amounts are integer paise, quantities integer milli-units — lossless, same as the DB.
 * `exportMirror` writes these under `<company>/agent/`.
 */
export function buildMirrorFiles(db: DB, slug: string, opts: MirrorOptions = {}): MirrorFile[] {
  const what = opts.what ?? 'all'
  const format = opts.format ?? 'all'
  const files: MirrorFile[] = []
  const csv = (name: string, content: string): void => {
    files.push({ name, mimeType: 'text/csv', content })
  }
  const json = (name: string, value: unknown): void => {
    files.push({ name, mimeType: 'application/json', content: JSON.stringify(value, null, 2) })
  }
  const wantCsv = format !== 'json'
  const wantJson = format !== 'csv'
  const asOn = opts.to ?? todayISO()

  if (what === 'masters' || what === 'all') {
    const groups = new Map(masters.listGroups(db).map((g) => [g.id, g.name]))
    const ledgers = masters.listLedgers(db).map((l) => ({ ...l, groupName: groups.get(l.groupId) ?? '' }))
    if (wantCsv) {
      csv(
        'ledgers.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'opening_balance_paise', 'gstin', 'state_code', 'hsn', 'gst_rate', 'credit_days'],
          ledgers.map((l) => [
            String(l.id), l.name, l.groupName, String(l.openingBalance),
            l.gstin ?? '', l.stateCode ?? '', l.hsn ?? '',
            l.gstRate === null ? '' : String(l.gstRate),
            l.creditDays === null ? '' : String(l.creditDays)
          ])
        )
      )
    }
    if (wantJson) json('ledgers.json', ledgers)
    if (wantCsv) {
      const units = new Map(masters.listUnits(db).map((u) => [u.id, u.symbol]))
      const stockGroups = new Map(masters.listStockGroups(db).map((g) => [g.id, g.name]))
      csv(
        'items.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'unit', 'hsn', 'gst_rate', 'opening_qty_milli', 'opening_value_paise'],
          masters.listStockItems(db).map((i) => [
            String(i.id), i.name, i.groupId === null ? '' : stockGroups.get(i.groupId) ?? '',
            units.get(i.unitId) ?? '', i.hsn ?? '',
            i.gstRate === null ? '' : String(i.gstRate),
            String(i.openingQtyMilli), String(i.openingValue)
          ])
        )
      )
    }
  }

  if ((what === 'vouchers' || what === 'all') && wantJson) {
    const conds = [NOT_DELETED]
    const params: string[] = []
    if (opts.from) { conds.push('v.date >= ?'); params.push(opts.from) }
    if (opts.to) { conds.push('v.date <= ?'); params.push(opts.to) }
    const rows = db
      .prepare(`SELECT v.id, v.date FROM vouchers v WHERE ${conds.join(' AND ')} ORDER BY v.date, v.id`)
      .all(...params) as { id: number; date: string }[]
    const byFy = new Map<string, Voucher[]>()
    for (const r of rows) {
      const label = fyLabel(r.date)
      const list = byFy.get(label) ?? []
      const v = getVoucher(db, r.id)
      if (v) list.push(v)
      byFy.set(label, list)
    }
    for (const [label, vouchersOfFy] of byFy) json(`vouchers-${label}.json`, vouchersOfFy)
  }

  if ((what === 'reports' || what === 'all') && wantJson) {
    json('trial-balance.json', { asOn, ...trialBalanceFor(db, asOn, opts.canSeeProfit !== false) })
    json('outstandings.json', { asOn, receivable: outstandings(db, 'receivable', asOn), payable: outstandings(db, 'payable', asOn) })
  }

  const voucherTypes = masters.listVoucherTypes(db)
  json('meta.json', {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    company: slug,
    amountsUnit: 'paise (integer, 100 paise = 1 rupee)',
    quantitiesUnit: 'milli-units (integer, 1000 = 1 unit)',
    voucherTypes,
    files: files.map((f) => f.name)
  })
  return files
}

/** Regenerate the read mirror under `<company>/agent/` (see buildMirrorFiles). */
export function exportMirror(db: DB, slug: string, opts: MirrorOptions = {}): MirrorResult {
  const dir = agentDir(slug)
  mkdirSync(dir, { recursive: true })
  const files = buildMirrorFiles(db, slug, opts)
  for (const f of files) writeFileSync(join(dir, f.name), f.content)
  return { dir, files: files.map((f) => f.name) }
}

// ---------- debounced auto-refresh after saveVoucher (feature-flag gated in ipc.ts) ----------

let refreshTimer: NodeJS.Timeout | null = null

/** Regenerate the mirror 30s after the last voucher save — bursts of entry collapse to one export. */
export function scheduleMirrorRefresh(db: DB, slug: string, delayMs = 30_000): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    try {
      exportMirror(db, slug)
    } catch (err) {
      log('warn', 'agent-mirror-refresh-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
  }, delayMs)
  // Never keep the process alive just for a pending mirror refresh.
  refreshTimer.unref?.()
}

export function cancelMirrorRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}
