// `npm run verify` — everything, in one command, in the order that fails fastest.
//
// Four harnesses, a typecheck and a build were six things to remember and one of them was always
// the one skipped. The order is deliberate: typecheck catches a whole class of error in seconds,
// the pure tests are next fastest, and the E2E suite — which boots a real Electron app 29 times —
// runs last and only if everything cheaper has passed.
//
//   npm run verify            everything
//   npm run verify --fast     skip the build and E2E: the pre-commit set
//
// Every step's duration is reported, because a suite that quietly grows to twenty minutes is a
// suite people stop running.
import { spawnSync } from 'node:child_process'

const fast = process.argv.includes('--fast')

const steps = [
  { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'engine tests', cmd: 'npm', args: ['test'] },
  { name: 'db tests', cmd: 'npm', args: ['run', 'test:db'] },
  { name: 'renderer tests', cmd: 'npm', args: ['run', 'test:renderer'] },
  ...(fast
    ? []
    : [
        { name: 'build', cmd: 'npm', args: ['run', 'build'] },
        { name: 'bundle budget', cmd: 'node', args: ['scripts/bundle-budget.mjs'] },
        { name: 'smoke', cmd: 'npm', args: ['run', 'smoke'] },
        { name: 'e2e', cmd: 'npm', args: ['run', 'e2e'] }
      ])
]

const results = []
let failed = null

for (const step of steps) {
  process.stdout.write(`\n──────── ${step.name} ────────\n`)
  const t0 = Date.now()
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: process.platform === 'win32' })
  const ms = Date.now() - t0
  const ok = r.status === 0
  results.push({ name: step.name, ok, ms })
  if (!ok) {
    failed = step.name
    break
  }
}

console.log('\n════════ verify ════════')
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s`)
}
const total = results.reduce((s, r) => s + r.ms, 0)
console.log(`${(total / 1000).toFixed(0)}s total${fast ? ' (fast: build and e2e skipped)' : ''}`)

if (failed) {
  console.error(`\nStopped at "${failed}". Nothing after it was run.`)
  process.exit(1)
}
