import { dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'fs'
import { z } from 'zod'
import type { DB } from './db/connection'
import { backupCompany, openCompanyDb } from './db/connection'
import { readCompanyInfo, seedCompany, writeCompanyInfo } from './db/seed'
import { readRegistry, touchLastOpened, upsertCompany } from './registry'
import { companyDbPath, companyExportsDir, ensureCompanyTree, slugify } from './paths'
import { log, revealLogs } from './log'
import {
  companyCreateSchema, godownInputSchema, groupInputSchema, ledgerInputSchema, periodSchema,
  rendererLogSchema, stockGroupInputSchema, stockItemInputSchema, unitInputSchema, voucherInputSchema,
  voucherTypeInputSchema
} from '@shared/schemas'
import * as masters from './services/masters'
import * as vouchers from './services/vouchers'
import * as reports from './services/reports'
import * as gst from './services/gst'
import * as intel from './services/intel'
import * as analysis from './services/analysis'
import * as banking from './services/banking'
import * as edocs from './services/edocs'
import * as invoice from './services/invoice'
import * as extras from './services/extras'
import * as payroll from './services/payroll'
import * as nic from './services/nic'
import { importTallyXml } from './services/tallyImport'
import {
  bomInputSchema, currencyInputSchema, employeeInputSchema, nicCredentialsSchema
} from '@shared/schemas'
import { existsSync } from 'fs'
import type { CompanyInfo } from '@shared/domain'

interface OpenCompany {
  slug: string
  db: DB
  info: CompanyInfo
}

let current: OpenCompany | null = null

function requireCompany(): OpenCompany {
  if (!current) throw new Error('No company is open')
  return current
}

export function closeCurrentCompany(): void {
  if (current) {
    current.db.close()
    current = null
  }
}

type Handler = (payload: unknown) => unknown | Promise<unknown>

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(`total:${channel}`, async (_event, payload: unknown) => {
    try {
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err instanceof Error
          ? err.message
          : String(err)
      // Never log payloads — only the channel name and the error message.
      log('error', 'ipc-handler', { channel, error: message })
      return { ok: false, error: message }
    }
  })
}

const idSchema = z.object({ id: z.number().int().positive() })
const withIdSchema = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive(), data: schema })

export function registerIpc(): void {
  // ---------- company ----------
  handle('company:list', () => readRegistry())

  handle('company:create', (payload) => {
    const input = companyCreateSchema.parse(payload)
    let slug = slugify(input.name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(input.name)}-${n++}`
    ensureCompanyTree(slug)
    const db = openCompanyDb(slug)
    const info: CompanyInfo = { ...input }
    seedCompany(db, info)
    db.close()
    upsertCompany({ slug, name: input.name, stateCode: input.stateCode, gstin: input.gstin, lastOpenedAt: null })
    return { slug }
  })

  handle('company:open', (payload) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(payload)
    if (!existsSync(companyDbPath(slug))) throw new Error('Company database not found')
    closeCurrentCompany()
    backupCompany(slug, 'open')
    const db = openCompanyDb(slug)
    const info = readCompanyInfo(db)
    current = { slug, db, info }
    touchLastOpened(slug)
    return { slug, info }
  })

  handle('company:close', () => {
    closeCurrentCompany()
    return null
  })

  handle('company:current', () => (current ? { slug: current.slug, info: current.info } : null))

  handle('company:updateInfo', (payload) => {
    const c = requireCompany()
    const input = companyCreateSchema.parse(payload)
    const info: CompanyInfo = { ...input }
    writeCompanyInfo(c.db, info)
    c.info = info
    upsertCompany({ slug: c.slug, name: info.name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: new Date().toISOString() })
    return info
  })

  handle('company:backup', () => {
    const c = requireCompany()
    return { path: backupCompany(c.slug, 'manual') }
  })

  handle('company:revealExports', () => {
    const c = requireCompany()
    shell.openPath(companyExportsDir(c.slug))
    return null
  })

  // ---------- masters ----------
  handle('master:groups:list', () => masters.listGroups(requireCompany().db))
  handle('master:groups:tree', () => masters.groupTree(requireCompany().db))
  handle('master:groups:create', (p) => masters.createGroup(requireCompany().db, groupInputSchema.parse(p)))
  handle('master:groups:update', (p) => {
    const { id, data } = withIdSchema(groupInputSchema).parse(p)
    return masters.updateGroup(requireCompany().db, id, data)
  })
  handle('master:groups:delete', (p) => masters.deleteGroup(requireCompany().db, idSchema.parse(p).id))

  handle('master:ledgers:list', () => masters.listLedgers(requireCompany().db))
  handle('master:ledgers:create', (p) => masters.createLedger(requireCompany().db, ledgerInputSchema.parse(p)))
  handle('master:ledgers:update', (p) => {
    const { id, data } = withIdSchema(ledgerInputSchema).parse(p)
    return masters.updateLedger(requireCompany().db, id, data)
  })
  handle('master:ledgers:delete', (p) => masters.deleteLedger(requireCompany().db, idSchema.parse(p).id))
  handle('master:ledgerBalances', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return masters.ledgerBalances(requireCompany().db, asOn)
  })

  handle('master:voucherTypes:list', () => masters.listVoucherTypes(requireCompany().db))
  handle('master:voucherTypes:create', (p) => masters.createVoucherType(requireCompany().db, voucherTypeInputSchema.parse(p)))
  handle('master:voucherTypes:update', (p) => {
    const { id, data } = withIdSchema(voucherTypeInputSchema).parse(p)
    return masters.updateVoucherType(requireCompany().db, id, data)
  })

  handle('master:units:list', () => masters.listUnits(requireCompany().db))
  handle('master:units:create', (p) => masters.createUnit(requireCompany().db, unitInputSchema.parse(p)))
  handle('master:stockGroups:list', () => masters.listStockGroups(requireCompany().db))
  handle('master:stockGroups:create', (p) => masters.createStockGroup(requireCompany().db, stockGroupInputSchema.parse(p)))
  handle('master:stockItems:list', () => masters.listStockItems(requireCompany().db))
  handle('master:stockItems:create', (p) => masters.createStockItem(requireCompany().db, stockItemInputSchema.parse(p)))
  handle('master:stockItems:update', (p) => {
    const { id, data } = withIdSchema(stockItemInputSchema).parse(p)
    return masters.updateStockItem(requireCompany().db, id, data)
  })
  handle('master:stockItems:delete', (p) => masters.deleteStockItem(requireCompany().db, idSchema.parse(p).id))
  handle('master:godowns:list', () => masters.listGodowns(requireCompany().db))
  handle('master:godowns:create', (p) => masters.createGodown(requireCompany().db, godownInputSchema.parse(p)))

  // ---------- vouchers ----------
  handle('voucher:list', (p) => {
    const { from, to, voucherTypeId } = periodSchema.extend({ voucherTypeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.listVouchers(requireCompany().db, from, to, voucherTypeId)
  })
  handle('voucher:get', (p) => vouchers.getVoucher(requireCompany().db, idSchema.parse(p).id))
  handle('voucher:save', (p) => {
    const { data, id } = z.object({ data: voucherInputSchema, id: z.number().int().positive().optional() }).parse(p)
    return vouchers.saveVoucher(requireCompany().db, data, id)
  })
  handle('voucher:delete', (p) => vouchers.deleteVoucher(requireCompany().db, idSchema.parse(p).id))
  handle('voucher:nextNumber', (p) => {
    const { voucherTypeId, date, excludeId } = z
      .object({ voucherTypeId: z.number().int().positive(), date: z.string(), excludeId: z.number().int().positive().optional() })
      .parse(p)
    return { number: vouchers.nextVoucherNumber(requireCompany().db, voucherTypeId, date, excludeId) }
  })
  handle('voucher:duplicates', (p) => {
    const { data, excludeId } = z.object({ data: voucherInputSchema, excludeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.findDuplicates(requireCompany().db, data, excludeId)
  })

  // ---------- reports ----------
  handle('report:dayBook', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.dayBook(requireCompany().db, from, to)
  })
  handle('report:ledger', (p) => {
    const { ledgerId, from, to } = periodSchema.extend({ ledgerId: z.number().int().positive() }).parse(p)
    return reports.ledgerStatement(requireCompany().db, ledgerId, from, to)
  })
  handle('report:trialBalance', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return reports.trialBalance(requireCompany().db, asOn)
  })
  handle('report:profitLoss', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.profitAndLoss(requireCompany().db, from, to)
  })
  handle('report:balanceSheet', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    const c = requireCompany()
    return reports.balanceSheet(c.db, `${c.info.booksFrom}-04-01`, asOn)
  })
  handle('report:stockSummary', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return reports.stockSummary(requireCompany().db, asOn)
  })
  handle('report:dashboard', (p) => {
    const { today, fyFrom } = z.object({ today: z.string(), fyFrom: z.string() }).parse(p)
    return reports.dashboard(requireCompany().db, today, fyFrom)
  })

  // ---------- gst ----------
  const gstPeriodInput = periodSchema.extend({ period: z.string().regex(/^\d{6}$/) })
  handle('gst:gstr1', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    return gst.gstr1(c.db, c.info, from, to, period)
  })
  handle('gst:gstr3b', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    return gst.gstr3b(c.db, c.info, from, to, period)
  })
  handle('gst:exportGstr1', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    const result = gst.gstr1(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr1', period, result.json)
    const csvPath = gst.exportGstr1Csv(c.slug, result)
    shell.showItemInFolder(jsonPath)
    return { jsonPath, csvPath }
  })
  handle('gst:exportGstr3b', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    const result = gst.gstr3b(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr3b', period, result.json)
    shell.showItemInFolder(jsonPath)
    return { jsonPath }
  })

  // ---------- analysis ----------
  handle('analysis:register', (p) => {
    const { kind, from, to } = periodSchema.extend({ kind: z.enum(['sales', 'purchase']) }).parse(p)
    return analysis.registerByMonth(requireCompany().db, kind, from, to)
  })
  handle('analysis:outstandings', (p) => {
    const { side, asOn } = z.object({ side: z.enum(['receivable', 'payable']), asOn: z.string() }).parse(p)
    return analysis.outstandings(requireCompany().db, side, asOn)
  })

  // ---------- banking ----------
  handle('bank:ledgers', () => banking.bankLedgers(requireCompany().db))
  handle('bank:recon', (p) => {
    const { ledgerId, from, to } = periodSchema.extend({ ledgerId: z.number().int().positive() }).parse(p)
    return banking.bankRecon(requireCompany().db, ledgerId, from, to)
  })
  handle('bank:setBankDate', (p) => {
    const { lineId, bankDate } = z.object({ lineId: z.number().int().positive(), bankDate: z.string().nullable() }).parse(p)
    banking.setBankDate(requireCompany().db, lineId, bankDate)
    return null
  })
  handle('bank:importCsv', async (p) => {
    const { ledgerId, csvText } = z
      .object({ ledgerId: z.number().int().positive(), csvText: z.string().optional() })
      .parse(p)
    const c = requireCompany()
    let csv = csvText
    if (csv === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose bank statement CSV',
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      csv = readFileSync(picked.filePaths[0], 'utf8')
    }
    return banking.importStatement(c.db, ledgerId, csv)
  })

  // ---------- e-documents + invoice printing ----------
  handle('edoc:list', (p) => {
    const { from, to } = periodSchema.parse(p)
    return edocs.listSalesInvoices(requireCompany().db, from, to)
  })
  handle('edoc:exportEInvoice', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    const r = edocs.exportEInvoices(c.db, c.info, c.slug, from, to, period)
    shell.showItemInFolder(r.path)
    return r
  })
  handle('edoc:exportEwb', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    const r = edocs.exportEwb(c.db, c.info, c.slug, from, to, period)
    shell.showItemInFolder(r.path)
    return r
  })
  handle('invoice:pdf', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await invoice.invoicePdf(c.db, c.info, c.slug, voucherId)
    shell.openPath(path)
    return { path }
  })

  // ---------- currencies + BOM ----------
  handle('currency:list', () => extras.listCurrencies(requireCompany().db))
  handle('currency:create', (p) => extras.createCurrency(requireCompany().db, currencyInputSchema.parse(p)))
  handle('currency:delete', (p) => extras.deleteCurrency(requireCompany().db, idSchema.parse(p).id))
  handle('bom:get', (p) => extras.getBom(requireCompany().db, z.object({ itemId: z.number().int().positive() }).parse(p).itemId))
  handle('bom:set', (p) => extras.setBom(requireCompany().db, bomInputSchema.parse(p)))
  handle('bom:items', () => extras.itemsWithBom(requireCompany().db))

  // ---------- payroll ----------
  const daysSchema = z.array(z.object({ employeeId: z.number().int().positive(), payableDays: z.number().min(0).max(31) }))
  const monthSchema = z.string().regex(/^\d{4}-\d{2}$/)
  handle('payroll:employees:list', () => payroll.listEmployees(requireCompany().db))
  handle('payroll:employees:save', (p) => {
    const { data, id } = z.object({ data: employeeInputSchema, id: z.number().int().positive().optional() }).parse(p)
    return payroll.saveEmployee(requireCompany().db, data, id)
  })
  handle('payroll:employees:delete', (p) => payroll.deleteEmployee(requireCompany().db, idSchema.parse(p).id))
  handle('payroll:preview', (p) => {
    const { month, days } = z.object({ month: monthSchema, days: daysSchema }).parse(p)
    return payroll.previewRun(requireCompany().db, month, days)
  })
  handle('payroll:commit', (p) => {
    const { month, days } = z.object({ month: monthSchema, days: daysSchema }).parse(p)
    return payroll.commitRun(requireCompany().db, month, days)
  })
  handle('payroll:runs', () => payroll.listRuns(requireCompany().db))
  handle('payroll:deleteRun', (p) => payroll.deleteRun(requireCompany().db, idSchema.parse(p).id))
  handle('payroll:payslip', async (p) => {
    const { runId, employeeId } = z.object({ runId: z.number().int().positive(), employeeId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await payroll.payslipPdf(c.db, c.info, c.slug, runId, employeeId)
    shell.openPath(path)
    return { path }
  })

  // ---------- Tally import ----------
  handle('tally:import', async (p) => {
    const { xmlText } = z.object({ xmlText: z.string().optional() }).default({}).parse(p ?? {})
    const c = requireCompany()
    let xml = xmlText
    if (xml === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a Tally XML export (Masters and/or Vouchers)',
        filters: [{ name: 'Tally XML', extensions: ['xml', 'txt'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      xml = readFileSync(picked.filePaths[0], 'utf8')
    }
    backupCompany(c.slug, 'pre-tally-import')
    return importTallyXml(c.db, xml)
  })

  // ---------- live filing (NIC APIs) ----------
  handle('nic:get', () => {
    const creds = nic.readNicCredentials(requireCompany().db)
    // Never send the password back to the UI in full.
    return { ...creds, password: creds.password ? '••••••••' : '' }
  })
  handle('nic:save', (p) => {
    const c = requireCompany()
    const incoming = nicCredentialsSchema.parse(p)
    const existing = nic.readNicCredentials(c.db)
    if (incoming.password === '••••••••') incoming.password = existing.password
    nic.writeNicCredentials(c.db, incoming)
    nic.resetNicSession()
    return { configured: nic.nicConfigured(c.db) }
  })
  handle('nic:status', () => ({ configured: nic.nicConfigured(requireCompany().db) }))
  handle('nic:generateIrn', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    return nic.generateIrn(c.db, c.info, voucherId)
  })
  handle('nic:generateEwb', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    return nic.generateEwbByIrn(c.db, c.info, voucherId)
  })

  // ---------- intelligence ----------
  handle('intel:suggestLedgers', (p) => {
    const { kind, query } = z.object({ kind: z.string(), query: z.string() }).parse(p)
    return intel.suggestLedgers(requireCompany().db, kind, query)
  })
  handle('intel:anomaly', (p) => {
    const { ledgerId, amount } = z.object({ ledgerId: z.number().int().positive(), amount: z.number().int() }).parse(p)
    return intel.anomalyCheck(requireCompany().db, ledgerId, amount)
  })

  // ---------- logging ----------
  handle('log:renderer', (p) => {
    const { message, stack, componentStack, screen } = rendererLogSchema.parse(p)
    log('error', 'renderer-error', { message, stack, componentStack, screen })
    return null
  })
  handle('log:reveal', () => {
    revealLogs()
    return null
  })
}
