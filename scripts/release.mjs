// `npm run release -- patch|minor|major|X.Y.Z` — cut a release, then prove it published.
//
// The steps were written down in CLAUDE.md and run from memory, which is fine until the once a
// year somebody runs them tired. Two failures are silent and expensive:
//
//   * A DRAFT release. `releases/latest` does not return drafts, and that endpoint is what both
//     the in-app updater and the site's download button read. A drafted release looks perfect on
//     the releases page and reaches nobody.
//   * A tag pushed without its commit, or a tag pushed from a dirty tree, so the artefacts do not
//     match the source anyone can read.
//
// So this does the boring part and then goes and looks. `--dry-run` does everything except the
// two irreversible acts (the version commit and the push).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipVerify = args.includes('--skip-verify')
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch'

/** Run a command, inheriting stdio. Exits the script on failure. */
function run(cmd, cmdArgs, { allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0 && !allowFail) die(`${cmd} ${cmdArgs.join(' ')} failed`)
  return r.status === 0
}

/** Run a command and capture stdout. */
function out(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: process.platform === 'win32' })
  return (r.stdout ?? '').trim()
}

function die(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function step(title) {
  process.stdout.write(`\n──────── ${title} ────────\n`)
}

// ---- 1. the tree has to be publishable ----
step('pre-flight')
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  die(`"${bump}" is not patch, minor, major or an explicit X.Y.Z version`)
}
if (out('git', ['status', '--porcelain'])) {
  die('the working tree is dirty — a release must be reproducible from a commit that exists')
}
const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main' && !args.includes('--any-branch')) {
  die(`on "${branch}". Releases are cut from main (pass --any-branch if you really mean it)`)
}
run('git', ['fetch', '--tags', '--quiet'])
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', `origin/${branch}`])) {
  die(`local ${branch} and origin/${branch} disagree — push or pull before releasing`)
}
if (!out('gh', ['--version'])) {
  die('the gh CLI is not on PATH, so the release could be cut but never checked. Install it first.')
}
console.log(`ok  clean tree on ${branch}, in step with origin, gh present`)

// ---- 2. everything green, including the E2E suite ----
if (skipVerify) {
  console.log('\n!  --skip-verify: shipping without running the suite')
} else {
  step('verify')
  run('node', ['scripts/verify.mjs'])
}

// ---- 3. version, tag, push ----
step('version and tag')
if (dryRun) {
  console.log(`(dry run) would run: npm version ${bump} && git push --follow-tags`)
  process.exit(0)
}
run('npm', ['version', bump])
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
console.log(`ok  ${tag}`)
run('git', ['push', '--follow-tags'])

// ---- 4. go and look ----
// The workflow builds a DMG, a ZIP and an NSIS installer, which takes several minutes on a
// macOS runner. Poll rather than guess a duration.
step(`waiting for ${tag} to publish`)
const deadline = Date.now() + 30 * 60 * 1000
let release = null
while (Date.now() < deadline) {
  const json = out('gh', ['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets,url'])
  if (json) {
    try {
      release = JSON.parse(json)
    } catch {
      // gh printed something that is not JSON — keep waiting rather than crashing the poll.
    }
  }
  if (release?.assets?.length) break
  process.stdout.write('.')
  await new Promise((r) => setTimeout(r, 20_000))
}
process.stdout.write('\n')

if (!release) {
  die(`no release for ${tag} after 30 minutes. Check: gh run list --workflow release.yml`)
}

// The whole reason this script exists.
if (release.isDraft) {
  die(
    `${tag} published as a DRAFT. releases/latest does not return drafts, so the in-app updater ` +
      `and the site's download button will both still serve the previous version. Publish it: ` +
      `gh release edit ${tag} --draft=false`
  )
}
if (release.isPrerelease) {
  die(`${tag} is marked pre-release, which releases/latest also skips. gh release edit ${tag} --prerelease=false`)
}

const names = release.assets.map((a) => a.name)
const missing = [
  ['macOS DMG', /\.dmg$/],
  ['macOS ZIP (the updater feed)', /\.zip$/],
  ['the electron-updater manifest', /^latest-mac\.yml$/]
].filter(([, re]) => !names.some((n) => re.test(n)))

if (missing.length) {
  die(
    `${tag} is published but missing ${missing.map(([label]) => label).join(', ')}.\n` +
      `  Assets present: ${names.join(', ') || '(none)'}`
  )
}

console.log(`\n✓ ${tag} is published, not drafted.`)
console.log(`  ${release.url}`)
console.log(`  ${names.join('\n  ')}`)
console.log('\nLast thing: open the site and confirm the download button offers this version.')
