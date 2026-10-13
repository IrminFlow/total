// The setup wizard's service (WP 8.3, plan 2026-10-13 §4). Creates a company from the wizard's
// answers in ONE transaction: the standard seed (seedCompany — the accountant path, unchanged),
// the company audit row, the preset's units and accounts through the masters services (each
// audited, each carrying its simple_category), the modules written EXPLICITLY (§4.3 —
// DEFAULT_FEATURES is not touched, so a company without `features` meta keeps today's
// defaults), the GST filing frequency for a regular registration, and meta `ui` (mode, the
// three answers, fresh vs continuing) through the WP 8.1 model. Nothing is posted: the trial
// balance of a new company is zero.
import type { DB } from '../db/connection'
import { seedCompany } from '../db/seed'
import { writeAudit } from './audit'
import { createLedger, createUnit } from './masters'
import { setFeatures, setGstProfile, setUi } from './config'
import { CATEGORIES } from '@shared/simple/categories'
import { EXTRA_UNITS, PRESETS, presetAccounts } from '@shared/simple/presets'
import { chargesGst } from '@shared/gst/registration'
import {
  setupCompanyInfo, setupFeatures, setupGstProfile, setupUi, simpleSetupSchema,
  type SimpleSetup, type SimpleSetupInput
} from '@shared/simple/setup'
import type { CompanyInfo } from '@shared/domain'

export interface SetupResult {
  info: CompanyInfo
  setup: SimpleSetup
  /** Ledger ids by category key, in seeding order. */
  accounts: Record<string, number>
}

/** Parse + the checks the schema can't make on its own (the start date against today). */
export function parseSetup(raw: SimpleSetupInput, today: string): SimpleSetup {
  const s = simpleSetupSchema.parse(raw)
  if (s.startDate > today) throw new Error('The start date can’t be after today')
  return s
}

/** Seed a FRESH company database (no meta yet) from the wizard's answers. */
export function applySetup(db: DB, raw: SimpleSetupInput, today: string): SetupResult {
  const setup = parseSetup(raw, today)
  const info = setupCompanyInfo(setup)
  const preset = PRESETS[setup.businessType]
  const accounts: Record<string, number> = {}
  db.transaction(() => {
    seedCompany(db, info)
    writeAudit(db, 'company', 0, 'create', null, { ...info, setup: { businessType: setup.businessType, gst: setup.gst, stock: setup.stock } })

    // Units the preset uses that the standard seed lacks (a restaurant's plates).
    const haveUnit = db.prepare('SELECT 1 FROM units WHERE symbol = ? COLLATE NOCASE')
    for (const symbol of preset.units) {
      if (haveUnit.get(symbol)) continue
      const u = EXTRA_UNITS.find((x) => x.symbol === symbol)
      if (!u) throw new Error(`Preset unit "${symbol}" is not defined`)
      createUnit(db, { ...u })
    }

    const groupId = db.prepare('SELECT id FROM groups WHERE name = ?')
    for (const key of presetAccounts(setup.businessType, chargesGst(info.gstRegistrationType))) {
      const c = CATEGORIES[key]
      const g = groupId.get(c.group) as { id: number } | undefined
      if (!g) throw new Error(`Seed group "${c.group}" not found`)
      const l = createLedger(db, {
        name: c.name,
        groupId: g.id,
        taxType: 'taxType' in c ? c.taxType : null,
        simpleCategory: key
      })
      accounts[key] = l.id
    }

    setFeatures(db, setupFeatures(setup))
    const profile = setupGstProfile(setup)
    if (profile) setGstProfile(db, profile)
    setUi(db, setupUi(setup))
  })()
  return { info, setup, accounts }
}
