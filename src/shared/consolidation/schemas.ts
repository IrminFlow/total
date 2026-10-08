/** WP 6.5 — Zod schemas for the consolidation IPC channels (parsed in src/main/ipcConsolidation.ts). */
import { z } from 'zod'
import { isoDate } from '../schemas'

const slug = z.string().trim().min(1).max(120)
const bp = z.number().int().min(0).max(10000)
const id = z.number().int().positive()
const nature = z.enum(['asset', 'liability', 'income', 'expense'])

export const consolMemberSchema = z.object({
  companySlug: slug,
  role: z.enum(['parent', 'subsidiary', 'associate']),
  ownershipBp: bp.default(10000),
  acquiredOn: isoDate.nullable().default(null),
  includeFrom: isoDate.nullable().default(null),
  includeTo: isoDate.nullable().default(null),
  investmentLedgerId: id.nullable().default(null),
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
  })
export type ConsolGroupInput = z.infer<typeof consolGroupInputSchema>

export const consolMappingInputSchema = z
  .object({
    groupId: id,
    companySlug: slug,
    ledgerId: id.nullable().default(null),
    groupName: z.string().trim().min(1).max(120).nullable().default(null),
    targetName: z.string().trim().min(1).max(120),
    targetNature: nature.nullable().default(null)
  })
  .refine((m) => (m.ledgerId == null) !== (m.groupName == null), 'map either one ledger or one group')
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
