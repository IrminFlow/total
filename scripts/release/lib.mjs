// Scheduled release (owner, 7 Nov 2026) — the pure decisions of the gate, kept apart from the
// GitHub / git calls in gate.mjs so they are unit-tested (lib.test.ts). Nothing here touches the
// network, the disk or the clock.

/** Paths whose changes alone never make a release: docs, the marketing site, CI and the release
 *  machinery itself, and the Markdown files at the repo root (README, CHANGELOG, CLAUDE.md,
 *  to-do.md …). Markdown INSIDE src/ (the help articles) ships with the app and counts. */
export const NON_RELEASE_PREFIXES = ['docs/', 'site/', '.github/', 'scripts/release/', 'scripts/e2e/']

/** Test-only files (unit / renderer / DB tests, their fixtures and helpers) never ship either. */
const TEST_ONLY = [/\.(test|dbtest)\.tsx?$/, /(^|\/)__tests__\//, /(^|\/)__fixtures__\//]

/** Does a change to `path` (repo-relative, forward slashes) count toward a release? */
export function countsForRelease(path) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (NON_RELEASE_PREFIXES.some((prefix) => p.startsWith(prefix))) return false
  if (!p.includes('/') && /\.md$/i.test(p)) return false
  if (TEST_ONLY.some((re) => re.test(p))) return false
  return true
}

/** The jobs of ci.yml that must have run and succeeded on main's HEAD. */
export const REQUIRED_CI_JOBS = ['test', 'perf', 'smoke-mac', 'e2e-mac', 'build-win']

/**
 * The verdict on main's CI for one SHA.
 * `runs`: the ci.yml workflow runs for that head SHA (push event), any order.
 * `jobs`: the jobs of the newest run ({ name, status, conclusion }).
 * Returns { ok, wait, reason } — `wait` = still running (skip this slot, try the next).
 */
export function ciVerdict(runs, jobs, required = REQUIRED_CI_JOBS) {
  if (!runs.length) return { ok: false, wait: false, reason: 'CI (ci.yml) has not run on this commit of main' }
  const run = [...runs].sort((a, b) => (b.run_attempt ?? 1) - (a.run_attempt ?? 1) || b.id - a.id)[0]
  if (run.status !== 'completed') return { ok: false, wait: true, reason: `CI run ${run.id} on this commit is still ${run.status}` }
  if (run.conclusion !== 'success') return { ok: false, wait: false, reason: `CI run ${run.id} on this commit ended "${run.conclusion}"` }
  const byName = new Map(jobs.map((j) => [j.name, j]))
  const missing = required.filter((name) => !byName.has(name))
  if (missing.length) return { ok: false, wait: false, reason: `CI run ${run.id} has no ${missing.join(', ')} job` }
  const bad = jobs.filter((j) => j.conclusion !== 'success')
  if (bad.length) return { ok: false, wait: false, reason: `CI run ${run.id}: ${bad.map((j) => `${j.name} ${j.conclusion ?? j.status}`).join(', ')}` }
  return { ok: true, wait: false, reason: `CI run ${run.id} passed (${jobs.map((j) => j.name).join(', ')})` }
}

/** "0.12.3" → { major, minor, patch }; throws on anything else (no pre-release tags here). */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  if (!m) throw new Error(`Not a plain x.y.z version: ${v}`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** The next patch version — the only bump the schedule ever makes. */
export function nextPatch(v) {
  const { major, minor, patch } = parseVersion(v)
  return `${major}.${minor}.${patch + 1}`
}

/** May the schedule release from `version`? 1.0 and later is the owner's call: only with the
 *  approval file (.github/release-minor-approved) in the tree. */
export function versionAllowed(version, approvalFilePresent) {
  const { major } = parseVersion(version)
  if (major >= 1 && !approvalFilePresent) {
    return { ok: false, reason: `package.json is at ${version} (1.0 track) and .github/release-minor-approved is not there — the owner releases 1.x` }
  }
  return { ok: true, reason: null }
}

/** package.json and the last tag must agree, or a patch bump would skip / repeat a version. */
export function versionMatchesTag(version, lastTag) {
  const want = String(lastTag).replace(/^v/, '')
  if (version !== want) return { ok: false, reason: `package.json says ${version} but the last tag is ${lastTag}` }
  return { ok: true, reason: null }
}

/**
 * Move CHANGELOG.md's "## [Unreleased]" body under "## [version] - date" and leave an empty
 * Unreleased heading above it. An empty Unreleased section gets a one-line note.
 */
export function moveUnreleased(changelog, version, date) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/i.test(l))
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading')
  if (lines.some((l) => l.startsWith(`## [${version}]`))) throw new Error(`CHANGELOG.md already has a ${version} section`)
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end)
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  const section = body.length ? body : ['No changes were listed for this release.']
  return [...lines.slice(0, start), '## [Unreleased]', '', `## [${version}] - ${date}`, '', ...section, '', ...lines.slice(end)].join('\n')
}

/** The body of one version's section (release notes), or null. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

/**
 * Compare the old build's report outputs with the new build's on the same books.
 * Old values must be found unchanged in the new ones: a key the old output had that the new one
 * lacks, a changed value, a changed array length — each is a difference. A key ONLY the new code
 * returns (an additive field or a report the old build did not have) is listed as `added`, never
 * a difference: it carries no figure the old books showed.
 * Returns { differences: [{ path, old, new }], added: [path] } (paths like `demo-traders/tb:2026-03-31.rows[3].closing`).
 */
export function compareOutputs(oldOut, newOut, limit = 200) {
  const differences = []
  const added = []
  const walk = (a, b, path) => {
    if (differences.length >= limit) return
    if (Object.is(a, b)) return
    const aObj = a !== null && typeof a === 'object'
    const bObj = b !== null && typeof b === 'object'
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return void differences.push({ path, old: a, new: b })
      if (a.length !== b.length) differences.push({ path: `${path}.length`, old: a.length, new: b.length })
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`)
      return
    }
    if (aObj && bObj) {
      for (const k of Object.keys(a)) {
        if (!(k in b)) differences.push({ path: `${path}.${k}`, old: a[k], new: undefined })
        else walk(a[k], b[k], `${path}.${k}`)
      }
      for (const k of Object.keys(b)) if (!(k in a)) added.push(`${path}.${k}`)
      return
    }
    differences.push({ path, old: a, new: b })
  }
  for (const key of Object.keys(oldOut)) {
    if (!(key in newOut)) differences.push({ path: key, old: '(present)', new: undefined })
    else walk(oldOut[key], newOut[key], key)
  }
  for (const key of Object.keys(newOut)) if (!(key in oldOut)) added.push(key)
  return { differences, added }
}

export const FIGURES_LABEL = 'figures-approved'
export const BLOCKER_LABEL = 'release-blocker'

/**
 * Do figure differences stop the release? Only when there are some and no PR merged since the
 * last tag carries `figures-approved`. The approval covers the batch: the run summary lists every
 * difference so the owner sees exactly what moved.
 * `prs`: [{ number, title, labels: [name] }] merged since the last tag.
 */
export function figuresVerdict(differences, prs) {
  if (!differences.length) return { ok: true, reason: 'Every report on the upgraded books is identical' }
  const approved = prs.filter((p) => p.labels.includes(FIGURES_LABEL))
  if (approved.length) {
    return { ok: true, reason: `${differences.length} figure difference(s), approved by ${approved.map((p) => `#${p.number}`).join(', ')} (${FIGURES_LABEL})` }
  }
  return { ok: false, reason: `${differences.length} figure difference(s) on the upgraded books and no PR since the last tag is labelled ${FIGURES_LABEL}` }
}

/** The release-blocker check over the open PRs ([{ number, title, labels }]). */
export function blockerVerdict(openPrs) {
  const blocking = openPrs.filter((p) => p.labels.includes(BLOCKER_LABEL))
  if (blocking.length) return { ok: false, reason: `open PR(s) labelled ${BLOCKER_LABEL}: ${blocking.map((p) => `#${p.number} ${p.title}`).join('; ')}` }
  return { ok: true, reason: `no open PR is labelled ${BLOCKER_LABEL}` }
}

/** Is the last tag a finished release — published (not a draft) with every asset? `release` is the
 *  GitHub release for the tag, or null when there is none. */
export function lastReleaseVerdict(tag, release, buildRunning = false) {
  const version = String(tag).replace(/^v/, '')
  const rerun = 're-run it: Actions → Release → Run workflow with that tag'
  // A draft while its Release run is still going = being built (a release by hand): wait, quietly.
  if ((!release || release.draft) && buildRunning) return { ok: false, wait: true, reason: `${tag} is still being built (its Release run is in progress)` }
  if (!release) return { ok: false, reason: `${tag} has no GitHub release — ${rerun}` }
  if (release.draft) return { ok: false, reason: `the ${tag} release is still a draft — its build did not finish; ${rerun}` }
  const missing = missingAssets(version, (release.assets ?? []).map((a) => a.name))
  if (missing.length) return { ok: false, reason: `the ${tag} release lacks ${missing.join(', ')} — ${rerun}` }
  return { ok: true, reason: `${tag} is published with every asset` }
}

/** The assets every release must carry (electron-updater reads latest*.yml; the site links dmg / exe). */
export function missingAssets(version, names) {
  const want = [
    { what: 'macOS DMG', test: (n) => n === `Total-${version}-arm64.dmg` },
    { what: 'macOS ZIP', test: (n) => n === `Total-${version}-arm64-mac.zip` },
    { what: 'Windows installer', test: (n) => n === `Total-Setup-${version}.exe` },
    { what: 'latest-mac.yml', test: (n) => n === 'latest-mac.yml' },
    { what: 'latest.yml', test: (n) => n === 'latest.yml' }
  ]
  return want.filter((w) => !names.some(w.test)).map((w) => w.what)
}
