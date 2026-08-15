import type { DB } from './connection'
import { DEFAULT_GROUPS, DEFAULT_VOUCHER_TYPES, DEFAULT_UNITS } from '@shared/seed'
import type { CompanyInfo } from '@shared/domain'

/** Populate a fresh company database: company info, default groups, voucher types, units, Cash ledger. */
export function seedCompany(db: DB, info: CompanyInfo): void {
  const run = db.transaction(() => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('company', JSON.stringify(info))

    const insertGroup = db.prepare(
      'INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 1)'
    )
    const idByName = new Map<string, number>()
    for (const g of DEFAULT_GROUPS) {
      const parentId = g.parent ? idByName.get(g.parent)! : null
      const res = insertGroup.run(g.name, parentId, g.nature, g.affectsGrossProfit ? 1 : 0)
      idByName.set(g.name, Number(res.lastInsertRowid))
    }

    const insertVt = db.prepare(
      "INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES (?, ?, 'auto', '', 1)"
    )
    for (const vt of DEFAULT_VOUCHER_TYPES) insertVt.run(vt.name, vt.kind)

    const insertUnit = db.prepare('INSERT INTO units (name, symbol, decimals, uqc) VALUES (?, ?, ?, ?)')
    for (const u of DEFAULT_UNITS) insertUnit.run(u.name, u.symbol, u.decimals, u.uqc)

    db.prepare('INSERT INTO godowns (name) VALUES (?)').run('Main Location')

    db.prepare('INSERT INTO ledgers (name, group_id, is_system) VALUES (?, ?, 1)').run(
      'Cash',
      idByName.get('Cash-in-Hand')!
    )
  })
  run()
}

export function readCompanyInfo(db: DB): CompanyInfo {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string }
  return JSON.parse(row.value) as CompanyInfo
}

export function writeCompanyInfo(db: DB, info: CompanyInfo): void {
  db.prepare("UPDATE meta SET value = ? WHERE key = 'company'").run(JSON.stringify(info))
}
