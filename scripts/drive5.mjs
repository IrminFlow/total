// Pass 5: functional banking check via IPC + banking screen shot with data.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = '/Users/irmin/total-t'
const SHOTS = '/private/tmp/claude-501/-Users-irmin-total-t/0434fe82-7dc5-4778-8cdc-ba2b98437f00/scratchpad/shots'
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], timeout: 30000 })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await new Promise((r) => setTimeout(r, 1500))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const invoke = (channel, payload) => page.evaluate(async ({ channel, payload }) => await window.total.invoke(channel, payload), { channel, payload })
const clickText = async (text) => {
  await page.evaluate((t) => {
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
    const rows = [...document.querySelectorAll('div.kbar-row, div[class*="cursor-pointer"]')]
    const el = buttons.find((e) => e.textContent?.trim() === t) ?? rows.find((e) => e.textContent?.includes(t)) ?? buttons.find((e) => e.textContent?.includes(t))
    el?.click()
  }, text)
  await sleep(500)
}

try {
  await invoke('company:open', { slug: 'demo-traders' })

  // Ensure a bank ledger exists
  const ledgers = (await invoke('master:ledgers:list')).data
  let bank = ledgers.find((l) => l.name === 'HDFC Bank')
  if (!bank) {
    const groups = (await invoke('master:groups:list')).data
    const bankGroup = groups.find((g) => g.name === 'Bank Accounts')
    bank = (await invoke('master:ledgers:create', {
      name: 'HDFC Bank', groupId: bankGroup.id, openingBalance: 0, gstin: null, stateCode: null,
      address: null, taxType: null, gstRate: null, hsn: null
    })).data
    console.log('bank ledger created', bank.id)
  }

  // Contra: Cash -> Bank 20,000 (if not already)
  const vouchers = (await invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })).data
  if (!vouchers.some((v) => v.kind === 'contra')) {
    const types = (await invoke('master:voucherTypes:list')).data
    const contra = types.find((t) => t.kind === 'contra')
    const cash = ledgers.find((l) => l.name === 'Cash')
    const saved = await invoke('voucher:save', {
      data: {
        voucherTypeId: contra.id, date: '2026-08-15', partyLedgerId: null,
        narration: 'Cash deposited into bank', reference: null,
        instrumentNo: 'DEP001', instrumentDate: '2026-08-15',
        transporterId: null, vehicleNo: null, transportDistanceKm: null,
        lines: [
          { ledgerId: bank.id, drCr: 'dr', amount: 2000000 },
          { ledgerId: cash.id, drCr: 'cr', amount: 2000000 }
        ],
        inventory: []
      }
    })
    console.log('contra saved:', saved.ok ? saved.data.number : saved.error)
  }

  const recon1 = (await invoke('bank:recon', { ledgerId: bank.id, from: '2026-04-01', to: '2027-03-31' })).data
  console.log('RECON before:', JSON.stringify({ book: recon1.bookBalance, bank: recon1.bankBalance, rows: recon1.rows.length }))
  const line = recon1.rows.find((r) => !r.bankDate)
  if (line) {
    await invoke('bank:setBankDate', { lineId: line.lineId, bankDate: '2026-08-16' })
  }
  const recon2 = (await invoke('bank:recon', { ledgerId: bank.id, from: '2026-04-01', to: '2027-03-31' })).data
  console.log('RECON after:', JSON.stringify({ book: recon2.bookBalance, bank: recon2.bankBalance }))

  // reload UI state and screenshot the banking screen with data
  await page.reload()
  await sleep(1500)
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
} finally {
  try {
    await clickText('Demo Traders')
    await sleep(1000)
    await clickText('Reconciliation')
    await sleep(800)
    await page.screenshot({ path: path.join(SHOTS, '50-banking-data.png') })
    console.log('shot: 50-banking-data')
  } catch {}
  await app.close()
}
