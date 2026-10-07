// IPC channels for banking depth (WP 4.1): statement import workspace (formats, mapping
// profiles, matching, bulk confirm / create, undo), learned rules, cheque books + register +
// printing, the PDC register with bounce handling, and bulk payment files. Registered from
// ipc.ts with its `handle` (role gate + { ok, data | error } envelope); every payload is
// Zod-parsed here. Every write channel is mapped in auditCoverage.ts.
import { dialog, shell } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import {
  bankDetailsSchema, bounceSchema, chequeBookInputSchema, chequeStatusSchema, confirmMatchesSchema, createFromLinesSchema, exportBatchSchema,
  importProfileSchema, learnedRuleEditSchema, paymentTemplateSchema, statementSourceSchema, workspaceQuerySchema
} from '@shared/bankSchemas'
import * as bankImport from './services/bankImport'
import * as cheques from './services/cheques'
import * as cheque from './services/cheque'
import * as pdc from './services/pdc'
import * as bulkPay from './services/bulkPayments'
import { writeAudit } from './services/audit'
import { companyExportsDir } from './paths'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const id = z.number().int().positive()
const idSchema = z.object({ id })
const bankSchema = z.object({ bankLedgerId: id })
const MAX_STATEMENT_BYTES = 15 * 1024 * 1024

const todayISO = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function registerBankingIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- statement import ----------
  // Native file picker; returns the file for preview (the renderer never reads the disk itself).
  handle('bankImport:pickFile', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a bank statement',
      filters: [
        { name: 'Bank statements', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'sta', 'mt940', '940', 'xml'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return null
    if (statSync(path).size > MAX_STATEMENT_BYTES) throw new Error('That file is larger than 15 MB — split the statement by period')
    return { fileName: basename(path), base64: readFileSync(path).toString('base64') }
  })
  handle('bankImport:preview', (p) => {
    const { bankLedgerId, source } = z.object({ bankLedgerId: id, source: statementSourceSchema }).parse(p)
    return bankImport.previewStatement(db(), bankLedgerId, source)
  })
  handle('bankImport:commit', (p) => {
    const { bankLedgerId, source, saveProfile } = z.object({ bankLedgerId: id, source: statementSourceSchema, saveProfile: z.boolean().default(true) }).parse(p)
    return bankImport.commitStatement(db(), bankLedgerId, source, { saveProfile })
  })
  handle('bankImport:profile', (p) => {
    const { bankLedgerId, format } = z.object({ bankLedgerId: id, format: z.enum(['csv', 'xlsx']) }).parse(p)
    return bankImport.getImportProfile(db(), bankLedgerId, format)
  }, 'viewer')
  handle('bankImport:saveProfile', (p) => {
    const { bankLedgerId, format, profile } = z.object({ bankLedgerId: id, format: z.enum(['csv', 'xlsx']), profile: importProfileSchema }).parse(p)
    return bankImport.saveImportProfile(db(), bankLedgerId, format, profile)
  })
  handle('bankImport:workspace', (p) => {
    const { bankLedgerId, ...q } = workspaceQuerySchema.parse(p)
    return bankImport.statementWorkspace(db(), bankLedgerId, q)
  }, 'viewer')
  handle('bankImport:imports', (p) => bankImport.listImports(db(), bankSchema.parse(p).bankLedgerId), 'viewer')
  handle('bankImport:confirm', (p) => {
    const { bankLedgerId, groups, tolerance } = confirmMatchesSchema.parse(p)
    return bankImport.confirmMatches(db(), bankLedgerId, groups, tolerance)
  })
  handle('bankImport:unmatch', (p) => {
    const { bankLedgerId, lineId } = z.object({ bankLedgerId: id, lineId: id }).parse(p)
    bankImport.unmatchLine(db(), bankLedgerId, lineId)
    return null
  })
  handle('bankImport:ignore', (p) => {
    const { bankLedgerId, lineId, ignored } = z.object({ bankLedgerId: id, lineId: id, ignored: z.boolean() }).parse(p)
    bankImport.setLineIgnored(db(), bankLedgerId, lineId, ignored)
    return null
  })
  handle('bankImport:createVouchers', (p) => {
    const { bankLedgerId, items } = createFromLinesSchema.parse(p)
    return bankImport.createVouchersFromLines(db(), bankLedgerId, items)
  })
  handle('bankImport:undo', (p) => {
    const { bankLedgerId, importId } = z.object({ bankLedgerId: id, importId: id }).parse(p)
    return bankImport.undoLastImport(db(), bankLedgerId, importId)
  })

  // ---------- learned rules ----------
  handle('bankLearned:list', () => bankImport.listLearnedRules(db()), 'viewer')
  handle('bankLearned:update', (p) => {
    const { id: ruleId, data } = z.object({ id, data: learnedRuleEditSchema }).parse(p)
    return bankImport.updateLearnedRule(db(), ruleId, data)
  })
  handle('bankLearned:delete', (p) => {
    bankImport.deleteLearnedRule(db(), idSchema.parse(p).id)
    return null
  })

  // ---------- cheque books + register ----------
  handle('cheques:books', (p) => cheques.listChequeBooks(db(), z.object({ bankLedgerId: id.optional() }).default({}).parse(p ?? {}).bankLedgerId), 'viewer')
  handle('cheques:saveBook', (p) => {
    const { id: bookId, data } = z.object({ id: id.optional(), data: chequeBookInputSchema }).parse(p)
    return cheques.saveChequeBook(db(), data, bookId)
  })
  handle('cheques:deleteBook', (p) => {
    cheques.deleteChequeBook(db(), idSchema.parse(p).id)
    return null
  })
  handle('cheques:register', (p) => {
    const { bankLedgerId, includeAvailable } = z.object({ bankLedgerId: id, includeAvailable: z.boolean().default(true) }).parse(p)
    return cheques.chequeRegister(db(), bankLedgerId, includeAvailable)
  }, 'viewer')
  handle('cheques:next', (p) => cheques.nextChequeNumber(db(), bankSchema.parse(p).bankLedgerId), 'viewer')
  handle('cheques:setStatus', (p) => cheques.setChequeStatus(db(), chequeStatusSchema.parse(p)))
  // Issue the register entry (next leaf unless one is given) and print it — "Print cheque" from a
  // payment voucher. A re-print of the same voucher re-uses its leaf.
  handle('cheques:print', async (p) => {
    const { voucherId, bankLedgerId, number } = z.object({ voucherId: id, bankLedgerId: id, number: z.string().trim().max(20).nullable().optional() }).parse(p)
    const c = company()
    const row = cheques.issueCheque(c.db, voucherId, bankLedgerId, number ?? null)
    const path = await cheque.chequePdf(c.db, c.info, c.slug, voucherId, bankLedgerId, row.number)
    cheques.recordChequePrint(c.db, row.chequeId!)
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'cheque_pdf', voucherId, bankLedgerId, chequeNo: row.number, path })
    return { path, cheque: row }
  })

  // ---------- post-dated cheques ----------
  handle('pdc:register', (p) => {
    const { today } = z.object({ today: isoDate.optional() }).default({}).parse(p ?? {})
    return pdc.pdcRegisterFull(db(), today ?? todayISO())
  }, 'viewer')
  handle('pdc:bounce', (p) => pdc.bouncePdc(db(), bounceSchema.parse(p)))

  // ---------- bulk payments ----------
  handle('bulkPay:beneficiaries', () => bulkPay.listBeneficiaries(db()), 'viewer')
  handle('bulkPay:setBankDetails', (p) => {
    const { ledgerId, data } = z.object({ ledgerId: id, data: bankDetailsSchema }).parse(p)
    return bulkPay.setBankDetails(db(), ledgerId, data)
  })
  handle('bulkPay:templates', () => bulkPay.listPaymentTemplates(db()), 'viewer')
  handle('bulkPay:saveTemplate', (p) => {
    const { id: templateId, data } = z.object({ id: id.optional(), data: paymentTemplateSchema }).parse(p)
    return bulkPay.savePaymentTemplate(db(), data, templateId)
  })
  handle('bulkPay:deleteTemplate', (p) => {
    bulkPay.deletePaymentTemplate(db(), idSchema.parse(p).id)
    return null
  })
  handle('bulkPay:candidates', (p) => {
    const { bankLedgerId, from, to } = z.object({ bankLedgerId: id, from: isoDate, to: isoDate }).parse(p)
    return bulkPay.paymentCandidates(db(), bankLedgerId, from, to)
  }, 'viewer')
  handle('bulkPay:batches', (p) => bulkPay.listPaymentBatches(db(), bankSchema.parse(p).bankLedgerId), 'viewer')
  handle('bulkPay:export', (p) => {
    const input = exportBatchSchema.parse(p)
    const c = company()
    const result = bulkPay.exportPaymentBatch(c.db, input)
    const dir = companyExportsDir(c.slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, result.fileName)
    writeFileSync(path, result.text, 'utf8')
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'bulk_payment_file', batchId: result.batchId, path, count: result.count, total: result.total })
    shell.showItemInFolder(path)
    return { ...result, path }
  })
}
