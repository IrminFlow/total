/**
 * Headless CLI entry point — bundled by `scripts/total-cli.mjs` (esbuild) and run under
 * Electron-as-Node so better-sqlite3's Electron-ABI build loads. Never imports Electron APIs
 * that need a browser process; `require('electron')` resolves to the binary-path string here,
 * which the shared modules tolerate (they only call `app.*` when TOTAL_DATA_DIR is unset, and
 * the launcher always sets it).
 *
 * Every command prints a single JSON document to stdout; errors go to stderr with exit code 1.
 * All writes are audit-logged with user_name 'agent-cli' — except `mcp`, which speaks the MCP
 * protocol on stdin/stdout (WP 5.7, src/main/mcp/) and attributes its rows to `mcp:<client>`.
 */
import { readFileSync } from 'fs'
import { setAuditContext } from '../services/audit'
import { todayISO } from '@shared/dates'
import { dataRoot } from '../paths'
import { LEGACY_INBOX_WARNING, scanInbox, type MirrorFormat, type MirrorWhat } from '../services/agentBridge'
import { runAsAuditUser } from '../services/audit'
import { runMcpStdio } from '../mcp/stdio'
import { parseRole } from '../mcp/session'
import {
  cmdCompanies, cmdCreateCompany, cmdExport, cmdImportMasters, cmdInitAgentDocs, cmdNextNumber,
  cmdPost, cmdTrialBalance, openCompany
} from './commands'
import { AGENTS_MD, ensureAgentDocs, voucherSchemaJsonText } from './docs'

const USAGE = `total-cli — headless access to Total's books (same validation as the app)

Usage: npm run cli -- <command> [options]

Commands:
  companies                                List the company registry as JSON.
  create-company --name <n> --state <code> [--gstin <g>] [--books-from <year>]
                                           Create + seed a new company; prints { slug }.
  post --company <slug> --file <voucher.json>
                                           Post one voucher (or an array). JSON per-voucher results.
  import-masters --company <slug> --file <x.csv> --kind ledgers|items
                                           Import masters CSV (template headers).
  trial-balance --company <slug> [--as-on YYYY-MM-DD]
                                           Trial balance JSON to stdout.
  next-number --company <slug> --type <name-or-id> [--date YYYY-MM-DD]
                                           Next voucher number for a type.
  export --company <slug> [--what masters|vouchers|reports|all] [--format csv|json|all]
         [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                           Regenerate CSV/JSON mirrors under <company>/agent/.
  init-agent-docs                          Write AGENTS.md + voucher.schema.json into the data root.
  mcp --company <slug> [--role viewer|accountant|owner] [--user <name>] [--no-mask] [--pseudonymise]
                                           MCP server on stdio: the in-app assistant's read + draft
                                           tools and read-only resources. Default role viewer;
                                           accountant/owner (draft tools) need --role and, when the
                                           company has users, --user + TOTAL_MCP_PIN. Masking of
                                           GSTIN/PAN/bank numbers is on unless --no-mask. Nothing
                                           it does posts to the books.
  inbox --company <slug> [--legacy-inbox-post]
                                           Process <company>/inbox/ once: voucher drops become
                                           drafts for review. --legacy-inbox-post (DEPRECATED)
                                           posts them / imports masters CSVs as before.

Data root: TOTAL_DATA_DIR (currently ${process.env.TOTAL_DATA_DIR ?? '~/Documents/total'})
Amounts are integer paise; every voucher must balance (debits == credits) or it is rejected.`

interface Args {
  command: string
  flags: Map<string, string>
}

/** Flags that take no value. */
const SWITCHES = new Set(['legacy-inbox-post', 'no-mask', 'pseudonymise'])

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}' (flags look like --name value)`)
    const key = arg.slice(2)
    if (SWITCHES.has(key)) {
      flags.set(key, 'true')
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Flag --${key} needs a value`)
    flags.set(key, value)
    i++
  }
  return { command: command ?? 'help', flags }
}

function required(args: Args, name: string): string {
  const v = args.flags.get(name)
  if (!v) throw new Error(`Missing required flag --${name}`)
  return v
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function withCompany<T>(args: Args, fn: (db: import('../db/connection').DB, slug: string) => T): T {
  const slug = required(args, 'company')
  const db = openCompany(slug)
  try {
    return fn(db, slug)
  } finally {
    db.close()
  }
}

const CLI_VERSION = `${process.env.npm_package_version ?? ''}-cli`.replace(/^-/, 'cli')

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  setAuditContext({ appVersion: CLI_VERSION, getUserName: () => 'agent-cli' })
  // Self-discovery: make sure AGENTS.md exists in the data root from the very first CLI run.
  ensureAgentDocs()

  switch (args.command) {
    case 'companies':
      out(cmdCompanies())
      return
    case 'create-company': {
      out(
        cmdCreateCompany({
          name: required(args, 'name'),
          stateCode: required(args, 'state'),
          gstin: args.flags.get('gstin') ?? null,
          booksFrom: args.flags.has('books-from') ? Number(args.flags.get('books-from')) : undefined
        })
      )
      return
    }
    case 'post': {
      const file = required(args, 'file')
      const payload: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const results = withCompany(args, (db) => cmdPost(db, payload))
      out(results)
      if (results.some((r) => !r.ok)) process.exitCode = 1
      return
    }
    case 'import-masters': {
      const kind = required(args, 'kind')
      if (kind !== 'ledgers' && kind !== 'items') throw new Error(`--kind must be ledgers or items, got '${kind}'`)
      const csvText = readFileSync(required(args, 'file'), 'utf8')
      const result = withCompany(args, (db) => cmdImportMasters(db, kind, csvText))
      out(result)
      if (result.errors.length > 0) process.exitCode = 1
      return
    }
    case 'trial-balance':
      out(withCompany(args, (db) => cmdTrialBalance(db, args.flags.get('as-on') ?? todayISO())))
      return
    case 'next-number':
      out(withCompany(args, (db) => cmdNextNumber(db, required(args, 'type'), args.flags.get('date') ?? todayISO())))
      return
    case 'export': {
      const what = (args.flags.get('what') ?? 'all') as MirrorWhat
      const format = (args.flags.get('format') ?? 'all') as MirrorFormat
      if (!['masters', 'vouchers', 'reports', 'all'].includes(what)) throw new Error(`Bad --what '${what}'`)
      if (!['csv', 'json', 'all'].includes(format)) throw new Error(`Bad --format '${format}'`)
      out(
        withCompany(args, (db, slug) =>
          cmdExport(db, slug, { what, format, from: args.flags.get('from'), to: args.flags.get('to') })
        )
      )
      return
    }
    case 'mcp': {
      const slug = required(args, 'company')
      const db = openCompany(slug)
      try {
        await runMcpStdio({
          db,
          slug,
          role: parseRole(args.flags.get('role')),
          user: args.flags.get('user') ?? null,
          pin: process.env.TOTAL_MCP_PIN ?? null,
          maskIds: !args.flags.has('no-mask'),
          pseudonymiseParties: args.flags.has('pseudonymise'),
          version: CLI_VERSION
        })
      } finally {
        db.close()
      }
      return
    }
    case 'inbox': {
      const legacyPost = args.flags.has('legacy-inbox-post')
      if (legacyPost) process.stderr.write(`${LEGACY_INBOX_WARNING}\n`)
      out(withCompany(args, (db, slug) => runAsAuditUser('agent-inbox', () => scanInbox(db, slug, { legacyPost }))))
      return
    }
    case 'init-agent-docs':
      out(cmdInitAgentDocs(AGENTS_MD, voucherSchemaJsonText()))
      return
    case 'help':
    case '--help':
      process.stdout.write(USAGE + '\n')
      return
    default:
      throw new Error(`Unknown command '${args.command}'\n\n${USAGE}`)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.stderr.write(`(data root: ${(() => { try { return dataRoot() } catch { return 'unknown' } })()})\n`)
  process.exit(1)
})
