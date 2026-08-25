// Scenario 32 — a machine that has never held the app, and the same machine after a reinstall.
//
// Two roadmap items, one run, because they are the same claim read from both ends: the books
// belong to the user and live in their Documents folder. #346 starts with that folder absent —
// no data directory, no company, no remembered anything — and asks whether the app can arrive.
// #350 takes the installation away afterwards and asks whether the books stayed.
//
// Every other scenario begins from a directory the harness made, so this is the only place the
// very first millisecond is under test.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

// A path inside a directory that does not exist either — the app has to build the whole chain,
// not just the last segment.
const freshRoot = join(mkdtempSync(join(tmpdir(), 'total-fresh-')), 'never', 'existed', 'total')
assert(!existsSync(freshRoot), 'the data directory really is absent before launch')

await scenario(
  '32-fresh-machine',
  async (h) => {
    // ---- #346: first run on nothing ----
    await h.waitScreen('company-select')
    await h.shot('01-first-run')

    assert(existsSync(h.dataDir), 'first launch created the data directory it was pointed at')
    const { companies } = await h.invoke('company:list')
    assertEq(companies.length, 0, 'a machine that has never held the app has no companies')

    // The data-root panel has to be able to answer for a root it just made, including the
    // question of whether a sync client is sitting on it. A crash here is a crash on the very
    // first screen a buyer sees.
    const root = await h.invoke('app:dataRoot:get')
    assertEq(root.root, h.dataDir, 'the panel names the root the app actually built')
    assertEq(root.chosenMissing, false, 'and does not report it missing — it exists now')
    assertEq(root.companyOpen, false, 'with nothing open, because there is nothing to open')

    await h.createCompanyUI('Fresh Machine Traders')
    await h.shot('02-gateway')

    // Post something worth losing. A company row surviving a reinstall proves little; a voucher
    // with an amount in it is what the user would actually miss.
    const types = await h.invoke('master:voucherTypes:list')
    const ledgers = await h.invoke('master:ledgers:list')
    const groups = await h.invoke('master:groups:list')
    const cash = ledgers.find((l) => l.name === 'Cash')
    const sales = await h.invoke('master:ledgers:create', {
      name: 'Reinstall Sales',
      groupId: groups.find((g) => g.name === 'Sales Accounts').id,
      openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null
    })
    const today = new Date().toISOString().slice(0, 10)
    const saved = await h.invoke('voucher:save', {
      data: {
        voucherTypeId: types.find((t) => t.kind === 'receipt').id,
        date: today,
        partyLedgerId: null, narration: 'Survives a reinstall', reference: null,
        instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: 4_56_700 },
          { ledgerId: sales.id, drCr: 'cr', amount: 4_56_700 }
        ],
        inventory: []
      }
    })

    // ---- #350: uninstall, then reinstall ----
    const filesBefore = readdirSync(h.dataDir)
    await h.reinstall()

    assert(
      readdirSync(h.dataDir).length >= filesBefore.length,
      'removing the installation removed nothing from the data directory'
    )

    await h.waitScreen('company-select')
    const { companies: after } = await h.invoke('company:list')
    assertEq(after.length, 1, 'the company is still there after a reinstall')
    assertEq(after[0].name, 'Fresh Machine Traders', 'and it is the same company, by name')

    await h.openCompany('Fresh Machine Traders')
    const list = await h.invoke('voucher:list', { from: today, to: today })
    const found = list.find((v) => v.id === saved.id)
    assert(found, 'the voucher posted before the reinstall is still in the books')
    assertEq(found.amount, 4_56_700, 'to the paise')
    await h.shot('03-after-reinstall')
  },
  { harness: { dataDir: freshRoot, createDataDir: false } }
)
