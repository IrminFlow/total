import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const args = process.argv.slice(2)
let input = null
let expectedRevision = process.env.RELEASE_REVISION?.trim() || process.env.GITHUB_SHA?.trim() || null
let candidateEvidenceDir = null
let quiet = false
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]
  if (value === '--quiet') quiet = true
  else if (value === '--revision') expectedRevision = args[++index]
  else if (value === '--candidate-evidence-dir') candidateEvidenceDir = args[++index]
  else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`)
  else if (!input) input = value
  else throw new Error(`Unexpected argument: ${value}`)
}
if (!input) throw new Error('Usage: npm run acceptance:gate -- <evidence.json> [--revision <40-char-sha>] [--candidate-evidence-dir <dir>]')

const path = resolve(input)
const evidence = JSON.parse(readFileSync(path, 'utf8'))
const root = resolve(new URL('..', import.meta.url).pathname)
const productVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const RELEASE_BOUND_KINDS = new Set(['migration', 'clean-machine', 'human', 'mobile'])
const MAX_AGE_DAYS = { migration: 30, 'clean-machine': 30, human: 90, mobile: 90 }
const SHA256 = /^[a-f0-9]{64}$/
const FULL_REVISION = /^[a-f0-9]{40}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function exactIds(rows, expected, label) {
  assert(Array.isArray(rows), `${label} must be an array`)
  assert(rows.every((row) => row && typeof row.id === 'string'), `${label} entries must have string ids`)
  const actual = rows.map((row) => row.id).sort()
  assert(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} must contain exactly: ${expected.join(', ')}`)
}
function approved(result, label) {
  assert(result === 'passed' || result === 'approved', `${label} must be passed or approved`)
}
function timestamp(value, label) {
  assert(typeof value === 'string' && ISO_TIMESTAMP.test(value), `${label} must be an ISO UTC timestamp`)
  const parsed = Date.parse(value)
  assert(Number.isFinite(parsed), `${label} must be an ISO UTC timestamp`)
  assert(parsed <= Date.now() + MAX_FUTURE_SKEW_MS, `${label} cannot be in the future`)
  return parsed
}
function nonPlaceholder(value, label, minimum = 2) {
  assert(typeof value === 'string' && value.trim().length >= minimum, `${label} is required`)
  assert(!['unknown', 'n/a', 'na', 'none', 'tbd'].includes(value.trim().toLowerCase()), `${label} cannot be a placeholder`)
}
function sha(value, label) {
  assert(typeof value === 'string' && SHA256.test(value), `${label} must be a lowercase SHA-256`)
  assert(!/^([a-f0-9])\1{63}$/.test(value), `${label} cannot be a placeholder digest`)
}
function assertUnique(rows, field, label) {
  const values = rows.map((row) => row[field])
  assert(new Set(values).size === values.length, `${label} must be unique for every source`)
}
function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}
let candidateFiles = null
function candidateArtifact(name, expectedSha, expectedBytes, label) {
  nonPlaceholder(name, `${label}: artifact name`)
  assert(basename(name) === name, `${label}: artifact name must not contain a path`)
  sha(expectedSha, `${label}: artifact digest`)
  assert(Number.isSafeInteger(expectedBytes) && expectedBytes > 0, `${label}: artifact size is required`)
  if (!candidateEvidenceDir) return
  const candidateRoot = resolve(candidateEvidenceDir)
  assert(existsSync(candidateRoot), `Candidate evidence directory is missing: ${candidateRoot}`)
  candidateFiles ??= filesBelow(candidateRoot)
  const matches = candidateFiles.filter((file) => basename(file) === name)
  assert(matches.length === 1, `${label}: candidate artifact ${name} must exist exactly once`)
  assert(statSync(matches[0]).size === expectedBytes, `${label}: candidate artifact size does not match tested evidence`)
  const actualSha = createHash('sha256').update(readFileSync(matches[0])).digest('hex')
  assert(actualSha === expectedSha, `${label}: candidate artifact digest does not match tested evidence`)
}
function common() {
  assert(evidence.schema === 1, 'schema must be 1')
  assert(['migration', 'clean-machine', 'human', 'mobile', 'commercial', 'legal'].includes(evidence.kind), 'Unknown acceptance kind')
  assert(evidence.productVersion === productVersion, `productVersion must be ${productVersion}`)
  assert(evidence.status === 'approved', 'status must be approved')
  const approvedAt = timestamp(evidence.approvedAt, 'approvedAt')
  assert(Array.isArray(evidence.approvers) && evidence.approvers.length > 0, 'At least one named approver is required')
  for (const approver of evidence.approvers) {
    assert(typeof approver.name === 'string' && approver.name.trim().length >= 2, 'Every approver needs a name')
    assert(typeof approver.role === 'string' && approver.role.trim().length >= 2, 'Every approver needs a role')
    assert(approver.decision === 'approved', 'Every approver decision must be approved')
  }
  if (!RELEASE_BOUND_KINDS.has(evidence.kind)) return
  if (!expectedRevision) expectedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assert(FULL_REVISION.test(expectedRevision ?? ''), 'A full 40-character expected release revision is required')
  assert(FULL_REVISION.test(evidence.testedRevision ?? ''), 'testedRevision must be a full 40-character commit SHA')
  assert(evidence.testedRevision === expectedRevision, 'testedRevision does not match the release commit')
  const testedAt = timestamp(evidence.testedAt, 'testedAt')
  assert(testedAt <= approvedAt, 'testedAt must not be after approvedAt')
  const maxAgeMs = MAX_AGE_DAYS[evidence.kind] * 24 * 60 * 60 * 1000
  assert(Date.now() - testedAt <= maxAgeMs, `${evidence.kind} evidence is older than ${MAX_AGE_DAYS[evidence.kind]} days`)
  assert(approvedAt - testedAt <= 14 * 24 * 60 * 60 * 1000, 'Approval must occur within 14 days of testing')
}
function migration() {
  exactIds(evidence.sources, ['tally', 'busy', 'marg', 'zoho_books', 'spreadsheet'], 'sources')
  assert(/\.(?:dmg|zip|exe)$/i.test(evidence.testedArtifact?.name ?? ''), 'migration: tested artifact must be a distributable installer')
  candidateArtifact(evidence.testedArtifact?.name, evidence.testedArtifact?.sha256, evidence.testedArtifact?.bytes, 'migration')
  const metricNames = ['openingDebit', 'openingCredit', 'voucherCount', 'receivables', 'payables', 'stockValue', 'taxLiability', 'attachments']
  const economicMetrics = ['openingDebit', 'openingCredit', 'receivables', 'payables', 'stockValue', 'taxLiability']
  const exportFormats = {
    tally: ['tally-xml'],
    busy: ['busy-xml', 'busy-csv', 'busy-xlsx', 'csv', 'xlsx'],
    marg: ['marg-xml', 'marg-csv', 'marg-xlsx', 'csv', 'xlsx'],
    zoho_books: ['zoho-csv', 'zoho-xlsx', 'csv', 'xlsx'],
    spreadsheet: ['csv', 'xls', 'xlsx', 'ods'],
  }
  for (const source of evidence.sources) {
    assert(source.consented === true, `${source.id}: source must be consented`)
    sha(source.sourceSha256, `${source.id}: sourceSha256`)
    nonPlaceholder(source.sourceApplicationVersion, `${source.id}: sourceApplicationVersion`)
    nonPlaceholder(source.exportFormat, `${source.id}: exportFormat`)
    assert(exportFormats[source.id].includes(source.exportFormat.trim().toLowerCase()), `${source.id}: exportFormat is not an accepted representative format`)
    nonPlaceholder(source.importerProfile, `${source.id}: importerProfile`)
    const importedAt = timestamp(source.importedAt, `${source.id}: importedAt`)
    assert(importedAt <= Date.parse(evidence.testedAt), `${source.id}: importedAt must not be after testedAt`)
    assert(typeof source.importExecutionId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(source.importExecutionId), `${source.id}: importExecutionId is required`)
    sha(source.importLogSha256, `${source.id}: importLogSha256`)
    sha(source.backupSha256, `${source.id}: backupSha256`)
    sha(source.reconciliationManifestSha256, `${source.id}: reconciliationManifestSha256`)
    assert(Number.isInteger(source.importBatchId) && source.importBatchId > 0, `${source.id}: importBatchId is required`)
    assert(source.backupVerified === true, `${source.id}: backup must be verified`)
    assert(source.rejectedRowsResolved === true, `${source.id}: rejected rows must be resolved`)
    approved(source.result, `${source.id}: result`)
    for (const name of metricNames) {
      const metric = source.metrics?.[name]
      assert(metric && Number.isSafeInteger(metric.expected) && metric.expected >= 0 && Number.isSafeInteger(metric.actual) && metric.actual >= 0, `${source.id}: ${name} needs non-negative integer expected and actual values`)
      assert(Number.isSafeInteger(metric.difference) && metric.difference === metric.actual - metric.expected, `${source.id}: ${name} difference is inconsistent`)
      assert(metric.difference === 0, `${source.id}: ${name} does not reconcile`)
    }
    assert(source.metrics.voucherCount.expected > 0, `${source.id}: representative evidence must include at least one voucher`)
    assert(economicMetrics.some((name) => source.metrics[name].expected > 0), `${source.id}: representative evidence must include a non-zero accounting reconciliation domain`)
  }
  for (const field of ['sourceSha256', 'importExecutionId', 'importLogSha256', 'backupSha256', 'reconciliationManifestSha256'])
    assertUnique(evidence.sources, field, field)
}
function cleanMachine() {
  exactIds(evidence.platforms, ['macos-arm64', 'macos-intel', 'windows-11'], 'platforms')
  const required = ['freshInstall', 'launch', 'postVoucher', 'backupRestore', 'uninstallPreservesData']
  for (const platform of evidence.platforms) {
    assert(platform.cleanDevice === true, `${platform.id}: must use a clean device or VM`)
    nonPlaceholder(platform.osVersion, `${platform.id}: osVersion`)
    if (platform.id === 'windows-11')
      assert(/^Windows 11\s+.*(?:\b\d{2}H\d\b|\bbuild\s+\d+)/i.test(platform.osVersion), 'windows-11: osVersion must include the Windows 11 release or build')
    else assert(/^macOS\s+\d+(?:\.\d+){0,2}(?:\s+.+)?$/i.test(platform.osVersion), `${platform.id}: osVersion must include the macOS version/build`)
    const expectedArchitecture = platform.id === 'macos-arm64' ? 'arm64' : 'x64'
    assert(platform.architecture === expectedArchitecture, `${platform.id}: architecture must be ${expectedArchitecture}`)
    const expectedExtension = platform.id === 'windows-11' ? '.exe' : '.dmg'
    assert(typeof platform.installerName === 'string' && platform.installerName.toLowerCase().endsWith(expectedExtension), `${platform.id}: installerName must identify the tested ${expectedExtension} artifact`)
    candidateArtifact(platform.installerName, platform.installerSha256, platform.installerBytes, platform.id)
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
    cohort.scenarios.forEach((scenario, index) => {
      nonPlaceholder(scenario?.name, `${cohort.id}: scenario ${index + 1} name`)
      assert(Number.isSafeInteger(scenario.durationMinutes) && scenario.durationMinutes > 0, `${cohort.id}: ${scenario.name} durationMinutes must be positive`)
      sha(scenario.evidenceSha256, `${cohort.id}: ${scenario.name} evidenceSha256`)
      approved(scenario.result, `${cohort.id}: ${scenario.name}`)
    })
    assert(Array.isArray(cohort.blockers) && cohort.blockers.every((item) => !['p0', 'p1'].includes(String(item?.severity ?? '').trim().toLowerCase())), `${cohort.id}: unresolved P0/P1 blocker remains`)
  }
}
function mobile() {
  exactIds(evidence.devices, ['ios', 'android'], 'devices')
  for (const device of evidence.devices) {
    assert(device.physicalDevice === true, `${device.id}: physical device required`)
    nonPlaceholder(device.osVersion, `${device.id}: osVersion`)
    nonPlaceholder(device.model, `${device.id}: model`)
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
if (!quiet) console.log(JSON.stringify({ ok: true, kind: evidence.kind, path, testedRevision: evidence.testedRevision ?? null, approvedAt: evidence.approvedAt, approvers: evidence.approvers.length }))
