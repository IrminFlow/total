/** WP 6.5 — Zod schemas for the consolidation IPC channels (parsed in src/main/ipcConsolidation.ts). */
import { z } from 'zod'
import { isoDate } from '../schemas'

const slug = z.string().trim().min(1).max(120)
const bp = z.number().int().min(0).max(10000)
const id = z.number().int().positive()
const nature = z.enum(['asset', 'liability', 'income', 'expense'])
const isBs = (n: string): boolean => n === 'asset' || n === 'liability'

export const consolMemberSchema = z.object({
  companySlug: slug,
  role: z.enum(['parent', 'subsidiary', 'associate']),
  ownershipBp: bp.default(10000),
  acquiredOn: isoDate.nullable().default(null),
  includeFrom: isoDate.nullable().default(null),
  includeTo: isoDate.nullable().default(null),
  investmentLedgerId: id.nullable().default(null),
  investmentCost: z.number().int().min(0).nullable().default(null),
  acquisitionEquity: z.number().int().nullable().default(null)
})

export const consolGroupInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    presentationCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'a three-letter currency code').default('INR'),
    icTolerance: z.number().int().min(0).max(100_000_000).default(100),
    unrealisedMarginBp: bp.nullable().default(null),
    members: z.array(consolMemberSchema).min(1).max(20)
  })
  .superRefine((g, ctx) => {
    if (g.members.filter((m) => m.role === 'parent').length !== 1) ctx.addIssue({ code: 'custom', path: ['members'], message: 'exactly one member must be the parent' })
    const seen = new Set<string>()
    for (const m of g.members) {
      if (seen.has(m.companySlug)) ctx.addIssue({ code: 'custom', path: ['members'], message: `${m.companySlug} is listed twice` })
      seen.add(m.companySlug)
      if (m.role === 'parent' && m.ownershipBp !== 10000) ctx.addIssue({ code: 'custom', path: ['members'], message: 'the parent is 100 % its own' })
      if (m.includeFrom && m.includeTo && m.includeFrom > m.includeTo) ctx.addIssue({ code: 'custom', path: ['members'], message: `${m.companySlug}: “include from” is after “include to”` })
    }
    // One investment ledger per subsidiary, unless every subsidiary sharing it states its own cost.
    const byLedger = new Map<number, typeof g.members>()
    for (const m of g.members) {
      if (m.role !== 'subsidiary' || m.investmentLedgerId == null) continue
      byLedger.set(m.investmentLedgerId, [...(byLedger.get(m.investmentLedgerId) ?? []), m])
    }
    for (const subs of byLedger.values()) {
      if (subs.length > 1 && subs.some((m) => m.investmentCost == null)) {
        ctx.addIssue({ code: 'custom', path: ['members'], message: `${subs.map((m) => m.companySlug).join(', ')} share an investment ledger — enter each one's investment amount` })
      }
    }
  })
export type ConsolGroupInput = z.infer<typeof consolGroupInputSchema>

export const consolMappingInputSchema = z
  .object({
    groupId: id,
    companySlug: slug,
    ledgerId: id.nullable().default(null),
    groupName: z.string().trim().min(1).max(120).nullable().default(null),
    targetName: z.string().trim().min(1).max(120),
    targetNature: nature.nullable().default(null),
    /** The source ledger's / group's nature as the form saw it; the service re-checks it against the member's books. */
    sourceNature: nature.optional()
  })
  .refine((m) => (m.ledgerId == null) !== (m.groupName == null), 'map either one ledger or one group')
  .refine((m) => !m.targetNature || !m.sourceNature || isBs(m.targetNature) === isBs(m.sourceNature), {
    message: 'a mapping cannot move a ledger between the balance sheet and the P&L', path: ['targetNature']
  })
export type ConsolMappingInput = z.infer<typeof consolMappingInputSchema>

export const consolPairInputSchema = z
  .object({
    groupId: id,
    memberA: slug,
    ledgerAId: id,
    memberB: slug,
    ledgerBId: id,
    kind: z.enum(['receivable_payable', 'sales_purchase', 'loan', 'other']),
    unrealisedMarginBp: bp.nullable().default(null)
  })
  .refine((p) => p.memberA !== p.memberB, 'a pair links two different companies')
export type ConsolPairInput = z.infer<typeof consolPairInputSchema>

export const consolRunSchema = z
  .object({ groupId: id, from: isoDate, to: isoDate, comparePrior: z.boolean().default(false) })
  .refine((r) => r.from <= r.to, 'from must be on or before to')
