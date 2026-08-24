import { z } from 'zod'

export const extractedDocumentSchema = z.object({
  supplierOrMerchant: z.string().trim().max(200).nullable(),
  documentNumber: z.string().trim().max(120).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  gstin: z.string().trim().max(20).nullable(),
  subtotal: z.number().int().nonnegative().nullable(),
  tax: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  items: z.array(z.object({ description:z.string().trim().min(1).max(500), quantityMilli:z.number().int().nonnegative().nullable(), amount:z.number().int().nonnegative().nullable() })).max(200),
  confidenceBps: z.number().int().min(0).max(10000),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50)
})

export const aiProviderInputSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai', 'compatible']).default('openai'),
  apiMode: z.enum(['responses', 'chat_completions']).default('responses'),
  model: z.string().trim().min(1).max(120).default('gpt-5-mini'),
  baseUrl: z.string().trim().max(500).nullable().default(null),
  apiKey: z.string().trim().max(500).optional(),
  clearApiKey: z.boolean().optional()
})

export type AiProviderInput = z.infer<typeof aiProviderInputSchema>
export type AiProviderConfig = Omit<AiProviderInput, 'apiKey' | 'clearApiKey'> & { hasApiKey: boolean }

export const aiAskSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  includeContext: z.boolean().default(true),
  contextFields: z.array(z.enum(['company', 'period', 'dashboard', 'trial_balance', 'receivables', 'payables', 'units'])).max(7).optional()
})

export const aiDraftVoucherSchema = z.object({
  prompt: z.string().trim().min(8).max(4_000)
})

export type AiContextFieldId = 'company' | 'period' | 'dashboard' | 'trial_balance' | 'receivables' | 'payables' | 'units'

export interface AiContextField {
  id: AiContextFieldId
  label: string
  description: string
  records: number
  bytes: number
  json: string
}

export interface AiContextPreview {
  fields: AiContextField[]
  selected: AiContextFieldId[]
  bytes: number
}

export interface AiCitation {
  label: string
  uri: string
}

export const aiGroundedAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  citations: z.array(z.object({ label: z.string().trim().min(1).max(200), uri: z.string().trim().min(1).max(500) })).max(20)
})
export type AiGroundedAnswer = z.infer<typeof aiGroundedAnswerSchema>

/** Accept only references the deterministic local context builder supplied. Model-invented links
 *  are rejected, and answers grounded in book context must cite at least one source. */
export function validateAiCitations(citations: AiCitation[], allowedCitations: AiCitation[] | null): AiCitation[] {
  if (allowedCitations === null) return []
  if (citations.length === 0) throw new Error('The provider returned an uncited answer; no book claim was shown')
  const allowed = new Map(allowedCitations.map((citation) => [citation.uri, citation]))
  const safe: AiCitation[] = []
  for (const citation of citations) {
    const known = allowed.get(citation.uri)
    if (!known) throw new Error('The provider cited a source that was not in the shared book context')
    if (!safe.some((item) => item.uri === known.uri)) safe.push(known)
  }
  return safe
}

export interface AiAnswer {
  text: string
  model: string
  provider: AiProviderConfig['provider']
  citations: AiCitation[]
}
