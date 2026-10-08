// WP 5.8 — `npm run ai:evals` (scripts/ai-evals.mjs bundles this and runs it under Electron-as-Node,
// like test:db). Seeds Eval Traders into a scratch directory, runs the catalogue, writes
// report.json + report.md there.
//
//   npm run ai:evals                         mocked provider; exit 1 unless 100 % pass
//   npm run ai:evals -- --case acc.*         only matching cases (exact id, or prefix*; repeatable)
//   npm run ai:evals -- --live --model <id>  real model, key from OPENAI_API_KEY; lists the key's
//                                            models first and stops if <id> is not there; reports
//                                            only — exits 1 only on errors, never on accuracy
//   --sample <n>   keep n cases spread over the catalogue     --out <dir>   report directory
//
// Only the synthetic fixture is ever sent. The key stays in the provider; both report files are
// passed through redactSecrets before they are written.
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { reportMarkdown } from '@shared/aiEvalScoring'
import { AI_DEFAULT_MODEL } from '@shared/ai'
import { migrate } from '../../db/migrate'
import { OpenAiProvider, redactSecrets } from '../provider'
import { seedEvalFixture } from './fixture'
import { EVAL_CASES } from './cases'
import { assertModelAvailable, runEvals } from './runner'
import { selectCases } from './select'
import { createMcpParity } from './mcpParity'

interface Args {
  live: boolean
  cases: string[]
  model: string
  sample: number
  out: string | null
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { live: false, cases: [], model: AI_DEFAULT_MODEL, sample: 0, out: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    const v = (): string => {
      const x = argv[++i]
      if (x === undefined) throw new Error(`${k} needs a value`)
      return x
    }
    if (k === '--live') a.live = true
    else if (k === '--case') a.cases.push(v())
    else if (k === '--model') a.model = v()
    else if (k === '--sample') a.sample = Math.max(0, Number.parseInt(v(), 10) || 0)
    else if (k === '--out') a.out = v()
    else if (k === '--help' || k === '-h') {
      process.stdout.write('npm run ai:evals -- [--live] [--model <id>] [--case <id|prefix*>]... [--sample <n>] [--out <dir>]\n')
      process.exit(0)
    } else throw new Error(`Unknown option ${k}`)
  }
  return a
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const out = resolve(args.out ?? mkdtempSync(join(tmpdir(), 'total-ai-evals-')))
  if (out.startsWith(join(homedir(), 'Documents', 'total'))) throw new Error('Refusing to write evals into ~/Documents/total — use a scratch directory')
  mkdirSync(out, { recursive: true })
  const key = args.live ? (process.env.OPENAI_API_KEY ?? '').trim() : ''
  if (args.live && !key) throw new Error('A live run needs OPENAI_API_KEY in the environment')

  const cases = selectCases(EVAL_CASES, args.cases, args.sample)
  if (!cases.length) throw new Error(`No case matches ${args.cases.join(', ')}`)

  let live: OpenAiProvider | undefined
  if (args.live) {
    live = new OpenAiProvider({ apiKey: key })
    const models = await assertModelAvailable(live, args.model)
    process.stdout.write(`Model ${args.model} is listed by the key (${models.length} models).\n`)
  }

  // A fresh fixture every run (the file is this run's own; a previous run's copy is replaced).
  const dbPath = join(out, 'eval-traders.db')
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true })
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  migrate(db)
  const fx = seedEvalFixture(db)
  const mcp = createMcpParity()
  try {
    const report = await runEvals({
      fx,
      cases,
      mode: args.live ? 'live' : 'mock',
      live,
      model: args.model,
      mcp: mcp.run,
      onResult: (r) => process.stdout.write(`${r.status === 'pass' ? '✓' : r.status === 'skipped' ? '-' : '✗'} ${r.id}${r.status === 'error' ? ` (${redactSecrets(r.error ?? '', key)})` : ''}\n`)
    })
    const md = redactSecrets(reportMarkdown(report), key)
    const json = redactSecrets(JSON.stringify(report, null, 2), key)
    if (key && (md.includes(key) || json.includes(key))) throw new Error('The report would contain the API key — not written')
    writeFileSync(join(out, 'report.json'), json)
    writeFileSync(join(out, 'report.md'), md)
    process.stdout.write(`\n${md.split('\n## Failures')[0]}\nReport: ${join(out, 'report.md')}\n`)
    if (report.mode === 'mock') return report.thresholdMet ? 0 : 1
    return report.totals.errors > 0 ? 1 : 0
  } finally {
    await mcp.close()
    db.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`ai:evals: ${redactSecrets(err instanceof Error ? err.message : String(err), process.env.OPENAI_API_KEY ?? null)}\n`)
    process.exit(2)
  }
)
