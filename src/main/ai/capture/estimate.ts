// WP 5.4 — the cost estimate shown before anything is sent: pages × a per-page token allowance,
// priced with the company's own price table (Settings → AI; no price row → "not priced", never a
// guess). Pure; tested. The allowances are deliberately on the high side of what one bill page
// costs: a page image ~1,600 input tokens (high detail), a PDF sent as a file ~2,200 (the provider
// sends both its text and a page image), a text layer ~1,200; plus ~700 for the instructions and
// schema and ~1,200 output tokens per bill.
import type { AiModelPrice } from '@shared/ai'
import { estimateCostMicroUsd } from '../cost'

export const ESTIMATE_TOKENS = { imagePage: 1600, pdfFilePage: 2200, textPage: 1200, prompt: 700, outputPerBill: 1200 } as const

export interface EstimateInput {
  mime: string
  pages: number
  textLayer: boolean
}

export function estimateCapture(items: readonly EstimateInput[], price: AiModelPrice | undefined | null): {
  pages: number
  inputTokens: number
  outputTokens: number
  costMicroUsd: number | null
  unmaskable: number
} {
  let input = 0
  let pages = 0
  let unmaskable = 0
  for (const it of items) {
    pages += it.pages
    const perPage = it.mime === 'application/pdf' ? (it.textLayer ? ESTIMATE_TOKENS.textPage : ESTIMATE_TOKENS.pdfFilePage) : ESTIMATE_TOKENS.imagePage
    input += ESTIMATE_TOKENS.prompt + it.pages * perPage
    if (!(it.mime === 'application/pdf' && it.textLayer)) unmaskable++
  }
  const output = items.length * ESTIMATE_TOKENS.outputPerBill
  const cost = items.length ? estimateCostMicroUsd({ inputTokens: input, cachedTokens: 0, outputTokens: output, reasoningTokens: 0 }, price) : 0
  return { pages, inputTokens: input, outputTokens: output, costMicroUsd: cost, unmaskable }
}
