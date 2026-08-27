import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStagedReleaseManifest } from '../staged-release-manifest.mjs'

test('staged artifact manifest is content-addressed and explicitly non-publishable', () => {
  const root = mkdtempSync(join(tmpdir(), 'total-staged-release-'))
  const pkg = join(root, 'package.json')
  const output = join(root, 'manifest.json')
  writeFileSync(pkg, JSON.stringify({ version: '0.6.0' }))
  writeFileSync(join(root, 'Total-Setup-0.6.0.exe'), 'installer bytes')
  const manifest = createStagedReleaseManifest({
    artifactDirectory: root,
    output,
    channel: 'internal',
    rolloutPercentage: 25,
    sourceRevision: 'a'.repeat(40),
    platform: 'win',
    createdAt: '2026-08-27T00:00:00.000Z',
    packagePath: pkg,
  })
  assert.equal(manifest.publishable, false)
  assert.equal(manifest.signed, false)
  assert.equal(manifest.rolloutPercentage, 25)
  assert.match(manifest.artifacts[0].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), manifest)
})

test('staged artifact manifest rejects unsafe rollout inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'total-staged-release-'))
  const pkg = join(root, 'package.json')
  writeFileSync(pkg, JSON.stringify({ version: '0.6.0' }))
  writeFileSync(join(root, 'Total.dmg'), 'dmg bytes')
  assert.throws(() => createStagedReleaseManifest({
    artifactDirectory: root,
    output: join(root, 'manifest.json'),
    channel: 'production',
    rolloutPercentage: 101,
    sourceRevision: 'short',
    platform: 'mac',
    packagePath: pkg,
  }))
})
