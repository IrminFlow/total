// Mutation testing for the money and GST engines (roadmap #327).
//
//   node scripts/mutate.mjs                    # money + gst/calc + the GST rate maths
//   node scripts/mutate.mjs --file=src/shared/money.ts
//   node scripts/mutate.mjs --list             # what would be mutated, without running anything
//   node scripts/mutate.mjs --restore          # put the sources back after a hard kill
//
// A passing test suite says the tests did not fail. It does not say they would have. Mutation
// testing asks the only question that distinguishes those: if I break the code on purpose, does
// anything notice? A surviving mutant is a line the suite executes and does not check.
//
// Hand-rolled rather than Stryker, for the same reason schemaDoc.ts hand-rolls a zod walk: this
// is a source transform, a subprocess and a counter. Stryker would bring a config format, a
// plugin system and a runner that would have to be taught about three separate vitest projects,
// to run the same experiment.
//
// SCOPED ON PURPOSE. This runs against the engines where a wrong answer is money — rounding,
// tax splits, thresholds — and not across the whole repo. Mutation testing is slow (one full
// suite run per mutant), and a score averaged over fifty thousand lines of UI would say nothing
// about the twelve that matter.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * A journal on disk, because a signal handler is not enough here.
 *
 * This script has a mutated engine on disk for most of its life, and killing it half way through
 * left a wrong tax calculation in the working tree that looked like a clean checkout. The obvious
 * fix — restore from a SIGTERM handler — does not work: the process spends its time blocked
 * inside a SYNCHRONOUS child (`execFileSync` running the tests), and Node cannot run a handler
 * while the main thread is in a sync call. That was tried, and the file was still mutated
 * afterwards.
 *
 * So the recovery is not in this process at all. Every original is written to a journal before
 * anything is touched, and the next run restores from it BEFORE doing anything else — which is
 * why this runs above every other statement in the file. A hard kill self-heals; `--restore`
 * heals it now, without running anything.
 */
const JOURNAL = '.mutate-journal.json'

if (existsSync(JOURNAL)) {
  const saved = JSON.parse(readFileSync(JOURNAL, 'utf8'))
  for (const [file, src] of Object.entries(saved)) writeFileSync(file, src)
  rmSync(JOURNAL, { force: true })
  console.log(`recovered ${Object.keys(saved).length} file(s) from a run that was killed`)
} else if (process.argv.includes('--restore')) {
  console.log('nothing to restore')
}
if (process.argv.includes('--restore')) process.exit(0)

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const LIST_ONLY = process.argv.includes('--list')

const TARGETS = arg('file')
  ? [arg('file')]
  : [
      'src/shared/money.ts',
      'src/shared/gst/calc.ts',
      'src/shared/gst/turnover.ts',
      'src/shared/gst/lateFee.ts',
      'src/shared/roundOff.ts'
    ]

/**
 * The mutations, chosen for what they mean rather than for coverage of the operator table.
 *
 * Every one of these is a bug somebody has actually shipped in accounting code: a boundary that
 * should be inclusive and is not, a rounding that goes the wrong way at exactly .5, a sign that
 * flips a debit into a credit, a division that becomes a multiplication in a rate calculation.
 * `+` → `-` on the other hand is usually caught by the first test that runs, so it is cheap noise.
 */
const MUTATIONS = [
  { from: />=/g, to: '>', why: 'an inclusive boundary made exclusive' },
  { from: /<=/g, to: '<', why: 'an inclusive boundary made exclusive' },
  { from: /(?<![<>=!])>(?!=)/g, to: '>=', why: 'an exclusive boundary made inclusive' },
  { from: /(?<![<>=!])<(?!=)/g, to: '<=', why: 'an exclusive boundary made inclusive' },
  { from: /===/g, to: '!==', why: 'an equality test inverted' },
  { from: /Math\.round/g, to: 'Math.floor', why: 'rounding half-up made truncation' },
  { from: /Math\.floor/g, to: 'Math.ceil', why: 'truncation made rounding up' },
  { from: /Math\.abs/g, to: 'Number', why: 'a magnitude left signed' },
  { from: /(?<![*/])\*(?![*/])/g, to: '/', why: 'a rate multiplied instead of divided' },
  { from: /\+ 1\b/g, to: '+ 0', why: 'an off-by-one' },
  { from: /- 1\b/g, to: '- 0', why: 'an off-by-one' }
]

/** Every distinct (file, offset, replacement) this produces — one mutant each. */
function mutantsFor(file) {
  const src = readFileSync(file, 'utf8')
  // Comments are not behaviour. Mutating one produces a mutant nothing can kill, which would
  // report as a survivor and send somebody hunting for a test that could never exist.
  const masked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  const out = []
  for (const { from, to, why } of MUTATIONS) {
    for (const m of masked.matchAll(from)) {
      out.push({
        file,
        at: m.index,
        len: m[0].length,
        was: m[0],
        now: to,
        why,
        line: src.slice(0, m.index).split('\n').length
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

const all = TARGETS.flatMap(mutantsFor)

if (LIST_ONLY) {
  for (const m of all) console.log(`${m.file}:${m.line}  ${m.was} → ${m.now}   (${m.why})`)
  console.log(`\n${all.length} mutants across ${TARGETS.length} file(s)`)
  process.exit(0)
}

/**
 * The tests that actually cover these engines, rather than all 2,000.
 *
 * One full suite run per mutant is the honest way to do this and it is also 26 minutes for 103
 * mutants, which is a check nobody runs twice. Scoping to the files that exercise these engines
 * gives the same answer in a fraction of the time — a mutant killed by a GST test is killed
 * whether or not the payroll tests ran alongside it.
 *
 * The risk of scoping is a false survivor: a mutant that some test outside this list would have
 * caught. That is the safe direction to be wrong in — it over-reports work to do, never
 * under-reports it — and any survivor is re-checked against the whole suite below before it is
 * reported, so the final number is exact either way.
 */
const SCOPE = [
  'src/shared/money.test.ts',
  'src/shared/gst',
  'src/shared/roundOff.test.ts',
  'src/shared/posting.prop.test.ts',
  'src/shared/proptest.test.ts'
]

function passes(files) {
  try {
    execFileSync('npx', ['vitest', 'run', '--silent', '--reporter=dot', ...files], {
      stdio: 'ignore',
      timeout: 300_000
    })
    return true
  } catch {
    return false
  }
}

console.log(`${all.length} mutants across ${TARGETS.length} file(s). One suite run each.\n`)

const survivors = []
const originals = new Map(TARGETS.map((f) => [f, readFileSync(f, 'utf8')]))

writeFileSync(JOURNAL, JSON.stringify(Object.fromEntries(originals)))

const restore = () => {
  for (const [file, src] of originals) writeFileSync(file, src)
  rmSync(JOURNAL, { force: true })
}

// Still worth having for the cases where the process IS interruptible, and cheap.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore()
    console.error(`\n${signal} — sources restored.`)
    process.exit(130)
  })
}
process.on('uncaughtException', (err) => {
  restore()
  throw err
})


try {
  for (const [i, m] of all.entries()) {
    const src = originals.get(m.file)
    writeFileSync(m.file, src.slice(0, m.at) + m.now + src.slice(m.at + m.len))
    const killed = !passes(SCOPE)
    writeFileSync(m.file, src)
    // A line per mutant rather than a dot: this runs for minutes and its output is usually read
    // through a pipe, where a progress bar of dots is a blank file until the process exits.
    console.log(`${String(i + 1).padStart(3)}/${all.length}  ${killed ? 'killed  ' : 'SURVIVED'}  ${m.file}:${m.line}  ${m.was} → ${m.now}`)
    if (!killed) survivors.push(m)
  }
} finally {
  restore()
}

// Re-check every survivor against the WHOLE suite before reporting it. Scoping the runs above
// can only produce false survivors, and a false survivor sends somebody hunting for a test that
// already exists.
const confirmed = []
for (const m of survivors) {
  const src = originals.get(m.file)
  writeFileSync(m.file, src.slice(0, m.at) + m.now + src.slice(m.at + m.len))
  const stillAlive = passes([])
  writeFileSync(m.file, src)
  if (stillAlive) confirmed.push(m)
  else console.log(`  (killed by a test outside the scoped set: ${m.file}:${m.line} ${m.was} → ${m.now})`)
}
survivors.length = 0
survivors.push(...confirmed)

const killed = all.length - survivors.length
const score = all.length === 0 ? 100 : (killed / all.length) * 100

console.log(`\n\n${killed}/${all.length} killed — ${score.toFixed(1)}%`)

if (survivors.length > 0) {
  console.log('\nSurvived (a line the suite runs and does not check):')
  for (const m of survivors) console.log(`  ${m.file}:${m.line}  ${m.was} → ${m.now}   ${m.why}`)
}

// Not a gate by default: a survivor is a conversation, not a build break, and some are legitimate
// (equivalent mutants, or a branch that genuinely cannot be reached). --min turns it into one.
const min = Number(arg('min') ?? NaN)
if (!Number.isNaN(min) && score < min) {
  console.error(`\nBelow the floor of ${min}%.`)
  process.exit(1)
}
