// Fail the build when a bundle grows past its budget.
//
// Startup time is the first thing a buyer judges and the renderer chunk is most of it. A budget
// only works if it is checked automatically: a 40 KB dependency added on a Tuesday is invisible,
// and twelve of them are a second of cold start nobody can attribute to anything.
//
// The numbers below are the measured sizes at the time of writing plus headroom, not aspirations.
// Raising one is fine — do it deliberately, in a commit that says why.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BUDGETS_KB = {
  // The renderer: React, TanStack Query, zustand, the whole UI. This is the one that matters.
  'out/renderer/assets': 2400,
  // Main process: better-sqlite3 is native and not counted here, so this is our own code.
  'out/main': 900,
  'out/preload': 40,
  // The MCP server is a separate esbuild target, bundled and shipped unpacked.
  'out/mcp': 3000
}

function sizeKb(dir) {
  let total = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      // Source maps ship in dev builds and are not what a user downloads.
      else if (!entry.name.endsWith('.map')) total += statSync(full).size
    }
  }
  walk(dir)
  return Math.round(total / 1024)
}

let overBudget = false
console.log('bundle budget')
for (const [dir, budget] of Object.entries(BUDGETS_KB)) {
  let kb
  try {
    kb = sizeKb(dir)
  } catch {
    console.log(`  ?     ${dir.padEnd(22)} missing — run npm run build first`)
    continue
  }
  const pct = Math.round((kb / budget) * 100)
  const over = kb > budget
  if (over) overBudget = true
  console.log(`  ${over ? 'OVER' : 'ok  '}  ${dir.padEnd(22)} ${String(kb).padStart(5)} KB of ${budget} KB (${pct}%)`)
}

if (overBudget) {
  console.error('\nA bundle is over budget. Either trim it, or raise the number in scripts/bundle-budget.mjs')
  console.error('in a commit that says what you added and why it is worth the bytes.')
  process.exit(1)
}
