import { describe, it, expect } from 'vitest'
import {
  countsForRelease,
  ciVerdict,
  nextPatch,
  parseVersion,
  versionAllowed,
  versionMatchesTag,
  moveUnreleased,
  changelogSection,
  compareOutputs,
  figuresVerdict,
  blockerVerdict,
  missingAssets,
  lastReleaseVerdict,
  REQUIRED_CI_JOBS
} from './lib.mjs'

const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' })
const allJobs = REQUIRED_CI_JOBS.map(ok)

describe('which changes count toward a release', () => {
  it('app code, tests, package files and help articles count', () => {
    for (const p of ['src/main/ipc.ts', 'src/renderer/src/help/en/getting-started.md', 'package.json', 'package-lock.json', 'resources/fonts/OFL.txt', 'src/main/db/testdb.ts', 'scripts/total-cli.mjs'])
      expect(countsForRelease(p), p).toBe(true)
  })
  it('tests, their fixtures and the e2e scenarios do not ship', () => {
    for (const p of ['src/shared/money.test.ts', 'src/main/services/vouchers.dbtest.ts', 'src/renderer/src/__tests__/home.test.tsx', 'src/main/perf/__fixtures__/reportHashes.json', 'scripts/e2e/01-onboarding.mjs'])
      expect(countsForRelease(p), p).toBe(false)
  })
  it('docs, site, CI, the release scripts and root Markdown do not', () => {
    for (const p of ['docs/owner/README.md', 'site/app/page.tsx', '.github/workflows/ci.yml', 'scripts/release/lib.mjs', 'CHANGELOG.md', 'CLAUDE.md', 'to-do.md', './README.md'])
      expect(countsForRelease(p), p).toBe(false)
  })
})

describe('CI verdict on main HEAD', () => {
  it('no run = skip, not wait', () => {
    expect(ciVerdict([], [])).toMatchObject({ ok: false, wait: false })
  })
  it('a running run = wait for the next slot', () => {
    expect(ciVerdict([{ id: 1, status: 'in_progress', conclusion: null }], [])).toMatchObject({ ok: false, wait: true })
  })
  it('a failed run fails', () => {
    expect(ciVerdict([{ id: 1, status: 'completed', conclusion: 'failure' }], allJobs).ok).toBe(false)
  })
  it('every required job must be there (e2e-mac runs only on push)', () => {
    const v = ciVerdict([{ id: 1, status: 'completed', conclusion: 'success' }], allJobs.filter((j) => j.name !== 'e2e-mac'))
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('e2e-mac')
  })
  it('a skipped or cancelled job fails even when the run says success', () => {
    const jobs = allJobs.map((j) => (j.name === 'perf' ? { ...j, conclusion: 'skipped' } : j))
    expect(ciVerdict([{ id: 1, status: 'completed', conclusion: 'success' }], jobs).ok).toBe(false)
  })
  it('the newest attempt decides (a re-run that passed)', () => {
    const runs = [
      { id: 5, run_attempt: 1, status: 'completed', conclusion: 'failure' },
      { id: 5, run_attempt: 2, status: 'completed', conclusion: 'success' }
    ]
    expect(ciVerdict(runs, allJobs).ok).toBe(true)
  })
  it('all green passes', () => {
    expect(ciVerdict([{ id: 9, status: 'completed', conclusion: 'success' }], allJobs)).toMatchObject({ ok: true })
  })
})

describe('versions', () => {
  it('patch only', () => {
    expect(nextPatch('0.12.0')).toBe('0.12.1')
    expect(nextPatch('v0.12.9')).toBe('0.12.10')
  })
  it('rejects pre-release and junk', () => {
    expect(() => parseVersion('1.0.0-beta.1')).toThrow()
    expect(() => parseVersion('')).toThrow()
  })
  it('1.0 and later need the approval file', () => {
    expect(versionAllowed('0.99.3', false).ok).toBe(true)
    expect(versionAllowed('1.0.0', false).ok).toBe(false)
    expect(versionAllowed('1.0.0', true).ok).toBe(true)
  })
  it('package.json must match the last tag', () => {
    expect(versionMatchesTag('0.12.0', 'v0.12.0').ok).toBe(true)
    expect(versionMatchesTag('0.12.1', 'v0.12.0').ok).toBe(false)
  })
})

describe('CHANGELOG', () => {
  const log = ['# Changelog', '', 'intro', '', '## [Unreleased]', '', '**Plain words** (#1). A.', '', '- B (#2)', '', '## [0.12.0] - 2026-10-22', '', 'old'].join('\n')
  it('moves Unreleased under the new version and leaves an empty Unreleased', () => {
    const out = moveUnreleased(log, '0.12.1', '2026-11-08')
    expect(out).toBe(
      ['# Changelog', '', 'intro', '', '## [Unreleased]', '', '## [0.12.1] - 2026-11-08', '', '**Plain words** (#1). A.', '', '- B (#2)', '', '## [0.12.0] - 2026-10-22', '', 'old'].join('\n')
    )
    expect(changelogSection(out, '0.12.1')).toBe('**Plain words** (#1). A.\n\n- B (#2)')
    expect(changelogSection(out, '0.12.0')).toBe('old')
  })
  it('an empty Unreleased gets a note', () => {
    const out = moveUnreleased('## [Unreleased]\n\n## [0.1.0] - x\n', '0.1.1', '2026-11-08')
    expect(changelogSection(out, '0.1.1')).toBe('No changes were listed for this release.')
  })
  it('refuses a repeated version or a missing heading', () => {
    expect(() => moveUnreleased(log, '0.12.0', 'd')).toThrow()
    expect(() => moveUnreleased('# nothing', '0.1.1', 'd')).toThrow()
  })
})

describe('comparing old and new report outputs', () => {
  it('identical = no differences', () => {
    const a = { 'x/tb': { rows: [{ id: 1, closing: 100 }], total: 100 } }
    expect(compareOutputs(a, structuredClone(a))).toEqual({ differences: [], added: [] })
  })
  it('a changed figure is a difference with its path', () => {
    const a = { 'x/tb': { rows: [{ id: 1, closing: 100 }] } }
    const b = { 'x/tb': { rows: [{ id: 1, closing: 101 }] } }
    expect(compareOutputs(a, b).differences).toEqual([{ path: 'x/tb.rows[0].closing', old: 100, new: 101 }])
  })
  it('a field only the new code returns is added, not a difference', () => {
    const r = compareOutputs({ r: { a: 1 } }, { r: { a: 1, rounding: 0 }, extra: 5 })
    expect(r.differences).toEqual([])
    expect(r.added).toEqual(['r.rounding', 'extra'])
  })
  it('a lost field, a lost report, a changed row count and a type change are differences', () => {
    const r = compareOutputs({ r: { a: 1, b: [1, 2] }, gone: 1, t: [1] }, { r: { b: [1] }, t: { 0: 1 } })
    expect(r.differences.map((d) => d.path).sort()).toEqual(['gone', 'r.a', 'r.b.length', 't'])
  })
  it('null vs 0 is a difference', () => {
    expect(compareOutputs({ r: null }, { r: 0 }).differences).toHaveLength(1)
  })
})

describe('figure approval and blockers', () => {
  const prs = [
    { number: 10, title: 'a', labels: [] },
    { number: 11, title: 'b', labels: ['figures-approved'] }
  ]
  it('no differences = ok without any label', () => {
    expect(figuresVerdict([], []).ok).toBe(true)
  })
  it('differences need a figures-approved PR in the batch', () => {
    const d = [{ path: 'p', old: 1, new: 2 }]
    expect(figuresVerdict(d, prs.slice(0, 1)).ok).toBe(false)
    const v = figuresVerdict(d, prs)
    expect(v.ok).toBe(true)
    expect(v.reason).toContain('#11')
  })
  it('an open release-blocker PR stops the slot', () => {
    expect(blockerVerdict([{ number: 3, title: 'x', labels: ['release-blocker'] }]).ok).toBe(false)
    expect(blockerVerdict([{ number: 3, title: 'x', labels: ['bug'] }]).ok).toBe(true)
  })
})

describe('the last tag must be a finished release', () => {
  const assets = ['Total-0.12.0-arm64.dmg', 'Total-0.12.0-arm64-mac.zip', 'Total-Setup-0.12.0.exe', 'latest.yml', 'latest-mac.yml'].map((name) => ({ name }))
  it('published with every asset = ok', () => {
    expect(lastReleaseVerdict('v0.12.0', { draft: false, assets }).ok).toBe(true)
  })
  it('no release, a draft, or a missing asset is flagged', () => {
    expect(lastReleaseVerdict('v0.12.0', null).ok).toBe(false)
    expect(lastReleaseVerdict('v0.12.0', { draft: true, assets }).reason).toContain('draft')
    expect(lastReleaseVerdict('v0.12.0', { draft: false, assets: assets.slice(1) }).reason).toContain('macOS DMG')
  })
  it('a draft whose Release run is still going is a quiet wait, not an issue', () => {
    expect(lastReleaseVerdict('v0.13.0', { draft: true, assets: [] }, true)).toMatchObject({ ok: false, wait: true })
    expect(lastReleaseVerdict('v0.13.0', null, true)).toMatchObject({ ok: false, wait: true })
    expect(lastReleaseVerdict('v0.13.0', { draft: true, assets: [] }, false).wait).toBeUndefined()
  })
})

describe('release assets', () => {
  it('lists what is missing', () => {
    const names = ['Total-0.12.1-arm64.dmg', 'Total-0.12.1-arm64-mac.zip', 'latest-mac.yml']
    expect(missingAssets('0.12.1', names)).toEqual(['Windows installer', 'latest.yml'])
    expect(missingAssets('0.12.1', [...names, 'Total-Setup-0.12.1.exe', 'latest.yml'])).toEqual([])
  })
})
