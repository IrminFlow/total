import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const input = process.argv.find((value, index) => index > 1 && !value.startsWith('--'))
const quiet = process.argv.includes('--quiet')
if (!input) throw new Error('Usage: npm run acceptance:gate -- <evidence.json>')
const path = resolve(input)
const evidence = JSON.parse(readFileSync(path, 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function exactIds(rows, expected, label) {
  assert(Array.isArray(rows), `${label} must be an array`)
  const actual = rows.map((row) => row.id).sort()
  assert(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} must contain exactly: ${expected.join(', ')}`)
}
function approved(result, label) {
  assert(result === 'passed' || result === 'approved', `${label} must be passed or approved`)
}
function common() {
  assert(evidence.schema === 1, 'schema must be 1')
  assert(['migration', 'clean-machine', 'human', 'mobile', 'commercial', 'legal'].includes(evidence.kind), 'Unknown acceptance kind')
  assert(evidence.productVersion === '0.5.0', 'productVersion must be 0.5.0')
  assert(evidence.status === 'approved', 'status must be approved')
  assert(!Number.isNaN(Date.parse(evidence.approvedAt)), 'approvedAt must be an ISO timestamp')
  assert(Array.isArray(evidence.approvers) && evidence.approvers.length > 0, 'At least one named approver is required')
  for (const approver of evidence.approvers) {
    assert(typeof approver.name === 'string' && approver.name.trim().length >= 2, 'Every approver needs a name')
    assert(typeof approver.role === 'string' && approver.role.trim().length >= 2, 'Every approver needs a role')
    assert(approver.decision === 'approved', 'Every approver decision must be approved')
  }
}
function migration() {
  exactIds(evidence.sources, ['tally', 'busy', 'marg', 'zoho_books', 'spreadsheet'], 'sources')
  const metricNames = ['openingDebit', 'openingCredit', 'voucherCount', 'receivables', 'payables', 'stockValue', 'taxLiability', 'attachments']
  for (const source of evidence.sources) {
    assert(source.consented === true, `${source.id}: source must be consented`)
    assert(/^[a-f0-9]{64}$/.test(source.sourceSha256), `${source.id}: sourceSha256 must be SHA-256`)
    assert(Number.isInteger(source.importBatchId) && source.importBatchId > 0, `${source.id}: importBatchId is required`)
    assert(source.backupVerified === true, `${source.id}: backup must be verified`)
    assert(source.rejectedRowsResolved === true, `${source.id}: rejected rows must be resolved`)
    approved(source.result, `${source.id}: result`)
    for (const name of metricNames) {
      const metric = source.metrics?.[name]
      assert(metric && Number.isInteger(metric.expected) && Number.isInteger(metric.actual), `${source.id}: ${name} needs integer expected and actual values`)
      assert(metric.difference === metric.actual - metric.expected, `${source.id}: ${name} difference is inconsistent`)
      assert(metric.difference === 0, `${source.id}: ${name} does not reconcile`)
    }
  }
}
function cleanMachine() {
  exactIds(evidence.platforms, ['macos-arm64', 'macos-intel', 'windows-11'], 'platforms')
  const required = ['freshInstall', 'launch', 'postVoucher', 'backupRestore', 'uninstallPreservesData']
  for (const platform of evidence.platforms) {
    assert(platform.cleanDevice === true, `${platform.id}: must use a clean device or VM`)
    for (const name of required) approved(platform.checks?.[name], `${platform.id}: ${name}`)
    if (platform.id === 'macos-intel') {
      assert(platform.checks?.upgradeFromV04 === 'not_applicable', 'macos-intel: v0.4 upgrade must be marked not_applicable because no public Intel v0.4 exists')
      assert(String(platform.upgradeNote ?? '').includes('v0.4'), 'macos-intel: explain the absent public v0.4 build')
    } else approved(platform.checks?.upgradeFromV04, `${platform.id}: upgradeFromV04`)
  }
}
function human() {
  exactIds(evidence.cohorts, ['bookkeeper', 'business-owner', 'chartered-accountant', 'payroll-operator', 'inventory-manufacturing'], 'cohorts')
  for (const cohort of evidence.cohorts) {
    assert(Number.isInteger(cohort.participants) && cohort.participants >= 1, `${cohort.id}: at least one participant is required`)
    assert(Number.isInteger(cohort.durationMinutes) && cohort.durationMinutes >= 60, `${cohort.id}: session must last at least 60 minutes`)
    assert(Array.isArray(cohort.scenarios) && cohort.scenarios.length >= 3, `${cohort.id}: at least three scenarios are required`)
    cohort.scenarios.forEach((scenario) => approved(scenario.result, `${cohort.id}: ${scenario.name ?? 'scenario'}`))
    assert(Array.isArray(cohort.blockers) && cohort.blockers.every((item) => !['p0', 'p1'].includes(item.severity)), `${cohort.id}: unresolved P0/P1 blocker remains`)
  }
}
function mobile() {
  exactIds(evidence.devices, ['ios', 'android'], 'devices')
  for (const device of evidence.devices) {
    assert(device.physicalDevice === true, `${device.id}: physical device required`)
    assert(typeof device.osVersion === 'string' && device.osVersion.trim(), `${device.id}: OS version required`)
    for (const name of ['cameraCapture', 'nativeShare', 'desktopImport', 'duplicateReview']) approved(device.checks?.[name], `${device.id}: ${name}`)
  }
}
function commercial() {
  assert(evidence.model === 'perpetual-major-version', 'Commercial model must be perpetual-major-version')
  assert(evidence.automaticBetaConversion === false, 'Beta must not convert automatically')
  assert(evidence.permanentBookAccess === true && evidence.permanentPortableExport === true, 'Book access and portable export must remain permanent')
  assert(Number.isInteger(evidence.businessPricePaise) && evidence.businessPricePaise > 0, 'Business price is required')
  assert(Number.isInteger(evidence.practicePricePaise) && evidence.practicePricePaise > evidence.businessPricePaise, 'Practice price is required')
  assert(evidence.directRefundDays >= 30, 'Direct refund period must be at least 30 days')
}
function legal() {
  assert(typeof evidence.reviewer?.name === 'string' && evidence.reviewer.name.trim().length >= 2, 'Qualified legal reviewer name required')
  assert(typeof evidence.reviewer?.qualification === 'string' && evidence.reviewer.qualification.trim().length >= 3, 'Legal qualification required')
  assert(Array.isArray(evidence.jurisdictions) && evidence.jurisdictions.includes('India'), 'India review is required')
  exactIds(evidence.documents, ['privacy', 'terms', 'security', 'commercial-policy'], 'documents')
  evidence.documents.forEach((document) => approved(document.result, `legal: ${document.id}`))
}

common()
if (evidence.kind === 'migration') migration()
if (evidence.kind === 'clean-machine') cleanMachine()
if (evidence.kind === 'human') human()
if (evidence.kind === 'mobile') mobile()
if (evidence.kind === 'commercial') commercial()
if (evidence.kind === 'legal') legal()
if (!quiet) console.log(JSON.stringify({ ok: true, kind: evidence.kind, path, approvedAt: evidence.approvedAt, approvers: evidence.approvers.length }))
