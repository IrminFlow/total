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
  // The renderer: React, TanStack Query, zustand, the whole UI, plus every code-split screen
  // chunk. Splitting the screens out (K#226) moved bytes around inside this total rather than
  // removing them — what it changed is how many of them are read before anything is on screen,
  // which is the ENTRY_CHUNK_KB budget below and not this one.
  //
  // 3000 → 3200 when the last inventory lane landed: barcode labels, serial numbers, standard
  // costing, item images, price-list versioning and FX revaluation are six screens' worth of UI.
  // The number that actually guards startup is ENTRY_CHUNK_KB below, which is at 1,421 of 1,600 —
  // these bytes are in code-split chunks that are read when their screen is opened and not before.
  'out/renderer/assets': 3200,
  // Main process: better-sqlite3 is native and not counted here, so this is our own code.
  //
  // 900 → 1500 in the K lane, which found it already at 1,370 KB from the services sections
  // H/O/T/S/V added; a budget that is already breached is a budget nobody can use. Then 1500 →
  // 1700 when multi-GSTIN, the purchase chain, custom fields, job work and FX revaluation landed
  // together — 1,545 KB of services, which is what those features cost and not an accident. Then
  // 1700 → 1800 for the branch-transfer invoice, ISD, and the corrected e-TDS record layout,
  // which is 72 + 41 + 54 field definitions read out of the published file format.
  //
  // Worth checking against, because it is the number that would move if the AI SDK ever stopped
  // being code-split: `openai` is a megabyte, and it is currently a separate 6 KB entry chunk
  // (out/main/provider-*.js) with the SDK behind it. If this budget jumps by that much, that is
  // the first thing to look at — see ai-boundaries.test.ts, which guards the import graph.
  'out/main': 1800,
  'out/preload': 40,
  // The MCP server is a separate esbuild target, bundled and shipped unpacked.
  'out/mcp': 3000
}

/**
 * The startup budget that is not a stopwatch (roadmap K#236).
 *
 * `scripts/e2e/37-startup-budget.mjs` times a real cold launch, and on a shared machine that
 * measurement's noise is larger than most regressions worth catching — it can only be set loose
 * enough to catch a catastrophe. This number is the same regression, measured in the one unit
 * that does not move with the machine: bytes the renderer must read, parse and evaluate before it
 * can put anything on screen.
 *
 * A regression here looks like one static import added to App.tsx or to a component it reaches,
 * which drags a screen — and everything that screen imports — back into the entry chunk. That is
 * invisible in a diff and invisible in a timing on a busy runner. It is not invisible here.
 *
 * Measured 1,363 KB after the split (2,498 KB before it). The budget is that plus room for a
 * feature or two; if you need more, say in the commit what came in and why it has to be eager.
 */
const ENTRY_CHUNK_KB = 1600

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

// The entry chunk: the one file index.html loads directly. Everything else under assets/ is a
// lazy chunk, a font or the stylesheet, and none of it is read before the first screen.
try {
  const entries = readdirSync('out/renderer/assets').filter((f) => /^index-.*\.js$/.test(f))
  if (entries.length !== 1) {
    console.error(`\nExpected exactly one entry chunk in out/renderer/assets, found ${entries.length}: ${entries.join(', ')}`)
    console.error('If the build now emits several, this budget needs to learn which one index.html loads.')
    process.exit(1)
  }
  const kb = Math.round(statSync(join('out/renderer/assets', entries[0])).size / 1024)
  const over = kb > ENTRY_CHUNK_KB
  if (over) overBudget = true
  console.log(
    `  ${over ? 'OVER' : 'ok  '}  ${'entry chunk'.padEnd(22)} ${String(kb).padStart(5)} KB of ${ENTRY_CHUNK_KB} KB (${Math.round((kb / ENTRY_CHUNK_KB) * 100)}%) — read before the first screen`
  )
} catch {
  console.log('  ?     entry chunk            missing — run npm run build first')
}

if (overBudget) {
  console.error('\nA bundle is over budget. Either trim it, or raise the number in scripts/bundle-budget.mjs')
  console.error('in a commit that says what you added and why it is worth the bytes.')
  process.exit(1)
}
