import type { VoucherKind } from './domain'

export type VoucherDraftMode = 'accounting' | 'invoice' | 'manufacture' | 'physical_stock'

export interface VoucherWorkDraft {
  id: number
  voucherTypeId: number
  voucherTypeName: string
  kind: VoucherKind
  mode: VoucherDraftMode
  title: string
  payloadVersion: number
  payload: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface VoucherWorkDraftInput {
  voucherTypeId: number
  mode: VoucherDraftMode
  title: string
  payloadVersion: number
  payload: Record<string, unknown>
}
