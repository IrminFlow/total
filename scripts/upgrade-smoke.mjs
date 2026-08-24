// Release-only acceptance against two packaged executables. A real public v0.4
// build writes a company into a disposable data root; the candidate opens and
// migrates those exact files, then proves that balances, vouchers and backups
// survived. No developer build or fixture database substitutes for the old app.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const oldExecutable = resolveRequired('OLD_TOTAL_EXECUTABLE')
const candidateExecutable = resolveRequired('CURRENT_TOTAL_EXECUTABLE')
const expectedOldVersion = process.env.OLD_TOTAL_VERSION ?? '0.4.0'
const expectedCandidateVersion = process.env.CURRENT_TOTAL_VERSION ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const evidencePath = resolve(process.env.UPGRADE_EVIDENCE ?? 'dist/upgrade-evidence.json')
const scratch = mkdtempSync(join(tmpdir(), 'total-upgrade-smoke-'))
const dataDir = join(scratch, 'data')
const profileDir = join(scratch, 'profile')

function resolveRequired(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`)
  return path
}

async function withApp(executablePath, work) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profileDir}`],
    timeout: 90_000,
    env: { ...env, TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.total), null, { timeout: 45_000 })
    const invoke = async (channel, payload) => {
      const result = await page.evaluate(([name, body]) => window.total.invoke(name, body), [channel, payload])
      if (!result.ok) throw new Error(`${channel}: ${result.error}`)
      return result.data
    }
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), arch: process.arch }))
    if (!identity.packaged) throw new Error(`Upgrade executable is not packaged: ${executablePath}`)
    return await work({ invoke, identity })
  } finally {
    await app.close()
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function seedWithPublicRelease() {
  return withApp(oldExecutable, async ({ invoke, identity }) => {
    assert(identity.version === expectedOldVersion, `Expected public ${expectedOldVersion}, got ${identity.version}`)
    const created = await invoke('company:create', {
      name: 'Public v0.4 Upgrade Books', stateCode: '27', gstin: null,
      gstRegistrationType: 'unregistered', address: 'Migration evidence', booksFrom: 2026,
      email: null, phone: null, pan: null, tan: null
    })
    await invoke('company:open', { slug: created.slug })
    const types = await invoke('master:voucherTypes:list')
    const ledgers = await invoke('master:ledgers:list')
    const groups = await invoke('master:groups:list')
    const journal = types.find((row) => row.kind === 'journal')
    const cash = ledgers.find((row) => row.name === 'Cash')
    const capitalGroup = groups.find((row) => row.name === 'Capital Account')
    assert(journal && cash && capitalGroup, 'Public v0.4 seeded journal, Cash ledger or Capital Account group is missing')
    const capital = await invoke('master:ledgers:create', {
      name: 'Upgrade Test Capital', groupId: capitalGroup.id, openingBalance: 0,
      gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
      hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null,
      rcm: false, itcEligibility: 'eligible', priceLevelId: null, creditLimit: null
    })
    const saved = await invoke('voucher:save', {
      data: {
        voucherTypeId: journal.id, date: '2026-08-24', partyLedgerId: null,
        narration: 'Created by the public v0.4 upgrade acceptance test', reference: 'V04-UPGRADE',
        instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: 12345, costAllocations: [] },
          { ledgerId: capital.id, drCr: 'cr', amount: 12345, costAllocations: [] }
        ], inventory: [], billRefs: [], tds: null
      }
    })
    assert(saved.id && !saved.approvalRequired, 'Public v0.4 voucher was not posted')
    const vouchers = await invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
    const trial = await invoke('report:trialBalance', { asOn: '2026-08-31' })
    assert(vouchers.length === 1, `Public v0.4 created ${vouchers.length} vouchers instead of 1`)
    assert(trial.totalDebit === 12345 && trial.totalCredit === 12345, 'Public v0.4 trial balance does not tie at ₹123.45')
    return { identity, slug: created.slug, voucherId: saved.id, voucherCount: vouchers.length, totalDebit: trial.totalDebit, totalCredit: trial.totalCredit }
  })
}

async function verifyCandidate(slug, voucherId, pass) {
  return withApp(candidateExecutable, async ({ invoke, identity }) => {
    assert(identity.version === expectedCandidateVersion, `Expected candidate ${expectedCandidateVersion}, got ${identity.version}`)
    const companies = await invoke('company:list')
    assert(companies.companies.some((company) => company.slug === slug), `Candidate cannot see migrated company ${slug}`)
    await invoke('company:open', { slug })
    const vouchers = await invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
    const voucher = await invoke('voucher:get', { id: voucherId })
    const trial = await invoke('report:trialBalance', { asOn: '2026-08-31' })
    assert(vouchers.length === 1, `Candidate pass ${pass} found ${vouchers.length} vouchers instead of 1`)
    assert(voucher?.reference === 'V04-UPGRADE', `Candidate pass ${pass} lost the voucher reference`)
    assert(trial.totalDebit === 12345 && trial.totalCredit === 12345, `Candidate pass ${pass} changed the trial balance`)
    let backup = null
    if (pass === 1) {
      await invoke('backup:run')
      const backups = await invoke('backup:list')
      const row = backups.find((item) => item.tag === 'manual') ?? backups[0]
      assert(row?.file, 'Candidate did not list its post-migration backup')
      const preview = await invoke('backup:preview', { file: row.file })
      assert(preview.valid && preview.integrity === 'ok' && preview.voucherCount === 1, `Post-migration backup is invalid: ${JSON.stringify(preview)}`)
      backup = { file: row.file, integrity: preview.integrity, voucherCount: preview.voucherCount }
    }
    return { pass, identity, voucherCount: vouchers.length, totalDebit: trial.totalDebit, totalCredit: trial.totalCredit, backup }
  })
}

try {
  const old = await seedWithPublicRelease()
  const firstOpen = await verifyCandidate(old.slug, old.voucherId, 1)
  const secondOpen = await verifyCandidate(old.slug, old.voucherId, 2)
  const evidence = {
    schema: 1,
    ok: true,
    checkedAt: new Date().toISOString(),
    transition: `${old.identity.version} -> ${firstOpen.identity.version}`,
    publicRelease: old,
    candidateFirstOpen: firstOpen,
    candidateSecondOpen: secondOpen,
    assertions: ['packaged-builds', 'shared-data-root', 'registry-preserved', 'migration-idempotent', 'voucher-count-preserved', 'trial-balance-preserved', 'verified-backup-after-migration']
  }
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
