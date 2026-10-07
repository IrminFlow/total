// IPC channels for pricing and counter billing (WP 2.6): the items × levels grid and price-list
// tools, party-wise rates, discount schemes, the pricing options, the resolver, and the counter
// (checkout, quote, held bills, day end, print). Registered from ipc.ts with its `handle` (role
// gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { shell } from 'electron'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import {
  bulkRateUpdateSchema, copyLevelSchema, counterCheckoutSchema, counterConfigSchema, discountSchemeInputSchema, heldBillSchema,
  partyRateInputSchema, priceResolveSchema, pricingConfigSchema, ratesCsvImportSchema
} from '@shared/pricingSchemas'
import * as priceLevels from './services/priceLevels'
import * as pricing from './services/pricing'
import * as counter from './services/counter'
import { documentPdfWith, documentHtml, getTemplate } from './services/printTemplates'
import { writeAudit } from './services/audit'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })

export function registerPricingIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- price lists ----------
  handle('pricing:grid', (p) => priceLevels.rateGrid(db(), z.object({ date: isoDate }).parse(p).date), 'viewer')
  handle('pricing:setGridRate', (p) => {
    const q = z
      .object({ priceLevelId: z.number().int().positive(), stockItemId: z.number().int().positive(), date: isoDate, rate: z.number().int().min(0).nullable() })
      .parse(p)
    return priceLevels.setGridRate(db(), q.priceLevelId, q.stockItemId, q.date, q.rate)
  })
  handle('pricing:updateRate', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive(), data: z.unknown() }).parse(p)
    return priceLevels.saveRate(db(), data as Parameters<typeof priceLevels.saveRate>[1], id)
  })
  handle('pricing:bulkUpdate', (p) => priceLevels.bulkUpdateRates(db(), bulkRateUpdateSchema.parse(p)))
  handle('pricing:copyLevel', (p) => priceLevels.copyLevel(db(), copyLevelSchema.parse(p)))
  handle('pricing:exportCsv', (p) => {
    const { priceLevelId } = z.object({ priceLevelId: z.number().int().positive().optional() }).default({}).parse(p ?? {})
    return { csv: priceLevels.exportRatesCsv(db(), priceLevelId) }
  }, 'viewer')
  handle('pricing:importCsv', (p) => {
    const { csvText, dryRun } = ratesCsvImportSchema.parse(p)
    return priceLevels.importRatesCsv(db(), csvText, dryRun)
  })

  // ---------- party-wise rates ----------
  handle('pricing:partyRates', (p) => {
    const { ledgerId } = z.object({ ledgerId: z.number().int().positive().optional() }).default({}).parse(p ?? {})
    return pricing.listPartyRates(db(), ledgerId)
  }, 'viewer')
  handle('pricing:savePartyRate', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: partyRateInputSchema }).parse(p)
    return pricing.savePartyRate(db(), data, id)
  })
  handle('pricing:deletePartyRate', (p) => {
    pricing.deletePartyRate(db(), idSchema.parse(p).id)
    return null
  })

  // ---------- discount schemes ----------
  handle('pricing:schemes', () => pricing.listSchemes(db()), 'viewer')
  handle('pricing:saveScheme', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: discountSchemeInputSchema }).parse(p)
    return pricing.saveScheme(db(), data, id)
  })
  handle('pricing:deleteScheme', (p) => {
    pricing.deleteScheme(db(), idSchema.parse(p).id)
    return null
  })

  // ---------- options + resolver ----------
  handle('pricing:config', () => pricing.getPricingConfig(db()), 'viewer')
  handle('pricing:setConfig', (p) => pricing.setPricingConfig(db(), pricingConfigSchema.parse(p)))
  handle('pricing:resolve', (p) => pricing.resolveLines(db(), priceResolveSchema.parse(p)), 'viewer')

  // ---------- counter billing ----------
  handle('counter:config', () => ({ config: counter.getCounterConfig(db()), accounts: counter.counterAccounts(db()) }), 'viewer')
  handle('counter:setConfig', (p) => counter.setCounterConfig(db(), counterConfigSchema.parse(p)))
  handle('counter:quote', (p) => counter.counterQuote(db(), company().info, counterCheckoutSchema.parse(p)), 'viewer')
  handle('counter:checkout', (p) => counter.counterCheckout(db(), company().info, counterCheckoutSchema.parse(p)))
  handle('counter:held', () => counter.listHeldBills(db()), 'viewer')
  handle('counter:hold', (p) => counter.holdBill(db(), heldBillSchema.parse(p)))
  handle('counter:recall', (p) => counter.recallHeldBill(db(), z.object({ id: z.string().min(1).max(40) }).parse(p).id))
  handle('counter:discardHeld', (p) => {
    counter.discardHeldBill(db(), z.object({ id: z.string().min(1).max(40) }).parse(p).id)
    return null
  })
  handle('counter:dayEnd', (p) => counter.counterDayEnd(db(), z.object({ date: isoDate }).parse(p).date), 'viewer')
  /** The bill's printed HTML with a template (the receipt or A4) — the screen's preview. */
  handle('counter:printHtml', (p) => {
    const { voucherId, templateId } = z.object({ voucherId: z.number().int().positive(), templateId: z.string().min(1).max(60) }).parse(p)
    const c = company()
    return { html: documentHtml(c.db, c.info, voucherId, getTemplate(c.db, templateId)).html }
  }, 'viewer')
  handle('counter:print', async (p) => {
    const { voucherId, templateId } = z.object({ voucherId: z.number().int().positive(), templateId: z.string().min(1).max(60) }).parse(p)
    const c = company()
    const path = await documentPdfWith(c.db, c.info, c.slug, voucherId, templateId)
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'counter_bill_pdf', voucherId, templateId, path })
    void shell.openPath(path)
    return { path }
  }, 'viewer')
}
