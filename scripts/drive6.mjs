// Pass 6: payroll, BOM/manufacture, multi-currency, Tally import, NIC credential round-trip.
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
const invoke = async (channel, payload) => {
  const r = await page.evaluate(async ({ channel, payload }) => await window.total.invoke(channel, payload), { channel, payload })
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data
}
const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') })
  console.log('shot:', name)
}
const clickText = async (text) => {
  const r = await page.evaluate((t) => {
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
    const rows = [...document.querySelectorAll('div.kbar-row, div[class*="cursor-pointer"]')]
    const el = buttons.find((e) => e.textContent?.trim() === t) ?? rows.find((e) => e.textContent?.includes(t)) ?? buttons.find((e) => e.textContent?.includes(t))
    if (!el) return 'NOT_FOUND'
    el.click()
    return 'OK'
  }, text)
  console.log('click', JSON.stringify(text), r)
  await sleep(500)
}

try {
  await invoke('company:open', { slug: 'demo-traders' })

  // ---------- payroll ----------
  const employees = await invoke('payroll:employees:list')
  if (!employees.some((e) => e.name === 'Asha Kulkarni')) {
    await invoke('payroll:employees:save', {
      data: {
        name: 'Asha Kulkarni', code: 'E001', designation: 'Accountant', joined: null,
        pan: 'ABCPK1234F', uan: '100200300400', esicNo: null,
        basic: 3000000, hra: 1200000, special: 600000,
        pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
      }
    })
    await invoke('payroll:employees:save', {
      data: {
        name: 'Ravi Iyer', code: 'E002', designation: 'Sales', joined: null,
        pan: null, uan: null, esicNo: null,
        basic: 1200000, hra: 400000, special: 200000,
        pfEnabled: true, esiEnabled: true, ptEnabled: true, active: true
      }
    })
  }
  const preview = await invoke('payroll:preview', { month: '2026-08', days: [] })
  console.log('PAYROLL preview:', JSON.stringify(preview.map((l) => ({ n: l.employeeName, gross: l.gross, pf: l.pfEmp, esi: l.esiEmp, pt: l.pt, net: l.net }))))
  const runs = await invoke('payroll:runs')
  if (!runs.some((r) => r.month === '2026-08')) {
    const run = await invoke('payroll:commit', { month: '2026-08', days: [] })
    console.log('PAYROLL committed: voucher', run.voucherId, 'lines', run.lines.length)
    const slip = await invoke('payroll:payslip', { runId: run.id, employeeId: run.lines[0].employeeId })
    console.log('PAYSLIP:', slip.path)
  }

  // ---------- BOM + manufacture ----------
  const units = await invoke('master:units:list')
  const nos = units.find((u) => u.symbol === 'Nos') ?? units[0]
  const items = await invoke('master:stockItems:list')
  const ensureItem = async (name, gstRate) => {
    const found = items.find((i) => i.name === name)
    if (found) return found
    return await invoke('master:stockItems:create', {
      name, groupId: null, unitId: nos.id, hsn: '8471', gstRate, cessRate: null, openingQtyMilli: 0, openingValue: 0
    })
  }
  const ssd = await ensureItem('SSD 1TB', 18)
  const pc = await ensureItem('Custom PC', 18)
  await invoke('bom:set', { itemId: pc.id, lines: [{ componentId: ssd.id, qtyMilliPerUnit: 2000 }] })
  // Purchase 10 SSDs @ 8,000 so there's stock cost
  const ledgers = await invoke('master:ledgers:list')
  const supplier = ledgers.find((l) => l.name === 'Bulk Suppliers')
  const purchases = ledgers.find((l) => l.name === 'Purchases')
  const types = await invoke('master:voucherTypes:list')
  const purchaseType = types.find((t) => t.kind === 'purchase')
  const vouchers = await invoke('voucher:list', { from: '2026-04-01', to: '2027-03-31' })
  if (!vouchers.some((v) => v.narration === 'SSD stock')) {
    const cgst = ledgers.find((l) => l.taxType === 'cgst')
    const sgst = ledgers.find((l) => l.taxType === 'sgst')
    await invoke('voucher:save', {
      data: {
        voucherTypeId: purchaseType.id, date: '2026-08-15', partyLedgerId: supplier.id,
        narration: 'SSD stock', reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: supplier.id, drCr: 'cr', amount: 9440000 },
          { ledgerId: purchases.id, drCr: 'dr', amount: 8000000 },
          { ledgerId: cgst.id, drCr: 'dr', amount: 720000 },
          { ledgerId: sgst.id, drCr: 'dr', amount: 720000 }
        ],
        inventory: [{ stockItemId: ssd.id, godownId: null, qtyMilli: 10000, ratePaise: 800000, amount: 8000000, direction: 'in' }]
      }
    })
    console.log('SSD purchase saved')
  }

  // Manufacture via UI
  await page.reload()
  await sleep(1500)
  await clickText('Demo Traders')
  await sleep(1200)
  await clickText('Voucher entry')
  await sleep(500)
  await clickText('Stock Journal')
  await sleep(500)
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    inputs.find((i) => i.placeholder === 'Stock item')?.focus()
  })
  await page.keyboard.type('Custom PC', { delay: 15 })
  await sleep(500)
  await page.keyboard.press('Enter')
  await sleep(800)
  // qty field: value '1' — set to 3
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
    const q = inputs.find((i) => i.value === '1' && i.className.includes('text-right'))
    if (q) {
      q.focus()
      q.select()
    }
  })
  await page.keyboard.type('3', { delay: 20 })
  await sleep(600)
  await shot('60-manufacture')
  await clickText('Save manufacture')
  await sleep(1000)

  const stock = await invoke('report:stockSummary', { asOn: '2027-03-31' })
  console.log('STOCK:', JSON.stringify(stock.map((s) => ({ n: s.name, qty: s.closingQtyMilli / 1000, val: s.closingValue }))))

  // ---------- multi-currency ----------
  const currencies = await invoke('currency:list')
  if (!currencies.some((c) => c.code === 'USD')) {
    await invoke('currency:create', { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 })
    console.log('USD created')
  }
  await clickText('Sales')
  await sleep(600)
  await shot('61-sales-currency')

  // ---------- Tally import ----------
  const tallyXml = `<?xml version="1.0"?><ENVELOPE><BODY>
    <TALLYMESSAGE><GROUP NAME="Overseas Debtors"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
    <TALLYMESSAGE><LEDGER NAME="Imported Ledger Co"><PARENT>Overseas Debtors</PARENT><OPENINGBALANCE>-7500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
    <TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20260810</DATE><VOUCHERNUMBER>TLY-9</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Imported Ledger Co</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE>
  </BODY></ENVELOPE>`
  const imported = await invoke('tally:import', { xmlText: tallyXml })
  console.log('TALLY IMPORT:', JSON.stringify(imported))

  // ---------- NIC credentials round-trip ----------
  const st0 = await invoke('nic:status')
  const saveRes = await invoke('nic:save', {
    baseUrlEinvoice: 'https://einv-apisandbox.nic.in', baseUrlEwb: '',
    username: 'demo_user', password: 'secret123', clientId: 'CID', clientSecret: 'CSEC',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----'
  })
  const got = await invoke('nic:get')
  console.log('NIC:', JSON.stringify({ before: st0.configured, afterSave: saveRes.configured, maskedPw: got.password }))

  // Trial balance still ties?
  const tb = await invoke('report:trialBalance', { asOn: '2027-03-31' })
  console.log('TB:', tb.totalDebit, tb.totalCredit, tb.totalDebit === tb.totalCredit ? 'TIES' : 'MISMATCH')

  // Payroll screen shot
  await clickText('Employees & runs')
  await sleep(700)
  await clickText('Pay runs')
  await sleep(700)
  await shot('62-payroll')
} catch (err) {
  console.error('DRIVE ERROR:', err.message)
  await shot('99-error6')
} finally {
  await app.close()
}
