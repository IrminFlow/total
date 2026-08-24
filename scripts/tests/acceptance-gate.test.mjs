import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const gate = join(root, 'scripts/acceptance-gate.mjs')
const readiness = join(root, 'scripts/production-readiness.mjs')
const productVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const revision = 'a'.repeat(40)
const testedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const approvedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
const approvers = [
  {
    name: 'Acceptance owner',
    role: 'Release acceptance',
    decision: 'approved',
  },
]
const metricNames = ['openingDebit', 'openingCredit', 'voucherCount', 'receivables', 'payables', 'stockValue', 'taxLiability', 'attachments']

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tempEvidence(evidence) {
  const dir = mkdtempSync(join(tmpdir(), 'total-acceptance-'))
  const path = join(dir, 'evidence.json')
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
  return { dir, path }
}

function runGate(evidence, extra = []) {
  const { path } = tempEvidence(evidence)
  return spawnSync(process.execPath, [gate, path, '--quiet', '--revision', revision, ...extra], { encoding: 'utf8' })
}

function validMigration() {
  const artifactBody = 'signed migration candidate'
  const sourceIds = ['tally', 'busy', 'marg', 'zoho_books', 'spreadsheet']
  return {
    artifactBody,
    evidence: {
      schema: 1,
      kind: 'migration',
      status: 'approved',
      productVersion,
      testedRevision: revision,
      testedAt,
      testedArtifact: {
        name: 'Total-0.5.0.dmg',
        bytes: Buffer.byteLength(artifactBody),
        sha256: digest(artifactBody),
      },
      approvedAt,
      approvers,
      sources: sourceIds.map((id, index) => ({
        id,
        consented: true,
        sourceSha256: digest(`source-${id}`),
        sourceApplicationVersion: `${id}-2026`,
        exportFormat: id === 'tally' ? 'tally-xml' : 'csv',
        importerProfile: `${id}-standard`,
        importedAt: new Date(Date.parse(testedAt) - 10 * 60 * 1000).toISOString(),
        importExecutionId: `import-${id}-20260824`,
        importLogSha256: digest(`log-${id}`),
        backupSha256: digest(`backup-${id}`),
        reconciliationManifestSha256: digest(`manifest-${id}`),
        importBatchId: index + 1,
        backupVerified: true,
        rejectedRowsResolved: true,
        result: 'passed',
        metrics: Object.fromEntries(
          metricNames.map((name) => {
            const expected = name === 'voucherCount' ? 3 : name === 'receivables' ? 10000 + index : 0
            return [name, { expected, actual: expected, difference: 0 }]
          }),
        ),
      })),
    },
  }
}

const humanArtifactBodies = {
  'macos-dmg': { name: 'Total-0.5.0.dmg', body: 'signed human acceptance DMG' },
  'macos-zip': { name: 'Total-0.5.0-mac.zip', body: 'signed human acceptance ZIP' },
  'windows-exe': { name: 'Total.Setup.0.5.0.exe', body: 'signed human acceptance EXE' },
}

function validHuman() {
  return {
    schema: 1,
    kind: 'human',
    status: 'approved',
    productVersion,
    testedRevision: revision,
    testedAt,
    testedArtifacts: Object.entries(humanArtifactBodies).map(([id, artifact]) => ({
      id,
      name: artifact.name,
      bytes: Buffer.byteLength(artifact.body),
      sha256: digest(artifact.body),
    })),
    approvedAt,
    approvers,
    cohorts: ['bookkeeper', 'business-owner', 'chartered-accountant', 'payroll-operator', 'inventory-manufacturing'].map((id) => ({
      id,
      participants: 1,
      durationMinutes: 60,
      scenarios: ['one', 'two', 'three'].map((name, index) => ({
        name,
        durationMinutes: 15,
        evidenceSha256: digest(`${id}-${name}`),
        artifactIds: [[...Object.keys(humanArtifactBodies)][index]],
        result: 'passed',
      })),
      blockers: [],
    })),
  }
}

test('binds human acceptance to every exact macOS and Windows candidate artifact', () => {
  const evidence = validHuman()
  const candidateDir = mkdtempSync(join(tmpdir(), 'total-human-candidate-'))
  for (const artifact of Object.values(humanArtifactBodies)) writeFileSync(join(candidateDir, artifact.name), artifact.body)
  const accepted = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.equal(accepted.status, 0, accepted.stderr)

  writeFileSync(join(candidateDir, humanArtifactBodies['windows-exe'].name), 'different candidate')
  const replaced = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.notEqual(replaced.status, 0)
  assert.match(replaced.stderr, /size does not match|digest does not match/)
})

test('does not let macOS-only scenarios approve Windows human acceptance', () => {
  const evidence = validHuman()
  for (const cohort of evidence.cohorts)
    cohort.scenarios.forEach((scenario, index) => { scenario.artifactIds = [index % 2 === 0 ? 'macos-dmg' : 'macos-zip'] })
  const result = runGate(evidence)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /windows-exe was not exercised/)
})

test('rejects human evidence that omits a release-target artifact identity', () => {
  const evidence = validHuman()
  evidence.testedArtifacts = evidence.testedArtifacts.filter((artifact) => artifact.id !== 'windows-exe')
  const result = runGate(evidence)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must contain exactly.*windows-exe/)
})
function validCleanMachine() {
  const dmg = 'signed universal dmg'
  const exe = 'signed Windows installer'
  const checks = {
    freshInstall: 'passed',
    launch: 'passed',
    postVoucher: 'passed',
    backupRestore: 'passed',
    uninstallPreservesData: 'passed',
    upgradeFromV04: 'passed',
  }
  return {
    artifacts: { 'Total-0.5.0.dmg': dmg, 'Total.Setup.0.5.0.exe': exe },
    evidence: {
      schema: 1,
      kind: 'clean-machine',
      status: 'approved',
      productVersion,
      testedRevision: revision,
      testedAt,
      approvedAt,
      approvers,
      platforms: [
        {
          id: 'macos-arm64',
          cleanDevice: true,
          osVersion: 'macOS 15.6 (24G84)',
          architecture: 'arm64',
          installerName: 'Total-0.5.0.dmg',
          installerBytes: Buffer.byteLength(dmg),
          installerSha256: digest(dmg),
          checks,
        },
        {
          id: 'macos-intel',
          cleanDevice: true,
          osVersion: 'macOS 15.6 (24G84)',
          architecture: 'x64',
          installerName: 'Total-0.5.0.dmg',
          installerBytes: Buffer.byteLength(dmg),
          installerSha256: digest(dmg),
          upgradeNote: 'No public Intel v0.4 build exists.',
          checks: { ...checks, upgradeFromV04: 'not_applicable' },
        },
        {
          id: 'windows-11',
          cleanDevice: true,
          osVersion: 'Windows 11 24H2 build 26100',
          architecture: 'x64',
          installerName: 'Total.Setup.0.5.0.exe',
          installerBytes: Buffer.byteLength(exe),
          installerSha256: digest(exe),
          checks,
        },
      ],
    },
  }
}

test('accepts fresh migration evidence bound to the release and exact candidate artifact', () => {
  const { evidence, artifactBody } = validMigration()
  const candidateDir = mkdtempSync(join(tmpdir(), 'total-acceptance-candidate-'))
  writeFileSync(join(candidateDir, evidence.testedArtifact.name), artifactBody)
  const result = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.equal(result.status, 0, result.stderr)
})

test('rejects stale, wrong-revision, duplicate and economically empty migration evidence', async (t) => {
  await t.test('wrong revision', () => {
    const { evidence } = validMigration()
    evidence.testedRevision = 'b'.repeat(40)
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /does not match the release commit/)
  })
  await t.test('stale test', () => {
    const { evidence } = validMigration()
    evidence.testedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    evidence.approvedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    for (const source of evidence.sources) source.importedAt = evidence.testedAt
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /older than 30 days/)
  })
  await t.test('duplicate source identity', () => {
    const { evidence } = validMigration()
    evidence.sources[1].sourceSha256 = evidence.sources[0].sourceSha256
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /sourceSha256 must be unique/)
  })
  await t.test('all-zero accounting domains', () => {
    const { evidence } = validMigration()
    for (const source of evidence.sources) {
      for (const name of metricNames) source.metrics[name] = { expected: 0, actual: 0, difference: 0 }
    }
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /at least one voucher/)
  })
})

test('recomputes candidate artifact identity and rejects a different build', () => {
  const { evidence } = validMigration()
  const candidateDir = mkdtempSync(join(tmpdir(), 'total-acceptance-candidate-'))
  writeFileSync(join(candidateDir, evidence.testedArtifact.name), 'different signed candidate')
  const result = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /size does not match|digest does not match/)
})

test('validates clean-machine OS, architecture and exact installer identities', () => {
  const { evidence, artifacts } = validCleanMachine()
  const candidateDir = mkdtempSync(join(tmpdir(), 'total-clean-candidate-'))
  for (const [name, body] of Object.entries(artifacts)) writeFileSync(join(candidateDir, name), body)
  const accepted = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.equal(accepted.status, 0, accepted.stderr)

  evidence.platforms[0].osVersion = 'unknown'
  const invalidOs = runGate(evidence, ['--candidate-evidence-dir', candidateDir])
  assert.notEqual(invalidOs.status, 0)
  assert.match(invalidOs.stderr, /osVersion/)
})

test('rejects blank clean-machine OS and installer digests', async (t) => {
  await t.test('blank OS', () => {
    const { evidence } = validCleanMachine()
    evidence.platforms[0].osVersion = ''
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /osVersion/)
  })
  await t.test('blank installer digest', () => {
    const { evidence } = validCleanMachine()
    evidence.platforms[0].installerSha256 = ''
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /artifact digest/)
  })
})

test('rejects future release-bound evidence timestamps', () => {
  const evidence = validHuman()
  evidence.testedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  evidence.approvedAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  const result = runGate(evidence)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot be in the future/)
})

test('rejects placeholder SHA-256 strings', () => {
  const { evidence } = validMigration()
  evidence.sources[0].sourceSha256 = '0'.repeat(64)
  const result = runGate(evidence)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /placeholder digest/)
})

test('treats blocker severity case-insensitively', () => {
  const evidence = validHuman()
  evidence.cohorts[0].blockers.push({
    severity: ' P1 ',
    title: 'Core workflow blocked',
  })
  const result = runGate(evidence)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unresolved P0\/P1 blocker/)
})

test('requires named, timed and evidence-linked human scenarios', async (t) => {
  await t.test('blank name', () => {
    const evidence = validHuman()
    evidence.cohorts[0].scenarios[0].name = ''
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /scenario 1 name/)
  })
  await t.test('zero duration', () => {
    const evidence = validHuman()
    evidence.cohorts[0].scenarios[0].durationMinutes = 0
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /durationMinutes must be positive/)
  })
  await t.test('blank evidence digest', () => {
    const evidence = validHuman()
    evidence.cohorts[0].scenarios[0].evidenceSha256 = ''
    const result = runGate(evidence)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /evidenceSha256/)
  })
})

test('keeps approved commercial policy reusable across code revisions and age', () => {
  const evidence = JSON.parse(readFileSync(join(root, 'docs/evidence/commercial-policy-approved.json'), 'utf8'))
  assert.equal(evidence.testedRevision, undefined)
  evidence.approvedAt = '2020-01-01T00:00:00.000Z'
  const result = runGate(evidence)
  assert.equal(result.status, 0, result.stderr)
})

test('production readiness passes the exact release revision into acceptance validation', () => {
  const { evidence } = validMigration()
  const { path } = tempEvidence(evidence)
  const env = {
    ...process.env,
    RELEASE_REVISION: revision,
    MIGRATION_ACCEPTANCE_EVIDENCE: path,
  }
  const output = JSON.parse(
    execFileSync(process.execPath, [readiness], {
      cwd: root,
      env,
      encoding: 'utf8',
    }),
  )
  assert.equal(output.checks.find((check) => check.id === 'real-migration-acceptance')?.status, 'ready')

  evidence.testedRevision = 'b'.repeat(40)
  writeFileSync(path, `${JSON.stringify(evidence)}\n`)
  const mismatch = JSON.parse(
    execFileSync(process.execPath, [readiness], {
      cwd: root,
      env,
      encoding: 'utf8',
    }),
  )
  assert.equal(mismatch.checks.find((check) => check.id === 'real-migration-acceptance')?.status, 'external')
})
