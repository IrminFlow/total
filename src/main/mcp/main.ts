/**
 * stdio entry point for the Total MCP server.
 *
 * Runs under the Electron binary with ELECTRON_RUN_AS_NODE=1, the same trick scripts/test-db.mjs
 * and scripts/total-cli.mjs use, so better-sqlite3's Electron-ABI build loads with no rebuild and
 * the end user needs no Node install of their own.
 *
 *   total-mcp --company <slug> [--allow-writes]
 *
 * `--company` is required and there is deliberately no tool to switch: an agent that can silently
 * change which books it is writing to is an agent that posts a purchase into the wrong company.
 */

import { openForMcp, listCompanySlugs } from './companyDb'
import { serve } from './server'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const slug = arg('company')
  if (!slug) {
    // stderr, never stdout: stdout is the MCP transport and any stray byte corrupts the stream.
    process.stderr.write(
      `total-mcp: --company <slug> is required.\nKnown companies: ${listCompanySlugs().join(', ') || '(none)'}\n`
    )
    process.exit(2)
  }

  const company = openForMcp(slug, process.argv.includes('--allow-writes'))
  await serve(company)
}

main().catch((err: unknown) => {
  process.stderr.write(`total-mcp: ${(err as Error).message}\n`)
  process.exit(1)
})
