// Scheduled release (owner, 7 Nov 2026) — the gate's steps, called by
// .github/workflows/scheduled-release.yml. The decisions are in lib.mjs (unit-tested); this file
// only gathers facts (git, the GitHub API through `gh`) and writes results.
//
//   preflight <out.json>                     commits since the last tag, CI on HEAD, blockers, version
//   compare <old.json> <new.json> <preflight.json> <out.json>   the upgrade test's verdict
//   decide <preflight.json> <upgrade.json|-> <out.json>         the slot's verdict + run summary
//   issue <decision.json> [released|failed]   open / update / close the "Scheduled release skipped" issue
//   bump <version> <date>                     package.json + lock + CHANGELOG (no commit)
//   notes <version>                           this version's CHANGELOG section (release notes)
//   verify <version>                          /releases/latest + the site's /api/latest show it
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT / GITHUB_STEP_SUMMARY (optional), GATE_SHA (the
// main commit under test, default HEAD).
import { execFileSync } from 'child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import {
  countsForRelease,
  ciVerdict,
  versionAllowed,
  versionMatchesTag,
  nextPatch,
  moveUnreleased,
  changelogSection,
  compareOutputs,
  figuresVerdict,
  blockerVerdict,
  missingAssets,
  lastReleaseVerdict,
  BLOCKER_LABEL
} from './lib.mjs'

const REPO = process.env.GITHUB_REPOSITORY ?? 'Total-org/total-org'
const SITE_LATEST = process.env.SITE_LATEST_URL ?? 'https://devjindal.tech/api/latest'
export const ISSUE_TITLE = 'Scheduled release skipped'

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim()
const git = (...args) => sh('git', args)
const ghApi = (path, ...extra) => JSON.parse(sh('gh', ['api', '-H', 'Accept: application/vnd.github+json', path, ...extra]) || 'null')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')

function setOutput(name, value) {
  const line = `${name}=${String(value).replace(/\n/g, ' ')}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
  else process.stdout.write(`output ${line}`)
}
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  process.stdout.write(md + '\n')
}

/** PRs merged into main whose merge commit is in lastTag..sha — exact, not by date alone. */
function mergedPrsSince(lastTag, sha) {
  const inRange = new Set(git('rev-list', `${lastTag}..${sha}`).split('\n').filter(Boolean))
  if (!inRange.size) return []
  const since = git('log', '-1', '--format=%cI', lastTag)
  const list = JSON.parse(
    sh('gh', ['pr', 'list', '--repo', REPO, '--state', 'merged', '--base', 'main', '--search', `merged:>=${since.slice(0, 10)}`, '--limit', '500', '--json', 'number,title,labels,mergeCommit'])
  )
  return list
    .filter((p) => p.mergeCommit && inRange.has(p.mergeCommit.oid))
    .map((p) => ({ number: p.number, title: p.title, labels: p.labels.map((l) => l.name) }))
    .sort((a, b) => a.number - b.number)
}

function preflight(outFile) {
  const sha = process.env.GATE_SHA || git('rev-parse', 'HEAD')
  const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', sha)
  const commits = git('rev-list', '--count', `${lastTag}..${sha}`)
  const changed = git('diff', '--name-only', lastTag, sha).split('\n').filter(Boolean)
  const counting = changed.filter(countsForRelease)
  const version = JSON.parse(git('show', `${sha}:package.json`)).version
  const approvalFile = (() => {
    try {
      sh('git', ['cat-file', '-e', `${sha}:.github/release-minor-approved`], { stdio: ['ignore', 'pipe', 'pipe'] })
      return true
    } catch {
      return false
    }
  })()
  const checks = []
  // The last tag must be a finished release (published, every asset), or the upgrade test would
  // start from code users never got and a broken "latest" would sit unnoticed. Not quiet.
  // /releases/tags/{tag} hides drafts (404), so look through the list for this tag.
  const lastRelease = (ghApi(`repos/${REPO}/releases?per_page=30`) ?? []).find((r) => r.tag_name === lastTag) ?? null
  const releaseRuns = ghApi(`repos/${REPO}/actions/workflows/release.yml/runs?per_page=20`).workflow_runs ?? []
  // A Release run still going (a tag pushed by hand, or a re-run by dispatch) = being built. A
  // scheduled slot's own call runs inside its slot, which this one's concurrency group waits for.
  const buildRunning = releaseRuns.some((r) => r.status !== 'completed')
  const { wait: lastWait, ...lastDone } = lastReleaseVerdict(lastTag, lastRelease, buildRunning)
  checks.push({ name: 'last release complete', ...lastDone })
  let quiet = !!lastWait
  let wait = false
  if (Number(commits) === 0) {
    quiet = quiet || lastDone.ok
    checks.push({ name: 'new commits', ok: false, reason: `nothing new on main since ${lastTag}` })
  } else if (!counting.length) {
    quiet = quiet || lastDone.ok
    checks.push({ name: 'new commits', ok: false, reason: `${commits} commit(s) since ${lastTag}, only docs / site / CI / root Markdown changed` })
  } else {
    checks.push({ name: 'new commits', ok: true, reason: `${commits} commit(s) since ${lastTag}; ${counting.length} file(s) that ship changed` })
  }
  const vt = versionMatchesTag(version, lastTag)
  const va = versionAllowed(version, approvalFile)
  checks.push({ name: 'version', ok: vt.ok && va.ok, reason: !vt.ok ? vt.reason : !va.ok ? va.reason : `${version} → ${nextPatch(version)} (patch)` })

  // The newest ci.yml push run on main for this exact SHA (a run id carries its latest attempt);
  // its own jobs, so status and jobs always come from the same run.
  const runs = ghApi(`repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`).workflow_runs ?? []
  const newest = [...runs].sort((a, b) => b.id - a.id)[0]
  const jobs = newest
    ? (ghApi(`repos/${REPO}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`).jobs ?? []).map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion }))
    : []
  const ci = ciVerdict(newest ? [newest] : [], jobs)
  wait = ci.wait
  checks.push({ name: 'CI on main HEAD', ok: ci.ok, reason: ci.reason })

  const open = JSON.parse(sh('gh', ['pr', 'list', '--repo', REPO, '--state', 'open', '--label', BLOCKER_LABEL, '--limit', '100', '--json', 'number,title,labels']))
  const blockers = blockerVerdict(open.map((p) => ({ number: p.number, title: p.title, labels: p.labels.map((l) => l.name) })))
  checks.push({ name: 'release blockers', ...blockers })

  const prs = mergedPrsSince(lastTag, sha)
  const result = { sha, lastTag, version, nextVersion: nextPatch(version), commits: Number(commits), changed: counting.length, quiet, wait, checks, prs }
  result.ok = checks.every((c) => c.ok)
  writeJson(outFile, result)
  setOutput('ok', result.ok)
  setOutput('quiet', quiet)
  setOutput('sha', sha)
  setOutput('last_tag', lastTag)
  setOutput('next_version', result.nextVersion)
  for (const c of checks) process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.reason}\n`)
}

const healthProblems = (slug, c, expectedMigrations) => {
  const p = []
  if (c.migrations !== expectedMigrations) p.push(`${slug}: ${c.migrations} of ${expectedMigrations} migrations after opening`)
  if (c.integrity !== 'ok') p.push(`${slug}: integrity_check says ${c.integrity}`)
  if (c.foreignKeyProblems) p.push(`${slug}: ${c.foreignKeyProblems} foreign key problem(s)`)
  if (!c.auditChain?.ok) p.push(`${slug}: the audit chain does not verify`)
  if (!c.restoreCheck?.ok) p.push(`${slug}: the backup restore check failed — ${c.restoreCheck?.error}`)
  return p
}

function compare(oldFile, newFile, preflightFile, outFile) {
  const old = readJson(oldFile)
  const neu = readJson(newFile)
  const pre = readJson(preflightFile)
  const health = []
  const differences = []
  const added = []
  for (const [slug, c] of Object.entries(old.companies)) {
    const n = neu.companies[slug]
    if (!n) {
      health.push(`${slug}: missing after the upgrade`)
      continue
    }
    health.push(...healthProblems(slug, n, neu.migrations))
    const r = compareOutputs(c.figures, n.figures)
    differences.push(...r.differences.map((d) => ({ ...d, path: `${slug}/${d.path}` })))
    added.push(...r.added.map((a) => `${slug}/${a}`))
  }
  const figures = figuresVerdict(differences, pre.prs)
  const migrated = Object.entries(old.companies).map(([slug, c]) => `${slug} ${c.migrations} → ${neu.companies[slug]?.migrations}`)
  const checks = [
    { name: 'migrations + backup restore check', ok: health.length === 0, reason: health.length ? health.join('; ') : `clean (${migrated.join(', ')}; integrity, foreign keys, audit chain, restore check OK)` },
    { name: 'figures on upgraded books', ...figures }
  ]
  const reportCount = Object.values(old.companies).reduce((n, c) => n + Object.keys(c.figures).length, 0)
  const result = { ok: checks.every((c) => c.ok), checks, reportCount, differences: differences.slice(0, 200), differenceCount: differences.length, added: added.slice(0, 200), addedCount: added.length }
  writeJson(outFile, result)
  for (const c of checks) process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.reason}\n`)
  setOutput('ok', result.ok)
}

const fmt = (v) => {
  const s = JSON.stringify(v)
  return s === undefined ? '(none)' : s.length > 80 ? `${s.slice(0, 77)}…` : s
}

function decide(preflightFile, upgradeFile, outFile) {
  // A preflight that crashed (API outage, git error) left no file: a skip with a reason.
  const pre = existsSync(preflightFile)
    ? readJson(preflightFile)
    : { sha: process.env.GATE_SHA || '(unknown)', lastTag: '(unknown)', nextVersion: '(unknown)', quiet: false, wait: false, ok: false, prs: [], checks: [{ name: 'preflight', ok: false, reason: `preflight did not finish (${process.env.PREFLIGHT_RESULT ?? 'no result'}) — see the preflight job log` }] }
  const up = upgradeFile !== '-' && existsSync(upgradeFile) ? readJson(upgradeFile) : null
  const dryRun = process.env.DRY_RUN === 'true'
  const checks = [...pre.checks]
  if (up) checks.push(...up.checks)
  else if (pre.ok) checks.push({ name: 'upgrade test', ok: false, reason: 'the upgrade test did not finish — see the upgrade job log' })
  const ok = checks.every((c) => c.ok)
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.reason}`)
  const verdict = ok ? (dryRun ? 'would release' : 'release') : pre.quiet ? 'skip (quiet)' : pre.wait && reasons.length === 1 ? 'skip (CI still running)' : 'skip'
  const decision = { ok, release: ok && !dryRun, dryRun, quiet: pre.quiet, verdict, reasons, version: pre.nextVersion, lastTag: pre.lastTag, sha: pre.sha, prs: pre.prs }
  writeJson(outFile, decision)
  const lines = [
    `## Scheduled release — ${verdict}${dryRun ? ' (dry run)' : ''}`,
    '',
    `main \`${String(pre.sha).slice(0, 10)}\`, last release ${pre.lastTag}, next ${ok ? `v${pre.nextVersion}` : '—'}`,
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${String(c.reason).replace(/\|/g, '\\|')} |`)
  ]
  if (up) {
    lines.push('', `Upgrade test: ${up.reportCount} reports compared (TB, P&L, BS, Outstandings both sides and stock per year; GSTR-1 / GSTR-3B per month) on Demo Traders and Perf Traders.`)
    if (up.differenceCount) {
      lines.push('', `### Figure differences (${up.differenceCount}${up.differenceCount > up.differences.length ? `, first ${up.differences.length}` : ''})`, '', '| Where | Last release | Now |', '|---|---|---|')
      for (const d of up.differences.slice(0, 60)) lines.push(`| \`${d.path}\` | ${fmt(d.old).replace(/\|/g, '\\|')} | ${fmt(d.new).replace(/\|/g, '\\|')} |`)
    }
    if (up.addedCount) lines.push('', `${up.addedCount} field(s) / report(s) only the new code returns (not compared), e.g. ${up.added.slice(0, 5).map((a) => `\`${a}\``).join(', ')}`)
  }
  if (pre.prs.length) lines.push('', `PRs in this batch: ${pre.prs.map((p) => `#${p.number}${p.labels.includes('figures-approved') ? ' (figures-approved)' : ''}`).join(', ')}`)
  summary(lines.join('\n'))
  setOutput('release', decision.release)
  setOutput('ok', ok)
  setOutput('quiet', pre.quiet)
  setOutput('version', pre.nextVersion)
}

function findIssue() {
  const list = JSON.parse(sh('gh', ['issue', 'list', '--repo', REPO, '--state', 'open', '--search', `"${ISSUE_TITLE}" in:title`, '--json', 'number,title']))
  return list.find((i) => i.title === ISSUE_TITLE) ?? null
}

/** A skip with a reason opens (or comments on) ONE issue; a successful release closes it. Quiet
 *  skips, CI-still-running skips and dry runs leave it alone. */
function issue(decisionFile, outcome) {
  const d = { ...readJson(decisionFile), released: outcome === 'released' }
  if (outcome === 'failed') {
    d.ok = false
    d.quiet = false
    d.verdict = 'release failed'
    d.reasons = [`the release of v${d.version} started but did not finish — the version commit / tag may already be on main; see the run`]
  }
  const run = process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : '(local run)'
  if (d.dryRun) return void process.stdout.write('dry run: the issue is left alone\n')
  const existing = findIssue()
  if (d.released) {
    if (existing) sh('gh', ['issue', 'close', String(existing.number), '--repo', REPO, '--comment', `Released v${d.version} (${run}). Closing.`])
    return
  }
  if (d.ok || d.quiet || d.verdict === 'skip (CI still running)') return
  const body = [`The ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC slot did not release main \`${d.sha.slice(0, 10)}\`.`, '', ...d.reasons.map((r) => `- ${r}`), '', `Run: ${run}`, '', 'This issue closes itself after the next successful scheduled release.'].join('\n')
  if (existing) sh('gh', ['issue', 'comment', String(existing.number), '--repo', REPO, '--body', body])
  else sh('gh', ['issue', 'create', '--repo', REPO, '--title', ISSUE_TITLE, '--body', body])
}

function bump(version, date) {
  const pkg = readJson('package.json')
  if (nextPatch(pkg.version) !== version) throw new Error(`package.json is ${pkg.version}; refusing to bump to ${version}`)
  sh('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: 'pipe' })
  writeFileSync('CHANGELOG.md', moveUnreleased(readFileSync('CHANGELOG.md', 'utf8'), version, date))
  process.stdout.write(`bumped to ${version}\n`)
}

function notes(version) {
  const body = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
  process.stdout.write((body || `Total ${version}.`) + `\n\nFull history: CHANGELOG.md.\n`)
}

async function verify(version) {
  const problems = []
  const latest = ghApi(`repos/${REPO}/releases/latest`)
  if (latest.tag_name !== `v${version}`) problems.push(`/releases/latest is ${latest.tag_name}, not v${version}`)
  if (latest.draft) problems.push('the release is a draft')
  const missing = missingAssets(version, (latest.assets ?? []).map((a) => a.name))
  if (missing.length) problems.push(`missing assets: ${missing.join(', ')}`)
  // The site caches the GitHub lookup for 5 minutes (site/lib/release.ts revalidate: 300).
  let site = null
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(SITE_LATEST, { headers: { 'user-agent': 'total-release-check' } })
      site = res.status === 200 ? (await res.json()).version : `HTTP ${res.status}`
    } catch (err) {
      site = `error ${err.message}`
    }
    if (site === version) break
    await new Promise((r) => setTimeout(r, 60_000))
  }
  if (site !== version) problems.push(`${SITE_LATEST} reports ${site}, not ${version}`)
  summary(problems.length ? `### Release check FAILED\n\n${problems.map((p) => `- ${p}`).join('\n')}` : `### Release check passed\n\nv${version}: /releases/latest has every asset; ${SITE_LATEST} reports ${version}.`)
  if (problems.length) process.exit(1)
}

const [cmd, ...args] = process.argv.slice(2)
const commands = { preflight, compare, decide, issue, bump, notes, verify }
if (!commands[cmd]) {
  console.error(`usage: gate.mjs <${Object.keys(commands).join('|')}> …`)
  process.exit(2)
}
await commands[cmd](...args)
