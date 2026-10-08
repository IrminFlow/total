// WP 5.4 — document capture shapes shared by main and the renderer, and the IPC payload schemas
// (Zod-parsed in main/ipcCapture.ts).
import { z } from 'zod'
import type { ParsedBill } from './parse'
import type { BillTotals } from './totals'
import type { DuplicateHit } from './duplicates'
import type { CategorySource } from './categorise'

export type CaptureStatus = 'queued' | 'pending' | 'processing' | 'needs_review' | 'drafted' | 'duplicate' | 'saved' | 'failed' | 'cancelled'
export type CaptureOrigin = 'picker' | 'drop' | 'folder'

/** Files capture accepts (sniffed by content too). HEIC/HEIF is converted to JPEG before sending. */
export const CAPTURE_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif'
}
export const CAPTURE_MAX_BYTES = 20 * 1024 * 1024
export const CAPTURE_MAX_PAGES = 20

/** A question the bill → draft step needs the user to answer (no draft until answered). */
export interface CaptureQuestion {
  /** 'supplier' or 'line:N' (the printed line index). */
  field: string
  said: string
  question: string
  candidates: { id: number; name: string; detail?: string }[]
  /** Line questions: "book this line to a ledger instead" is offered. */
  ledgerOption?: boolean
}

/** What the app read from the bill and decided — shown in the review panel. */
export interface CaptureReview {
  mode: 'text' | 'image' | 'pdf'
  parsed: ParsedBill
  totals: BillTotals
  questions: CaptureQuestion[]
  /** "Create party" suggested action (never done automatically). */
  suggestedParty: { name: string; gstin: string | null; stateCode: string | null; address: string | null } | null
  duplicates: DuplicateHit[]
  /** Assumptions of the draft (also on the draft's banner). */
  assumptions: string[]
  /** GST the editor's calculation gives vs. what the bill prints. */
  taxCheck: { computed: number; printed: number; computedTotal: number; printedTotal: number | null } | null
}

/** The user's answers to the questions. */
export interface CaptureMapping {
  supplierLedgerId?: number
  /** Purchase / expense ledger for an invoice or for ledger lines. */
  accountLedgerId?: number
  lines?: Record<string, { itemId?: number; ledgerId?: number }>
}

export interface CaptureItemDto {
  id: number
  fileName: string
  mime: string
  size: number
  pages: number
  textLayer: boolean
  origin: CaptureOrigin
  status: CaptureStatus
  error: string | null
  attempts: number
  addedBy: string | null
  supplierName: string | null
  supplierLedgerId: number | null
  invoiceNo: string | null
  invoiceDate: string | null
  total: number | null
  duplicateKind: 'same_invoice' | 'same_amount' | null
  duplicateVoucherId: number | null
  draftId: number | null
  voucherId: number | null
  costMicroUsd: number | null
  createdAt: string
  updatedAt: string
  review: CaptureReview | null
  mapping: CaptureMapping | null
}

export interface CaptureEstimate {
  items: number
  /** The queued files this estimate priced — the approval sends exactly these. */
  ids: number[]
  /** Privacy in force (Settings → AI) — the disclosure reflects it. */
  maskIds: boolean
  pseudonymise: boolean
  pages: number
  inputTokens: number
  outputTokens: number
  /** null = no price set for the model (Settings → AI → prices). */
  costMicroUsd: number | null
  model: string
  /** Items sent as images / files (identifiers in them cannot be masked). */
  unmaskable: number
  /** Why nothing can be sent now (AI off, notice, key). */
  blocker: string | null
}

export interface CaptureQueueView {
  items: CaptureItemDto[]
  running: boolean
  /** Why the queue is not being sent (AI off …), or null. */
  blocker: string | null
  inboxPath: string
}

// ---------- bank statement categorisation ----------

export interface StatementCategoryRow {
  lineId: number
  date: string
  description: string
  reference: string
  side: 'deposit' | 'withdrawal'
  amount: number
  ledgerId: number | null
  ledgerName: string | null
  partyLedgerId: number | null
  kind: 'payment' | 'receipt' | 'contra'
  source: CategorySource
  confidence: number
  why: string
  oldestBillsFirst: boolean
  candidates: { id: number; name: string; why: string; memoryId?: number }[]
  /** WP 5.6: the memory the proposal rests on (cited on the draft). */
  memoryId?: number
}

export interface StatementCategorisation {
  rows: StatementCategoryRow[]
  /** The residual was sent to the model (AI on); false = deterministic rules only. */
  aiUsed: boolean
  aiNote: string | null
  /** Picks the model made outside the candidates (dropped). */
  rejected: number
}

export interface CategoriseAcceptResult {
  drafts: { lineId: number; draftId: number; summary: string }[]
  failed: { lineId: number; error: string }[]
}

// ---------- IPC payloads ----------

const id = z.number().int().positive()

export const captureAddFilesSchema = z.object({
  files: z
    .array(z.object({ name: z.string().trim().min(1).max(255), base64: z.string().min(1).max(Math.ceil((CAPTURE_MAX_BYTES * 4) / 3) + 8) }))
    .min(1)
    .max(50)
})

export const captureIdsSchema = z.object({ ids: z.array(id).max(500).optional() }).default({})
export const captureIdSchema = z.object({ id })
export const captureProcessSchema = z.object({ ids: z.array(id).min(1).max(500) })

export const captureResolveSchema = z.object({
  id,
  mapping: z
    .object({
      supplierLedgerId: id.optional(),
      accountLedgerId: id.optional(),
      lines: z.record(z.string().regex(/^\d{1,3}$/), z.object({ itemId: id.optional(), ledgerId: id.optional() }).strict()).optional()
    })
    .strict()
})

export const categoriseSchema = z.object({ bankLedgerId: id, lineIds: z.array(id).max(500).optional(), useAi: z.boolean().default(true) })

export const categoriseAcceptSchema = z.object({
  bankLedgerId: id,
  items: z
    .array(
      z
        .object({
          lineId: id,
          ledgerId: id,
          kind: z.enum(['payment', 'receipt', 'contra']).optional(),
          oldestBillsFirst: z.boolean().optional(),
          narration: z.string().trim().max(500).optional(),
          memoryId: id.optional()
        })
        .strict()
    )
    .min(1)
    .max(500)
})
