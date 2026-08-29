// Time every screen against a book the size of a real business.
//
//   node scripts/perf-sweep.mjs                 # 4,000 invoices (~9,000 vouchers)
//   node scripts/perf-sweep.mjs --vouchers=20000
//
// Two performance measurements exist in this repo and they answer different questions.
// `services/scale.dbtest.ts` times the SQL. This times what a person waits for: the app is
// launched, a book is built, and every screen in the sidebar is navigated to with the clock
// running until it reports itself idle. That interval covers the query, the structured clone of
// the payload across IPC, and React rendering it — and on the row reports it is dominated by the
// second and third, which no service-level benchmark can see.
//
// The book is built through the ordinary `voucher:save` channel rather than by writing SQLite
// directly. That is slower to build, and it is the honest thing to measure against: it exercises
// the same validation, audit and duplicate-number path a real entry does, so the resulting book
// is one the app could actually have produced.
//
// Output: a markdown table on stdout and in smoke-out/perf/report.md. Not a pass/fail gate — a
// shared runner's variance is larger than most regressions worth catching. The numbers are for
// reading.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Harness } from './lib/harness.mjs'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const strArg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : null
}
const INVOICES = arg('vouchers', 4000)

/**
 * `--data-dir=<path>` runs against a book that is already there instead of building one.
 *
 * Building the book is the expensive half — it posts every voucher through the ordinary
 * `voucher:save` channel, which is the honest way to build it and is also a hundred thousand IPC
 * round trips at the sizes that matter. Timing a screen afterwards takes seconds. Separating the
 * two means the big book is built once and read many times, which is the difference between a
 * measurement you take and a measurement you avoid taking.
 *
 * The path is printed at the end of every build so it can be fed back in.
 */
const reuseDir = strArg('data-dir')

const outDir = path.join(process.cwd(), 'smoke-out', 'perf')
mkdirSync(outDir, { recursive: true })

const h = new Harness(reuseDir ? { dataDir: reuseDir } : {})
const rows = []
let built = null

try {
  await h.launch()
  if (reuseDir) {
    await h.openCompany('Demo Traders', 120_000)
  } else {
    await h.createDemoCompany()
  }

  // ---- build the book ----
  const t0 = Date.now()
  built = reuseDir
    ? { vouchers: (await h.invoke('voucher:list', { from: '2020-01-01', to: '2030-12-31' })).length }
    : await h.page.evaluate(async (count) => {
    const call = async (ch, p) => {
      const r = await window.total.invoke(ch, p)
      if (!r.ok) throw new Error(`${ch}: ${r.error}`)
      return r.data
    }

    const groups = await call('master:groups:list')
    const gid = (n) => groups.find((g) => g.name === n).id
    const mk = (name, group) => call('master:ledgers:create', { name, groupId: gid(group) })

    const sales = (await mk('Perf Sales A/c', 'Sales Accounts')).id
    const purch = (await mk('Perf Purchase A/c', 'Purchase Accounts')).id
    const ledgers = await call('master:ledgers:list')
    const cash = ledgers.find((l) => l.name === 'Cash').id

    const parties = []
    for (let i = 0; i < 40; i++) parties.push((await mk(`Perf Party ${i + 1}`, 'Sundry Debtors')).id)
    const suppliers = []
    for (let i = 0; i < 10; i++) suppliers.push((await mk(`Perf Supplier ${i + 1}`, 'Sundry Creditors')).id)

    const types = await call('master:voucherTypes:list')
    const tid = (k) => types.find((t) => t.kind === k).id
    const salesType = tid('sales')
    const receiptType = tid('receipt')
    const purchaseType = tid('purchase')

    const line = (ledgerId, drCr, amount) => ({ ledgerId, drCr, amount, costAllocations: [] })
    const post = (data) => call('voucher:save', { data })

    for (let i = 0; i < count; i++) {
      const party = parties[i % parties.length]
      // Working days across three financial years, which is what a business migrating off Tally
      // brings with it.
      const date = `${2025 + (i % 3)}-${String(((i * 7) % 12) + 1).padStart(2, '0')}-${String(((i * 13) % 26) + 1).padStart(2, '0')}`
      const amount = 100000 + (i % 500) * 137

      await post({
        voucherTypeId: salesType, date, partyLedgerId: party, narration: `Perf invoice ${i}`,
        lines: [line(party, 'dr', amount), line(sales, 'cr', amount)], inventory: [], billRefs: [], tds: null
      })

      // Three in four invoices get a receipt, one in five of those a part payment. That tail of
      // partly-settled bills is what makes the FIFO allocator work for its living, and it is the
      // reason the ageing reports are the slow ones.
      if (i % 4 !== 3) {
        const part = i % 5 === 0 ? Math.floor(amount / 3) : amount
        await post({
          voucherTypeId: receiptType, date, partyLedgerId: party, narration: `Perf receipt ${i}`,
          lines: [line(cash, 'dr', part), line(party, 'cr', part)], inventory: [], billRefs: [], tds: null
        })
      }
      if (i % 5 === 0) {
        const supplier = suppliers[i % suppliers.length]
        await post({
          voucherTypeId: purchaseType, date, partyLedgerId: supplier, narration: `Perf purchase ${i}`,
          lines: [line(purch, 'dr', amount), line(supplier, 'cr', amount)], inventory: [], billRefs: [], tds: null
        })
      }
    }

    const all = await call('voucher:list', { from: '2020-01-01', to: '2030-12-31' })
    return { vouchers: all.length }
  }, INVOICES)

  const buildMs = Date.now() - t0
  console.log(
    reuseDir
      ? `reusing ${built.vouchers.toLocaleString('en-IN')} vouchers in ${reuseDir}`
      : `built ${built.vouchers.toLocaleString('en-IN')} vouchers in ${(buildMs / 1000).toFixed(0)}s`
  )

  // ---- time every screen ----
  const screens = await h.page.$$eval('[data-testid^="nav-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace(/^nav-/, ''))
  )
  console.log(`timing ${screens.length} screens…`)

  for (const name of screens) {
    // Two passes: the first pays the cold query and whatever the cache had to fill, the second is
    // what a person feels on every visit after that. A screen that is slow once is a different
    // problem from one that is slow every time, and reporting a single number hides which it is.
    const times = []
    for (let pass = 0; pass < 2; pass++) {
      await h.goto('gateway', 60_000).catch(() => {})
      const t = Date.now()
      try {
        await h.goto(name, 60_000)
        times.push(Date.now() - t)
      } catch {
        times.push(null)
      }
    }
    rows.push({ screen: name, cold: times[0], warm: times[1] })
    console.log(
      `  ${name.padEnd(20)} ${String(times[0] ?? '—').padStart(6)} ms cold  ${String(times[1] ?? '—').padStart(6)} ms warm`
    )
  }
} finally {
  await h.close()
}

const ok = rows.filter((r) => r.warm !== null)
const slowest = [...ok].sort((a, b) => b.warm - a.warm)
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')

const md = [
  `# Screen timings at ${(built?.vouchers ?? 0).toLocaleString('en-IN')} vouchers`,
  '',
  `Measured ${stamp} on ${process.platform}. Time from clicking a sidebar entry to the screen`,
  'reporting itself idle — query, IPC payload and render together. Cold is the first visit of the',
  'session; warm is every visit after it.',
  '',
  '| Screen | Cold | Warm |',
  '|---|---:|---:|',
  ...slowest.map((r) => `| ${r.screen} | ${r.cold} ms | ${r.warm} ms |`),
  ...rows.filter((r) => r.warm === null).map((r) => `| ${r.screen} | — | did not settle |`),
  '',
  `Slowest warm: ${slowest.slice(0, 3).map((r) => `${r.screen} ${r.warm} ms`).join(', ')}.`
].join('\n')

writeFileSync(path.join(outDir, 'report.md'), md + '\n')
console.log('\n' + md)
console.log(`\nwritten to ${path.join(outDir, 'report.md')}`)
// Last line, so it is the thing left on screen after an hour-long build: the book is still on
// disk, and re-timing it is `--data-dir=<that>`.
console.log(`book kept at ${h.dataDir}\n  re-time it:  node scripts/perf-sweep.mjs --data-dir=${h.dataDir}`)
