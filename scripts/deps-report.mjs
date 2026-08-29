// `node scripts/deps-report.mjs` — how far behind the dependencies are, as a report (roadmap #338).
//
// Deliberately NOT a gate. A build that fails because something published a minor version this
// morning teaches people to skip the check, and the check that matters — a known vulnerability in
// something this app ships a Chromium alongside — is already a gate in release.yml
// (`npm audit --omit=dev --audit-level=high`). This one answers the other question, the one
// nobody asks until an upgrade has become expensive: what has drifted, and by how much.
//
// Runtime dependencies are listed first and separately, because they are the ones that reach the
// user's machine. A dev dependency four majors behind is a chore; a runtime one is a decision.
//
// Two dependencies are pinned on purpose and say so here rather than reading as neglect:
// `electron` sets better-sqlite3's ABI (bumping it needs a rebuild of the native module), and
// `better-sqlite3` must match whatever Electron is on.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Held back deliberately — printed with the reason so the report does not read as a to-do. */
const PINNED = {
  electron: 'sets better-sqlite3’s ABI — bumping it needs `npx @electron/rebuild -f -w better-sqlite3`',
  'better-sqlite3': 'must match Electron’s ABI, so it moves when Electron does and not before'
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const runtime = new Set(Object.keys(pkg.dependencies ?? {}))

/** `npm outdated` exits 1 when anything is outdated, which is its normal state, not an error. */
function outdated() {
  try {
    const out = execFileSync('npm', ['outdated', '--json', '--long'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() ? JSON.parse(out) : {}
  } catch (err) {
    const out = err.stdout?.toString() ?? ''
    if (!out.trim()) return {}
    try {
      return JSON.parse(out)
    } catch {
      console.error('npm outdated printed something that is not JSON; reporting nothing rather than guessing.')
      return {}
    }
  }
}

const major = (v) => Number(String(v ?? '').replace(/^[^\d]*/, '').split('.')[0] ?? 0)

const rows = Object.entries(outdated()).map(([name, info]) => ({
  name,
  current: info.current ?? '(not installed)',
  wanted: info.wanted,
  latest: info.latest,
  majors: Math.max(0, major(info.latest) - major(info.current ?? info.wanted)),
  runtime: runtime.has(name)
}))

const fmt = (list) =>
  list.length === 0
    ? ['| — | | | |']
    : list
        .sort((a, b) => b.majors - a.majors || a.name.localeCompare(b.name))
        .map((r) => {
          const behind = r.majors > 0 ? `**${r.majors} major${r.majors > 1 ? 's' : ''}**` : 'minor/patch'
          const note = PINNED[r.name] ? ` — pinned: ${PINNED[r.name]}` : ''
          return `| ${r.name} | ${r.current} | ${r.latest} | ${behind}${note} |`
        })

const lines = [
  '## Dependency freshness',
  '',
  `${rows.length} package${rows.length === 1 ? '' : 's'} behind latest. This is a report, not a gate —`,
  'the gate is `npm audit --omit=dev --audit-level=high` in the release workflow.',
  '',
  '### Runtime — these reach the user’s machine',
  '',
  '| Package | Installed | Latest | Behind |',
  '|---|---|---|---|',
  ...fmt(rows.filter((r) => r.runtime)),
  '',
  '### Build and test only',
  '',
  '| Package | Installed | Latest | Behind |',
  '|---|---|---|---|',
  ...fmt(rows.filter((r) => !r.runtime))
]

const report = lines.join('\n')
console.log(report)

// GitHub renders this on the run's summary page, which is where somebody will actually read it.
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
}
