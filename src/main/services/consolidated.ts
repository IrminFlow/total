import Database from 'better-sqlite3'
import type { ProfitAndLoss, StatementNode } from '@shared/reports'
import {
  mergeByName, type ConsolidateCompanyInput, type ConsolidateInputRow, type ConsolidatedResult, type ConsolidationOptions
} from '@shared/consolidate'
import { MIGRATIONS } from '../db/migrations'
import { requireRegisteredCompany } from '../registry'
import * as reports from './reports'
import { usersExist } from './users'

export type ConsolidatedKind = 'tb' | 'pnl'
export type { ConsolidatedResult }

/**
 * Flatten a P&L's StatementNode trees down to leaf ledger rows: expenses land on the
 * debit side, incomes on the credit side — matching trial-balance row shape so both
 * report kinds merge through the same `mergeByName`. Group nodes are skipped (only
 * leaves are summed) to avoid double-counting subtotal nodes.
 */
function flattenPnl(pnl: ProfitAndLoss): ConsolidateInputRow[] {
  const out: ConsolidateInputRow[] = []
  const walk = (nodes: StatementNode[], side: 'dr' | 'cr', groupName: string): void => {
    for (const node of nodes) {
      if (node.kind === 'ledger') {
        out.push({
          group: groupName,
          name: node.name,
          dr: side === 'dr' ? node.amount : 0,
          cr: side === 'cr' ? node.amount : 0
        })
      } else {
        walk(node.children, side, node.name)
      }
    }
  }
  walk(pnl.tradingExpenses, 'dr', 'Trading Expenses')
  walk(pnl.tradingIncomes, 'cr', 'Trading Incomes')
  walk(pnl.indirectExpenses, 'dr', 'Indirect Expenses')
  walk(pnl.indirectIncomes, 'cr', 'Indirect Incomes')
  if (pnl.openingStock) out.push({ group: 'Stock-in-Hand', name: 'Opening Stock', dr: pnl.openingStock, cr: 0 })
  if (pnl.closingStock) out.push({ group: 'Stock-in-Hand', name: 'Closing Stock', dr: 0, cr: pnl.closingStock })
  return out
}

/**
 * Read-only, multi-company consolidation: opens each company's DB read-only (safe even
 * if that company is already open read-write elsewhere thanks to WAL), runs the
 * requested report, and merges the results by ledger/line name. A company whose schema
 * predates the current migrations is skipped with a warning — a readonly connection
 * cannot run migrations to catch it up.
 */
export function consolidated(
  slugs: string[],
  kind: ConsolidatedKind,
  from: string,
  to: string,
  options: ConsolidationOptions = { translationRates: {}, eliminations: [] },
  authorizedProtectedSlugs: ReadonlySet<string> = new Set()
): ConsolidatedResult {
  if (new Set(slugs).size !== slugs.length) throw new Error('Each company may be selected only once')
  // Resolve every target before opening any report. An unregistered/traversal target rejects the
  // entire request instead of being converted into a warning beside otherwise-disclosed data.
  const targets = slugs.map((slug) => ({ slug, ...requireRegisteredCompany(slug) }))
  for (const target of targets) {
    const accessDb = new Database(target.paths.database, { readonly: true, fileMustExist: true })
    try {
      if (usersExist(accessDb) && !authorizedProtectedSlugs.has(target.slug)) {
        throw new Error(
          `${target.summary.name} is protected. Open and sign in to that company before including it.`
        )
      }
    } finally {
      accessDb.close()
    }
  }

  const warnings: string[] = []
  const perCompany: ConsolidateCompanyInput[] = []

  for (const target of targets) {
    const { slug } = target
    const label = target.summary.name
    let db: Database.Database | undefined
    let rows: ConsolidateInputRow[] = []
    try {
      db = new Database(target.paths.database, { readonly: true, fileMustExist: true })
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
      if (n !== MIGRATIONS.length) {
        warnings.push(`${label}: schema is out of date and can't be migrated read-only — skipped`)
      } else if (kind === 'tb') {
        const tb = reports.trialBalance(db, to)
        rows = tb.rows.map((r) => ({ group: r.groupName, name: r.ledgerName, dr: r.debit, cr: r.credit }))
      } else {
        rows = flattenPnl(reports.profitAndLoss(db, from, to))
      }
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)} — skipped`)
    } finally {
      db?.close()
    }
    const rate=options.translationRates[slug]??1
    perCompany.push({ company: label, rows:rows.map((row)=>({...row,dr:Math.round(row.dr*rate),cr:Math.round(row.cr*rate)})) })
  }

  if(options.eliminations.length)perCompany.push({company:'Eliminations',rows:options.eliminations.map((row)=>({group:row.group,name:row.name,dr:row.amount>=0?row.amount:0,cr:row.amount<0?-row.amount:0}))})

  return {
    columns: perCompany.map((c) => c.company),
    rows: mergeByName(perCompany),
    warnings,
    translationRates:Object.fromEntries(slugs.map((slug)=>[slug,options.translationRates[slug]??1])),
    eliminationCount:options.eliminations.length
  }
}
