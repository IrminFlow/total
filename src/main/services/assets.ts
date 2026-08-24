/**
 * The fixed asset register, and the two depreciation schedules the law asks for.
 *
 * Nothing here posts by itself. `depreciationDraft` returns a journal for a human to look at and
 * save; the register is otherwise a record of what the business owns, reconcilable to the ledger
 * balances it was bought through.
 */
import type { DB } from '../db/connection'
import {
  daysInUseDuring,
  depreciateBlock,
  depreciateCompaniesAct,
  disposeAsset,
  IT_BLOCKS,
  MAX_RESIDUAL_PERCENT,
  type BlockResult,
  type DepreciationMethod
} from '@shared/depreciation'
import { fyFromStartYear } from '@shared/dates'
import { writeAudit } from './audit'
import { findOrCreateLedger } from './masters'

// ---------- blocks ----------

export interface AssetBlock {
  id: number
  name: string
  itRate: number
}

export function listBlocks(db: DB): AssetBlock[] {
  return (db.prepare('SELECT id, name, it_rate AS itRate FROM asset_blocks ORDER BY name').all() as AssetBlock[])
}

/**
 * Create the common blocks on first use.
 *
 * Seeded lazily rather than in the schema so a company that never buys an asset never sees them,
 * and so the list can grow without a migration. Existing names are left alone: a company that has
 * edited a rate has done so on purpose.
 */
export function ensureBlocks(db: DB): AssetBlock[] {
  const existing = new Set(listBlocks(db).map((b) => b.name.toLowerCase()))
  const insert = db.prepare('INSERT INTO asset_blocks (name, it_rate) VALUES (?, ?)')
  for (const b of IT_BLOCKS) {
    if (!existing.has(b.name.toLowerCase())) insert.run(b.name, b.rate)
  }
  return listBlocks(db)
}

export function saveBlock(db: DB, input: { name: string; itRate: number }, id?: number): AssetBlock {
  if (id) {
    db.prepare('UPDATE asset_blocks SET name = ?, it_rate = ? WHERE id = ?').run(input.name, input.itRate, id)
  } else {
    id = Number(db.prepare('INSERT INTO asset_blocks (name, it_rate) VALUES (?, ?)').run(input.name, input.itRate).lastInsertRowid)
  }
  return listBlocks(db).find((b) => b.id === id)!
}

// ---------- assets ----------

export interface FixedAsset {
  id: number
  name: string
  code: string | null
  blockId: number | null
  blockName: string | null
  itRate: number | null
  ledgerId: number | null
  ledgerName: string | null
  purchaseDate: string
  putToUseDate: string | null
  cost: number
  residualValue: number
  usefulLifeMonths: number
  method: DepreciationMethod
  location: string | null
  notes: string | null
  disposedOn: string | null
  disposalProceeds: number | null
  /** Accumulated Companies Act depreciation from every posted run. */
  accumulated: number
  /** Cost less accumulated depreciation. */
  bookValue: number
}

const ASSET_SELECT = `
  SELECT fa.*, ab.name AS blockName, ab.it_rate AS itRate, l.name AS ledgerName,
         COALESCE((SELECT SUM(dl.depreciation) FROM depreciation_lines dl WHERE dl.asset_id = fa.id), 0) AS accumulated
  FROM fixed_assets fa
  LEFT JOIN asset_blocks ab ON ab.id = fa.block_id
  LEFT JOIN ledgers l ON l.id = fa.ledger_id`

interface AssetRow {
  id: number; name: string; code: string | null; block_id: number | null; blockName: string | null
  itRate: number | null; ledger_id: number | null; ledgerName: string | null
  purchase_date: string; put_to_use_date: string | null; cost: number; residual_value: number
  useful_life_months: number; method: DepreciationMethod; location: string | null; notes: string | null
  disposed_on: string | null; disposal_proceeds: number | null; accumulated: number
}

const mapAsset = (r: AssetRow): FixedAsset => ({
  id: r.id,
  name: r.name,
  code: r.code,
  blockId: r.block_id,
  blockName: r.blockName,
  itRate: r.itRate,
  ledgerId: r.ledger_id,
  ledgerName: r.ledgerName,
  purchaseDate: r.purchase_date,
  putToUseDate: r.put_to_use_date,
  cost: r.cost,
  residualValue: r.residual_value,
  usefulLifeMonths: r.useful_life_months,
  method: r.method,
  location: r.location,
  notes: r.notes,
  disposedOn: r.disposed_on,
  disposalProceeds: r.disposal_proceeds,
  accumulated: r.accumulated,
  bookValue: r.cost - r.accumulated
})

export function listAssets(db: DB, opts: { includeDisposed?: boolean } = {}): FixedAsset[] {
  const rows = (db.prepare(`${ASSET_SELECT} ORDER BY fa.purchase_date DESC, fa.id DESC`).all() as AssetRow[]).map(mapAsset)
  return opts.includeDisposed ? rows : rows.filter((a) => a.disposedOn === null)
}

export function getAsset(db: DB, id: number): FixedAsset | null {
  const row = db.prepare(`${ASSET_SELECT} WHERE fa.id = ?`).get(id) as AssetRow | undefined
  return row ? mapAsset(row) : null
}

export interface AssetInput {
  name: string
  code?: string | null
  blockId?: number | null
  ledgerId?: number | null
  purchaseDate: string
  putToUseDate?: string | null
  cost: number
  residualValue?: number
  usefulLifeMonths: number
  method?: DepreciationMethod
  location?: string | null
  notes?: string | null
}

/**
 * Record an asset.
 *
 * The residual value is capped at 5% of cost rather than rejected above it: Schedule II sets that
 * ceiling, and a typo in the field should not lose the rest of a form somebody has filled in. The
 * cap is silent in the data but visible in the register, which shows both cost and residual.
 */
export function saveAsset(db: DB, input: AssetInput, id?: number): FixedAsset {
  if (input.cost <= 0) throw new Error('An asset must have a cost')
  if (input.usefulLifeMonths <= 0) throw new Error('An asset needs a useful life')
  const residual = Math.min(input.residualValue ?? 0, Math.floor((input.cost * MAX_RESIDUAL_PERCENT) / 100))
  const code = input.code?.trim() ? input.code.trim() : null
  const before = id ? getAsset(db, id) : null

  if (id) {
    db.prepare(
      `UPDATE fixed_assets SET name = ?, code = ?, block_id = ?, ledger_id = ?, purchase_date = ?,
       put_to_use_date = ?, cost = ?, residual_value = ?, useful_life_months = ?, method = ?,
       location = ?, notes = ? WHERE id = ?`
    ).run(
      input.name, code, input.blockId ?? null, input.ledgerId ?? null, input.purchaseDate,
      input.putToUseDate ?? input.purchaseDate, input.cost, residual, input.usefulLifeMonths,
      input.method ?? 'slm', input.location ?? null, input.notes ?? null, id
    )
  } else {
    id = Number(
      db
        .prepare(
          `INSERT INTO fixed_assets (name, code, block_id, ledger_id, purchase_date, put_to_use_date,
            cost, residual_value, useful_life_months, method, location, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.name, code, input.blockId ?? null, input.ledgerId ?? null, input.purchaseDate,
          input.putToUseDate ?? input.purchaseDate, input.cost, residual, input.usefulLifeMonths,
          input.method ?? 'slm', input.location ?? null, input.notes ?? null
        ).lastInsertRowid
    )
  }
  const saved = getAsset(db, id)!
  writeAudit(db, 'fixed_asset', id, before ? 'update' : 'create', before, saved)
  return saved
}

export function deleteAsset(db: DB, id: number): void {
  const before = getAsset(db, id)
  if (!before) throw new Error('Asset not found')
  const depreciated = db.prepare('SELECT COUNT(*) AS n FROM depreciation_lines WHERE asset_id = ?').get(id) as { n: number }
  if (depreciated.n > 0) {
    throw new Error('This asset has been depreciated in a posted run — dispose of it instead of deleting it')
  }
  db.prepare('DELETE FROM fixed_assets WHERE id = ?').run(id)
  writeAudit(db, 'fixed_asset', id, 'delete', before, null)
}

// ---------- disposal (roadmap #368) ----------

export interface DisposalDraft {
  asset: FixedAsset
  bookValue: number
  proceeds: number
  profitOrLoss: number
  incomeTaxTreatment: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  narration: string
  date: string
}

/**
 * What selling an asset looks like in the books.
 *
 * The Companies Act books a profit or loss on the individual asset; the Income-tax Act does not —
 * the proceeds simply reduce the block. Both are reported, because conflating them is how a
 * profit on sale ends up taxed twice or not at all.
 */
export function disposalDraft(db: DB, assetId: number, on: string, proceeds: number): DisposalDraft {
  const asset = getAsset(db, assetId)
  if (!asset) throw new Error('Asset not found')
  if (asset.disposedOn) throw new Error(`${asset.name} was already disposed of on ${asset.disposedOn}`)

  const result = disposeAsset(asset.bookValue, proceeds, asset.blockName ?? 'its block')
  const lines: DisposalDraft['lines'] = []
  const add = (ledgerName: string, group: string, drCr: 'dr' | 'cr', amount: number): void => {
    if (amount > 0) lines.push({ ledgerName, group, drCr, amount })
  }

  add('Cash', 'Cash-in-Hand', 'dr', proceeds)
  add('Accumulated Depreciation', 'Fixed Assets', 'dr', asset.accumulated)
  add(asset.ledgerName ?? 'Fixed Assets', 'Fixed Assets', 'cr', asset.cost)
  if (result.profitOrLoss > 0) add('Profit on Sale of Assets', 'Indirect Incomes', 'cr', result.profitOrLoss)
  else add('Loss on Sale of Assets', 'Indirect Expenses', 'dr', -result.profitOrLoss)

  return {
    asset,
    bookValue: asset.bookValue,
    proceeds,
    profitOrLoss: result.profitOrLoss,
    incomeTaxTreatment: result.incomeTaxTreatment,
    lines,
    narration: `Sale of ${asset.name} on ${on}`,
    date: on
  }
}

/** Mark an asset gone. The journal is posted separately by the human, from the draft above. */
export function recordDisposal(db: DB, assetId: number, on: string, proceeds: number, voucherId?: number): FixedAsset {
  const before = getAsset(db, assetId)
  if (!before) throw new Error('Asset not found')
  if (before.disposedOn) throw new Error(`${before.name} was already disposed of on ${before.disposedOn}`)
  db.prepare('UPDATE fixed_assets SET disposed_on = ?, disposal_proceeds = ?, disposal_voucher_id = ? WHERE id = ?')
    .run(on, proceeds, voucherId ?? null, assetId)
  const after = getAsset(db, assetId)!
  writeAudit(db, 'fixed_asset', assetId, 'update', before, after)
  return after
}

// ---------- the two schedules (roadmap #367) ----------

export interface AssetScheduleRow {
  assetId: number
  name: string
  code: string | null
  blockName: string | null
  purchaseDate: string
  putToUseDate: string | null
  method: DepreciationMethod
  cost: number
  openingWdv: number
  depreciation: number
  closingWdv: number
  heldFraction: number
  cappedAtResidual: boolean
  /** Disposed during the year — depreciated up to the disposal, then out. */
  disposedOn: string | null
}

export interface DepreciationSchedule {
  fyStartYear: number
  from: string
  to: string
  /** Per asset, under the Companies Act. */
  companiesAct: AssetScheduleRow[]
  companiesActTotal: number
  /** Per block, under the Income-tax Act. */
  incomeTax: BlockResult[]
  incomeTaxTotal: number
  /** The gap the accountant has to carry as deferred tax. */
  difference: number
  /** Assets with no block, so they appear in the books' schedule and not the return's. */
  unblocked: number
  alreadyPosted: boolean
}

/**
 * Both schedules for a financial year.
 *
 * Opening written-down values come from posted runs, so re-running a year that has already been
 * posted shows what was posted rather than recomputing it from scratch — a schedule that changes
 * after it has been filed is worse than no schedule.
 */
export function depreciationSchedule(db: DB, fyStartYear: number): DepreciationSchedule {
  const fy = fyFromStartYear(fyStartYear)
  const posted = db.prepare('SELECT id FROM depreciation_runs WHERE fy_start_year = ?').get(fyStartYear) as
    | { id: number }
    | undefined

  const assets = listAssets(db, { includeDisposed: true }).filter(
    (a) => a.purchaseDate <= fy.to && (a.disposedOn === null || a.disposedOn >= fy.from)
  )

  // Accumulated depreciation from runs BEFORE this year — the opening written-down value.
  const priorByAsset = new Map(
    (
      db
        .prepare(
          `SELECT dl.asset_id AS assetId, COALESCE(SUM(dl.depreciation), 0) AS prior
           FROM depreciation_lines dl JOIN depreciation_runs dr ON dr.id = dl.run_id
           WHERE dr.fy_start_year < ? GROUP BY dl.asset_id`
        )
        .all(fyStartYear) as { assetId: number; prior: number }[]
    ).map((r) => [r.assetId, r.prior])
  )

  const companiesAct: AssetScheduleRow[] = assets.map((a) => {
    const prior = priorByAsset.get(a.id) ?? 0
    const openingWdv = a.cost - prior
    const r = depreciateCompaniesAct(
      {
        cost: a.cost,
        residualValue: a.residualValue,
        usefulLifeMonths: a.usefulLifeMonths,
        method: a.method,
        putToUseDate: a.putToUseDate ?? a.purchaseDate,
        openingWdv,
        accumulated: prior
      },
      fy.from,
      fy.to,
      // An asset sold mid-year is depreciated up to the day it left — as a shorter *holding*, not
      // a shorter year, or the pro-rating would cancel itself out.
      a.disposedOn ?? undefined
    )
    return {
      assetId: a.id,
      name: a.name,
      code: a.code,
      blockName: a.blockName,
      purchaseDate: a.purchaseDate,
      putToUseDate: a.putToUseDate,
      method: a.method,
      cost: a.cost,
      openingWdv,
      depreciation: r.depreciation,
      closingWdv: r.closingWdv,
      heldFraction: r.heldFraction,
      cappedAtResidual: r.cappedAtResidual,
      disposedOn: a.disposedOn
    }
  })

  // Income tax: pool by block. Opening WDV of a block is the tax WDV, which this app only knows
  // once it has been running — for a first year it is the cost of assets brought forward.
  const blocks = listBlocks(db)
  const incomeTax: BlockResult[] = blocks
    .map((block) => {
      const inBlock = assets.filter((a) => a.blockId === block.id)
      if (inBlock.length === 0) return null
      const broughtForward = inBlock.filter((a) => a.purchaseDate < fy.from)
      const additions = inBlock
        .filter((a) => a.purchaseDate >= fy.from && a.purchaseDate <= fy.to)
        .map((a) => ({
          cost: a.cost,
          putToUseDate: a.putToUseDate ?? a.purchaseDate,
          daysInUse: daysInUseDuring(a.putToUseDate ?? a.purchaseDate, fy.from, fy.to)
        }))
      const deletions = inBlock
        .filter((a) => a.disposedOn && a.disposedOn >= fy.from && a.disposedOn <= fy.to)
        .reduce((s, a) => s + (a.disposalProceeds ?? 0), 0)

      return depreciateBlock({
        blockName: block.name,
        rate: block.itRate,
        openingWdv: broughtForward.reduce((s, a) => s + (a.cost - (priorByAsset.get(a.id) ?? 0)), 0),
        additions,
        deletions
      })
    })
    .filter((b): b is BlockResult => b !== null)

  const companiesActTotal = companiesAct.reduce((s, r) => s + r.depreciation, 0)
  const incomeTaxTotal = incomeTax.reduce((s, b) => s + b.depreciation, 0)

  return {
    fyStartYear,
    from: fy.from,
    to: fy.to,
    companiesAct,
    companiesActTotal,
    incomeTax,
    incomeTaxTotal,
    difference: companiesActTotal - incomeTaxTotal,
    unblocked: assets.filter((a) => a.blockId === null).length,
    alreadyPosted: posted !== undefined
  }
}

export interface DepreciationDraft {
  fyStartYear: number
  date: string
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
}

/**
 * The journal for a year's Companies Act depreciation — a draft, never posted here.
 *
 * Only the Companies Act figure goes in the books. The Income-tax number is a computation for the
 * return; booking it would make the accounts wrong.
 */
export function depreciationDraft(db: DB, fyStartYear: number): DepreciationDraft | null {
  const schedule = depreciationSchedule(db, fyStartYear)
  if (schedule.companiesActTotal === 0) return null
  return {
    fyStartYear,
    date: schedule.to,
    narration: `Depreciation for FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)} (Companies Act, per the asset register)`,
    lines: [
      { ledgerName: 'Depreciation', group: 'Indirect Expenses', drCr: 'dr', amount: schedule.companiesActTotal },
      { ledgerName: 'Accumulated Depreciation', group: 'Fixed Assets', drCr: 'cr', amount: schedule.companiesActTotal }
    ],
    total: schedule.companiesActTotal
  }
}

/**
 * Record that a year's depreciation was posted.
 *
 * Stores the per-asset charge so next year's opening written-down value is what was actually
 * booked rather than a recomputation — and so a schedule printed after filing still matches.
 */
export function recordDepreciationRun(db: DB, fyStartYear: number, voucherId: number | null): number {
  const existing = db.prepare('SELECT id FROM depreciation_runs WHERE fy_start_year = ?').get(fyStartYear)
  if (existing) throw new Error(`Depreciation for FY ${fyStartYear} has already been posted`)
  const schedule = depreciationSchedule(db, fyStartYear)

  const run = db.transaction((): number => {
    const runId = Number(
      db.prepare('INSERT INTO depreciation_runs (fy_start_year, voucher_id) VALUES (?, ?)').run(fyStartYear, voucherId).lastInsertRowid
    )
    const insert = db.prepare(
      'INSERT INTO depreciation_lines (run_id, asset_id, opening_wdv, depreciation, closing_wdv) VALUES (?, ?, ?, ?, ?)'
    )
    for (const r of schedule.companiesAct) {
      if (r.depreciation > 0) insert.run(runId, r.assetId, r.openingWdv, r.depreciation, r.closingWdv)
    }
    return runId
  })()

  writeAudit(db, 'depreciation_run', run, 'create', null, { fyStartYear, voucherId, total: schedule.companiesActTotal })
  return run
}

/** Ensure the ledgers a depreciation or disposal draft names exist, so saving it does not fail. */
export function ensureAssetLedgers(db: DB): void {
  findOrCreateLedger(db, 'Depreciation', 'Indirect Expenses')
  findOrCreateLedger(db, 'Accumulated Depreciation', 'Fixed Assets')
}
